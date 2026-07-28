import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeExecuted } from "@/lib/marketHub";
import type { MarketDetail, OrderBook } from "@/types/market-detail";

const { tradeHandlers } = vi.hoisted(() => ({
  tradeHandlers: new Map<string, (trade: TradeExecuted) => void>(),
}));

vi.mock("@/lib/marketHub", () => ({
  onTradeExecuted: (marketId: string, handler: (trade: TradeExecuted) => void) => {
    tradeHandlers.set(marketId, handler);
    return () => tradeHandlers.delete(marketId);
  },
}));

import { useMarketPrice } from "../useMarketPrice";

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 };

function makeMarket(overrides: Partial<MarketDetail> = {}): MarketDetail {
  return {
    id: "condition-1",
    type: "yesno",
    title: "Will this test pass?",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: null,
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseAsset: "sat",
    divisibility: 10_000,
    baseUnit: "sats",
    creator: {
      id: "creator",
      name: "Creator",
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: "test",
      source: "oracle",
      resolutionDate: "2026-01-02T00:00:00Z",
      status: "open",
    },
    currentOdds: { yes: 50, no: 50 },
    priceHistory: { timeframe: "7d", data: [] },
    orderBook: emptyBook,
    outcomeOrderBooks: {},
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    ...overrides,
  } as MarketDetail;
}

beforeEach(() => {
  vi.clearAllMocks();
  tradeHandlers.clear();
});

describe("useMarketPrice", () => {
  it("falls back to the midpoint default when no trades exist", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 0, no: 100 } }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(5_000);
    expect(result.current.defaultOrderPrice).toBe(5_000);
  });

  it("uses creator initial probability before any trades exist", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          currentOdds: { yes: 50, no: 50 },
          initialProbabilities: { Yes: 70, No: 30 },
        }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(7_000);
    expect(result.current.defaultOrderPrice).toBe(7_000);
  });

  it("updates current price from the latest trade event", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket(),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: emptyBook,
      }),
    );

    act(() => {
      tradeHandlers.get("condition-1-Yes")?.({
        tradeId: "trade-1",
        executionPrice: 6_300,
        amountSubunits: 10,
        side: "Buy",
        timestamp: "2026-01-01T00:01:00Z",
      });
    });

    expect(result.current.currentPrice).toBe(6_300);
    expect(result.current.defaultOrderPrice).toBe(6_300);
  });

  it("uses the spread midpoint as the order entry default when both sides exist", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 60, no: 40 } }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: {
          bids: [{ price: 4_000, amount: 1, total: 1 }],
          asks: [{ price: 7_000, amount: 1, total: 1 }],
          spread: 3_000,
        },
      }),
    );

    expect(result.current.currentPrice).toBe(6_000);
    expect(result.current.defaultOrderPrice).toBe(5_500);
  });

  it("derives a yes/no No price by inverting the primary Yes history", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          currentOdds: { yes: 60, no: 40 },
          priceHistory: {
            timeframe: "7d",
            data: [{ timestamp: "2026-01-01T00:00:00Z", price: 60 }],
          },
        }),
        marketId: "condition-1-No",
        outcomeSetId: "No",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(4_000);
    expect(result.current.defaultOrderPrice).toBe(4_000);
  });

  it("derives a categorical complement price from the missing primary outcome history", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          type: "categorical",
          outcomes: [
            { id: "alice", label: "Alice", odds: 70 },
            { id: "bob", label: "Bob", odds: 20 },
            { id: "carol", label: "Carol", odds: 10 },
          ],
          outcomePriceHistories: {
            Alice: {
              timeframe: "7d",
              data: [{ timestamp: "2026-01-01T00:00:00Z", price: 70 }],
            },
          },
        } as Partial<MarketDetail>),
        marketId: "condition-1-Bob|Carol",
        outcomeSetId: "Bob|Carol",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(3_000);
  });

  it("maps numeric currentPrice percentages onto the market divisibility range", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          type: "numeric",
          divisibility: 10_000,
          currentPrice: 12.5,
          loBound: 0,
          hiBound: 100,
          precision: 0,
          unit: "USD",
        } as Partial<MarketDetail>),
        marketId: "condition-1-HI",
        outcomeSetId: "HI",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(1_250);
  });

  it("uses current price as the order entry default when there is no spread", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 65, no: 35 } }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: {
          bids: [{ price: 4_000, amount: 1, total: 1 }],
          asks: [],
          spread: 0,
        },
      }),
    );

    expect(result.current.defaultOrderPrice).toBe(6_500);
  });

  it("does not override the user's manual price edit in a page-style consumer", () => {
    const bookWithoutSpread: OrderBook = {
      bids: [{ price: 4_000, amount: 1, total: 1 }],
      asks: [],
      spread: 0,
    };
    const bookWithSpread: OrderBook = {
      bids: [{ price: 4_000, amount: 1, total: 1 }],
      asks: [{ price: 7_000, amount: 1, total: 1 }],
      spread: 3_000,
    };
    let manuallyEdited = false;
    let limitPrice = 0;

    const { result, rerender } = renderHook(
      ({ orderBook }: { orderBook: OrderBook }) => {
        const marketPrice = useMarketPrice({
          market: makeMarket({ currentOdds: { yes: 60, no: 40 } }),
          marketId: "condition-1-Yes",
          outcomeSetId: "Yes",
          orderBook,
        });
        if (!manuallyEdited) limitPrice = marketPrice.defaultOrderPrice;
        return marketPrice;
      },
      { initialProps: { orderBook: bookWithoutSpread } },
    );

    expect(limitPrice).toBe(6_000);
    manuallyEdited = true;
    limitPrice = 4_200;

    rerender({ orderBook: bookWithSpread });

    expect(result.current.defaultOrderPrice).toBe(5_500);
    expect(limitPrice).toBe(4_200);
  });
});
