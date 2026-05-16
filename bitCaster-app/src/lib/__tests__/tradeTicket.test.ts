import { describe, expect, it } from "vitest";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import type { MarketDetail } from "@/types/market-detail";

const market: MarketDetail = {
  id: "condition-1",
  title: "Test market",
  type: "yesno",
  imageUrl: "",
  categoryTags: [],
  volume: 0,
  liquidity: 0,
  traderCount: 0,
  closingDate: "2026-12-31T00:00:00Z",
  createdDate: "2026-01-01T00:00:00Z",
  activeSince: "2026-01-01T00:00:00Z",
  baseUnit: "sats",
  creator: {
    id: "creator",
    name: "creator",
    totalMarketsCreated: 0,
    feePercent: 0,
  },
  resolution: {
    criteria: "Test market",
    source: "oracle",
    resolutionDate: "2026-12-31T00:00:00Z",
    status: "open",
  },
  priceHistory: { data: [], timeframe: "7d" },
  orderBook: {
    bids: [{ price: 47, amount: 100, total: 100 }],
    asks: [{ price: 53, amount: 100, total: 100 }],
    spread: 6,
  },
  recentTrades: [],
  comments: [],
  relatedMarkets: [],
  currentOdds: { yes: 50, no: 50 },
};

describe("buildTradeTicket", () => {
  it("builds limit orders with canonical Yes outcome names and valid GTC price", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 50,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-1-YES");
    expect(ticket.request).toMatchObject({
      outcomeId: "YES",
      side: "Buy",
      price: 50,
      amountSats: 100,
      timeInForce: "GTC",
    });
  });

  it("uses aggressive FAK pricing for executable market buys", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: 100,
      side: "buy",
      orderType: "market",
      limitPrice: 50,
      orderBook: market.orderBook,
    });

    expect(ticket.request.price).toBe(99);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("rejects amounts outside the first-release 100 sat settlement tick", () => {
    expect(() =>
      buildTradeTicket({
        market,
        selection: { side: "yes" },
        amountSats: 150,
        side: "buy",
        orderType: "limit",
        limitPrice: 50,
        orderBook: market.orderBook,
      }),
    ).toThrow("Enter an amount in 100 sat increments.");
  });

  it("prefers direct asks for Buy NO market orders when available", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "no" },
      amountSats: 100,
      side: "buy",
      orderType: "market",
      limitPrice: 50,
      orderBook: {
        bids: [{ price: 40, amount: 100, total: 100 }],
        asks: [{ price: 62, amount: 100, total: 100 }],
        spread: 22,
      },
      complementaryOrderBook: {
        bids: [{ price: 50, amount: 100, total: 100 }],
        asks: [],
        spread: 0,
      },
    });

    expect(ticket.marketId).toBe("condition-1-NO");
    expect(ticket.request.price).toBe(99);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("uses aggressive FAK pricing for Buy NO market orders when complementary YES bids are available", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "no" },
      amountSats: 100,
      side: "buy",
      orderType: "market",
      limitPrice: 50,
      orderBook: {
        bids: [],
        asks: [],
        spread: 0,
      },
      complementaryOrderBook: {
        bids: [{ price: 50, amount: 200, total: 200 }],
        asks: [],
        spread: 0,
      },
    });

    expect(ticket.marketId).toBe("condition-1-NO");
    expect(ticket.request.price).toBe(99);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("rejects market orders with no visible liquidity instead of emitting price 0", () => {
    expect(() =>
      buildTradeTicket({
        market,
        selection: { side: "yes" },
        amountSats: 100,
        side: "buy",
        orderType: "market",
        limitPrice: 50,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    ).toThrow(TradeTicketError);
  });
});
