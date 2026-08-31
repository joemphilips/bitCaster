import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MarketDetail, OrderBook } from "@/types/market-detail";

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
    divisibility: 1_000,
    baseUnit: "sats",
    registeredPrimitiveOutcomeIds: ["YES", "NO"],
    outcomes: [
      { id: "Yes", label: "Yes", odds: null },
      { id: "No", label: "No", odds: null },
    ],
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

describe("useMarketPrice", () => {
  it("returns a nullable market price and midpoint only as the order-entry default when no trades exist", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 0, no: 100 } }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBeNull();
    expect(result.current.defaultOrderPrice).toBe(500);
  });

  it("uses the spread midpoint as the order entry default when both sides exist", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 60, no: 40 } }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: {
          bids: [{ price: 400, amount: 1, total: 1 }],
          asks: [{ price: 700, amount: 1, total: 1 }],
          spread: 300,
        },
      }),
    );

    expect(result.current.currentPrice).toBeNull();
    expect(result.current.defaultOrderPrice).toBe(550);
  });

  it("derives yes/no from the latest source record and its same-fill complement", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          currentOdds: { yes: 60, no: 40 },
          latestConfirmedTrades: [{
            primitiveOutcomeId: "YES",
            fillId: "fill-1",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 600,
            divisibility: 1_000,
            faceAmountSubunits: 100,
          }],
        }),
        marketId: "condition-1-No",
        outcomeSetId: "No",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(400);
    expect(result.current.defaultOrderPrice).toBe(400);
  });

  it("chooses the latest yes/no source across both primitive outcomes", () => {
    const latestNo = {
      primitiveOutcomeId: "NO" as const,
      fillId: "fill-no",
      executedAt: "2026-01-02T00:00:00Z",
      eventOrder: "0002",
      priceTick: 250,
      divisibility: 1_000 as const,
      faceAmountSubunits: 100,
    };
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          latestConfirmedTrades: [
            {
              primitiveOutcomeId: "YES",
              fillId: "fill-yes",
              executedAt: "2026-01-01T00:00:00Z",
              eventOrder: "0001",
              priceTick: 800,
              divisibility: 1_000,
              faceAmountSubunits: 100,
            },
            latestNo,
          ],
        }),
        marketId: "condition-1-No",
        outcomeSetId: "No",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(250);
  });

  it("rejects an unknown or wrong-case yes/no route", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          latestConfirmedTrades: [{
            primitiveOutcomeId: "YES",
            fillId: "fill-route",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 600,
            divisibility: 1_000,
            faceAmountSubunits: 100,
          }],
        }),
        marketId: "condition-1-no",
        outcomeSetId: "no",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBeNull();
  });

  it("rejects a confirmed price when marketId is for a different condition", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          divisibility: 1_000_000,
          latestConfirmedTrades: [{
            primitiveOutcomeId: "YES",
            fillId: "fill-mismatched-market",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 600_000,
            divisibility: 1_000_000,
            faceAmountSubunits: 100,
          }],
        }),
        marketId: "condition-2-Yes",
        outcomeSetId: "Yes",
        orderBook: {
          bids: [{ price: 400_000, amount: 1, total: 1 }],
          asks: [{ price: 700_000, amount: 1, total: 1 }],
          spread: 300_000,
        },
      }),
    );

    expect(result.current.currentPrice).toBeNull();
    expect(result.current.defaultOrderPrice).toBe(500);
  });

  it("keeps categorical outcomes independent and does not normalize missing prices", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          type: "categorical",
          outcomes: [
            { id: "alice", label: "Alice", odds: 70 },
            { id: "bob", label: "Bob", odds: 20 },
            { id: "carol", label: "Carol", odds: 10 },
          ],
          registeredPrimitiveOutcomeIds: ["alice", "bob", "carol"],
          latestConfirmedTrades: [
            { primitiveOutcomeId: "alice", fillId: "fill-a", executedAt: "2026-01-01T00:00:00Z", eventOrder: "0001", priceTick: 700, divisibility: 1_000, faceAmountSubunits: 100 },
            { primitiveOutcomeId: "bob", fillId: "fill-b", executedAt: "2026-01-02T00:00:00Z", eventOrder: "0002", priceTick: 200, divisibility: 1_000, faceAmountSubunits: 100 },
          ],
        } as Partial<MarketDetail>),
        marketId: "condition-1-Bob",
        outcomeSetId: "Bob",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(200);
  });

  it("rejects duplicate or unknown categorical complement routes", () => {
    const market = makeMarket({
      type: "categorical",
      outcomes: [
        { id: "alice", label: "Alice", odds: null },
        { id: "bob", label: "Bob", odds: null },
        { id: "carol", label: "Carol", odds: null },
      ],
      registeredPrimitiveOutcomeIds: ["alice", "bob", "carol"],
      latestConfirmedTrades: [{
        primitiveOutcomeId: "alice",
        fillId: "fill-complement",
        executedAt: "2026-01-01T00:00:00Z",
        eventOrder: "0001",
        priceTick: 700,
        divisibility: 1_000,
        faceAmountSubunits: 100,
      }],
    });

    const duplicate = renderHook(() =>
      useMarketPrice({ market, marketId: "condition-1-Bob|Bob", outcomeSetId: "Bob|Bob", orderBook: emptyBook }),
    );
    const unknown = renderHook(() =>
      useMarketPrice({ market, marketId: "condition-1-Bob|Unknown", outcomeSetId: "Bob|Unknown", orderBook: emptyBook }),
    );

    expect(duplicate.result.current.currentPrice).toBeNull();
    expect(unknown.result.current.currentPrice).toBeNull();
  });

  it("maps numeric currentPrice percentages onto the market divisibility range", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          type: "numeric",
          divisibility: 1_000_000,
          currentPrice: null,
          loBound: 0,
          hiBound: 100,
          precision: 0,
          unit: "USD",
          registeredPrimitiveOutcomeIds: ["HI", "LO"],
          latestConfirmedTrades: [{
            primitiveOutcomeId: "LO",
            fillId: "numeric-fill",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 250_000,
            divisibility: 1_000_000,
            faceAmountSubunits: 100,
          }],
        } as Partial<MarketDetail>),
        marketId: "condition-1-HI",
        outcomeSetId: "HI",
        orderBook: emptyBook,
      }),
    );

    expect(result.current.currentPrice).toBe(750_000);
  });

  it("fails closed for numeric identity variants and invalid authority", () => {
    const unknownIdentity = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          type: "numeric",
          divisibility: 1_000_000,
          currentPrice: null,
          loBound: 0,
          hiBound: 100,
          precision: 0,
          unit: "USD",
          registeredPrimitiveOutcomeIds: ["hi", "lo"],
          latestConfirmedTrades: [{
            primitiveOutcomeId: "hi",
            fillId: "numeric-unknown",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 250_000,
            divisibility: 1_000_000,
            faceAmountSubunits: 100,
          }],
        } as Partial<MarketDetail>),
        marketId: "condition-1-hi",
        outcomeSetId: "hi",
        orderBook: emptyBook,
      }),
    );
    const invalidAuthority = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          latestConfirmedTradesValid: false,
          latestConfirmedTrades: [{
            primitiveOutcomeId: "YES",
            fillId: "invalid-authority",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 600,
            divisibility: 1_000,
            faceAmountSubunits: 100,
          }],
        }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: emptyBook,
      }),
    );

    expect(unknownIdentity.result.current.currentPrice).toBeNull();
    expect(invalidAuthority.result.current.currentPrice).toBeNull();
  });

  it("uses current price as the order entry default when there is no spread", () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({
          currentOdds: { yes: null, no: null },
          latestConfirmedTrades: [{
            primitiveOutcomeId: "YES",
            fillId: "fill-2",
            executedAt: "2026-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 650,
            divisibility: 1_000,
            faceAmountSubunits: 100,
          }],
        }),
        marketId: "condition-1-Yes",
        outcomeSetId: "Yes",
        orderBook: {
          bids: [{ price: 400, amount: 1, total: 1 }],
          asks: [],
          spread: 0,
        },
      }),
    );

    expect(result.current.defaultOrderPrice).toBe(650);
  });

  it("does not override the user's manual price edit in a page-style consumer", () => {
    const bookWithoutSpread: OrderBook = {
      bids: [{ price: 400, amount: 1, total: 1 }],
      asks: [],
      spread: 0,
    };
    const bookWithSpread: OrderBook = {
      bids: [{ price: 400, amount: 1, total: 1 }],
      asks: [{ price: 700, amount: 1, total: 1 }],
      spread: 300,
    };
    let manuallyEdited = false;
    let limitPrice = 0;

    const { result, rerender } = renderHook(
      ({ orderBook }: { orderBook: OrderBook }) => {
        const marketPrice = useMarketPrice({
          market: makeMarket({
            currentOdds: { yes: null, no: null },
            latestConfirmedTrades: [{
              primitiveOutcomeId: "YES",
              fillId: "fill-3",
              executedAt: "2026-01-01T00:00:00Z",
              eventOrder: "0001",
              priceTick: 600,
              divisibility: 1_000,
              faceAmountSubunits: 100,
            }],
          }),
          marketId: "condition-1-Yes",
          outcomeSetId: "Yes",
          orderBook,
        });
        if (!manuallyEdited) limitPrice = marketPrice.defaultOrderPrice;
        return marketPrice;
      },
      { initialProps: { orderBook: bookWithoutSpread } },
    );

    expect(limitPrice).toBe(600);
    manuallyEdited = true;
    limitPrice = 420;

    rerender({ orderBook: bookWithSpread });

    expect(result.current.defaultOrderPrice).toBe(550);
    expect(limitPrice).toBe(420);
  });
});
