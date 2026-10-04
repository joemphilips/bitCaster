import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Amount } from "@cashu/cashu-ts";
import { createDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import type { CtfRangeMintMetadata } from "@bitcaster/client-sdk/ctfRangeMintMetadata";
import type { PriceHistory } from "@/types/market-detail";
import {
  assertMarketAcceptsOrders,
  booksByOutcomeSetFromDetail,
  buildPendingTopUpOrderIntent,
  composeMarketDetail,
  createMarketDetailDataState,
  fetchMarketDetailWithBooks,
  marketDetailDataReducer,
  pendingTopUpOrderIntentMatches,
  resolveTradeOrderBooks,
} from "@/pages/MarketDetailPage";
import { MarketDetailPage } from "@/pages/MarketDetailPage";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  fetchMarketDetail,
  fetchMarketPriceHistory,
  fetchMarketComments,
  fetchOrderBook,
  MarketDetailUnavailableError,
  type MarketCatalogueEntry,
  type MarketPriceHistoryResponse,
} from "@/lib/markets";
import {
  previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder,
} from "@/lib/browserCtfRangeOrderSubmission";
import { BrowserCtfRangeOrderError } from "@/lib/browserCtfRangeOrderCoordinator";
import { decodeBrowserCustodyProofRow } from "@/stores/durable-custody-types";
import { db } from "@/stores/proof-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import {
  joinMarket,
  onConfirmedTradeRecorded,
  onMarketFundingUpdated,
  refreshMarketSnapshot,
  type LatestConfirmedTrade,
  type MarketFundingUpdatedMessage,
  type MarketStatusChanged,
  type OrderBookSnapshot,
} from "@/lib/marketHub";
import type {
  CategoricalMarketDetail,
  Comment,
  MarketDetail,
  OrderBook,
} from "@/types/market-detail";
import type { PreviewFokOrderCapacityRequest } from "@bitcaster/client-sdk/fokOrderPreview";

const mocks = vi.hoisted(() => ({
  readCanonicalSellHoldings: vi.fn(),
  sellHoldingsByOutcomeSet: new Map([
    ["Yes", { selectableSubunits: 10_000, reservedSubunits: 0 }],
    ["No", { selectableSubunits: 10_000, reservedSubunits: 0 }],
    ["Alice", { selectableSubunits: 10_000, reservedSubunits: 0 }],
    ["Bob|Carol", { selectableSubunits: 10_000, reservedSubunits: 0 }],
  ]),
  createImplicitWalletAndNostrIdentity: vi.fn(),
  getExactUnitBalance: vi.fn(),
  navigate: vi.fn(),
  previewFokOrder: vi.fn(),
  previewFokOrderCapacity: vi.fn(),
  previewBrowserCtfRangeOrderFees: vi.fn(),
  getSettlementCapabilityAdmissionPolicy: vi.fn(),
  loadRangeMintMetadata: vi.fn(),
  readRangeProofs: vi.fn(),
  routeParams: { id: "condition-yesno" } as { id?: string },
  walletScopeId: "wallet-profile-a",
  signerRevision: 0,
  walletState: {
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    setupComplete: false,
    walletBackupState: "confirmed",
    activeMintUrl: null as string | null,
    mints: [] as Array<{ url: string; nickname?: string }>,
  },
  commentHandlers: [] as Array<(message: { conditionId: string; eventOrder: string }) => void>,
  rejoinHandlers: [] as Array<() => void>,
  confirmedTradeHandlers: [] as Array<
    (message: { conditionId: string; latestConfirmedTrade: LatestConfirmedTrade }) => void
  >,
  signalr: (() => {
    const registeredHandlers = new Map<string, (payload: unknown) => void>();
    const connection = {
      state: "Disconnected" as "Disconnected" | "Connected" | "Reconnecting",
      start: vi.fn(async () => {
        connection.state = "Connected";
      }),
      stop: vi.fn(async () => {
        connection.state = "Disconnected";
      }),
      invoke: vi.fn(async (_method: string, ..._args: unknown[]) => undefined),
      on: vi.fn((eventName: string, handler: (payload: unknown) => void) => {
        registeredHandlers.set(eventName, handler);
      }),
      onreconnected: vi.fn((_handler: () => void) => undefined),
    };
    return { connection, registeredHandlers };
  })(),
  fundingHandlers: [] as Array<{
    conditionId: string;
    handler: (message: MarketFundingUpdatedMessage) => void;
  }>,
  executeMarketFundingDelivery: vi.fn(),
  readMarketFundingHeadId: vi.fn(),
  settingsState: {
    nostrSignerMode: "none",
    nostrProfile: null as { pubkey: string } | null,
    signerBackupState: "confirmed",
  },
  topUpOverlayProps: null as {
    deficit: number;
    baseAsset: "sat";
    proofUnit?: "sat" | "msat" | null;
  } | null,
  liveStatusHandlers: [] as Array<(status: MarketStatusChanged) => void>,
  orderBookHandlers: new Map<string, (snapshot: OrderBookSnapshot) => void>(),
  windowPriceHistory: vi.fn<(history: PriceHistory) => PriceHistory>(),
}));

vi.mock("@microsoft/signalr", () => ({
  HubConnectionBuilder: class {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      return mocks.signalr.connection;
    }
  },
  HubConnectionState: {
    Connected: "Connected",
    Disconnected: "Disconnected",
    Reconnecting: "Reconnecting",
  },
}));

vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.routeParams,
}));

vi.mock("@/components/market-detail/PriceChart", () => ({
  PriceChart: ({
    priceHistory,
    currentDisplay,
    comments,
    outcomePriceHistories,
    onTimeframeChange,
  }: {
    onTimeframeChange?: (timeframe: PriceHistory["timeframe"]) => void;
    comments?: Comment[];
    outcomePriceHistories?: Record<string, PriceHistory>;
    priceHistory: PriceHistory;
    currentDisplay?: string;
  }) => {
    const latestPrice = priceHistory.data.at(-1)?.price.toFixed(2);
    return (
      <div data-testid="price-chart">
        <span data-testid="chart-latest-price">{latestPrice ?? "empty"}%</span>
        {latestPrice !== undefined && <span data-testid="latest-price-pill">{latestPrice}%</span>}
        <span data-testid="chart-headline">{currentDisplay}</span>
        <span data-testid="chart-snapshot">
          {JSON.stringify(outcomePriceHistories ?? priceHistory)}
        </span>
        <span data-testid="chart-comments">
          {comments?.map((comment) => comment.content).join(",")}
        </span>
        {(["1h", "24h", "7d", "30d", "all"] as const).map((timeframe) => (
          <button
            key={timeframe}
            onClick={() => onTimeframeChange?.(timeframe)}
          >{`snapshot-${timeframe}`}</button>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/market-detail/TopUpOverlay", () => ({
  TopUpOverlay: ({
    deficit,
    baseAsset,
    proofUnit,
    minimumDescription,
    onSuccess,
    onCancel,
  }: {
    deficit: number;
    baseAsset: "sat";
    proofUnit?: "sat" | "msat" | null;
    minimumDescription?: string;
    onSuccess: () => void;
    onCancel: () => void;
  }) => {
    mocks.topUpOverlayProps = { deficit, baseAsset, proofUnit };
    return (
      <div role="dialog" aria-label="Top Up Wallet">
        <h2>Top Up Wallet</h2>
        {minimumDescription && <p>{minimumDescription}</p>}
        <input data-testid="top-up-amount-input" />
        <button data-testid="top-up-success" onClick={onSuccess}>
          Simulate top-up success
        </button>
        <button data-testid="top-up-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  },
}));

vi.mock("@/hooks/useMarketStatusLive", () => ({
  useMarketStatusLive: (
    _conditionId: string | null | undefined,
    handler: (status: MarketStatusChanged) => void,
  ) => {
    mocks.liveStatusHandlers.push(handler);
  },
}));

vi.mock("@/lib/marketHub", async () => ({
  applyConfirmedTradeDelta: (
    await vi.importActual<typeof import("@/lib/marketHub")>("@/lib/marketHub")
  ).applyConfirmedTradeDelta,
  onConfirmedTradeRecorded: vi.fn(
    (
      _conditionId: string,
      handler: (message: {
        conditionId: string;
        latestConfirmedTrade: LatestConfirmedTrade;
      }) => void,
    ) => {
      mocks.confirmedTradeHandlers.push(handler);
      return () => {
        const index = mocks.confirmedTradeHandlers.indexOf(handler);
        if (index >= 0) mocks.confirmedTradeHandlers.splice(index, 1);
      };
    },
  ),
  joinMarket: vi.fn().mockResolvedValue(undefined),
  leaveMarket: vi.fn().mockResolvedValue(undefined),
  onMarketFundingUpdated: vi.fn(
    (conditionId: string, handler: (message: MarketFundingUpdatedMessage) => void) => {
      const registration = { conditionId, handler };
      mocks.fundingHandlers.push(registration);
      return () => {
        const index = mocks.fundingHandlers.indexOf(registration);
        if (index >= 0) mocks.fundingHandlers.splice(index, 1);
      };
    },
  ),
  refreshMarketSnapshot: vi.fn().mockResolvedValue(undefined),
  onMarketCommentsChanged: vi.fn((_conditionId, handler) => {
    mocks.commentHandlers.push(handler);
    return () => {
      mocks.commentHandlers.splice(mocks.commentHandlers.indexOf(handler), 1);
    };
  }),
  onMarketRejoined: vi.fn((_marketId, handler) => {
    mocks.rejoinHandlers.push(handler);
    return () => {
      mocks.rejoinHandlers.splice(mocks.rejoinHandlers.indexOf(handler), 1);
    };
  }),
  onOrderBookUpdated: vi.fn((marketId: string, handler: (snapshot: OrderBookSnapshot) => void) => {
    mocks.orderBookHandlers.set(marketId, handler);
    return () => mocks.orderBookHandlers.delete(marketId);
  }),
  onOrderCancelled: vi.fn(() => () => {}),
}));

vi.mock("@/lib/markets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/markets")>("@/lib/markets");
  mocks.windowPriceHistory.mockImplementation(actual.windowPriceHistory);
  return {
    ...actual,
    validateLatestConfirmedTrades: actual.validateLatestConfirmedTrades,
    deriveYesNoOdds: actual.deriveYesNoOdds,
    deriveCategoricalOdds: actual.deriveCategoricalOdds,
    fetchMarketDetail: vi.fn(),
    fetchMarketComments: vi.fn().mockResolvedValue({
      conditionId: "condition-yesno",
      snapshotEventOrder: null,
      comments: [],
    }),
    fetchMarketPriceHistory: vi.fn().mockResolvedValue({
      conditionId: "condition-yesno",
      snapshotEventOrder: null,
      asOf: "2026-09-27T17:00:00Z",
      outcomes: [],
      timeframe: "7d",
    }),
    fetchOrderBook: vi.fn(),
    generateNip98Header: vi.fn(),
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
    priceNumeratorToPercent: actual.priceNumeratorToPercent,
    signTradeComment: vi.fn(),
    windowPriceHistory: mocks.windowPriceHistory,
  };
});

vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  BrowserCtfRangeScoreTopUpCancelledError: class extends Error {},
  BrowserCtfRangeScoreTopUpRequiredError: class extends Error {},
  previewBrowserCtfRangeOrderFees: mocks.previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder: vi.fn(),
}));

vi.mock("@bitcaster/client-sdk/ctfRangeMintMetadata", async () => {
  const actual = await vi.importActual<typeof import("@bitcaster/client-sdk/ctfRangeMintMetadata")>(
    "@bitcaster/client-sdk/ctfRangeMintMetadata",
  );
  return { ...actual, loadCtfRangeMintMetadata: mocks.loadRangeMintMetadata };
});

vi.mock("@/stores/proof-db", async () => {
  const actual = await vi.importActual<typeof import("@/stores/proof-db")>("@/stores/proof-db");
  return {
    ...actual,
    getBoundedCanonicalRangeProofsForKeyset: mocks.readRangeProofs,
  };
});

vi.mock("@/lib/browserMarketFundingDelivery", () => ({
  BrowserMarketFundingInsufficientBalanceError: class extends Error {},
  executeBrowserMarketFundingDelivery: mocks.executeMarketFundingDelivery,
  readBrowserMarketFundingHeadId: mocks.readMarketFundingHeadId,
}));

vi.mock("@bitcaster/client-sdk/engineClient", async () => {
  const actual = await vi.importActual<typeof import("@bitcaster/client-sdk/engineClient")>(
    "@bitcaster/client-sdk/engineClient",
  );
  return {
    ...actual,
    BitcasterEngineClient: class extends actual.BitcasterEngineClient {
      listMyOrders = vi.fn().mockResolvedValue([]);
      getSettlementCapabilityAdmissionPolicy = mocks.getSettlementCapabilityAdmissionPolicy;
      previewFokOrder = mocks.previewFokOrder;
      previewFokOrderCapacity = mocks.previewFokOrderCapacity;
    },
  };
});
vi.mock("@/lib/canonicalSellHoldings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/canonicalSellHoldings")>(
    "@/lib/canonicalSellHoldings",
  );
  return {
    ...actual,
    readCanonicalMarketSellHoldings: mocks.readCanonicalSellHoldings,
  };
});

vi.mock("@/lib/identityOps", () => ({
  createImplicitWalletAndNostrIdentity: mocks.createImplicitWalletAndNostrIdentity,
  resolveCreatorPubkey: () => "funding-test-subject",
}));

vi.mock("@/stores/wallet", () => {
  const useWalletStore = (selector: (state: typeof mocks.walletState) => unknown) =>
    selector(mocks.walletState);
  useWalletStore.getState = () => mocks.walletState;
  return {
    getExactUnitBalance: mocks.getExactUnitBalance,
    useBalance: () => 1_000_000,
    useActiveMintInputFeePpk: () => 0,
    useWalletStore,
  };
});

vi.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
    { getState: () => mocks.settingsState },
  ),
}));

vi.mock("@/lib/browserWalletProfile", async () => ({
  ...(await vi.importActual<typeof import("@/lib/browserWalletProfile")>(
    "@/lib/browserWalletProfile",
  )),
  activeBrowserWalletScopeId: () => mocks.walletScopeId,
}));

vi.mock("@/lib/nostr", async () => ({
  ...(await vi.importActual<typeof import("@/lib/nostr")>("@/lib/nostr")),
  getNostrSignerRevision: () => mocks.signerRevision,
  subscribeToNostrSignerRevision: () => () => {},
}));

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 };

function rangeFeeFacts(consolidationFeeSubunits = "0") {
  return {
    settlementInputFeeSubunits: "1",
    sourcePreparationFeeSubunits: "0",
    consolidationFeeSubunits,
    settlementAsset: { kind: "regular", unit: "msat" } as const,
    sourcePreparationAsset: { kind: "regular", unit: "msat" } as const,
    consolidationAsset: { kind: "regular", unit: "msat" } as const,
    sourceMode: "wallet-send" as const,
  };
}

function reviewedRangeMintFacts(
  mintUrl: string,
  conditionId: string,
  observedAt: number,
  maxOutputs = 256,
): CtfRangeMintMetadata {
  const keys = Object.fromEntries(
    [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048].map((amount) => [
      String(amount),
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ]),
  );
  const keysets = [
    { id: `01${"22".repeat(32)}`, outcomeCollection: "Yes", outcomeCollectionId: "44".repeat(32) },
    { id: `01${"33".repeat(32)}`, outcomeCollection: "No", outcomeCollectionId: "55".repeat(32) },
  ].map((keyset) => ({
    canonicalMintUrl: mintUrl,
    ...keyset,
    conditionId,
    unit: "msat" as const,
    active: true as const,
    keys,
    inputFeePpk: 1,
    finalExpiry: null,
    registeredAt: 1,
  }));
  const conditionKeysetIds = keysets.map(({ id }) => id).sort();

  return {
    regular: [
      {
        canonicalMintUrl: mintUrl,
        id: `01${"11".repeat(32)}`,
        unit: "msat",
        active: true,
        keys,
        inputFeePpk: 1,
        finalExpiry: null,
      },
    ],
    conditional: keysets,
    conditionKeysetIds,
    maxInputs: 64,
    maxOutputs,
    maxRequestBytes: 65_536,
    maxPoolEntries: 128,
    maxExpirySeconds: 3_600,
    observation: {
      canonicalMintUrl: mintUrl,
      freshness: "fresh",
      observedAt,
      maxExpirySeconds: 3_600,
      conditionKeysetIds,
      conditionalKeysets: keysets.map(
        ({
          id,
          conditionId: keysetConditionId,
          unit,
          inputFeePpk,
          outcomeCollectionId,
          outcomeCollection,
          registeredAt,
          keys: keysetKeys,
        }) => ({
          keysetId: id,
          conditionId: keysetConditionId,
          unit,
          inputFeePpk,
          outcomeCollectionId,
          outcomeCollection,
          registeredAt,
          keys: keysetKeys,
        }),
      ),
    },
  };
}

async function configureRealRangeFeePreview(input: {
  conditionId: string;
  mintUrl: string;
  failMetadataOnce?: boolean;
  proofAmounts?: number[];
  bookPrice?: number;
  maxOutputs?: number;
}) {
  mocks.walletState.setupComplete = true;
  mocks.walletState.activeMintUrl = input.mintUrl;
  mocks.settingsState.nostrSignerMode = "nsec";
  mocks.routeParams.id = input.conditionId;
  mocks.getSettlementCapabilityAdmissionPolicy.mockReset().mockResolvedValue({
    coordinatorPubkey: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  });
  mocks.loadRangeMintMetadata
    .mockReset()
    .mockImplementation(
      async (metadataInput: { mintUrl: string; conditionId: string; observedAt: number }) =>
        reviewedRangeMintFacts(
          metadataInput.mintUrl,
          metadataInput.conditionId,
          metadataInput.observedAt,
          input.maxOutputs,
        ),
    );
  if (input.failMetadataOnce) {
    mocks.loadRangeMintMetadata.mockRejectedValueOnce(new Error("private mint detail"));
  }
  mocks.readRangeProofs.mockReset().mockResolvedValue(
    (input.proofAmounts ?? [1_024]).map((amount) => ({
      id: `01${"11".repeat(32)}`,
      amount,
      secret: `range-source-${amount}`,
      C: "02",
    })),
  );
  const actualSubmission = await vi.importActual<
    typeof import("@/lib/browserCtfRangeOrderSubmission")
  >("@/lib/browserCtfRangeOrderSubmission");
  vi.mocked(previewBrowserCtfRangeOrderFees).mockImplementation(
    actualSubmission.previewBrowserCtfRangeOrderFees,
  );
  vi.mocked(fetchMarketDetail).mockResolvedValue(
    fundedSatYesNoMarket({
      id: input.conditionId,
      state: "open",
      outcomeOrderBooks: {
        Yes: askBook(input.bookPrice ?? 400),
        No: emptyBook,
      },
    }),
  );
  vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
    marketId === `${input.conditionId}-Yes` ? askBook(input.bookPrice ?? 400) : emptyBook,
  );
}

function rangeProofs(keysetId: string, amounts: readonly number[]) {
  return amounts.map((amount, index) => ({
    id: keysetId,
    amount,
    secret: `${keysetId}-proof-${index}`,
    C: "02",
  }));
}

/** Records each fee result that the real fee helper returns to the page. */
function observeRealRangeFeePreview() {
  const observed: Array<Awaited<ReturnType<typeof previewBrowserCtfRangeOrderFees>>> = [];
  const realPreview = vi.mocked(previewBrowserCtfRangeOrderFees).getMockImplementation();
  if (realPreview === undefined) throw new Error("Configure the real fee preview first.");
  vi.mocked(previewBrowserCtfRangeOrderFees).mockImplementation(async (input) => {
    const facts = await realPreview(input);
    observed.push(facts);
    return facts;
  });
  return observed;
}

function insufficientExactFundsError() {
  return new BrowserCtfRangeOrderError(
    "insufficient-funds",
    "The wallet does not have enough exact funds for this order.",
    "offered",
  );
}

function fillablePreview() {
  return {
    fullFillAvailable: true,
    reason: "fillable" as const,
    previewRevision: "test-revision",
    quotePaymentSubunits: 1_000,
    averagePrice: 500,
    worstPrice: 500,
    currentLatestTradePrice: 500,
    projectedFinalPrice: 500,
    priceDenominator: 1_000,
    subsidyMayHelp: false,
  };
}

function capacityPreview(
  request: PreviewFokOrderCapacityRequest,
  referencePrice = request.side === "Buy" ? 400 : 600,
  maxFaceAmountSubunits = 10_000,
) {
  const denominator = 1_000;
  const automaticLimit = Math.max(
    1,
    Math.min(denominator - 1, referencePrice + (request.side === "Buy" ? 200 : -200)),
  );
  const effectiveLimit = request.price ?? automaticLimit;
  const hasCapacity =
    request.side === "Buy" ? effectiveLimit >= referencePrice : effectiveLimit <= referencePrice;
  const maxFace = hasCapacity ? maxFaceAmountSubunits : 0;
  return {
    status: "ready" as const,
    referencePrice,
    effectiveLimitPrice: effectiveLimit,
    maxFaceAmountSubunits: maxFace,
    quotePaymentSubunits: maxFace === 0 ? 0 : 5_000,
    worstPrice: maxFace === 0 ? null : referencePrice,
    priceDenominator: denominator,
    previewRevision: "capacity-test-revision",
  };
}

function nonfillablePreview() {
  return {
    fullFillAvailable: false,
    reason: "price_limit" as const,
    previewRevision: "test-revision-2",
    quotePaymentSubunits: null,
    averagePrice: null,
    worstPrice: null,
    currentLatestTradePrice: 500,
    projectedFinalPrice: null,
    priceDenominator: 1_000,
    subsidyMayHelp: false,
  };
}

const loadedComment: Comment = {
  id: "comment-1",
  userId: "commenter",
  userDisplayName: "Verified trader",
  content: "Keep this comment",
  timestamp: "2026-01-02T00:00:00Z",
  trade: null,
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
    divisibility: 1_000,
    registeredPrimitiveOutcomeIds: ["YES", "NO"],
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
    divisibility: 1_000,
    outcomeOrderBooks: {
      Yes: askBook(400),
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
    divisibility: 1_000,
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
    divisibility: 1_000,
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
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue(rangeFeeFacts());
    vi.mocked(onMarketFundingUpdated).mockClear();
    vi.mocked(joinMarket).mockClear();
    vi.mocked(refreshMarketSnapshot).mockReset().mockResolvedValue(undefined);
    mocks.fundingHandlers.length = 0;
    mocks.executeMarketFundingDelivery.mockReset().mockResolvedValue({
      progress: "received",
      transfer: { transferId: "payment-1", requestedAmount: "1000" },
    });
    mocks.readMarketFundingHeadId.mockReset().mockResolvedValue(null);
    mocks.windowPriceHistory.mockClear();
    mocks.liveStatusHandlers.length = 0;
    mocks.confirmedTradeHandlers.length = 0;
    mocks.commentHandlers.length = 0;
    mocks.rejoinHandlers.length = 0;
    mocks.routeParams.id = "condition-yesno";
    mocks.walletScopeId = browserWalletScopeIdFromMnemonic(mocks.walletState.mnemonic)!;
    usePendingTradesStore.setState({ byOrderId: {} });
    mocks.signerRevision = 0;
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
    vi.mocked(fetchMarketPriceHistory).mockReset().mockResolvedValue({
      conditionId: "condition-yesno",
      snapshotEventOrder: null,
      asOf: "2026-09-27T17:00:00Z",
      outcomes: [],
      timeframe: "7d",
    });
    vi.mocked(fetchMarketComments).mockReset().mockResolvedValue({
      conditionId: "condition-yesno",
      snapshotEventOrder: null,
      comments: [],
    });
    vi.mocked(fetchMarketDetail).mockReset();
    vi.mocked(fetchOrderBook).mockReset();
    vi.mocked(submitBrowserCtfRangeOrder).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockReset();
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue(rangeFeeFacts());
    vi.mocked(onMarketFundingUpdated).mockClear();
    vi.mocked(joinMarket).mockClear();
    vi.mocked(refreshMarketSnapshot).mockReset().mockResolvedValue(undefined);
    mocks.fundingHandlers.length = 0;
    mocks.executeMarketFundingDelivery.mockReset().mockResolvedValue({
      progress: "received",
      transfer: { transferId: "payment-1", requestedAmount: "1000" },
    });
    mocks.readMarketFundingHeadId.mockReset().mockResolvedValue(null);
    mocks.previewFokOrder.mockReset();
    mocks.previewFokOrder.mockResolvedValue(fillablePreview());
    mocks.previewFokOrderCapacity.mockReset();
    mocks.previewFokOrderCapacity.mockImplementation((request: PreviewFokOrderCapacityRequest) =>
      Promise.resolve(capacityPreview(request)),
    );
    mocks.sellHoldingsByOutcomeSet.clear();
    for (const [outcomeSetId, holding] of [
      ["Yes", { selectableSubunits: 10_000, reservedSubunits: 0 }],
      ["No", { selectableSubunits: 10_000, reservedSubunits: 0 }],
      ["Alice", { selectableSubunits: 10_000, reservedSubunits: 0 }],
      ["Bob|Carol", { selectableSubunits: 10_000, reservedSubunits: 0 }],
    ] as const) {
      mocks.sellHoldingsByOutcomeSet.set(outcomeSetId, holding);
    }
    mocks.readCanonicalSellHoldings.mockReset();
    mocks.readCanonicalSellHoldings.mockImplementation(
      async (identity: {
        routeId: string;
        conditionId: string;
        scopeId: string;
        mintUrl: string;
      }) => ({
        identityKey: JSON.stringify([
          identity.routeId,
          identity.conditionId,
          identity.scopeId,
          identity.mintUrl,
        ]),
        status: "ready" as const,
        byOutcomeSetId: new Map(mocks.sellHoldingsByOutcomeSet),
      }),
    );
    mocks.getExactUnitBalance.mockReset();
    mocks.liveStatusHandlers.length = 0;
    mocks.confirmedTradeHandlers.length = 0;
    mocks.orderBookHandlers.clear();
    mocks.routeParams.id = "condition-yesno";
    mocks.walletScopeId = browserWalletScopeIdFromMnemonic(mocks.walletState.mnemonic)!;
    usePendingTradesStore.setState({ byOrderId: {} });
    mocks.signerRevision = 0;
    mocks.navigate.mockReset();
    mocks.walletState.setupComplete = false;
    mocks.walletState.walletBackupState = "confirmed";
    mocks.walletState.activeMintUrl = null;
    mocks.walletState.mints = [];
    mocks.settingsState.nostrSignerMode = "none";
    mocks.settingsState.nostrProfile = null;
    mocks.settingsState.signerBackupState = "confirmed";
    mocks.createImplicitWalletAndNostrIdentity.mockReset();
    mocks.topUpOverlayProps = null;
  });

  it("keeps the live NO headline while waiting for the authoritative YES-basis history", async () => {
    const actualHub = await vi.importActual<typeof import("@/lib/marketHub")>("@/lib/marketHub");
    await actualHub.disconnect();
    mocks.signalr.connection.state = "Disconnected";
    mocks.signalr.connection.start.mockClear();
    mocks.signalr.connection.stop.mockClear();
    mocks.signalr.connection.invoke.mockClear();
    mocks.signalr.connection.on.mockClear();
    mocks.signalr.registeredHandlers.clear();
    vi.mocked(joinMarket).mockImplementation(actualHub.joinMarket);
    vi.mocked(onConfirmedTradeRecorded).mockImplementation((conditionId, handler) =>
      actualHub.onConfirmedTradeRecorded(conditionId, handler),
    );

    const buyTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "Yes",
      fillId: "00000000-0000-0000-0000-000000000001",
      executedAt: "2026-09-27T16:38:42.318Z",
      eventOrder: "0001",
      priceTick: 510,
      divisibility: 1_000,
      faceAmountSubunits: 1_000,
    };
    const market = yesNoMarket({
      registeredPrimitiveOutcomeIds: ["Yes", "No"],
      outcomes: [
        { id: "Yes", label: "Yes", odds: 510 },
        { id: "No", label: "No", odds: 490 },
      ],
      latestConfirmedTradesValid: true,
      latestConfirmedTrades: [buyTrade],
      priceHistory: {
        timeframe: "7d",
        data: [
          {
            timestamp: "2026-09-27T16:38:42.318Z",
            eventOrder: buyTrade.eventOrder,
            price: 51,
            volume: buyTrade.faceAmountSubunits,
            source: "fill",
          },
        ],
      },
    });
    mocks.routeParams.id = market.id;
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
    vi.mocked(fetchMarketPriceHistory).mockResolvedValue({
      conditionId: market.id,
      timeframe: "7d",
      snapshotEventOrder: buyTrade.eventOrder,
      asOf: "2026-09-27T16:40:00Z",
      outcomes: [
        {
          outcomeId: "Yes",
          data: [
            {
              timestamp: buyTrade.executedAt,
              eventOrder: buyTrade.eventOrder,
              price: buyTrade.priceTick,
              volumeSubunits: buyTrade.faceAmountSubunits,
              source: "fill",
            },
          ],
        },
      ],
    });
    const view = render(<MarketDetailPage />);

    try {
      await screen.findByRole("heading", { name: "Will it happen?" });
      await waitFor(() =>
        expect(mocks.signalr.connection.invoke).toHaveBeenCalledWith(
          "JoinMarket",
          `${market.id}-Yes`,
        ),
      );
      expect(mocks.signalr.connection.invoke).toHaveBeenCalledWith("JoinMarket", `${market.id}-No`);
      expect(screen.getByTestId("chart-latest-price")).toHaveTextContent("51.00%");
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("51.00%");
      expect(screen.getByTestId("chart-headline")).toHaveTextContent("51.0%");

      const confirmedTradeRecorded = mocks.signalr.registeredHandlers.get("ConfirmedTradeRecorded");
      expect(confirmedTradeRecorded).toBeDefined();
      const sellTrade: LatestConfirmedTrade = {
        primitiveOutcomeId: "No",
        fillId: "00000000-0000-0000-0000-000000000002",
        executedAt: "2026-09-27T16:39:16.998Z",
        eventOrder: "0002",
        priceTick: 510,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      };
      const confirmedHistoryResponse = {
        snapshotEventOrder: "0002",
        asOf: "2026-09-27T16:40:00Z",
        conditionId: market.id,
        timeframe: "7d",
        outcomes: [
          {
            outcomeId: "No",
            data: [
              {
                timestamp: sellTrade.executedAt,
                eventOrder: sellTrade.eventOrder,
                price: sellTrade.priceTick,
                volumeSubunits: sellTrade.faceAmountSubunits,
                source: "fill",
              },
            ],
          },
        ],
      } satisfies Awaited<ReturnType<typeof fetchMarketPriceHistory>>;
      let resolveHistory!: (response: typeof confirmedHistoryResponse) => void;
      vi.mocked(fetchMarketDetail).mockResolvedValue(market);
      vi.mocked(fetchMarketPriceHistory).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          }),
      );
      // This is the camel-case SignalR form of ConfirmedTradeNotificationPublisher.ToMessage.
      act(() =>
        confirmedTradeRecorded?.({
          conditionId: market.id,
          latestConfirmedTrade: sellTrade,
        }),
      );

      await waitFor(() => {
        expect(screen.getByTestId("chart-latest-price")).toHaveTextContent("51.00%");
        expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("51.00%");
        expect(screen.getByTestId("chart-headline")).toHaveTextContent("49.0%");
        expect(resolveHistory).toBeDefined();
      });
      await act(async () => {
        resolveHistory(confirmedHistoryResponse);
      });
      await waitFor(() => {
        expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("49.00%");
        expect(screen.getByTestId("chart-headline")).toHaveTextContent("49.0%");
      });
    } finally {
      view.unmount();
      await actualHub.disconnect();
      mocks.signalr.registeredHandlers.clear();
      vi.mocked(joinMarket).mockResolvedValue(undefined);
      vi.mocked(onConfirmedTradeRecorded).mockImplementation((_conditionId, handler) => {
        mocks.confirmedTradeHandlers.push(handler);
        return () => {
          const index = mocks.confirmedTradeHandlers.indexOf(handler);
          if (index >= 0) mocks.confirmedTradeHandlers.splice(index, 1);
        };
      });
    }
  });

  it.each([
    { buyPrice: 510, sellPrice: 510, expectedYesPrice: "49.00%", expectedHeadline: "49.0%" },
    { buyPrice: 490, sellPrice: 490, expectedYesPrice: "51.00%", expectedHeadline: "51.0%" },
  ])(
    "cold-mounts a full canonical binary snapshot and 7d history on the YES basis (%#)",
    async ({ buyPrice, sellPrice, expectedYesPrice, expectedHeadline }) => {
      const actualMarkets = await vi.importActual<typeof import("@/lib/markets")>("@/lib/markets");
      const conditionId = `cold-binary-${sellPrice}`;
      const buyExecutedAt = "2026-09-27T20:03:00.000Z";
      const sellExecutedAt = "2026-09-27T20:04:41.774Z";
      const buyTrade: LatestConfirmedTrade = {
        primitiveOutcomeId: "Yes",
        fillId: "00000000-0000-0000-0000-000000000101",
        executedAt: buyExecutedAt,
        eventOrder: "0001",
        priceTick: buyPrice,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      };
      const sellTrade: LatestConfirmedTrade = {
        primitiveOutcomeId: "No",
        fillId: "00000000-0000-0000-0000-000000000102",
        executedAt: sellExecutedAt,
        eventOrder: "0002",
        priceTick: sellPrice,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      };
      const catalogueEntry: MarketCatalogueEntry = {
        conditionId,
        outcomes: ["Yes", "No"],
        title: "Will it happen?",
        state: "open",
        createdAt: "2026-09-27T20:00:00.000Z",
        volume24hSubunits: 2_000,
        volume30dSubunits: 2_000,
        liquiditySubunits: 0,
        ammBotBudgetSubunits: 0,
        fundingRevision: null,
        volumeLifetimeSubunits: 2_000,
        baseAsset: "sat",
        divisibility: 1_000,
        // The public snapshot is in canonical primitive-outcome order.
        latestConfirmedTrades: [sellTrade, buyTrade],
        categoryTags: [],
        lastSuccessfulRefreshAt: sellExecutedAt,
      };
      const historyResponse: MarketPriceHistoryResponse = {
        snapshotEventOrder: "opaque-cut",
        asOf: "2026-09-27T20:00:00Z",
        conditionId,
        timeframe: "7d",
        outcomes: [
          {
            outcomeId: "No",
            data: [
              {
                timestamp: sellExecutedAt,
                eventOrder: sellTrade.eventOrder,
                price: sellPrice,
                volumeSubunits: sellTrade.faceAmountSubunits,
                source: "fill",
              },
            ],
          },
          {
            outcomeId: "Yes",
            data: [
              {
                timestamp: buyExecutedAt,
                eventOrder: buyTrade.eventOrder,
                price: buyPrice,
                volumeSubunits: buyTrade.faceAmountSubunits,
                source: "fill",
              },
            ],
          },
        ],
      };
      const fetchStub = vi.fn((input: RequestInfo | URL) => {
        const url = new URL(input.toString(), window.location.origin);
        if (url.pathname === "/api/v1/markets/query") {
          return Promise.resolve(
            new Response(JSON.stringify({ markets: [catalogueEntry] }), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.pathname === `/api/v1/markets/${conditionId}/price-history`) {
          return Promise.resolve(
            new Response(JSON.stringify(historyResponse), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });

      vi.stubGlobal("fetch", fetchStub);
      vi.mocked(fetchMarketDetail).mockImplementation(actualMarkets.fetchMarketDetail);
      vi.mocked(fetchMarketPriceHistory).mockImplementation(actualMarkets.fetchMarketPriceHistory);
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
      mocks.routeParams.id = conditionId;
      const view = render(<MarketDetailPage />);

      try {
        await screen.findByRole("heading", { name: "Will it happen?" });
        await waitFor(() => {
          expect(screen.getByTestId("chart-latest-price")).toHaveTextContent(expectedYesPrice);
          expect(screen.getByTestId("latest-price-pill")).toHaveTextContent(expectedYesPrice);
          expect(screen.getByTestId("chart-headline")).toHaveTextContent(expectedHeadline);
        });
        expect(fetchStub.mock.calls.map(([input]) => String(input))).toContain(
          `${window.location.origin}/api/v1/markets/${conditionId}/price-history?timeframe=7d&refresh=true`,
        );
      } finally {
        view.unmount();
        vi.unstubAllGlobals();
      }
    },
  );

  it("applies a MarketStatusChanged close push to the detail page and removes trading", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));

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
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-tab-buy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-tab-sell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-tab-liquidity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("confirm-amm-funding")).not.toBeInTheDocument();
  });

  it("replaces an empty trade preview with Liquidity after all route books load", async () => {
    let resolveBooks!: (book: OrderBook) => void;
    const books = new Promise<OrderBook>((resolve) => {
      resolveBooks = resolve;
    });
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket());
    vi.mocked(fetchOrderBook).mockReturnValue(books);
    mocks.previewFokOrderCapacity.mockResolvedValue({
      status: "ready",
      referencePrice: null,
      effectiveLimitPrice: null,
      maxFaceAmountSubunits: 0,
      quotePaymentSubunits: 0,
      worstPrice: null,
      priceDenominator: 1_000,
      previewRevision: "empty-book",
    });
    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getByTestId("trade-outcome-yes"));
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
    await waitFor(() => expect(mocks.previewFokOrderCapacity).toHaveBeenCalled());

    await act(async () => {
      resolveBooks(emptyBook);
    });

    expect(await screen.findByTestId("empty-trade-liquidity")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-trade-bar")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking the current market preview...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-liquidity-tab"));
    expect(screen.getByTestId("trade-tab-liquidity")).toHaveAttribute("aria-selected", "true");
  });

  it("does not call a market empty when its route book requests fail", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket());
    vi.mocked(fetchOrderBook).mockRejectedValue(new Error("Book unavailable"));
    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    await waitFor(() => expect(fetchOrderBook).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeInTheDocument();
  });

  it("keeps capacity requests independent from amount and Sell holdings", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://sell-holdings-a.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    const view = render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(mocks.previewFokOrderCapacity.mock.calls.at(-1)?.[0].price).toBe(999),
    );
    expect(screen.queryByTestId("trade-capacity-available")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-capacity-status")).not.toBeInTheDocument();
    const capacityCallsAfterBuy = mocks.previewFokOrderCapacity.mock.calls.length;

    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "2" },
    });
    await waitFor(() =>
      expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ faceAmountSubunits: 2_000 }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(mocks.previewFokOrderCapacity).toHaveBeenCalledTimes(capacityCallsAfterBuy);

    fireEvent.click(screen.getByTestId("trade-tab-sell"));
    await waitFor(() =>
      expect(mocks.previewFokOrderCapacity.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ side: "Sell" }),
      ),
    );
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() => expect(mocks.previewFokOrderCapacity.mock.calls.at(-1)?.[0].price).toBe(1));
    const capacityCallsAfterSellSelection = mocks.previewFokOrderCapacity.mock.calls.length;
    expect(Object.keys(mocks.previewFokOrderCapacity.mock.calls.at(-1)![0]).sort()).toEqual([
      "marketId",
      "price",
      "side",
      "tokenSide",
    ]);

    mocks.sellHoldingsByOutcomeSet.set("Yes", { selectableSubunits: 2_000, reservedSubunits: 0 });
    mocks.walletState.activeMintUrl = "https://sell-holdings-b.example";
    view.rerender(<MarketDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("trade-outcome-yes-availability")).toHaveTextContent(
        "You have 2 shares",
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(mocks.previewFokOrderCapacity).toHaveBeenCalledTimes(capacityCallsAfterSellSelection);
  });

  it.each([
    {
      side: "Buy",
      selection: "yes",
      tokenSide: "Outcome",
      discoveryPrice: 999,
      payment: 400,
      worstPrice: 500,
    },
    {
      side: "Buy",
      selection: "no",
      tokenSide: "Complement",
      discoveryPrice: 999,
      payment: 450,
      worstPrice: 700,
    },
    {
      side: "Sell",
      selection: "yes",
      tokenSide: "Outcome",
      discoveryPrice: 1,
      payment: 400,
      worstPrice: 300,
    },
    {
      side: "Sell",
      selection: "no",
      tokenSide: "Complement",
      discoveryPrice: 1,
      payment: 450,
      worstPrice: 250,
    },
  ] as const)(
    "discovers the full range and submits accepted $side $tokenSide terms",
    async ({ side, selection, tokenSide, discoveryPrice, payment, worstPrice }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      mocks.previewFokOrder.mockResolvedValue({
        ...fillablePreview(),
        quotePaymentSubunits: payment,
        worstPrice,
        averagePrice: payment,
      });
      vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
      vi.mocked(fetchOrderBook).mockResolvedValue(book(400));
      mockAcceptedOrder();
      render(<MarketDetailPage />);
      await screen.findByRole("heading", { name: "Will it happen?" });
      if (side === "Sell") fireEvent.click(screen.getByTestId("trade-tab-sell"));
      await waitFor(() => expect(screen.getByTestId(`trade-outcome-${selection}`)).toBeEnabled());
      fireEvent.click(screen.getByTestId(`trade-outcome-${selection}`));
      fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
      await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
      expect(mocks.previewFokOrderCapacity.mock.calls.at(-1)?.[0]).toEqual({
        marketId: "condition-yesno-Yes",
        side,
        tokenSide,
        price: discoveryPrice,
      });
      expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual({
        marketId: "condition-yesno-Yes",
        side,
        tokenSide,
        price: discoveryPrice,
        faceAmountSubunits: 1_000,
      });
      expect(screen.queryByTestId("trade-price-protection-toggle")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("trade-confirm"));
      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: {
            marketId: "condition-yesno-Yes",
            request: {
              outcomeId: "Yes",
              side,
              tokenSide,
              price: worstPrice,
              amountSubunits: 1_000,
              timeInForce: "FOK",
              maxQuotePaymentSubunits: side === "Buy" ? payment : null,
              minQuotePaymentSubunits: side === "Sell" ? payment : null,
            },
          },
          consentedFeeFacts: rangeFeeFacts(),
        }),
      );
    },
  );

  it("subscribes before joining and keeps a live funding observation over stale REST", async () => {
    const initial = yesNoMarket({ ammBotBudgetSubunits: 1_000, fundingRevision: "0001" });
    const staleRest = yesNoMarket({ ammBotBudgetSubunits: 5_000, fundingRevision: "0001" });
    vi.mocked(fetchMarketDetail).mockResolvedValueOnce(initial).mockResolvedValue(staleRest);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });

    await waitFor(() =>
      expect(mocks.fundingHandlers.some(({ conditionId }) => conditionId === initial.id)).toBe(
        true,
      ),
    );
    const registration = mocks.fundingHandlers.find(
      ({ conditionId }) => conditionId === initial.id,
    );
    expect(registration).toBeDefined();
    expect(onMarketFundingUpdated).toHaveBeenCalledWith(initial.id, expect.any(Function));
    expect(vi.mocked(onMarketFundingUpdated).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(joinMarket).mock.invocationCallOrder[0]!,
    );

    const budgetTexts = () =>
      screen.getAllByTestId("market-bot-budget").map((element) => element.textContent);
    expect(budgetTexts()).toEqual(expect.arrayContaining([expect.stringContaining("1 sats")]));
    act(() =>
      registration!.handler({
        conditionId: "another-condition",
        ammBotBudgetSubunits: 99_000,
        fundingRevision: "0009",
      }),
    );
    expect(budgetTexts()).toEqual(expect.arrayContaining([expect.stringContaining("1 sats")]));

    act(() =>
      registration!.handler({
        conditionId: initial.id,
        ammBotBudgetSubunits: 20_000,
        fundingRevision: "0002",
      }),
    );
    await waitFor(() =>
      expect(budgetTexts()).toEqual(expect.arrayContaining([expect.stringContaining("20 sats")])),
    );
    expect(refreshMarketSnapshot).not.toHaveBeenCalled();

    act(() => mocks.liveStatusHandlers.at(-1)?.({ conditionId: initial.id, state: "open" }));
    await waitFor(() => expect(fetchMarketDetail).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(budgetTexts()).toEqual(expect.arrayContaining([expect.stringContaining("20 sats")])),
    );
    expect(refreshMarketSnapshot).not.toHaveBeenCalled();
  });

  it("ignores a funding handler retained from the previous route", async () => {
    const initial = yesNoMarket({ ammBotBudgetSubunits: 1_000, fundingRevision: "0001" });
    const next = yesNoMarket({
      id: "condition-other",
      title: "Other market",
      ammBotBudgetSubunits: 2_000,
      fundingRevision: "0001",
    });
    vi.mocked(fetchMarketDetail).mockResolvedValueOnce(initial).mockResolvedValueOnce(next);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    const view = render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    const oldHandler = mocks.fundingHandlers.find(
      ({ conditionId }) => conditionId === initial.id,
    )!.handler;

    mocks.routeParams.id = next.id;
    view.rerender(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Other market" });
    act(() =>
      oldHandler({
        conditionId: initial.id,
        ammBotBudgetSubunits: 90_000,
        fundingRevision: "0009",
      }),
    );

    expect(screen.getAllByTestId("market-bot-budget").map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("2 sats")]),
    );
  });

  it("refreshes joined outcome snapshots after an explicit credit without a notification loop", async () => {
    const market = yesNoMarket({ ammBotBudgetSubunits: 0, fundingRevision: null });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
    mocks.executeMarketFundingDelivery.mockResolvedValue({
      progress: "credited",
      transfer: { transferId: "payment-2", requestedAmount: "1000" },
    });
    vi.mocked(refreshMarketSnapshot).mockImplementation(async () => {
      const observation = {
        conditionId: market.id,
        ammBotBudgetSubunits: 15_000,
        fundingRevision: "0001",
      };
      for (const registration of mocks.fundingHandlers) registration.handler(observation);
    });

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-tab-liquidity")[0]!);
    const amountInput = await screen.findByTestId("amm-funding-custom-budget");
    await waitFor(() => expect(amountInput).toBeEnabled());
    fireEvent.change(amountInput, { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => expect(refreshMarketSnapshot).toHaveBeenCalledTimes(2));
    expect(vi.mocked(refreshMarketSnapshot).mock.calls.map(([marketId]) => marketId)).toEqual(
      expect.arrayContaining(["condition-yesno-Yes", "condition-yesno-No"]),
    );
    expect(screen.getAllByTestId("market-bot-budget").map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("15 sats")]),
    );
    expect(refreshMarketSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not repeat detail or order-book requests when the deadline is null", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchMarketDetail).mockResolvedValue(
        yesNoMarket({ state: "open", closingDate: null }),
      );
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      render(<MarketDetailPage />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("heading", { name: "Will it happen?" })).toBeInTheDocument();
      expect(fetchMarketDetail).toHaveBeenCalledOnce();
      expect(fetchOrderBook).toHaveBeenCalledTimes(2);
      expect(fetchOrderBook).toHaveBeenNthCalledWith(1, "condition-yesno-Yes");
      expect(fetchOrderBook).toHaveBeenNthCalledWith(2, "condition-yesno-No");
      const detailCalls = vi.mocked(fetchMarketDetail).mock.calls.length;
      const orderBookCalls = vi.mocked(fetchOrderBook).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(fetchMarketDetail).toHaveBeenCalledTimes(detailCalls);
      expect(fetchOrderBook).toHaveBeenCalledTimes(orderBookCalls);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reloads chart history for a new confirmed trade but not its duplicate", async () => {
    const market = categoricalMarket() as CategoricalMarketDetail;
    market.registeredPrimitiveOutcomeIds = ["outcome-0", "outcome-1", "outcome-2"];
    market.latestConfirmedTrades = [];
    market.latestConfirmedTradesValid = true;
    mocks.routeParams.id = market.id;
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Winner" });
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.confirmedTradeHandlers.length).toBeGreaterThan(0));
    const message: { conditionId: string; latestConfirmedTrade: LatestConfirmedTrade } = {
      conditionId: market.id,
      latestConfirmedTrade: {
        primitiveOutcomeId: "outcome-1",
        fillId: "00000000-0000-0000-0000-000000000033",
        executedAt: "2026-08-18T00:00:02Z",
        eventOrder: "0004",
        priceTick: 500,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      },
    };
    act(() => mocks.confirmedTradeHandlers.forEach((handler) => handler(message)));
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2));
    await act(async () => mocks.confirmedTradeHandlers.forEach((handler) => handler(message)));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2);
  });

  it("coalesces source changes before application and refreshes a late comment and unchanged-price reconnect", async () => {
    const market = yesNoMarket();
    const initialHistory: MarketPriceHistoryResponse = {
      conditionId: market.id,
      timeframe: "7d",
      snapshotEventOrder: "opaque-old",
      asOf: "2026-09-27T17:00:00Z",
      outcomes: [
        {
          outcomeId: "Yes",
          data: [
            {
              eventOrder: "opaque-old",
              timestamp: "2026-09-27T16:00:00Z",
              price: 400,
              volumeSubunits: 1000,
              source: "fill",
            },
          ],
        },
      ],
    };
    const latestHistory = {
      ...initialHistory,
      snapshotEventOrder: "opaque-new",
      outcomes: [
        { outcomeId: "Yes", data: [{ ...initialHistory.outcomes[0].data[0], price: 620 }] },
      ],
    };
    let finishHistory!: (response: MarketPriceHistoryResponse) => void;
    let finishComments!: (response: Awaited<ReturnType<typeof fetchMarketComments>>) => void;
    vi.mocked(fetchMarketPriceHistory)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishHistory = resolve;
          }),
      )
      .mockResolvedValue(latestHistory);
    vi.mocked(fetchMarketComments)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishComments = resolve;
          }),
      )
      .mockResolvedValue({
        conditionId: market.id,
        snapshotEventOrder: "opaque-new",
        comments: [],
      });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
    const view = render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(1));
    const trade: LatestConfirmedTrade = {
      primitiveOutcomeId: "YES",
      fillId: "00000000-0000-0000-0000-000000000031",
      executedAt: "2026-09-27T16:00:00Z",
      eventOrder: "opaque-new",
      priceTick: 620,
      divisibility: 1000,
      faceAmountSubunits: 1000,
    };
    act(() => {
      for (let index = 0; index < 20; index += 1) {
        for (const handler of mocks.confirmedTradeHandlers)
          handler({
            conditionId: market.id,
            latestConfirmedTrade: { ...trade, eventOrder: `opaque-${index}` },
          });
      }
      for (const handler of mocks.commentHandlers)
        handler({ conditionId: market.id, eventOrder: "late-comment-source" });
    });
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(1);
    expect(fetchMarketComments).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishHistory(initialHistory);
      finishComments({ conditionId: market.id, snapshotEventOrder: "opaque-old", comments: [] });
    });
    await waitFor(() =>
      expect(screen.getByTestId("chart-latest-price")).toHaveTextContent("62.00%"),
    );
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2);
    expect(fetchMarketComments).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchMarketPriceHistory).mock.calls[1][2]).toMatchObject({
      minimumEventOrder: "opaque-19",
      refresh: true,
    });
    expect(vi.mocked(fetchMarketComments).mock.calls[1][1]).toMatchObject({
      minimumEventOrder: "late-comment-source",
      refresh: true,
    });
    vi.mocked(fetchMarketComments).mockResolvedValue({
      conditionId: market.id,
      snapshotEventOrder: "late",
      comments: [
        {
          commentId: "late",
          authorPubkey: "a".repeat(64),
          content: "late confirmed comment",
          createdAt: "2026-09-27T17:00:00Z",
          trade: null,
        },
      ],
    });
    await act(async () =>
      mocks.commentHandlers.forEach((handler) =>
        handler({
          conditionId: market.id,
          eventOrder: "late",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chart-comments")).toHaveTextContent("late confirmed comment"),
    );
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2);
    vi.mocked(fetchMarketPriceHistory).mockRejectedValue(new Error("503"));
    vi.mocked(fetchMarketComments).mockRejectedValue(new Error("503"));
    await act(async () => mocks.rejoinHandlers.forEach((handler) => handler()));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3);
    expect(fetchMarketComments).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("chart-latest-price")).toHaveTextContent("62.00%");
    expect(screen.getByTestId("chart-comments")).toHaveTextContent("late confirmed comment");
    const options = vi.mocked(fetchMarketPriceHistory).mock.calls[2][2];
    expect(options).toMatchObject({ refresh: true });
    expect(options?.minimumEventOrder).toBeUndefined();
    view.unmount();
    expect(options?.signal?.aborted).toBe(true);
    expect(mocks.commentHandlers).toHaveLength(0);
    expect(mocks.confirmedTradeHandlers).toHaveLength(0);
    expect(mocks.rejoinHandlers).toHaveLength(0);
  });

  it("discards old timeframe and route responses and clears omitted categorical outcomes", async () => {
    const market = categoricalMarket() as CategoricalMarketDetail;
    mocks.routeParams.id = market.id;
    const response = (
      timeframe: PriceHistory["timeframe"],
      price: number,
    ): MarketPriceHistoryResponse => ({
      conditionId: market.id,
      timeframe,
      snapshotEventOrder: "opaque",
      asOf: "2026-09-27T17:00:00Z",
      outcomes: [
        {
          outcomeId: "Alice",
          data: [
            {
              eventOrder: "opaque",
              timestamp: "2026-09-27T16:00:00Z",
              price,
              volumeSubunits: 1000,
              source: "fill",
            },
          ],
        },
      ],
    });
    let finishOld!: (response: MarketPriceHistoryResponse) => void;
    vi.mocked(fetchMarketPriceHistory)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementation(async (_id, timeframe) => response(timeframe ?? "7d", 620));
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);
    const view = render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Winner" });
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "snapshot-all" }));
    await waitFor(() =>
      expect(screen.getByTestId("chart-snapshot")).toHaveTextContent('"price":62'),
    );
    await act(async () => finishOld(response("7d", 400)));
    expect(screen.getByTestId("chart-snapshot")).not.toHaveTextContent('"price":40');
    expect(screen.getByTestId("chart-snapshot")).toHaveTextContent('"Bob":{"timeframe":"all"');
    expect(screen.getByTestId("chart-snapshot")).toHaveTextContent('"data":[]');
    let finishRoute!: (response: MarketPriceHistoryResponse) => void;
    vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRoute = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "snapshot-24h" }));
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3));
    mocks.routeParams.id = "condition-other";
    vi.mocked(fetchMarketDetail).mockResolvedValue(
      yesNoMarket({ id: "condition-other", title: "Other route" }),
    );
    view.rerender(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Other route" });
    await act(async () => finishRoute(response("24h", 400)));
    expect(screen.getByTestId("chart-snapshot")).not.toHaveTextContent('"price":40');
    view.unmount();
  });

  it("refreshes market volume for coalesced confirmed fills on the active condition", async () => {
    vi.useFakeTimers();
    try {
      const market = categoricalMarket() as CategoricalMarketDetail;
      market.registeredPrimitiveOutcomeIds = ["outcome-0", "outcome-1", "outcome-2"];
      market.latestConfirmedTrades = [];
      market.latestConfirmedTradesValid = true;
      mocks.routeParams.id = market.id;
      const firstTrade: LatestConfirmedTrade = {
        primitiveOutcomeId: "outcome-0",
        fillId: "00000000-0000-0000-0000-000000000034",
        executedAt: "2026-08-18T00:00:03Z",
        eventOrder: "0005",
        priceTick: 510,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      };
      const secondTrade: LatestConfirmedTrade = {
        primitiveOutcomeId: "outcome-1",
        fillId: "00000000-0000-0000-0000-000000000035",
        executedAt: "2026-08-18T00:00:04Z",
        eventOrder: "0006",
        priceTick: 520,
        divisibility: 1_000,
        faceAmountSubunits: 1_000,
      };
      vi.mocked(fetchMarketDetail)
        .mockResolvedValueOnce(market)
        .mockResolvedValue({
          ...market,
          volume: 2_000,
          volumeLifetimeSubunits: 2_000,
          latestConfirmedTrades: [firstTrade, secondTrade],
        });
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      render(<MarketDetailPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("heading", { name: "Winner" })).toBeInTheDocument();
      expect(mocks.confirmedTradeHandlers.length).toBeGreaterThan(0);
      expect(fetchMarketDetail).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /^Volume:\s*0 sats$/ })).toBeInTheDocument();

      const handler = (message: {
        conditionId: string;
        latestConfirmedTrade: LatestConfirmedTrade;
      }) => mocks.confirmedTradeHandlers.forEach((callback) => callback(message));
      act(() => {
        handler?.({ conditionId: market.id, latestConfirmedTrade: firstTrade });
        handler?.({ conditionId: market.id, latestConfirmedTrade: secondTrade });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: /^Volume:\s*2 sats$/ })).toBeInTheDocument();

      act(() => handler?.({ conditionId: "another-condition", latestConfirmedTrade: firstTrade }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("invalidates preview when a non-last categorical outcome receives a newer trade", async () => {
    const aliceTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "outcome-0",
      fillId: "00000000-0000-0000-0000-000000000031",
      executedAt: "2026-08-18T00:00:00Z",
      eventOrder: "0001",
      priceTick: 400,
      divisibility: 1_000,
      faceAmountSubunits: 1_000,
    };
    const carolTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "outcome-2",
      fillId: "00000000-0000-0000-0000-000000000032",
      executedAt: "2026-08-18T00:00:01Z",
      eventOrder: "0003",
      priceTick: 600,
      divisibility: 1_000,
      faceAmountSubunits: 1_000,
    };
    const bobTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "outcome-1",
      fillId: "00000000-0000-0000-0000-000000000033",
      executedAt: "2026-08-18T00:00:02Z",
      eventOrder: "0004",
      priceTick: 500,
      divisibility: 1_000,
      faceAmountSubunits: 1_000,
    };
    const market = categoricalMarket() as CategoricalMarketDetail;
    market.registeredPrimitiveOutcomeIds = ["outcome-0", "outcome-1", "outcome-2"];
    market.latestConfirmedTrades = [aliceTrade, carolTrade];
    market.latestConfirmedTradesValid = true;
    mocks.routeParams.id = market.id;
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Winner" });
    fireEvent.click(screen.getByTestId("buy-yes-Alice"));
    fireEvent.change(screen.getByTestId("trade-amount-input"), {
      target: { value: "1" },
    });
    await screen.findByTestId("fok-preview-ready");
    await waitFor(() => expect(mocks.confirmedTradeHandlers.length).toBeGreaterThan(0));
    const callsBeforeTrade = mocks.previewFokOrder.mock.calls.length;

    act(() => {
      mocks.confirmedTradeHandlers[0]?.({
        conditionId: market.id,
        latestConfirmedTrade: bobTrade,
      });
    });

    await waitFor(() =>
      expect(mocks.previewFokOrder.mock.calls.length).toBeGreaterThan(callsBeforeTrade),
    );
    expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ marketId: "condition-1-Alice" }),
    );
  });

  it("coalesces rapid trade-term edits into the final preview request", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    const amountInput = screen.getAllByTestId("trade-amount-input")[0];
    fireEvent.change(amountInput, { target: { value: "1" } });
    fireEvent.change(amountInput, { target: { value: "2" } });
    fireEvent.change(amountInput, { target: { value: "3" } });

    await waitFor(() => expect(mocks.previewFokOrder).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
    });
    expect(mocks.previewFokOrder.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ faceAmountSubunits: 3_000 }),
    );
  });

  it("coalesces a burst of live order-book updates into one preview", async () => {
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await screen.findByTestId("fok-preview-ready");
    await waitFor(() => expect(mocks.orderBookHandlers.has("condition-yesno-Yes")).toBe(true));
    const callsBeforeUpdates = mocks.previewFokOrder.mock.calls.length;
    const update = mocks.orderBookHandlers.get("condition-yesno-Yes");

    for (const price of [410, 420, 430]) {
      await act(async () => {
        update?.({
          marketId: "condition-yesno-Yes",
          bids: [],
          asks: [{ price, amount: 100 }],
          spread: null,
        });
      });
    }

    await waitFor(() =>
      expect(mocks.previewFokOrder).toHaveBeenCalledTimes(callsBeforeUpdates + 1),
    );
    expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ marketId: "condition-yesno-Yes" }),
    );
  });

  it("does not start a second automatic preview while final submission is pending", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await screen.findByTestId("fok-preview-ready");
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    const callsBeforeSubmit = mocks.previewFokOrder.mock.calls.length;
    let resolveFinalPreview!: (response: ReturnType<typeof fillablePreview>) => void;
    const finalPreview = new Promise<ReturnType<typeof fillablePreview>>((resolve) => {
      resolveFinalPreview = resolve;
    });
    mocks.previewFokOrder.mockReturnValue(finalPreview);

    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
    await waitFor(() => expect(mocks.previewFokOrder).toHaveBeenCalledTimes(callsBeforeSubmit + 1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mocks.previewFokOrder).toHaveBeenCalledTimes(callsBeforeSubmit + 1);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();

    await act(async () => {
      resolveFinalPreview(fillablePreview());
    });
    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
  });

  it("keeps the current route market when an earlier detail request completes late", async () => {
    let resolveA!: (market: MarketDetail) => void;
    let resolveB!: (market: MarketDetail) => void;
    const requestA = new Promise<MarketDetail>((resolve) => {
      resolveA = resolve;
    });
    const requestB = new Promise<MarketDetail>((resolve) => {
      resolveB = resolve;
    });
    vi.mocked(fetchMarketDetail).mockImplementation((conditionId) => {
      if (conditionId === "condition-yesno") return requestA;
      return requestB;
    });
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    const view = render(<MarketDetailPage />);
    await waitFor(() =>
      expect(vi.mocked(fetchMarketDetail)).toHaveBeenCalledWith("condition-yesno"),
    );

    mocks.routeParams.id = "condition-other";
    view.rerender(<MarketDetailPage />);
    expect(screen.getByText("Loading market...")).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(fetchMarketDetail)).toHaveBeenCalledWith("condition-other"),
    );

    resolveB(yesNoMarket({ id: "condition-other", title: "Market B" }));
    expect(await screen.findByRole("heading", { name: "Market B" })).toBeInTheDocument();

    resolveA(yesNoMarket({ id: "condition-yesno", title: "Market A" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Market B" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "Market A" })).not.toBeInTheDocument();
  });

  it("shows temporary service unavailability instead of a missing-market or mint error", async () => {
    vi.mocked(fetchMarketDetail).mockRejectedValue(new MarketDetailUnavailableError());
    render(<MarketDetailPage />);
    expect(
      await screen.findByText(
        "Market details are temporarily unavailable. Please try again later.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Market not found")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load market. Please check that the mint is running."),
    ).not.toBeInTheDocument();
    expect(fetchOrderBook).not.toHaveBeenCalled();
  });

  it("recovers from an initial detail projection miss without manual retry", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchMarketDetail)
        .mockRejectedValueOnce(new Error("detail projection is still catching up"))
        .mockResolvedValueOnce(yesNoMarket({ title: "Recovered market" }));
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      render(<MarketDetailPage />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByText("Failed to load market. Please check that the mint is running."),
      ).toBeInTheDocument();
      expect(fetchMarketDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(screen.getByRole("heading", { name: "Recovered market" })).toBeInTheDocument();
      expect(
        screen.queryByText("Failed to load market. Please check that the mint is running."),
      ).not.toBeInTheDocument();
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recovers after 39 temporary detail failures without overlapping requests", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.mocked(fetchMarketDetail).mockImplementation(() => {
        calls += 1;
        return calls <= 39
          ? Promise.reject(new MarketDetailUnavailableError())
          : Promise.resolve(yesNoMarket({ title: "Recovered market" }));
      });
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      render(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByText("Market details are temporarily unavailable. Please try again later."),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(78_000);
      });

      expect(screen.getByRole("heading", { name: "Recovered market" })).toBeInTheDocument();
      expect(fetchMarketDetail).toHaveBeenCalledTimes(40);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps manual Retry serial with an in-flight automatic retry", async () => {
    vi.useFakeTimers();
    try {
      let resolveRetry!: (detail: MarketDetail) => void;
      const pendingRetry = new Promise<MarketDetail>((resolve) => {
        resolveRetry = resolve;
      });
      vi.mocked(fetchMarketDetail)
        .mockRejectedValueOnce(new MarketDetailUnavailableError())
        .mockImplementationOnce(() => pendingRetry);
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      render(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRetry(yesNoMarket({ title: "Recovered market", state: "open" }));
        await Promise.resolve();
      });
      expect(screen.getByRole("heading", { name: "Recovered market" })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not start an automatic retry after its elapsed-time deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchMarketDetail).mockRejectedValue(new MarketDetailUnavailableError());
      render(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 95_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the short retry bound for a permanent detail error", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchMarketDetail).mockRejectedValue(new Error("market is missing"));
      render(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(fetchMarketDetail).toHaveBeenCalledTimes(6);
      expect(
        screen.getByText("Failed to load market. Please check that the mint is running."),
      ).toBeInTheDocument();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not retry a stale route after navigation", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchMarketDetail).mockImplementation((conditionId) =>
        conditionId === "condition-yesno"
          ? Promise.reject(new Error("detail projection is still catching up"))
          : Promise.resolve(yesNoMarket({ id: "condition-other", title: "Other market" })),
      );
      vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

      const view = render(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByText("Failed to load market. Please check that the mint is running."),
      ).toBeInTheDocument();

      mocks.routeParams.id = "condition-other";
      view.rerender(<MarketDetailPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("heading", { name: "Other market" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      const detailCalls = vi.mocked(fetchMarketDetail).mock.calls;
      expect(detailCalls.filter(([conditionId]) => conditionId === "condition-yesno")).toEqual([
        ["condition-yesno"],
      ]);
      expect(detailCalls.slice(1).every(([conditionId]) => conditionId === "condition-other")).toBe(
        true,
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the newest same-route refresh when an older refresh completes late", async () => {
    let resolveOld!: (market: MarketDetail) => void;
    let resolveNewest!: (market: MarketDetail) => void;
    const oldRequest = new Promise<MarketDetail>((resolve) => {
      resolveOld = resolve;
    });
    const newestRequest = new Promise<MarketDetail>((resolve) => {
      resolveNewest = resolve;
    });
    let detailRequestCount = 0;
    vi.mocked(fetchMarketDetail).mockImplementation(() => {
      detailRequestCount += 1;
      if (detailRequestCount === 1)
        return Promise.resolve(yesNoMarket({ title: "Initial market" }));
      if (detailRequestCount === 2) return oldRequest;
      return newestRequest;
    });
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);
    expect(await screen.findByRole("heading", { name: "Initial market" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.liveStatusHandlers.length).toBeGreaterThan(0));

    act(() => {
      mocks.liveStatusHandlers.at(-1)?.({
        conditionId: "condition-yesno",
        state: "open",
      });
    });
    await waitFor(() => expect(vi.mocked(fetchMarketDetail)).toHaveBeenCalledTimes(2));

    act(() => {
      mocks.liveStatusHandlers.at(-1)?.({
        conditionId: "condition-yesno",
        state: "open",
      });
    });
    await waitFor(() => expect(vi.mocked(fetchMarketDetail)).toHaveBeenCalledTimes(3));

    resolveNewest(yesNoMarket({ title: "Newest market" }));
    expect(await screen.findByRole("heading", { name: "Newest market" })).toBeInTheDocument();

    resolveOld(yesNoMarket({ title: "Old market" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Newest market" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "Old market" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load market. Please check that the mint is running."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Loading market...")).not.toBeInTheDocument();
  });

  it("preserves a loaded page when an optional background refresh fails", async () => {
    vi.mocked(fetchMarketDetail)
      .mockResolvedValueOnce(yesNoMarket({ title: "Loaded market" }))
      .mockRejectedValueOnce(new Error("temporary refresh failure"));
    vi.mocked(fetchOrderBook).mockResolvedValue(emptyBook);

    render(<MarketDetailPage />);
    expect(await screen.findByRole("heading", { name: "Loaded market" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.liveStatusHandlers.length).toBeGreaterThan(0));

    act(() => {
      mocks.liveStatusHandlers.at(-1)?.({
        conditionId: "condition-yesno",
        state: "open",
      });
    });

    await waitFor(() => expect(vi.mocked(fetchMarketDetail)).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Loaded market" })).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load market. Please check that the mint is running."),
    ).not.toBeInTheDocument();
  });

  it("throws from the submit guard when the market is closed", () => {
    expect(() => assertMarketAcceptsOrders(yesNoMarket({ state: "closed" }))).toThrow(
      "This market is closed and no longer accepts orders.",
    );
  });

  it.each([
    { signerBackupState: "confirmed", nostrReminder: false },
    { signerBackupState: "needs_backup", nostrReminder: true },
  ] as const)(
    "submits a priced Buy with a pending seed reminder and keeps the Nostr reminder separate",
    async ({ signerBackupState, nostrReminder }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.walletBackupState = "needs_backup";
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      mocks.settingsState.signerBackupState = signerBackupState;
      mocks.previewFokOrder.mockResolvedValue({
        ...fillablePreview(),
        averagePrice: 400,
        worstPrice: 400,
        currentLatestTradePrice: 400,
        projectedFinalPrice: 400,
      });
      vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
      vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));
      mockAcceptedOrder();

      render(<MarketDetailPage />);

      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
        target: { value: "1" },
      });

      await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
      expect(screen.queryByText("Insufficient funds")).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(usePendingTradesStore.getState().get("order-auto-1")?.walletId).toBe(
          browserWalletIdFromMnemonic(mocks.walletState.mnemonic),
        ),
      );
      if (nostrReminder) {
        expect(await screen.findByText("Nostr private key")).toBeInTheDocument();
        expect(screen.queryByText("Cashu recovery phrase")).not.toBeInTheDocument();
      } else {
        expect(screen.queryByText("Nostr private key")).not.toBeInTheDocument();
        expect(screen.queryByText("Cashu recovery phrase")).not.toBeInTheDocument();
      }
    },
  );

  it.each([
    { result: "success", message: "Order filled.", remainsVisible: false },
    { result: "error", message: "The order was refused.", remainsVisible: true },
  ] as const)(
    "keeps only unresolved $result messages when a new trade is selected",
    async ({ result, message, remainsVisible }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
      vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
        marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
      );
      mockAcceptedOrder();
      if (result === "error") {
        vi.mocked(submitBrowserCtfRangeOrder).mockRejectedValueOnce(new Error(message));
      }

      render(<MarketDetailPage />);
      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
        target: { value: "1" },
      });
      await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
      fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      if (remainsVisible) {
        await waitFor(() =>
          expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(message),
        );
      } else {
        await waitFor(() => expect(screen.queryAllByTestId("trade-amount-input")).toHaveLength(0));
      }

      fireEvent.click(screen.getAllByTestId("trade-outcome-no")[0]);
      if (remainsVisible) {
        expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(message);
      } else {
        expect(screen.queryByTestId("trade-submit-status")).not.toBeInTheDocument();
      }
      expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    },
  );

  it("retries real fee preparation after a transient mint-metadata failure", async () => {
    const conditionId = "aa".repeat(32);
    const mintUrl = "https://phase6-metadata-retry.example";
    await configureRealRangeFeePreview({
      conditionId,
      mintUrl,
      failMetadataOnce: true,
    });

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });

    expect(await screen.findByTestId("trade-feasibility-status")).toHaveTextContent(
      "Could not check the cost of this trade. Retry to continue.",
    );
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    expect(screen.queryByText("private mint detail")).not.toBeInTheDocument();
    expect(mocks.loadRangeMintMetadata).toHaveBeenCalledTimes(1);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(mocks.loadRangeMintMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.getSettlementCapabilityAdmissionPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.readRangeProofs).toHaveBeenCalledWith(
      mintUrl,
      expect.objectContaining({ keysetId: `01${"11".repeat(32)}`, unit: "msat" }),
    );
    expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mintUrl,
        market: expect.objectContaining({ id: conditionId }),
        ticket: expect.objectContaining({
          marketId: `${conditionId}-Yes`,
          request: expect.objectContaining({
            outcomeId: "Yes",
            tokenSide: "Outcome",
            side: "Buy",
            amountSubunits: 1_000,
            timeInForce: "FOK",
          }),
        }),
      }),
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("allows a smaller amount after the FOK preview refuses the oversized request", async () => {
    const conditionId = "bb".repeat(32);
    const mintUrl = "https://phase6-smaller-correction.example";
    await configureRealRangeFeePreview({ conditionId, mintUrl });
    mocks.previewFokOrder.mockImplementation(async (request) =>
      request.faceAmountSubunits > 1_000
        ? { ...nonfillablePreview(), previewRevision: "capacity-test-revision" }
        : fillablePreview(),
    );

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "2" } });

    expect(await screen.findByTestId("fok-preview-nonfillable")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ faceAmountSubunits: 2_000 }),
      ),
    );
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    expect(previewBrowserCtfRangeOrderFees).not.toHaveBeenCalled();
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });

    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ faceAmountSubunits: 1_000 }),
    );
    expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mintUrl,
        ticket: expect.objectContaining({
          marketId: `${conditionId}-Yes`,
          request: expect.objectContaining({
            tokenSide: "Outcome",
            side: "Buy",
            price: 500,
            amountSubunits: 1_000,
          }),
        }),
      }),
    );
    expect(mocks.readRangeProofs).toHaveBeenCalledTimes(1);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("discovers a fillable Buy beyond the old 20-point horizon", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));
    mocks.previewFokOrder.mockImplementation(async (request) =>
      request.price >= 800
        ? { ...fillablePreview(), quotePaymentSubunits: 700, averagePrice: 700, worstPrice: 800 }
        : nonfillablePreview(),
    );
    mockAcceptedOrder();
    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getByTestId("trade-outcome-yes"));
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(mocks.previewFokOrderCapacity.mock.calls.at(-1)?.[0].price).toBe(999);
    expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0].price).toBe(999);
    expect(screen.getByTestId("trade-quote-payment")).toHaveAttribute(
      "data-quote-payment-subunits",
      "700",
    );
    fireEvent.click(screen.getByTestId("trade-confirm"));
    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          request: expect.objectContaining({
            price: 800,
            maxQuotePaymentSubunits: 700,
            minQuotePaymentSubunits: null,
          }),
        }),
      }),
    );
  });

  it("ignores a YES inventory result that completes after switching to NO", async () => {
    const conditionId = "dd".repeat(32);
    const mintUrl = "https://phase6-stale-outcome-inventory.example";
    await configureRealRangeFeePreview({ conditionId, mintUrl });
    let resolveYesInventory!: (proofs: Array<{ amount: number }>) => void;
    const yesInventory = new Promise<Array<{ amount: number }>>((resolve) => {
      resolveYesInventory = resolve;
    });
    const noInventory = [
      { id: `01${"11".repeat(32)}`, amount: 1_024, secret: "no-range-source", C: "02" },
    ];
    mocks.readRangeProofs
      .mockReset()
      .mockReturnValueOnce(yesInventory)
      .mockResolvedValueOnce(noInventory)
      .mockResolvedValue(noInventory);

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
    await waitFor(() => expect(mocks.readRangeProofs).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(previewBrowserCtfRangeOrderFees).mock.calls[0]?.[0].ticket.request.tokenSide,
    ).toBe("Outcome");

    fireEvent.click(screen.getAllByTestId("trade-outcome-no")[0]);

    await waitFor(() => expect(mocks.readRangeProofs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          marketId: `${conditionId}-Yes`,
          request: expect.objectContaining({ tokenSide: "Complement", side: "Buy" }),
        }),
      }),
    );

    await act(async () => {
      resolveYesInventory([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("trade-confirm")).toBeEnabled();
    expect(screen.queryByTestId("trade-feasibility-status")).not.toBeInTheDocument();
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("shows the exact proof consolidation cost in the trade fee facts", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue(rangeFeeFacts("1500"));
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });

    const consolidationFees = await screen.findAllByTestId("trade-consolidation-fee");
    expect(consolidationFees[0]).toHaveTextContent("1.500 sats");
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        consentedFeeFacts: rangeFeeFacts("1500"),
        ticket: expect.objectContaining({
          request: expect.objectContaining({
            side: "Buy",
            tokenSide: "Outcome",
            price: 500,
          }),
        }),
      }),
    );
  });

  it("uses the accepted Sell worst price and minimum proceeds", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const market = fundedSatYesNoMarket({
      state: "open",
      outcomeOrderBooks: { Yes: book(600), No: emptyBook },
    });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? book(600) : emptyBook,
    );
    mockAcceptedOrder();

    expect(mocks.routeParams.id).toBe("condition-yesno");
    expect(mocks.walletState.activeMintUrl).toBe("https://mint.example");
    expect(activeBrowserWalletScopeId()).toBe(
      browserWalletScopeIdFromMnemonic(mocks.walletState.mnemonic),
    );

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getByTestId("trade-tab-sell"));
    await waitFor(() => expect(mocks.readCanonicalSellHoldings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByTestId("trade-outcome-yes")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("trade-worst-price")).toHaveAttribute(
        "data-price-numerator",
        "500",
      ),
    );
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    fireEvent.click(screen.getByTestId("trade-confirm"));

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          request: expect.objectContaining({
            side: "Sell",
            tokenSide: "Outcome",
            price: 500,
            minQuotePaymentSubunits: 1_000,
            maxQuotePaymentSubunits: null,
          }),
        }),
      }),
    );
  });

  it.each([
    {
      name: "regular fee cash is available",
      scenarioId: "1",
      heldShareSubunits: [1_000],
      regularCashSubunits: [4],
      maxOutputs: 256,
      refusal: null,
    },
    {
      name: "regular fee cash is absent",
      scenarioId: "2",
      heldShareSubunits: [1_000],
      regularCashSubunits: [],
      maxOutputs: 256,
      refusal:
        "The wallet needs ordinary sats to pay the source preparation fee. Add sats to the wallet and try again.",
    },
    {
      name: "the held share is missing from custody",
      scenarioId: "3",
      heldShareSubunits: [],
      regularCashSubunits: [4],
      maxOutputs: 256,
      refusal: "Insufficient outcome tokens",
    },
    {
      // 6 authorization outputs plus 1 regular change output exceed 6.
      name: "fee cash is present but the mint output bound is too small",
      scenarioId: "4",
      heldShareSubunits: [1_000],
      regularCashSubunits: [2],
      maxOutputs: 6,
      refusal:
        "This order needs more wallet proofs than the mint accepts in one request. Try a smaller amount.",
    },
  ])(
    "previews an exact one-share 100% Sell when $name",
    async ({ scenarioId, heldShareSubunits, regularCashSubunits, maxOutputs, refusal }) => {
      const conditionId = `e${scenarioId}`.padEnd(64, "0");
      const mintUrl = `https://phase6-full-exit-${scenarioId}.example`;
      await configureRealRangeFeePreview({ conditionId, mintUrl, maxOutputs });
      mocks.sellHoldingsByOutcomeSet.set("Yes", {
        selectableSubunits: 1_000,
        reservedSubunits: 0,
      });
      const offeredKeysetId = `01${"22".repeat(32)}`;
      const regularKeysetId = `01${"11".repeat(32)}`;
      mocks.readRangeProofs
        .mockReset()
        .mockImplementation(async (_mintUrl: string, request: { keysetId: string }) =>
          rangeProofs(
            request.keysetId,
            request.keysetId === offeredKeysetId ? heldShareSubunits : regularCashSubunits,
          ),
        );
      const observedFeeFacts = observeRealRangeFeePreview();

      render(<MarketDetailPage />);
      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getByTestId("trade-tab-sell"));
      await waitFor(() => expect(mocks.readCanonicalSellHoldings).toHaveBeenCalled());
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.click(screen.getByTestId("trade-sell-percentage-100"));

      const amountInput = screen.getByTestId("trade-amount-input") as HTMLInputElement;
      await waitFor(() => expect(amountInput.value).toBe("1"));
      await waitFor(() =>
        expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
          expect.objectContaining({
            marketId: `${conditionId}-Yes`,
            side: "Sell",
            tokenSide: "Outcome",
            faceAmountSubunits: 1_000,
          }),
        ),
      );
      await waitFor(() =>
        expect(mocks.readRangeProofs).toHaveBeenCalledWith(
          mintUrl,
          expect.objectContaining({ keysetId: regularKeysetId, asset: { kind: "regular" } }),
        ),
      );

      if (refusal === null) {
        await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
        expect(observedFeeFacts.at(-1)).toEqual({
          settlementInputFeeSubunits: "1",
          sourcePreparationFeeSubunits: "1",
          consolidationFeeSubunits: "0",
          settlementAsset: { kind: "regular", unit: "msat" },
          sourcePreparationAsset: { kind: "regular", unit: "msat" },
          consolidationAsset: {
            kind: "conditional",
            unit: "msat",
            conditionId,
            outcomeCollection: "Yes",
          },
          sourceMode: "mixed-source-ctf-convert",
        });
        expect(screen.getByTestId("trade-source-preparation-fee")).toHaveTextContent("0.001 sats");
        expect(screen.queryByTestId("trade-feasibility-status")).not.toBeInTheDocument();
      } else {
        expect(await screen.findByTestId("trade-feasibility-status")).toHaveTextContent(refusal);
        expect(screen.getByTestId("trade-confirm")).toBeDisabled();
        expect(observedFeeFacts).toEqual([]);
      }

      expect(amountInput.value).toBe("1");
      expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
    },
  );

  it("does not let a stale 100% Sell fee response enable the 50% Sell", async () => {
    const conditionId = "e3".repeat(32);
    const mintUrl = "https://phase6-full-exit-stale.example";
    await configureRealRangeFeePreview({ conditionId, mintUrl });
    mocks.sellHoldingsByOutcomeSet.set("Yes", {
      selectableSubunits: 2_000,
      reservedSubunits: 0,
    });
    const offeredKeysetId = `01${"22".repeat(32)}`;
    const heldShares = rangeProofs(offeredKeysetId, [2_000]);
    const pendingReads: Array<() => void> = [];
    mocks.readRangeProofs
      .mockReset()
      .mockImplementation(async (_mintUrl: string, request: { keysetId: string }) => {
        const proofs =
          request.keysetId === offeredKeysetId ? heldShares : rangeProofs(request.keysetId, [4]);
        if (request.keysetId !== offeredKeysetId) return proofs;
        return new Promise((resolve) => pendingReads.push(() => resolve(proofs)));
      });
    const observedFeeFacts = observeRealRangeFeePreview();

    render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getByTestId("trade-tab-sell"));
    await waitFor(() => expect(mocks.readCanonicalSellHoldings).toHaveBeenCalled());
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.click(screen.getByTestId("trade-sell-percentage-100"));
    const amountInput = screen.getByTestId("trade-amount-input") as HTMLInputElement;
    await waitFor(() => expect(amountInput.value).toBe("2"));
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    fireEvent.click(screen.getByTestId("trade-sell-percentage-50"));
    await waitFor(() => expect(amountInput.value).toBe("1"));
    await waitFor(() => expect(pendingReads).toHaveLength(2));

    await act(async () => {
      pendingReads[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(observedFeeFacts).toHaveLength(1));
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    expect(screen.queryByTestId("trade-source-preparation-fee")).not.toBeInTheDocument();

    await act(async () => {
      pendingReads[1]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          request: expect.objectContaining({ side: "Sell", amountSubunits: 1_000 }),
        }),
      }),
    );
    expect(amountInput.value).toBe("1");
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("refreshes exact fee preview when selectable inventory arrives without amount edits", async () => {
    mocks.walletState.setupComplete = true;
    const mintUrl = "https://inventory-wake.example";
    mocks.walletState.activeMintUrl = mintUrl;
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees)
      .mockResolvedValueOnce(rangeFeeFacts("0"))
      .mockResolvedValue(rangeFeeFacts("1500"));
    vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    const scopeId = browserWalletScopeIdFromMnemonic(mocks.walletState.mnemonic)!;
    const proofMaterial = createDurableCustodyProofMaterialRecord({
      scopeId,
      normalizedMint: mintUrl,
      unit: "msat",
      proof: {
        id: `01${"11".repeat(32)}`,
        amount: Amount.from(1_000),
        secret: "inventory-wake-proof",
        C: `02${"22".repeat(32)}`,
        dleq: null,
        p2pkE: null,
        witness: null,
      },
    });
    const proof = decodeBrowserCustodyProofRow({
      scopeId,
      normalizedMint: mintUrl,
      unit: "msat",
      assetKind: "regular",
      conditionId: null,
      outcomeCollection: null,
      baseAsset: "sat",
      ...proofMaterial,
      proofBody: new Uint8Array(proofMaterial.proofBody),
      revision: 0,
      selectability: "selectable",
      reservationOperationId: null,
      receivedAtMs: 1,
    });

    await db.custodyProofs.delete([scopeId, proof.proofId]);
    const rendered = render(<MarketDetailPage />);
    try {
      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      const amountInput = screen.getByTestId("trade-amount-input");
      fireEvent.change(amountInput, { target: { value: "1" } });
      await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
      await waitFor(() =>
        expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent("0.000 sats"),
      );
      const callsBeforeReceive = vi.mocked(previewBrowserCtfRangeOrderFees).mock.calls.length;

      await act(async () => {
        await db.custodyProofs.add(proof);
      });

      await waitFor(() =>
        expect(vi.mocked(previewBrowserCtfRangeOrderFees).mock.calls.length).toBeGreaterThan(
          callsBeforeReceive,
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent("1.500 sats"),
      );
      expect(amountInput).toHaveValue(1);
      expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
        expect.objectContaining({ mintUrl }),
      );
      expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      await db.custodyProofs.delete([scopeId, proof.proofId]);
    }
  });

  it("invalidates fee consent when a new signer receives the same trade terms", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    let resolveNewFees!: (fees: ReturnType<typeof rangeFeeFacts>) => void;
    const newFees = new Promise<ReturnType<typeof rangeFeeFacts>>((resolve) => {
      resolveNewFees = resolve;
    });
    vi.mocked(previewBrowserCtfRangeOrderFees)
      .mockResolvedValueOnce(rangeFeeFacts("0"))
      .mockReturnValue(newFees);
    vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    const rendered = render(<MarketDetailPage />);
    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());

    mocks.settingsState.nostrProfile = { pubkey: "b".repeat(64) };
    rendered.rerender(<MarketDetailPage />);
    await waitFor(() => expect(previewBrowserCtfRangeOrderFees).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("trade-consolidation-fee")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    await act(async () => resolveNewFees(rangeFeeFacts("1500")));
    await waitFor(() =>
      expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent("1.500 sats"),
    );
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("refreshes fee facts after a stale-fee submission refusal before requiring confirmation", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const feeFactsF0 = rangeFeeFacts("0");
    const feeFactsF1 = rangeFeeFacts("1500");
    let resolveFeeFactsF1!: (feeFacts: typeof feeFactsF1) => void;
    const feeFactsF1Promise = new Promise<typeof feeFactsF1>((resolve) => {
      resolveFeeFactsF1 = resolve;
    });
    let feeFactsChanged = false;
    vi.mocked(previewBrowserCtfRangeOrderFees).mockImplementation(() =>
      feeFactsChanged ? feeFactsF1Promise : Promise.resolve(feeFactsF0),
    );
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();
    vi.mocked(submitBrowserCtfRangeOrder).mockImplementationOnce(async () => {
      feeFactsChanged = true;
      throw new BrowserCtfRangeOrderError(
        "source-preparation-failed",
        "Wallet proof fees changed. Review the updated trade cost and try again.",
      );
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent("0.000 sats"),
    );
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());

    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "Wallet proof fees changed. Review the updated trade cost and try again.",
      ),
    );
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByTestId("trade-consolidation-fee")).not.toBeInTheDocument(),
    );
    expect(screen.getAllByTestId("trade-confirm")[0]).toBeDisabled();

    await act(async () => {
      resolveFeeFactsF1(feeFactsF1);
    });
    await waitFor(() =>
      expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent("1.500 sats"),
    );
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(2));
    expect(submitBrowserCtfRangeOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentedFeeFacts: feeFactsF1 }),
    );
  });

  it.each([
    {
      side: "Buy",
      accepted: 400,
      worse: 500,
      bound: { maxQuotePaymentSubunits: 400, minQuotePaymentSubunits: null },
    },
    {
      side: "Sell",
      accepted: 400,
      worse: 300,
      bound: { maxQuotePaymentSubunits: null, minQuotePaymentSubunits: 400 },
    },
  ] as const)(
    "requires refresh and new confirmation after worse $side aggregate with the same worst price",
    async ({ side, accepted, worse, bound }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      mocks.previewFokOrder.mockResolvedValue({
        ...fillablePreview(),
        quotePaymentSubunits: accepted,
      });
      vi.mocked(fetchMarketDetail).mockResolvedValue(fundedSatYesNoMarket({ state: "open" }));
      vi.mocked(fetchOrderBook).mockResolvedValue(book(400));
      mockAcceptedOrder();
      render(<MarketDetailPage />);
      await screen.findByRole("heading", { name: "Will it happen?" });
      if (side === "Sell") fireEvent.click(screen.getByTestId("trade-tab-sell"));
      await waitFor(() => expect(screen.getByTestId("trade-outcome-yes")).toBeEnabled());
      fireEvent.click(screen.getByTestId("trade-outcome-yes"));
      fireEvent.change(screen.getByTestId("trade-amount-input"), { target: { value: "1" } });
      await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
      expect(previewBrowserCtfRangeOrderFees).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ticket: expect.objectContaining({ request: expect.objectContaining(bound) }),
        }),
      );
      mocks.previewFokOrder.mockResolvedValue({
        ...fillablePreview(),
        quotePaymentSubunits: worse,
      });
      fireEvent.click(screen.getByTestId("trade-confirm"));
      await waitFor(() =>
        expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
          "Refresh the preview and confirm again.",
        ),
      );
      expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId("fok-preview-refresh"));
      await waitFor(() =>
        expect(screen.getByTestId("trade-quote-payment")).toHaveAttribute(
          "data-quote-payment-subunits",
          String(worse),
        ),
      );
      await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
      expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("trade-confirm"));
      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: expect.objectContaining({
            request: expect.objectContaining({
              price: 500,
              maxQuotePaymentSubunits: side === "Buy" ? worse : null,
              minQuotePaymentSubunits: side === "Sell" ? worse : null,
            }),
          }),
        }),
      );
    },
  );

  it("refuses submission when the final FOK preview becomes nonfillable", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await screen.findByTestId("fok-preview-ready");
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());

    mocks.previewFokOrder.mockResolvedValue(nonfillablePreview());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "The order is no longer fillable at the confirmed terms. Refresh the preview and confirm again.",
      ),
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("opens the trade top-up overlay from the page-level buy top-up button", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockRejectedValueOnce(insufficientExactFundsError());
    mocks.previewFokOrder.mockResolvedValue({
      ...fillablePreview(),
      averagePrice: 400,
      worstPrice: 400,
      currentLatestTradePrice: 400,
      projectedFinalPrice: 400,
    });
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });

    await screen.findAllByRole("button", { name: /Top up .+ wallet/i });
    const panelTopUpButton = screen
      .getAllByTestId("trade-confirm")
      .find((button) => /Top up .+ wallet/i.test(button.textContent ?? ""));
    expect(panelTopUpButton).toBeDefined();
    fireEvent.click(panelTopUpButton!);

    expect(await screen.findByRole("heading", { name: "Top Up Wallet" })).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toBeInTheDocument();
    expect(mocks.topUpOverlayProps).toEqual({ deficit: 0, baseAsset: "sat", proofUnit: undefined });
  });

  it("keeps the captured bound when a better preview arrives during top-up", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockRejectedValueOnce(insufficientExactFundsError());
    mocks.previewFokOrder.mockResolvedValue({
      ...fillablePreview(),
      averagePrice: 400,
      worstPrice: 400,
      currentLatestTradePrice: 400,
      projectedFinalPrice: 400,
    });
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });

    await screen.findAllByRole("button", { name: /Top up .+ wallet/i });
    fireEvent.click(
      screen
        .getAllByTestId("trade-confirm")
        .find((button) => /Top up .+ wallet/i.test(button.textContent ?? ""))!,
    );
    await screen.findByTestId("top-up-success");

    mocks.previewFokOrder.mockResolvedValue({
      ...fillablePreview(),
      averagePrice: 250,
      worstPrice: 250,
      currentLatestTradePrice: 250,
      projectedFinalPrice: 250,
    });
    await waitFor(() => expect(mocks.orderBookHandlers.has("condition-yesno-Yes")).toBe(true));
    await act(async () => {
      mocks.orderBookHandlers.get("condition-yesno-Yes")?.({
        marketId: "condition-yesno-Yes",
        bids: [],
        asks: [{ price: 250, amount: 100 }],
        spread: null,
      });
    });
    await waitFor(() => expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0].price).toBe(999));

    fireEvent.click(screen.getByTestId("top-up-success"));
    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "Wallet fee facts changed. Review the updated trade cost and retry.",
      ),
    );
    await waitFor(() => expect(screen.getByTestId("trade-confirm")).toBeEnabled());
    fireEvent.click(screen.getByTestId("trade-confirm"));

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          request: expect.objectContaining({
            price: 250,
            maxQuotePaymentSubunits: 1_000,
            minQuotePaymentSubunits: null,
          }),
        }),
      }),
    );
  });

  it("keeps captured consent while discovery refreshes during top-up", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees)
      .mockRejectedValueOnce(insufficientExactFundsError())
      .mockRejectedValueOnce(insufficientExactFundsError());
    mocks.previewFokOrder.mockResolvedValue({
      ...fillablePreview(),
      averagePrice: 400,
      worstPrice: 400,
      currentLatestTradePrice: 400,
      projectedFinalPrice: 400,
    });
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("trade-worst-price")).toHaveAttribute(
        "data-price-numerator",
        "400",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Top up sats wallet"),
    );
    fireEvent.click(screen.getByTestId("trade-confirm"));
    await screen.findByTestId("top-up-success");
    mocks.previewFokOrderCapacity.mockImplementation((request: PreviewFokOrderCapacityRequest) =>
      Promise.resolve(capacityPreview(request, 500)),
    );
    mocks.previewFokOrder.mockResolvedValue({
      ...fillablePreview(),
      averagePrice: 250,
      worstPrice: 250,
      currentLatestTradePrice: 250,
      projectedFinalPrice: 250,
    });
    await waitFor(() => expect(mocks.orderBookHandlers.has("condition-yesno-Yes")).toBe(true));
    await act(async () => {
      mocks.orderBookHandlers.get("condition-yesno-Yes")?.({
        marketId: "condition-yesno-Yes",
        bids: [],
        asks: [{ price: 250, amount: 100 }],
        spread: null,
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("trade-worst-price")).toHaveAttribute(
        "data-price-numerator",
        "250",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Top up sats wallet"),
    );

    fireEvent.click(screen.getByTestId("top-up-success"));
    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "Wallet fee facts changed. Review the updated trade cost and retry.",
      ),
    );
    expect(mocks.previewFokOrder.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ price: 400 }),
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("requires a new preview and action after implicit identity setup", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(yesNoMarket({ state: "open" }));
    vi.mocked(fetchOrderBook).mockResolvedValue(askBook(400));
    const previewCallsBeforeSetup = () => mocks.previewFokOrder.mock.calls.length;
    mocks.createImplicitWalletAndNostrIdentity.mockImplementation(async () => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      mocks.settingsState.nostrProfile = { pubkey: "a".repeat(64) };
      return { ok: true };
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await screen.findByTestId("fok-preview-ready");
    const callsBefore = previewCallsBeforeSetup();
    fireEvent.click(screen.getByTestId("trade-confirm"));
    expect(
      await screen.findByRole("heading", { name: "Do you have a Nostr account?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "No, create one for me" }));

    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "Trading identity changed. Review the new price preview and confirm again.",
      ),
    );
    await waitFor(() => expect(previewCallsBeforeSetup()).toBeGreaterThan(callsBefore));
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "signer", flushEffects: true },
    { kind: "signer", flushEffects: false },
    { kind: "wallet", flushEffects: false },
    { kind: "signer-revision", flushEffects: false },
    { kind: "unmount", flushEffects: false },
  ])(
    "abandons deferred fee preview after $kind change (effects flushed: $flushEffects)",
    async ({ kind, flushEffects }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      let resolveFeePreview!: (fees: ReturnType<typeof rangeFeeFacts>) => void;
      const deferredFeePreview = new Promise<ReturnType<typeof rangeFeeFacts>>((resolve) => {
        resolveFeePreview = resolve;
      });
      vi.mocked(previewBrowserCtfRangeOrderFees)
        .mockRejectedValueOnce(insufficientExactFundsError())
        .mockReturnValueOnce(deferredFeePreview);
      const market = fundedSatYesNoMarket({ state: "open" });
      vi.mocked(fetchMarketDetail).mockResolvedValue(market);
      vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
        marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
      );
      mockAcceptedOrder();

      const rendered = render(<MarketDetailPage />);
      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
        target: { value: "1" },
      });
      const confirm = screen.getAllByTestId("trade-confirm")[0];
      await waitFor(() => expect(confirm).toHaveTextContent("Top up sats wallet"));
      fireEvent.click(confirm);
      await screen.findByTestId("top-up-success");
      fireEvent.click(screen.getByTestId("top-up-success"));
      await waitFor(() => expect(previewBrowserCtfRangeOrderFees).toHaveBeenCalledTimes(2));

      if (kind === "wallet") mocks.walletScopeId = "wallet-profile-b";
      else if (kind === "signer-revision") mocks.signerRevision += 1;
      else if (kind === "unmount") rendered.unmount();
      else {
        mocks.settingsState.nostrSignerMode = "nip07";
        mocks.settingsState.nostrProfile = { pubkey: "b".repeat(64) };
      }
      if (flushEffects) rendered.rerender(<MarketDetailPage />);
      await act(async () => {
        resolveFeePreview(rangeFeeFacts());
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
    },
  );

  it("requires explicit fee confirmation after collateral top-up before submission", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockRejectedValueOnce(insufficientExactFundsError());
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("trade-confirm")[0]).toHaveTextContent("Top up sats wallet"),
    );
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("top-up-success");
    vi.mocked(previewBrowserCtfRangeOrderFees).mockResolvedValue(rangeFeeFacts("1500"));
    fireEvent.click(screen.getByTestId("top-up-success"));

    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "Wallet fee facts changed. Review the updated trade cost and retry.",
      ),
    );
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByTestId("trade-confirm")[0]).not.toHaveTextContent("Top up sats wallet"),
    );
    await screen.findByTestId("fok-preview-ready");
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);
    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: expect.any(String),
        mintUrl: "https://mint.example",
        mnemonic: mocks.walletState.mnemonic,
        consentedFeeFacts: rangeFeeFacts("1500"),
        ticket: expect.objectContaining({
          marketId: "condition-yesno-Yes",
          request: expect.objectContaining({
            amountSubunits: 1_000,
            outcomeId: "Yes",
            side: "Buy",
            timeInForce: "FOK",
          }),
        }),
      }),
    );
  });

  it.each([false, true])(
    "resumes Score top-up only for the same signer (changed: %s)",
    async (changedSigner) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      mocks.getExactUnitBalance.mockResolvedValue(5_000);
      const market = fundedSatYesNoMarket({ state: "open" });
      vi.mocked(fetchMarketDetail).mockResolvedValue(market);
      vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
        marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
      );
      vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
        await input.onScoreTopUpRequired?.({ requiredSats: 5, balanceSats: 0 });
        return {
          orderId: "order-score-1",
          status: "filled",
          remainingAmountSubunits: 0,
          fills: [],
          baseAsset: "sat",
          divisibility: 1_000,
          activeSettlementGroup: null,
        };
      });

      render(<MarketDetailPage />);

      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
        target: { value: "1" },
      });
      await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
      fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

      await screen.findByTestId("insufficient-balance-top-up");
      expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
      if (changedSigner) {
        mocks.settingsState.nostrSignerMode = "nip07";
        mocks.settingsState.nostrProfile = { pubkey: "b".repeat(64) };
      }
      fireEvent.click(await screen.findByTestId("top-up-success"));

      const submission = vi.mocked(submitBrowserCtfRangeOrder).mock.results[0].value;
      if (changedSigner) await expect(submission).rejects.toThrow();
      else await expect(submission).resolves.toMatchObject({ orderId: "order-score-1" });

      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      expect(mocks.getExactUnitBalance).toHaveBeenCalledWith("https://mint.example", "msat");
      expect(screen.queryByRole("dialog", { name: "Top Up Wallet" })).not.toBeInTheDocument();
    },
  );

  it("passes Score top-up through the msat overlay and balance boundary", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    let balanceMsat = 4_999;
    mocks.getExactUnitBalance.mockImplementation(async () => balanceMsat);
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
      await input.onScoreTopUpRequired?.({ requiredSats: 5, balanceSats: 0 });
      return {
        orderId: "order-score-msat-boundary",
        status: "filled",
        remainingAmountSubunits: 0,
        fills: [],
        baseAsset: "sat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      };
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-top-up");
    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    await waitFor(() => expect(mocks.topUpOverlayProps).not.toBeNull());
    expect(mocks.topUpOverlayProps).toEqual({
      deficit: 5_000,
      baseAsset: "sat",
      proofUnit: "msat",
    });

    fireEvent.click(await screen.findByTestId("top-up-success"));
    await waitFor(() => expect(mocks.getExactUnitBalance).toHaveBeenCalledTimes(1));
    expect(mocks.getExactUnitBalance).toHaveBeenCalledWith("https://mint.example", "msat");
    expect(screen.getByTestId("insufficient-balance-top-up")).toBeInTheDocument();

    balanceMsat = 5_000;
    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    fireEvent.click(await screen.findByTestId("top-up-success"));
    await waitFor(() => expect(mocks.getExactUnitBalance).toHaveBeenCalledTimes(2));
    const submission = vi.mocked(submitBrowserCtfRangeOrder).mock.results[0]?.value;
    await expect(submission).resolves.toMatchObject({ orderId: "order-score-msat-boundary" });
  });

  it("formats fractional Score balance and top-up amounts as sats", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.getExactUnitBalance.mockResolvedValue(4_999);
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
      await input.onScoreTopUpRequired?.({ requiredSats: 3.201, balanceSats: 1.6 });
      return {
        orderId: "order-score-fractional-display",
        status: "filled",
        remainingAmountSubunits: 0,
        fills: [],
        baseAsset: "sat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      };
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-top-up");
    expect(screen.getByText("3.201 sats")).toBeInTheDocument();
    expect(screen.getByText("1.6 sats")).toBeInTheDocument();
    expect(screen.getByText("1.601 sats")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("insufficient-balance-top-up"));
    expect(await screen.findByText(/Top up at least 1\.601 sats/)).toBeInTheDocument();
    expect(mocks.topUpOverlayProps).toEqual({
      deficit: 1_601,
      baseAsset: "sat",
      proofUnit: "msat",
    });
  });

  it.each([
    { label: "unknown", balanceSats: null },
    { label: "known", balanceSats: 0 },
  ])(
    "shows $label unavailable Score recovery and retries the same submission",
    async ({ label, balanceSats }) => {
      mocks.walletState.setupComplete = true;
      mocks.walletState.activeMintUrl = "https://mint.example";
      mocks.settingsState.nostrSignerMode = "nsec";
      const market = fundedSatYesNoMarket({ state: "open" });
      vi.mocked(fetchMarketDetail).mockResolvedValue(market);
      vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
        marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
      );
      vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
        await input.onScoreTopUpRequired?.({
          requiredSats: 5,
          balanceSats,
          recoveryStatus: "unavailable",
        });
        return {
          orderId: `order-score-retry-${label}`,
          status: "filled",
          remainingAmountSubunits: 0,
          fills: [],
          baseAsset: "sat",
          divisibility: 1_000,
          activeSettlementGroup: null,
        };
      });

      render(<MarketDetailPage />);

      await screen.findByRole("heading", { name: "Will it happen?" });
      fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
      fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
        target: { value: "1" },
      });
      await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
      fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

      await screen.findByTestId("insufficient-balance-retry");
      expect(screen.getByTestId("insufficient-balance-top-up")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Wallet recovery is currently unavailable",
      );
      if (balanceSats === null) {
        expect(screen.getByText("The balance in this browser is unavailable.")).toBeInTheDocument();
        expect(screen.queryByText("You have")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText(/You have/)).toBeInTheDocument();
      }

      fireEvent.click(screen.getByTestId("insufficient-balance-retry"));
      const submission = vi.mocked(submitBrowserCtfRangeOrder).mock.results[0]?.value;
      await expect(submission).resolves.toMatchObject({ orderId: `order-score-retry-${label}` });
      await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("insufficient-balance-retry")).not.toBeInTheDocument();
    },
  );

  it("keeps the same Score submission pending across repeated unavailable recovery callbacks", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );

    let recoveryRequests = 0;
    vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
      const requestRecovery = async () => {
        recoveryRequests += 1;
        await input.onScoreTopUpRequired?.({
          requiredSats: 5,
          balanceSats: null,
          recoveryStatus: "unavailable",
        });
      };
      await requestRecovery();
      await requestRecovery();
      return {
        orderId: "order-score-repeated-recovery",
        status: "filled",
        remainingAmountSubunits: 0,
        fills: [],
        baseAsset: "sat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      };
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-retry");
    const submission = vi.mocked(submitBrowserCtfRangeOrder).mock.results[0]?.value;
    let submissionSettled = false;
    void submission?.then(() => {
      submissionSettled = true;
    });
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    expect(recoveryRequests).toBe(1);
    expect(submissionSettled).toBe(false);
    expect(screen.getByTestId("insufficient-balance-top-up")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("insufficient-balance-retry"));
    await waitFor(() => expect(recoveryRequests).toBe(2));
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    expect(submissionSettled).toBe(false);
    expect(screen.getByTestId("insufficient-balance-retry")).toBeInTheDocument();
    expect(screen.getByTestId("insufficient-balance-top-up")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("insufficient-balance-retry"));
    await expect(submission).resolves.toMatchObject({
      orderId: "order-score-repeated-recovery",
    });
    expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1);
    expect(submissionSettled).toBe(true);
    expect(screen.queryByTestId("insufficient-balance-retry")).not.toBeInTheDocument();
  });

  it("cancels an in-flight Score top-up without starting another submission", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    vi.mocked(submitBrowserCtfRangeOrder).mockImplementation(async (input) => {
      await input.onScoreTopUpRequired?.({
        requiredSats: 5,
        balanceSats: 0,
        recoveryStatus: "unavailable",
      });
      return {
        orderId: "order-score-cancelled",
        status: "filled",
        remainingAmountSubunits: 0,
        fills: [],
        baseAsset: "sat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      };
    });

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() => expect(screen.getAllByTestId("trade-confirm")[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("insufficient-balance-cancel");
    fireEvent.click(screen.getByTestId("insufficient-balance-cancel"));

    await waitFor(() => expect(submitBrowserCtfRangeOrder).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("insufficient-balance-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("insufficient-balance-top-up")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
      "Participation Score top-up was cancelled. The order was not submitted.",
    );
  });

  it("does not auto-submit when collateral remains insufficient after top-up", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockRejectedValue(insufficientExactFundsError());
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("trade-confirm")[0]).toHaveTextContent("Top up sats wallet"),
    );
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("top-up-success");
    fireEvent.click(screen.getByTestId("top-up-success"));

    await waitFor(() =>
      expect(screen.getByTestId("trade-submit-status")).toHaveTextContent(
        "The wallet does not have enough exact funds for this order.",
      ),
    );
    expect(previewBrowserCtfRangeOrderFees).toHaveBeenCalledTimes(2);
    expect(submitBrowserCtfRangeOrder).not.toHaveBeenCalled();
  });

  it("drops a pending sat market order intent when order details change during top-up", async () => {
    mocks.walletState.setupComplete = true;
    mocks.walletState.activeMintUrl = "https://mint.example";
    mocks.settingsState.nostrSignerMode = "nsec";
    vi.mocked(previewBrowserCtfRangeOrderFees).mockRejectedValueOnce(insufficientExactFundsError());
    const market = fundedSatYesNoMarket({ state: "open" });
    vi.mocked(fetchMarketDetail).mockResolvedValue(market);
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      marketId === "condition-yesno-Yes" ? askBook(400) : emptyBook,
    );
    mockAcceptedOrder();

    render(<MarketDetailPage />);

    await screen.findByRole("heading", { name: "Will it happen?" });
    fireEvent.click(screen.getAllByTestId("trade-outcome-yes")[0]);
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("trade-confirm")[0]).toHaveTextContent("Top up sats wallet"),
    );
    fireEvent.click(screen.getAllByTestId("trade-confirm")[0]);

    await screen.findByTestId("top-up-success");
    fireEvent.change(screen.getAllByTestId("trade-amount-input")[0], {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("top-up-success"));

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

  it.each([null, "0001", "0002"])(
    "keeps the committed funding pair when REST returns revision %s",
    (fundingRevision) => {
      const initial = yesNoMarket({ ammBotBudgetSubunits: 10_000, fundingRevision: "0001" });
      const before = createMarketDetailDataState(initial);
      const funded = marketDetailDataReducer(before, {
        type: "marketFundingUpdated",
        observation: {
          conditionId: initial.id,
          ammBotBudgetSubunits: 30_000,
          fundingRevision: "0002",
        },
      });
      expect(funded.core).toMatchObject({
        ammBotBudgetSubunits: 30_000,
        fundingRevision: "0002",
      });
      expect(funded.booksByMarketId).toBe(before.booksByMarketId);
      expect(funded.confirmedTradesByConditionId).toBe(before.confirmedTradesByConditionId);
      const refreshed = marketDetailDataReducer(funded, {
        type: "marketSnapshotLoaded",
        detail: { ...initial, title: "Refreshed title", fundingRevision },
      });
      expect(refreshed.core).toMatchObject({
        title: "Refreshed title",
        ammBotBudgetSubunits: 30_000,
        fundingRevision: "0002",
      });
    },
  );

  it("ignores duplicate funding and a late update after a condition switch", () => {
    const initial = yesNoMarket({ ammBotBudgetSubunits: 30_000, fundingRevision: "0002" });
    const state = createMarketDetailDataState(initial);
    const action = {
      type: "marketFundingUpdated" as const,
      observation: {
        conditionId: initial.id,
        ammBotBudgetSubunits: 30_000,
        fundingRevision: "0002",
      },
    };
    expect(marketDetailDataReducer(state, action)).toBe(state);
    const switched = marketDetailDataReducer(state, { type: "routeChanged", routeId: "other" });
    expect(marketDetailDataReducer(switched, action)).toBe(switched);
  });

  it.each(["1h", "24h", "7d", "30d", "all"] as const)(
    "%s replaces complete history without inserting live fills or retaining omitted outcomes",
    (timeframe) => {
      const initial = categoricalMarket() as CategoricalMarketDetail;
      initial.registeredPrimitiveOutcomeIds = ["Alice", "Bob", "Carol"];
      const fine = {
        timeframe,
        asOf: "2026-08-18T00:00:00Z",
        snapshotEventOrder: "opaque",
        data: [
          { timestamp: "2026-08-17T23:00:00Z", eventOrder: "z", price: 40 },
          { timestamp: "2026-08-17T23:00:01Z", eventOrder: "a", price: 42 },
        ],
      };
      const state = marketDetailDataReducer(createMarketDetailDataState(initial), {
        type: "historyLoaded",
        marketId: initial.id,
        timeframe,
        historiesByOutcomeSetId: { Alice: fine, Bob: fine },
      });
      const live = marketDetailDataReducer(state, {
        type: "confirmedTradeRecorded",
        conditionId: initial.id,
        trade: {
          primitiveOutcomeId: "Alice",
          fillId: "00000000-0000-0000-0000-000000000001",
          executedAt: "2026-08-18T00:00:00Z",
          eventOrder: "0003",
          priceTick: 620,
          divisibility: 1000,
          faceAmountSubunits: 1000,
        },
      });
      expect(live.historiesByMarketId).toBe(state.historiesByMarketId);
      const coarse = { ...fine, data: [fine.data[1]] };
      const replaced = marketDetailDataReducer(live, {
        type: "historyLoaded",
        marketId: initial.id,
        timeframe,
        historiesByOutcomeSetId: { Alice: coarse },
      });
      expect(replaced.historiesByMarketId[initial.id]?.[timeframe]).toEqual({ Alice: coarse });
      const view = composeMarketDetail(replaced, timeframe);
      expect(view?.type).toBe("categorical");
      if (view?.type === "categorical") {
        expect(view.outcomePriceHistories.Bob).toBeUndefined();
        expect(view.outcomePriceHistories.Alice.data).toEqual([fine.data[1]]);
      }
    },
  );

  it("replaces independently widened all buckets and invalidates inactive snapshots", () => {
    const market = categoricalMarket();
    const point = (timestamp: string, price: number) => ({
      timestamp,
      eventOrder: "opaque",
      price,
    });
    const fine: PriceHistory = {
      timeframe: "all",
      asOf: "2026-09-27T17:00:00Z",
      data: [
        point("2026-09-27T16:00:00Z", 40),
        point("2026-09-27T16:01:00Z", 42),
        point("2026-09-27T16:02:00Z", 44),
      ],
    };
    const replace = (
      state: ReturnType<typeof createMarketDetailDataState>,
      histories: Record<string, PriceHistory>,
    ) =>
      marketDetailDataReducer(state, {
        type: "historyLoaded",
        marketId: market.id,
        timeframe: "all",
        historiesByOutcomeSetId: histories,
      });
    const initial = replace(createMarketDetailDataState(market), { Alice: fine, Bob: fine });
    const aliceWide = { ...fine, data: [fine.data[0], fine.data[2]] };
    const aliceReplacement = replace(initial, { Alice: aliceWide, Bob: fine });
    expect(aliceReplacement.historiesByMarketId[market.id]?.all?.Alice.data).toEqual(
      aliceWide.data,
    );
    expect(aliceReplacement.historiesByMarketId[market.id]?.all?.Bob.data).toEqual(fine.data);
    const bobWide = { ...fine, data: [fine.data[2]] };
    const bobReplacement = replace(aliceReplacement, { Alice: aliceWide, Bob: bobWide });
    expect(bobReplacement.historiesByMarketId[market.id]?.all).toEqual({
      Alice: aliceWide,
      Bob: bobWide,
    });
    const invalidated = marketDetailDataReducer(bobReplacement, {
      type: "historyInvalidated",
      marketId: market.id,
      timeframe: "all",
    });
    expect(invalidated.historiesByMarketId[market.id]?.["7d"]).toBeUndefined();
    expect(invalidated.historiesByMarketId[market.id]?.all).toEqual({
      Alice: aliceWide,
      Bob: bobWide,
    });
  });

  it("rejects a snapshot whose expected route differs from the active route", () => {
    const initial = createMarketDetailDataState(yesNoMarket());
    const routeB = marketDetailDataReducer(initial, {
      type: "routeChanged",
      routeId: "condition-other",
    });

    const stale = marketDetailDataReducer(routeB, {
      type: "marketSnapshotLoaded",
      detail: yesNoMarket({ id: "condition-yesno", title: "Stale A" }),
      expectedRouteId: "condition-yesno",
    });

    expect(stale).toBe(routeB);
    expect(stale.activeRouteId).toBe("condition-other");
    expect(stale.core).toBeNull();
  });

  it("preserves yes/no chart history and comments across submit refresh", () => {
    const history = {
      timeframe: "7d" as const,
      data: [
        {
          eventOrder: "2026-01-01T00:00:00Z",
          timestamp: "2026-01-01T00:00:00Z",
          price: 51,
          volume: 10,
        },
      ],
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

  it("does not use price history as current market price authority", () => {
    const initial = yesNoMarket({
      currentOdds: { yes: 50, no: 50 },
      priceHistory: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 80,
            source: "fill",
          },
        ],
      },
    });

    const view = composeMarketDetail(createMarketDetailDataState(initial), "7d");

    expect(view?.type).toBe("yesno");
    if (view?.type === "yesno") {
      expect(view.currentOdds).toEqual({ yes: null, no: null });
    }
  });

  it("does not use independent price histories as categorical current prices", () => {
    const initial = categoricalMarket() as CategoricalMarketDetail;
    initial.outcomes = [
      { id: "outcome-0", label: "Alice", odds: 33.33 },
      { id: "outcome-1", label: "Bob", odds: 33.33 },
      { id: "outcome-2", label: "Carol", odds: 33.33 },
    ];
    initial.priceHistory = {
      timeframe: "7d",
      data: [
        {
          eventOrder: "2026-01-01T00:00:00Z",
          timestamp: "2026-01-01T00:00:00Z",
          price: 80,
          source: "fill",
        },
      ],
    };
    initial.outcomePriceHistories = {
      Alice: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 80,
            source: "fill",
          },
        ],
      },
      Bob: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 10,
            source: "fill",
          },
        ],
      },
      Carol: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 10,
            source: "fill",
          },
        ],
      },
    };

    const view = composeMarketDetail(createMarketDetailDataState(initial), "7d");

    expect(view?.type).toBe("categorical");
    if (view?.type === "categorical") {
      expect(view.outcomes.map((outcome) => outcome.odds)).toEqual([null, null, null]);
    }
  });

  it("keeps composed numeric current value unavailable without a native trade representation", () => {
    const numericMarket = {
      ...yesNoMarket(),
      type: "numeric" as const,
      outcomes: [
        { id: "HI", label: "HI", odds: null },
        { id: "LO", label: "LO", odds: null },
      ],
      registeredPrimitiveOutcomeIds: ["HI", "LO"],
      currentPrice: 75,
      loBound: 0,
      hiBound: 100,
      precision: 2,
      unit: "USD",
      latestConfirmedTradesValid: true,
      latestConfirmedTrades: [
        {
          primitiveOutcomeId: "HI",
          fillId: "00000000-0000-0000-0000-000000000011",
          executedAt: "2026-08-18T00:00:00Z",
          eventOrder: "0001",
          priceTick: 750,
          divisibility: 1_000,
          faceAmountSubunits: 100,
        },
      ],
    } as unknown as MarketDetail;

    const composed = composeMarketDetail(createMarketDetailDataState(numericMarket), "7d");

    expect(composed?.type).toBe("numeric");
    expect(composed && composed.type === "numeric" ? composed.currentPrice : null).toBeNull();
  });

  it("preserves categorical histories and comments across lifecycle refresh", () => {
    const initial = categoricalMarket() as CategoricalMarketDetail;
    initial.priceHistory = {
      timeframe: "7d",
      data: [
        {
          eventOrder: "2026-01-01T00:00:00Z",
          timestamp: "2026-01-01T00:00:00Z",
          price: 34,
          volume: 1,
        },
      ],
    };
    initial.outcomePriceHistories = {
      Alice: initial.priceHistory,
      Bob: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 33,
            volume: 1,
          },
        ],
      },
      Carol: {
        timeframe: "7d",
        data: [
          {
            eventOrder: "2026-01-01T00:00:00Z",
            timestamp: "2026-01-01T00:00:00Z",
            price: 33,
            volume: 1,
          },
        ],
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
      data: [
        {
          eventOrder: "2026-01-01T00:00:00Z",
          timestamp: "2026-01-01T00:00:00Z",
          price: 49,
          volume: 4,
        },
      ],
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

  it("retains a newer live trade when a stale REST snapshot completes", () => {
    const initial = yesNoMarket();
    const initialState = createMarketDetailDataState(initial);
    expect(initialState.registeredPrimitiveOutcomeIdsByConditionId[initial.id]).toEqual([
      "YES",
      "NO",
    ]);
    const liveTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "YES",
      fillId: "00000000-0000-0000-0000-000000000001",
      executedAt: "2026-08-18T00:00:00Z",
      eventOrder: "0001",
      priceTick: 620,
      divisibility: 1_000,
      faceAmountSubunits: 1000,
    };
    const stateWithLive = marketDetailDataReducer(initialState, {
      type: "confirmedTradeRecorded",
      conditionId: initial.id,
      trade: liveTrade,
    });

    expect(stateWithLive.confirmedTradesByConditionId[initial.id]).toEqual([liveTrade]);

    const repaired = marketDetailDataReducer(stateWithLive, {
      type: "marketSnapshotLoaded",
      detail: {
        ...initial,
        state: "closed",
        latestConfirmedTrades: [
          {
            ...liveTrade,
            fillId: "00000000-0000-0000-0000-000000000002",
            eventOrder: "0000",
          },
        ],
      },
    });

    expect(repaired.confirmedTradesByConditionId[initial.id]).toEqual([liveTrade]);
    const composed = composeMarketDetail(repaired, "7d");
    expect(composed?.latestConfirmedTrades).toEqual([liveTrade]);
    expect(composed && composed.type === "yesno" ? composed.currentOdds : null).toEqual({
      yes: 620,
      no: 380,
    });
  });

  it("rejects changed REST facts for a fill already accepted from live", () => {
    const initial = yesNoMarket();
    const liveTrade: LatestConfirmedTrade = {
      primitiveOutcomeId: "YES",
      fillId: "00000000-0000-0000-0000-000000000003",
      executedAt: "2026-08-18T00:00:00Z",
      eventOrder: "0001",
      priceTick: 620,
      divisibility: 1_000,
      faceAmountSubunits: 1000,
    };
    const stateWithLive = marketDetailDataReducer(createMarketDetailDataState(initial), {
      type: "confirmedTradeRecorded",
      conditionId: initial.id,
      trade: liveTrade,
    });

    const conflictingRest = marketDetailDataReducer(stateWithLive, {
      type: "marketSnapshotLoaded",
      detail: {
        ...initial,
        state: "closed",
        latestConfirmedTrades: [
          {
            ...liveTrade,
            eventOrder: "0002",
            priceTick: 180,
            faceAmountSubunits: 2000,
          },
        ],
      },
    });

    expect(conflictingRest.confirmedTradesByConditionId[initial.id]).toEqual([liveTrade]);
    const composed = composeMarketDetail(conflictingRest, "7d");
    expect(composed && composed.type === "yesno" ? composed.currentOdds : null).toEqual({
      yes: 620,
      no: 380,
    });
  });

  it("ignores a malformed live delta without erasing the confirmed price", () => {
    const confirmed: LatestConfirmedTrade = {
      primitiveOutcomeId: "YES",
      fillId: "00000000-0000-0000-0000-000000000021",
      executedAt: "2026-08-18T00:00:00Z",
      eventOrder: "0001",
      priceTick: 610,
      divisibility: 1_000,
      faceAmountSubunits: 1000,
    };
    const initial = yesNoMarket({
      latestConfirmedTrades: [confirmed],
      latestConfirmedTradesValid: true,
    });
    const initialState = createMarketDetailDataState(initial);
    const stateAfterMalformed = marketDetailDataReducer(initialState, {
      type: "confirmedTradeRecorded",
      conditionId: initial.id,
      trade: {
        ...confirmed,
        fillId: "malformed-fill-id",
        eventOrder: "0002",
        priceTick: 900,
      },
    });

    expect(stateAfterMalformed.confirmedTradesByConditionId[initial.id]).toEqual([confirmed]);
    const composed = composeMarketDetail(stateAfterMalformed, "7d");
    expect(composed?.latestConfirmedTrades).toEqual([confirmed]);
    expect(composed && composed.type === "yesno" ? composed.currentOdds : null).toEqual({
      yes: 610,
      no: 390,
    });
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

describe("pending top-up order intent", () => {
  it("binds a sat top-up intent to market, selection, amount, comment, and required subunits", () => {
    const market = yesNoMarket({
      id: "condition-sat",
      baseAsset: "sat",
      baseUnit: "sats",
      divisibility: 1_000,
    });

    const intent = buildPendingTopUpOrderIntent({
      market,
      tradeSelection: { side: "yes" },
      tradeAmount: 2,
      tradeSide: "Buy",
      comment: "  auto after top-up  ",
      baseAsset: "sat",
      required: 900,
    });

    expect(intent).toMatchObject({
      marketId: "condition-sat",
      selectionKey: "yes:",
      tradeAmount: 2,
      tradeSide: "Buy",
      comment: "auto after top-up",
      baseAsset: "sat",
      required: 900,
    });
    expect(
      intent &&
        pendingTopUpOrderIntentMatches(intent, {
          market,
          tradeSelection: { side: "yes" },
          tradeAmount: 2,
          tradeSide: "Buy",
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
      }),
    ).toBe(false);
    expect(
      pendingTopUpOrderIntentMatches(intent!, {
        market,
        tradeSelection: { side: "no" },
        tradeAmount: 2,
        tradeSide: "Buy",
      }),
    ).toBe(false);
  });
});
