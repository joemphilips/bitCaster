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
  liquiditySats: 0,
  traderCount: 0,
  volumeLifetimeSats: 0,
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
  outcomes: [
    { id: "outcome-0", label: "Yes", odds: 50 },
    { id: "outcome-1", label: "No", odds: 50 },
  ],
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

const categoricalMarket: MarketDetail = {
  ...market,
  id: "condition-2",
  type: "categorical",
  outcomes: [
    { id: "outcome-0", label: "Alice", odds: 33.33 },
    { id: "outcome-1", label: "Bob", odds: 33.33 },
    { id: "outcome-2", label: "Carol", odds: 33.33 },
  ],
  outcomePriceHistories: {},
  outcomeOrderBooks: {},
};

describe("buildTradeTicket", () => {
  it("builds limit orders with oracle-verbatim Yes outcome names and valid GTC price", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 50,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-1-Yes");
    expect(ticket.request).toMatchObject({
      outcomeId: "Yes",
      tokenSide: "Outcome",
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

  it("builds sell orders after same-outcome CTF swaps are supported", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: 100,
      side: "sell",
      orderType: "limit",
      limitPrice: 50,
      orderBook: market.orderBook,
    });

    expect(ticket.request.side).toBe("Sell");
    expect(ticket.request.outcomeId).toBe("Yes");
    expect(ticket.request.price).toBe(50);
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

    expect(ticket.marketId).toBe("condition-1-No");
    expect(ticket.request.outcomeId).toBe("No");
    expect(ticket.request.tokenSide).toBe("Outcome");
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

    expect(ticket.marketId).toBe("condition-1-No");
    expect(ticket.request.outcomeId).toBe("No");
    expect(ticket.request.tokenSide).toBe("Outcome");
    expect(ticket.request.price).toBe(99);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("builds categorical YES tickets with the selected oracle label", () => {
    const ticket = buildTradeTicket({
      market: categoricalMarket,
      selection: { side: "yes", outcomeId: "outcome-0" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 45,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Alice");
    expect(ticket.request.outcomeId).toBe("Alice");
  });

  it("builds categorical NO tickets on primitive route with complement token side", () => {
    const ticket = buildTradeTicket({
      market: categoricalMarket,
      selection: { side: "no", outcomeId: "outcome-0" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 45,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Alice");
    expect(ticket.request.outcomeId).toBe("Alice");
    expect(ticket.request.tokenSide).toBe("Complement");
  });

  it("uses primitive labels as stable categorical selection ids across refresh order changes", () => {
    const refreshedMarket: MarketDetail = {
      ...categoricalMarket,
      outcomes: [
        { id: "Carol", label: "Carol", odds: 33.33 },
        { id: "Alice", label: "Alice", odds: 33.33 },
        { id: "Bob", label: "Bob", odds: 33.33 },
      ],
    };

    const ticket = buildTradeTicket({
      market: refreshedMarket,
      selection: { side: "yes", outcomeId: "Alice" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 45,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Alice");
    expect(ticket.request.outcomeId).toBe("Alice");
    expect(ticket.request.tokenSide).toBe("Outcome");
  });

  it("builds two-outcome categorical NO tickets with the selected primitive route", () => {
    const twoOutcomeCategoricalMarket: MarketDetail = {
      ...categoricalMarket,
      outcomes: [
        { id: "outcome-0", label: "Alice", odds: 50 },
        { id: "outcome-1", label: "Bob", odds: 50 },
      ],
    };

    const ticket = buildTradeTicket({
      market: twoOutcomeCategoricalMarket,
      selection: { side: "no", outcomeId: "outcome-1" },
      amountSats: 100,
      side: "buy",
      orderType: "limit",
      limitPrice: 45,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Bob");
    expect(ticket.request.outcomeId).toBe("Bob");
    expect(ticket.request.tokenSide).toBe("Complement");
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
