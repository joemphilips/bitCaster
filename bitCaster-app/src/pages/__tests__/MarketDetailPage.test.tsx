import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  assertMarketAcceptsOrders,
  booksByOutcomeSetFromDetail,
  buildPendingTopUpOrderIntent,
  composeMarketDetail,
  createMarketDetailDataState,
  decideTradeCollateralGate,
  defaultLimitPriceForDivisibility,
  fetchMarketDetailWithBooks,
  marketDetailDataReducer,
  pendingTopUpOrderIntentMatches,
  resolveTradeOrderBooks,
  shouldPromptForFundedActionBackup,
} from "@/pages/MarketDetailPage";
import { MarketDetailPage } from "@/pages/MarketDetailPage";
import { fetchMarketDetail, fetchOrderBook } from "@/lib/markets";
import {
  previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder,
} from "@/lib/browserCtfRangeOrderSubmission";
import type { MarketStatusChanged, OrderBookSnapshot } from "@/lib/marketHub";
import type {
  CategoricalMarketDetail,
  Comment,
  MarketDetail,
  OrderBook,
} from "@/types/market-detail";

const mocks = vi.hoisted(() => ({
  buildIndexedDbTokenHoldings: vi.fn(),
  getBalance: vi.fn(),
  ensureParticipationScoreForNextMatch: vi.fn(),
  navigate: vi.fn(),
  previewBrowserCtfRangeOrderFees: vi.fn(),
  routeParams: { id: "condition-yesno" } as { id?: string },
  walletState: {
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    setupComplete: false,
    walletBackupState: "confirmed",
    activeMintUrl: null as string | null,
    mints: [] as Array<{ url: string; nickname?: string }>,
  },
  settingsState: {
    nostrSignerMode: "none",
    signerBackupState: "confirmed",
  },
  liveStatusHandlers: [] as Array<(status: MarketStatusChanged) => void>,
  orderBookHandlers: new Map<string, (snapshot: OrderBookSnapshot) => void>(),
  windowPriceHistory: vi.fn((history: { timeframe: string; data: Array<unknown> }) => ({
    ...history,
    data: history.data.slice(-1000),
  })),
}));

vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.routeParams,
}));

vi.mock("@/components/market-detail/PriceChart", () => ({
  PriceChart: () => <div data-testid="price-chart" />,
}));

vi.mock("@/components/market-detail/TopUpOverlay", () => ({
  TopUpOverlay: ({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) => (
    <div role="dialog" aria-label="Top Up Wallet">
      <h2>Top Up Wallet</h2>
      <input data-testid="top-up-amount-input" />
      <button data-testid="top-up-success" onClick={onSuccess}>
        Simulate top-up success
      </button>
      <button data-testid="top-up-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/useMarketStatusLive", () => ({
  useMarketStatusLive: (
    _conditionId: string | null | undefined,
    handler: (status: MarketStatusChanged) => void,
  ) => {
    mocks.liveStatusHandlers.push(handler);
  },
}));

vi.mock("@/lib/marketHub", () => ({
  joinMarket: vi.fn().mockResolvedValue(undefined),
  leaveMarket: vi.fn().mockResolvedValue(undefined),
  onMarketRejoined: vi.fn(() => () => {}),
  onOrderBookUpdated: vi.fn((marketId: string, handler: (snapshot: OrderBookSnapshot) => void) => {
    mocks.orderBookHandlers.set(marketId, handler);
    return () => mocks.orderBookHandlers.delete(marketId);
  }),
  onOrderCancelled: vi.fn(() => () => {}),
}));

vi.mock("@/lib/markets", () => ({
  fetchMarketDetail: vi.fn(),
  fetchMarketComments: vi.fn().mockResolvedValue({ comments: [] }),
  fetchMarketPriceHistory: vi.fn().mockResolvedValue({ data: [], timeframe: "7d" }),
  fetchOrderBook: vi.fn(),
  generateNip98Header: vi.fn(),
  getParticipationScore: vi.fn().mockResolvedValue({ enabled: false, matchDebitScore: 0 }),
  mapSnapshotToOrderBook: (snapshot: OrderBookSnapshot) => ({
    bids: snapshot.bids.map((level) => ({
      price: level.price,
      amount: level.amount,
      total: level.amount,
    })),
    asks: snapshot.asks.map((level) => ({
      price: level.price,
      amount: level.amount,
      total: level.amount,
    })),
    spread: snapshot.spread ?? 0,
    depthLimit: snapshot.depthLimit,
  }),
  priceNumeratorToPercent: (price: number, divisibility = 100) => (price / divisibility) * 100,
  signTradeComment: vi.fn(),
  windowPriceHistory: mocks.windowPriceHistory,
}));

vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  previewBrowserCtfRangeOrderFees: mocks.previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder: vi.fn(),
}));

vi.mock("@/lib/participationScorePayment", () => ({
  ensureParticipationScoreForNextMatch: mocks.ensureParticipationScoreForNextMatch,
}));

vi.mock("@bitcaster/client-sdk/engineClient", () => ({
  BitcasterEngineClient: vi.fn().mockImplementation(function () {
    return {
      listMyOrders: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@/lib/walletHoldings", () => ({
  buildIndexedDbTokenHoldings: mocks.buildIndexedDbTokenHoldings,
}));

vi.mock("@/stores/wallet", () => {
  const useWalletStore = (selector: (state: typeof mocks.walletState) => unknown) =>
    selector(mocks.walletState);
  useWalletStore.getState = () => mocks.walletState;
  return {
    getBalance: mocks.getBalance,
    useActiveMintInputFeePpk: () => 0,
    useWalletStore,
  };
});

vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof mocks.settingsState) => unknown) =>
    selector(mocks.settingsState),
}));

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 };
const loadedComment: Comment = {
  id: "comment-1",
  userId: "commenter",
  userDisplayName: "Verified trader",
  content: "Keep this comment",
  timestamp: "2026-01-02T00:00:00Z",
  likeCount: 0,
  isLiked: false,
};

function book(price: number): OrderBook {
  return {
    bids: [{ price, amount: 100, total: 100 }],
    asks: [],
    spread: 0,
  };
}

function askBook(price: number): OrderBook {
  return {
    bids: [],
    asks: [{ price, amount: 100, total: 100 }],
    spread: 0,
  };
}

function yesNoMarket(overrides: Partial<MarketDetail> = {}): MarketDetail {
  return {
    id: "condition-yesno",
    title: "Will it happen?",
    type: "yesno",
    imageUrl: "",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "2026-12-31T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseUnit: "sats",
    baseAsset: "sat",
    divisibility: 10_000,
    creator: {
      id: "creator",
      name: "creator",
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    outcomes: [
      { id: "Yes", label: "Yes", odds: 50 },
      { id: "No", label: "No", odds: 50 },
    ],
    resolution: {
      criteria: "Will it happen?",
      source: "oracle",
      resolutionDate: "2026-12-31T00:00:00Z",
      status: "open",
    },
    priceHistory: { data: [], timeframe: "7d" },
    orderBook: emptyBook,
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    outcomeOrderBooks: {
      Yes: emptyBook,
      No: emptyBook,
    },
    ...overrides,
  } as MarketDetail;
}

function fundedSatYesNoMarket(overrides: Partial<MarketDetail> = {}): MarketDetail {
  return yesNoMarket({
    baseUnit: "sats",
    baseAsset: "sat",
    divisibility: 10_000,
    outcomeOrderBooks: {
      Yes: askBook(4_000),
      No: emptyBook,
    },
    ...overrides,
  });
}

function mockAcceptedOrder() {
  vi.mocked(submitBrowserCtfRangeOrder).mockResolvedValue({
    orderId: "order-auto-1",
    status: "filled",
    remainingAmountSubunits: 0,
    fills: [],
    baseAsset: "sat",
    divisibility: 10_000,
    activeSettlementGroup: null,
  });
}

function categoricalMarket(): MarketDetail {
  return {
    id: "condition-1",
    title: "Winner",
    type: "categorical",
    imageUrl: "",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "2026-12-31T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseUnit: "sats",
    baseAsset: "sat",
    divisibility: 10_000,
    creator: {
      id: "creator",
      name: "creator",
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    outcomes: [
      { id: "outcome-0", label: "Alice", odds: 33.33 },
      { id: "outcome-1", label: "Bob", odds: 33.33 },
      { id: "outcome-2", label: "Carol", odds: 33.33 },
    ],
    resolution: {
      criteria: "Winner",
      source: "oracle",
      resolutionDate: "2026-12-31T00:00:00Z",
      status: "open",
    },
    priceHistory: { data: [], timeframe: "7d" },
    orderBook: emptyBook,
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    outcomePriceHistories: {},
    outcomeOrderBooks: {},
  };
}

describe("fetchMarketDetailWithBooks", () => {
  beforeEach(() => {
    vi.mocked(fetchMarketDetail).mockReset();
    vi.mocked(fetchOrderBook).mockReset();
    vi.mocked(submitBrowserCtfRangeOrder).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue({
      consolidationFeeSubunits: 0,
      sourceFeeSubunits: 0,
    });
    mocks.windowPriceHistory.mockClear();
    mocks.liveStatusHandlers.length = 0;
    mocks.routeParams.id = "condition-yesno";
  });

  it("fetches singleton outcome-set books for categorical markets", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(categoricalMarket());
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) => book(marketId.length));

    const detail = await fetchMarketDetailWithBooks("condition-1");

    expect(fetchOrderBook).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetchOrderBook).mock.calls.map(([marketId]) => marketId)).toEqual([
      "condition-1-Alice",
      "condition-1-Bob",
      "condition-1-Carol",
    ]);
    expect(detail.outcomeOrderBooks).toHaveProperty("Alice");
    expect(detail.outcomeOrderBooks).not.toHaveProperty("Bob|Carol");
  });
});

describe("MarketDetailPage live market status", () => {
  beforeEach(() => {
    vi.mocked(fetchMarketDetail).mockReset();
    vi.mocked(fetchOrderBook).mockReset();
    vi.mocked(submitBrowserCtfRangeOrder).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue({
      consolidationFeeSubunits: 0,
      sourceFeeSubunits: 0,
    });
    mocks.buildIndexedDbTokenHoldings.mockReset();
    mocks.getBalance.mockReset();
    mocks.ensureParticipationScoreForNextMatch.mockReset();
    mocks.ensureParticipationScoreForNextMatch.mockResolvedValue({
      kind: "disabled",
      score: { enabled: false, matchDebitScore: 0 },
    });
    mocks.liveStatusHandlers.length = 0;
    mocks.orderBookHandlers.clear();
    mocks.routeParams.id = "condition-yesno";
    mocks.navigate.mockReset();
    mocks.walletState.setupComplete = false;
    mocks.walletState.walletBackupState = "confirmed";
    mocks.walletState.activeMintUrl = null;
    mocks.walletState.mints = [];
    mocks.settingsState.nostrSignerMode = "none";
    mocks.settingsState.signerBackupState = "confirmed";
  });

  it("applies a MarketStatusChanged close push to the detail page and disables trading", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });

    await waitFor(() => expect(mocks.liveStatusHandlers.length).toBeGreaterThan(0));
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "closed" }));
    act(() => {
      mocks.liveStatusHandlers.at(-1)?.({
        conditionId: "condition-yesno",
        state: "closed",
        closedAt: "2026-06-24T00:00:00Z",
      });
    });

    expect(await screen.findByText("Market Closed")).toBeInTheDocument();
    for (const input of screen.getAllByTestId("trade-amount-input")) {
      expect(input).toBeDisabled();
    }
    for (const button of screen.getAllByTestId("trade-confirm")) {
      expect(button).toBeDisabled();
    }

    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("classifies needs_backup wallets as requiring the funded-action backup prompt", () => {
    expect(shouldPromptForFundedActionBackup("needs_backup")).toBe(true);
    expect(shouldPromptForFundedActionBackup("none")).toBe(false);
    expect(shouldPromptForFundedActionBackup("confirmed")).toBe(false);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("throws from the submit guard when the market is closed", () => {
    expect(() => assertMarketAcceptsOrders(yesNoMarket({ state: "closed" }))).toThrow(
      "This market is closed and no longer accepts orders.",
    );
  });

  it("requires top-up when a priced buy covers quote cost but not face value", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 500,
      outcomeProofsByOutcomeSetId: {},
    });
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByRole("button", { name: /limit/i })[0]);
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    fireEvent.change(screen.getAllByTestId("limit-price-input")[0], {
      target: { value: "0.4" },
    });
    fireEvent.blur(screen.getAllByTestId("limit-price-input")[0]);

    await waitFor(() =>
      expect(screen.getAllByTestId("trade-confirm")[0]).toHaveTextContent("Top up sats wallet"),
    );
    expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled();
    expect(screen.getAllByText("Insufficient funds").length).toBeGreaterThan(0);
  });

  it("adds the exact proof consolidation cost to the trade pane mint fee", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 20_000,
      outcomeProofsByOutcomeSetId: {},
    });
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue({
      consolidationFeeSubunits: 1_500,
      sourceFeeSubunits: 0,
    });
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(4_000) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });

    const mintFees = await screen.findAllByTestId("trade-mint-fee");
    expect(mintFees[0]).toHaveTextContent("1.5 sats");
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConsolidationFeeSubunits: 1_500 }),
    );
  });

  it("opens the trade top-up overlay from the page-level buy top-up button", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 100,
      outcomeProofsByOutcomeSetId: {},
    });
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByRole("button", { name: /limit/i })[0]);
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    fireEvent.change(screen.getAllByTestId("limit-price-input")[0], {
      target: { value: "0.4" },
    });
    fireEvent.blur(screen.getAllByTestId("limit-price-input")[0]);

    await screen.findAllByRole("button", { name: /Top up .+ wallet/i });
    const panelTopUpButton = screen
      .getAllByTestId("trade-confirm")
      .find((button) => /Top up .+ wallet/i.test(button.textContent ?? ""));
    expect(panelTopUpButton).toBeDefined();
    fireEvent.click(panelTopUpButton!);

    expect(await screen.findByRole("heading", { name: "Top Up Wallet" })).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toBeInTheDocument();
  });

  it("auto-executes a sat market order once top-up success leaves enough proof-store balance", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 0,
      outcomeProofsByOutcomeSetId: {},
    });
    mocks.getBalance.mockResolvedValue(0);
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(4_000) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-top-up");
    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    mocks.getBalance.mockResolvedValue(10_000);
    fireEvent.click(await screen.findByTestId("top-up-success"));

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: expect.any(String),
        mintUrl: "https://mint.example",
        mnemonic: mocks.walletState.mnemonic,
        ticket: expect.objectContaining({
          marketId: "condition-yesno-Yes",
          request: expect.objectContaining({
            amountSubunits: 10_000,
            outcomeId: "Yes",
            side: "Buy",
            timeInForce: "FAK",
          }),
        }),
      }),
    );
  });

  it("does not auto-execute a sat market order when post-top-up balance is still insufficient", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 0,
      outcomeProofsByOutcomeSetId: {},
    });
    mocks.getBalance.mockResolvedValue(0);
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(4_000) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-top-up");
    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    mocks.getBalance.mockResolvedValue(3_900);
    fireEvent.click(await screen.findByTestId("top-up-success"));

    await screen.findAllByText(
      "Top-up completed, but the wallet balance is still below the order requirement.",
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("drops a pending sat market order intent when order details change during top-up", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.buildIndexedDbTokenHoldings.mockResolvedValue({
      baseUnitProofs: 0,
      outcomeProofsByOutcomeSetId: {},
    });
    mocks.getBalance.mockResolvedValue(0);
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(4_000) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-top-up");
    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "2" },
    });
    mocks.getBalance.mockResolvedValue(4_000);
    fireEvent.click(await screen.findByTestId("top-up-success"));

    await screen.findAllByText(
      "Order details changed during top-up. Review the order and confirm again.",
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });
});

describe("marketDetailDataReducer", () => {
  beforeEach(() => {
    mocks.windowPriceHistory.mockClear();
  });

  it("preserves yes/no chart history and comments across submit refresh", () => {
    const history = {
      timeframe: "7d" as const,
      data: [{ timestamp: "2026-01-01T00:00:00Z", price: 51, volume: 10 }],
    };
    const initial = yesNoMarket({
      priceHistory: history,
      comments: [loadedComment],
      outcomeOrderBooks: {
        Yes: askBook(55),
        No: book(45),
      },
    });
    const refresh = yesNoMarket({
      id: initial.id,
      state: "closed",
      priceHistory: { data: [], timeframe: "7d" },
      comments: [],
      recentTrades: [],
      relatedMarkets: [],
      orderBook: emptyBook,
      outcomeOrderBooks: {},
    });

    const state = marketDetailDataReducer(createMarketDetailDataState(initial), {
      type: "marketSubmitRefreshLoaded",
      detail: refresh,
      booksByOutcomeSetId: booksByOutcomeSetFromDetail(refresh, []),
      replaceOutcomeSetIds: [],
    });
    const view = composeMarketDetail(state, "7d");

    expect(view?.state).toBe("closed");
    expect(view?.priceHistory.data).toEqual(history.data);
    expect(view?.orderBook).toBe(initial.outcomeOrderBooks?.Yes);
    expect(view?.comments).toEqual([loadedComment]);
  });

  it("aligns yes/no displayed odds with the latest backend price history point", () => {
    const initial = yesNoMarket({
      currentOdds: { yes: 50, no: 50 },
      priceHistory: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 80, source: "fill" }],
      },
    });

    const view = composeMarketDetail(createMarketDetailDataState(initial), "7d");

    expect(view?.type).toBe("yesno");
    if (view?.type === "yesno") {
      expect(view.currentOdds).toEqual({ yes: 80, no: 20 });
    }
  });

  it("aligns categorical outcome odds with the latest backend outcome histories", () => {
    const initial = categoricalMarket() as CategoricalMarketDetail;
    initial.outcomes = [
      { id: "outcome-0", label: "Alice", odds: 33.33 },
      { id: "outcome-1", label: "Bob", odds: 33.33 },
      { id: "outcome-2", label: "Carol", odds: 33.33 },
    ];
    initial.priceHistory = {
      timeframe: "7d",
      data: [{ timestamp: "2026-01-01T00:00:00Z", price: 80, source: "fill" }],
    };
    initial.outcomePriceHistories = {
      Alice: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 80, source: "fill" }],
      },
      Bob: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 10, source: "fill" }],
      },
      Carol: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 10, source: "fill" }],
      },
    };

    const view = composeMarketDetail(createMarketDetailDataState(initial), "7d");

    expect(view?.type).toBe("categorical");
    if (view?.type === "categorical") {
      expect(view.outcomes.map((outcome) => outcome.odds)).toEqual([80, 10, 10]);
    }
  });

  it("preserves categorical histories and comments across lifecycle refresh", () => {
    const initial = categoricalMarket() as CategoricalMarketDetail;
    initial.priceHistory = {
      timeframe: "7d",
      data: [{ timestamp: "2026-01-01T00:00:00Z", price: 34, volume: 1 }],
    };
    initial.outcomePriceHistories = {
      Alice: initial.priceHistory,
      Bob: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 33, volume: 1 }],
      },
      Carol: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 33, volume: 1 }],
      },
    };
    initial.comments = [loadedComment];
    const refresh: CategoricalMarketDetail = {
      ...initial,
      state: "closed",
      priceHistory: { data: [], timeframe: "7d" },
      outcomePriceHistories: {},
      comments: [],
      recentTrades: [],
      relatedMarkets: [],
      orderBook: emptyBook,
      outcomeOrderBooks: {},
    };

    const state = marketDetailDataReducer(createMarketDetailDataState(initial), {
      type: "marketSnapshotLoaded",
      detail: refresh,
    });
    const view = composeMarketDetail(state, "7d");

    expect(view?.state).toBe("closed");
    expect(view?.comments).toEqual([loadedComment]);
    expect(view?.type).toBe("categorical");
    if (view?.type === "categorical") {
      expect(view.outcomePriceHistories.Alice.data).toEqual(
        initial.outcomePriceHistories.Alice.data,
      );
      expect(view.outcomePriceHistories.Bob.data).toEqual(initial.outcomePriceHistories.Bob.data);
    }
  });

  it("updates live books without erasing history or comments", () => {
    const history = {
      timeframe: "7d" as const,
      data: [{ timestamp: "2026-01-01T00:00:00Z", price: 49, volume: 4 }],
    };
    const initial = yesNoMarket({
      priceHistory: history,
      comments: [loadedComment],
      outcomeOrderBooks: {
        Yes: askBook(55),
        No: book(45),
      },
    });
    const liveBook = {
      bids: [{ price: 52, amount: 100, total: 100 }],
      asks: [],
      spread: 0,
    };

    const state = marketDetailDataReducer(createMarketDetailDataState(initial), {
      type: "orderBookUpdated",
      marketId: initial.id,
      outcomeSetId: "Yes",
      orderBook: liveBook,
    });
    const view = composeMarketDetail(state, "7d");

    expect(view?.orderBook).toBe(liveBook);
    expect(view?.priceHistory.data).toEqual(history.data);
    expect(view?.comments).toEqual([loadedComment]);
  });

  it("does not let late REST books overwrite a newer live book", () => {
    const initial = yesNoMarket({
      outcomeOrderBooks: {
        Yes: book(50),
        No: book(45),
      },
    });
    const liveBook = book(58);
    const restBook = book(51);
    const stateWithLive = marketDetailDataReducer(createMarketDetailDataState(initial), {
      type: "orderBookUpdated",
      marketId: initial.id,
      outcomeSetId: "Yes",
      orderBook: liveBook,
    });

    const stateAfterRest = marketDetailDataReducer(stateWithLive, {
      type: "booksLoaded",
      marketId: initial.id,
      booksByOutcomeSetId: { Yes: restBook },
      replaceOutcomeSetIds: ["Yes"],
    });
    const view = composeMarketDetail(stateAfterRest, "7d");

    expect(view?.orderBook).toBe(liveBook);
  });
});

describe("defaultLimitPriceForDivisibility", () => {
  it("uses the midpoint for supported market denominators", () => {
    expect(defaultLimitPriceForDivisibility(10_000, "sat")).toBe(5_000);
    expect(defaultLimitPriceForDivisibility(1_000_000, "sat")).toBe(500_000);
  });
});

describe("resolveTradeOrderBooks", () => {
  it("treats the public singleton book as complementary liquidity for categorical NO selections", () => {
    const market = categoricalMarket();
    market.outcomeOrderBooks = {
      Alice: {
        bids: [{ price: 60, amount: 100, total: 100 }],
        asks: [{ price: 35, amount: 100, total: 100 }],
        spread: 25,
      },
    };

    const books = resolveTradeOrderBooks(market, {
      side: "no",
      outcomeId: "outcome-0",
    });

    expect(books?.outcomeSets.selectedOutcomeSetId).toBe("Bob|Carol");
    expect(books?.selectedBook).toBeNull();
    expect(books?.complementBook).toBe(market.outcomeOrderBooks.Alice);
  });

  it("uses the public singleton book as direct liquidity for categorical YES selections", () => {
    const market = categoricalMarket();
    market.outcomeOrderBooks = { Alice: askBook(35) };

    const books = resolveTradeOrderBooks(market, {
      side: "yes",
      outcomeId: "outcome-0",
    });

    expect(books?.outcomeSets.selectedOutcomeSetId).toBe("Alice");
    expect(books?.selectedBook).toBe(market.outcomeOrderBooks.Alice);
    expect(books?.complementBook).toBeNull();
  });
});

describe("decideTradeCollateralGate", () => {
  it("returns top-up when balance does not cover the order face collateral", () => {
    expect(
      decideTradeCollateralGate({
        balance: 50,
        tradeFaceAmountSubunits: 100,
      }),
    ).toEqual({ kind: "top-up", balance: 50, required: 100 });
  });

  it("proceeds when balance covers the order face collateral", () => {
    expect(
      decideTradeCollateralGate({
        balance: 100,
        tradeFaceAmountSubunits: 100,
      }),
    ).toEqual({ kind: "proceed", balance: 100, required: 100 });
  });
});

describe("pending top-up order intent", () => {
  it("binds a sat top-up intent to market, selection, amount, comment, and required subunits", () => {
    const market = yesNoMarket({
      id: "condition-sat",
      baseAsset: "sat",
      baseUnit: "sats",
      divisibility: 10_000,
    });

    const intent = buildPendingTopUpOrderIntent({
      market,
      tradeSelection: { side: "yes" },
      tradeAmount: 2,
      tradeSide: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
      comment: "  auto after top-up  ",
      baseAsset: "sat",
      required: 9_000,
    });

    expect(intent).toMatchObject({
      marketId: "condition-sat",
      selectionKey: "yes:",
      tradeAmount: 2,
      tradeSide: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
      comment: "auto after top-up",
      baseAsset: "sat",
      required: 9_000,
    });
    expect(
      intent &&
        pendingTopUpOrderIntentMatches(intent, {
          market,
          tradeSelection: { side: "yes" },
          tradeAmount: 2,
          tradeSide: "Buy",
          orderType: "limit",
          limitPrice: 4_500,
        }),
    ).toBe(true);
  });

  it("drops a pending top-up intent when amount or selection changes before success", () => {
    const market = yesNoMarket({ id: "condition-sat", baseAsset: "sat" });
    const intent = buildPendingTopUpOrderIntent({
      market,
      tradeSelection: { side: "yes" },
      tradeAmount: 2,
      tradeSide: "Buy",
      orderType: "market",
      limitPrice: 999,
      baseAsset: "sat",
      required: 1_998,
    });

    expect(intent).not.toBeNull();
    expect(
      pendingTopUpOrderIntentMatches(intent!, {
        market,
        tradeSelection: { side: "yes" },
        tradeAmount: 3,
        tradeSide: "Buy",
        orderType: "market",
        limitPrice: 999,
      }),
    ).toBe(false);
    expect(
      pendingTopUpOrderIntentMatches(intent!, {
        market,
        tradeSelection: { side: "no" },
        tradeAmount: 2,
        tradeSide: "Buy",
        orderType: "market",
        limitPrice: 999,
      }),
    ).toBe(false);
  });
});
