import { describe, expect, it } from "vitest";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import { computeLimitOrderPreview, displaySharesToFaceSubunits } from "@/lib/tradeCostPreview";
import type { MarketDetail } from "@/types/market-detail";

const market: MarketDetail = {
  id: "condition-1",
  title: "Test market",
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
    bids: [{ price: 4_700, amount: 1_000_000, total: 1_000_000 }],
    asks: [{ price: 5_300, amount: 1_000_000, total: 1_000_000 }],
    spread: 600,
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
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "limit",
      limitPrice: 500,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-1-Yes");
    expect(ticket.request).toMatchObject({
      outcomeId: "Yes",
      tokenSide: "Outcome",
      side: "Buy",
      price: 500,
      amountSubunits: 1_000_000,
      timeInForce: "GTC",
    });
  });

  it("uses aggressive FAK pricing for executable market buys", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "market",
      limitPrice: 500,
      orderBook: market.orderBook,
    });

    expect(ticket.request.price).toBe(9999);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("rejects amounts outside the sat whole-share face amount", () => {
    expect(() =>
      buildTradeTicket({
        market,
        selection: { side: "yes" },
        amountSats: 500,
        side: "Buy",
        orderType: "limit",
        limitPrice: 500,
        orderBook: market.orderBook,
      }),
    ).toThrow("Enter an amount in 10000 sub-unit increments.");
  });

  it("builds sell orders after same-outcome CTF swaps are supported", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSubunits: 1_000_000,
      side: "Sell",
      orderType: "limit",
      limitPrice: 500,
      orderBook: market.orderBook,
    });

    expect(ticket.request.side).toBe("Sell");
    expect(ticket.request.outcomeId).toBe("Yes");
    expect(ticket.request.price).toBe(500);
  });

  it("builds Buy NO market orders as the YES complement for yes/no markets", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "no" },
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "market",
      limitPrice: 500,
      orderBook: {
        bids: [{ price: 4_000, amount: 1_000_000, total: 1_000_000 }],
        asks: [{ price: 6_200, amount: 1_000_000, total: 1_000_000 }],
        spread: 2_200,
      },
      complementaryOrderBook: {
        bids: [{ price: 5_000, amount: 1_000_000, total: 1_000_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(ticket.marketId).toBe("condition-1-Yes");
    expect(ticket.request.outcomeId).toBe("Yes");
    expect(ticket.request.tokenSide).toBe("Complement");
    expect(ticket.request.price).toBe(9999);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("uses aggressive FAK pricing for Buy NO complement market orders when YES bids are available", () => {
    const ticket = buildTradeTicket({
      market,
      selection: { side: "no" },
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "market",
      limitPrice: 500,
      orderBook: {
        bids: [],
        asks: [],
        spread: 0,
      },
      complementaryOrderBook: {
        bids: [{ price: 5_000, amount: 20_000_000, total: 20_000_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(ticket.marketId).toBe("condition-1-Yes");
    expect(ticket.request.outcomeId).toBe("Yes");
    expect(ticket.request.tokenSide).toBe("Complement");
    expect(ticket.request.price).toBe(9999);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("builds categorical YES tickets with the selected oracle label", () => {
    const ticket = buildTradeTicket({
      market: categoricalMarket,
      selection: { side: "yes", outcomeId: "outcome-0" },
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Alice");
    expect(ticket.request.outcomeId).toBe("Alice");
  });

  it("builds categorical NO tickets on primitive route with complement token side", () => {
    const ticket = buildTradeTicket({
      market: categoricalMarket,
      selection: { side: "no", outcomeId: "outcome-0" },
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
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
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
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
      amountSubunits: 1_000_000,
      side: "Buy",
      orderType: "limit",
      limitPrice: 4_500,
      orderBook: market.orderBook,
    });

    expect(ticket.marketId).toBe("condition-2-Bob");
    expect(ticket.request.outcomeId).toBe("Bob");
    expect(ticket.request.tokenSide).toBe("Complement");
  });

  it("sends protocol face amountSubunits, not the derived display cost", () => {
    const displayShares = 10;
    const faceAmountSats = displaySharesToFaceSubunits(displayShares, "sat", 10_000);
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: faceAmountSats,
      side: "Buy",
      orderType: "limit",
      limitPrice: 400,
      orderBook: market.orderBook,
    });

    const preview = computeLimitOrderPreview({
      displayShares,
      limitPrice: 400,
      feePercent: 2,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });

    expect(ticket.request.amountSubunits).toBe(faceAmountSats);
    // The cost preview is strictly smaller here (price 400 < 1000) and is the
    // thing we must NOT put on the wire.
    expect(preview.totalCost).not.toBe(ticket.request.amountSubunits);
    expect(preview.amount).toBe(displayShares);
    // amountSubunits stays a multiple of the market divisibility.
    expect(ticket.request.amountSubunits % 10_000).toBe(0);
  });

  it("converts share input to face amount in the order payload", () => {
    const displayShares = 50;
    const divisibility = 10_000;
    const ticket = buildTradeTicket({
      market: { ...market, divisibility },
      selection: { side: "yes" },
      amountSats: displaySharesToFaceSubunits(displayShares, "sat", divisibility),
      side: "Buy",
      orderType: "limit",
      limitPrice: 300,
      orderBook: market.orderBook,
    });

    expect(ticket.request.amountSubunits).toBe(500_000);
    expect(ticket.request.price).toBe(300);
  });

  it("uses an aggressive worst-price limit for market buys while keeping face amountSubunits", () => {
    const shares = 50_000_000;
    const ticket = buildTradeTicket({
      market,
      selection: { side: "yes" },
      amountSats: shares,
      side: "Buy",
      orderType: "market",
      limitPrice: 500,
      orderBook: market.orderBook,
    });
    // Market buy: face shares + worst-acceptable price (max 9999) + FAK.
    expect(ticket.request.amountSubunits).toBe(shares);
    expect(ticket.request.price).toBe(9999);
    expect(ticket.request.timeInForce).toBe("FAK");
  });

  it("rejects market orders with no visible liquidity instead of emitting price 0", () => {
    expect(() =>
      buildTradeTicket({
        market,
        selection: { side: "yes" },
        amountSubunits: 1_000_000,
        side: "Buy",
        orderType: "market",
        limitPrice: 500,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    ).toThrow(TradeTicketError);
  });
});
