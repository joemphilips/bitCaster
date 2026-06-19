import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  booksByOutcomeSetFromDetail,
  composeMarketDetail,
  createMarketDetailDataState,
  decideTradeCollateralGate,
  defaultLimitPriceForDivisibility,
  fetchMarketDetailWithBooks,
  liveTradeChartUpdate,
  marketDetailDataReducer,
  resolvePreflightSplitBuyCollateralRequirement,
  resolveTradeOrderBooks,
} from "@/pages/MarketDetailPage";
import { fetchMarketDetail, fetchOrderBook } from "@/lib/markets";
import type {
  CategoricalMarketDetail,
  Comment,
  MarketDetail,
  OrderBook,
} from "@/types/market-detail";

const mocks = vi.hoisted(() => ({
  resolveRootPreflightOutputAmountSats: vi.fn(),
}));

vi.mock("@/lib/markets", () => ({
  appendLivePricePoint: (
    history: { timeframe: string; data: Array<unknown> },
    point: unknown,
  ) => ({
    ...history,
    data: [...history.data, point],
  }),
  fetchMarketDetail: vi.fn(),
  fetchOrderBook: vi.fn(),
  priceNumeratorToPercent: (price: number, divisibility = 100) =>
    (price / divisibility) * 100,
  submitOrder: vi.fn(),
}));

vi.mock("@/lib/ctfSplit", () => ({
  resolveRootPreflightOutputAmountSats:
    mocks.resolveRootPreflightOutputAmountSats,
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
    liquiditySats: 0,
    volumeLifetimeSats: 0,
    closingDate: "2026-12-31T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseUnit: "sats",
    baseAsset: "sat",
    divisibility: 100,
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

function categoricalMarket(): MarketDetail {
  return {
    id: "condition-1",
    title: "Winner",
    type: "categorical",
    imageUrl: "",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySats: 0,
    volumeLifetimeSats: 0,
    closingDate: "2026-12-31T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseUnit: "sats",
    baseAsset: "sat",
    divisibility: 100,
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
    mocks.resolveRootPreflightOutputAmountSats.mockReset();
  });

  it("fetches singleton outcome-set books for categorical markets", async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(categoricalMarket());
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      book(marketId.length),
    );

    const detail = await fetchMarketDetailWithBooks("condition-1");

    expect(fetchOrderBook).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(fetchOrderBook).mock.calls.map(([marketId]) => marketId),
    ).toEqual(["condition-1-Alice", "condition-1-Bob", "condition-1-Carol"]);
    expect(detail.outcomeOrderBooks).toHaveProperty("Alice");
    expect(detail.outcomeOrderBooks).not.toHaveProperty("Bob|Carol");
  });
});

describe("marketDetailDataReducer", () => {
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

    const state = marketDetailDataReducer(
      createMarketDetailDataState(initial),
      {
        type: "marketSubmitRefreshLoaded",
        detail: refresh,
        booksByOutcomeSetId: booksByOutcomeSetFromDetail(refresh, []),
        replaceOutcomeSetIds: [],
      },
    );
    const view = composeMarketDetail(state, "7d");

    expect(view?.state).toBe("closed");
    expect(view?.priceHistory.data).toEqual(history.data);
    expect(view?.orderBook).toBe(initial.outcomeOrderBooks?.Yes);
    expect(view?.comments).toEqual([loadedComment]);
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

    const state = marketDetailDataReducer(
      createMarketDetailDataState(initial),
      { type: "marketSnapshotLoaded", detail: refresh },
    );
    const view = composeMarketDetail(state, "7d");

    expect(view?.state).toBe("closed");
    expect(view?.comments).toEqual([loadedComment]);
    expect(view?.type).toBe("categorical");
    if (view?.type === "categorical") {
      expect(view.outcomePriceHistories.Alice.data).toEqual(
        initial.outcomePriceHistories.Alice.data,
      );
      expect(view.outcomePriceHistories.Bob.data).toEqual(
        initial.outcomePriceHistories.Bob.data,
      );
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

    const state = marketDetailDataReducer(
      createMarketDetailDataState(initial),
      {
        type: "orderBookUpdated",
        marketId: initial.id,
        outcomeSetId: "Yes",
        orderBook: liveBook,
      },
    );
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
    const stateWithLive = marketDetailDataReducer(
      createMarketDetailDataState(initial),
      {
        type: "orderBookUpdated",
        marketId: initial.id,
        outcomeSetId: "Yes",
        orderBook: liveBook,
      },
    );

    const stateAfterRest = marketDetailDataReducer(stateWithLive, {
      type: "booksLoaded",
      marketId: initial.id,
      booksByOutcomeSetId: { Yes: restBook },
      replaceOutcomeSetIds: ["Yes"],
    });
    const view = composeMarketDetail(stateAfterRest, "7d");

    expect(view?.orderBook).toBe(liveBook);
  });

  it("merges late REST history without dropping live chart points", () => {
    const initial = yesNoMarket({
      priceHistory: {
        timeframe: "7d",
        data: [{ timestamp: "2026-01-01T00:00:00Z", price: 49, volume: 1 }],
      },
    });
    const stateWithLive = marketDetailDataReducer(
      createMarketDetailDataState(initial),
      {
        type: "tradeExecuted",
        marketId: initial.id,
        outcomeSetId: "Yes",
        timeframe: "7d",
        point: { timestamp: "2026-01-03T00:00:00Z", price: 55, volume: 2 },
      },
    );

    const stateAfterRest = marketDetailDataReducer(stateWithLive, {
      type: "historyLoaded",
      marketId: initial.id,
      timeframe: "7d",
      historiesByOutcomeSetId: {
        Yes: {
          timeframe: "7d",
          data: [
            { timestamp: "2026-01-01T00:00:00Z", price: 49, volume: 1 },
            { timestamp: "2026-01-02T00:00:00Z", price: 51, volume: 1 },
          ],
        },
      },
    });
    const view = composeMarketDetail(stateAfterRest, "7d");

    expect(view?.priceHistory.data).toEqual([
      { timestamp: "2026-01-01T00:00:00Z", price: 49, volume: 1 },
      { timestamp: "2026-01-02T00:00:00Z", price: 51, volume: 1 },
      { timestamp: "2026-01-03T00:00:00Z", price: 55, volume: 2 },
    ]);
  });

  it("projects live No trades into the visible Yes chart for yes/no markets", () => {
    const update = liveTradeChartUpdate(
      yesNoMarket({ divisibility: 1000 }),
      "No",
      {
        timestamp: "2026-01-03T00:00:00Z",
        executionPrice: 200,
        amountSats: 1000,
      },
    );

    expect(update).toEqual({
      outcomeSetId: "Yes",
      point: {
        timestamp: "2026-01-03T00:00:00Z",
        price: 80,
        volume: 1000,
      },
    });
  });
});

describe("defaultLimitPriceForDivisibility", () => {
  it("uses the midpoint for supported market denominators", () => {
    expect(defaultLimitPriceForDivisibility(100)).toBe(50);
    expect(defaultLimitPriceForDivisibility(1_000)).toBe(500);
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

describe("resolvePreflightSplitBuyCollateralRequirement", () => {
  beforeEach(() => {
    mocks.resolveRootPreflightOutputAmountSats.mockReset();
  });

  it("uses face-value root collateral for non-crossing preflight limit buys", async () => {
    mocks.resolveRootPreflightOutputAmountSats.mockResolvedValue(100);
    const market = categoricalMarket();
    market.outcomeOrderBooks = {
      Alice: { bids: [], asks: [], spread: 0 },
      "Bob|Carol": {
        bids: [{ price: 20, amount: 100, total: 100 }],
        asks: [],
        spread: 0,
      },
    };

    const required = await resolvePreflightSplitBuyCollateralRequirement({
      activeMintUrl: "https://mint.example",
      preflightSplit: true,
      market,
      tradeSelection: { side: "yes", outcomeId: "outcome-0" },
      tradeAmount: 1,
      tradeSide: "buy",
      orderType: "limit",
      limitPrice: 40,
    });

    expect(required).toBe(100);
    expect(mocks.resolveRootPreflightOutputAmountSats).toHaveBeenCalledWith({
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      conditionId: "condition-1",
      amountSats: 100,
      keepOutcomeSetId: "Alice",
      lockOutcomeSetId: "Bob|Carol",
    });
  });

  it("does not replace cost gating when the limit buy can cross immediately", async () => {
    const market = categoricalMarket();
    market.outcomeOrderBooks = {
      Alice: {
        bids: [],
        asks: [{ price: 40, amount: 100, total: 100 }],
        spread: 0,
      },
      "Bob|Carol": emptyBook,
    };

    const required = await resolvePreflightSplitBuyCollateralRequirement({
      activeMintUrl: "https://mint.example",
      preflightSplit: true,
      market,
      tradeSelection: { side: "yes", outcomeId: "outcome-0" },
      tradeAmount: 1,
      tradeSide: "buy",
      orderType: "limit",
      limitPrice: 40,
    });

    expect(required).toBeNull();
    expect(mocks.resolveRootPreflightOutputAmountSats).not.toHaveBeenCalled();
  });
});

describe("decideTradeCollateralGate", () => {
  it("returns top-up when balance covers quoted cost but not preflight face collateral", () => {
    expect(
      decideTradeCollateralGate({
        balance: 50,
        tradeSide: "buy",
        tradeFaceAmount: 100,
        requiredBuyCost: 40,
        preflightSplitRequirement: 100,
      }),
    ).toEqual({ kind: "top-up", balance: 50, required: 100 });
  });

  it("proceeds when balance covers preflight face collateral", () => {
    expect(
      decideTradeCollateralGate({
        balance: 100,
        tradeSide: "buy",
        tradeFaceAmount: 100,
        requiredBuyCost: 40,
        preflightSplitRequirement: 100,
      }),
    ).toEqual({ kind: "proceed", balance: 100, required: 100 });
  });
});
