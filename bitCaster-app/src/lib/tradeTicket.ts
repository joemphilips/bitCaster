import type { SubmitOrderRequest } from "@/lib/markets";
import type {
  MarketDetail,
  OrderBook,
  OrderType,
  TradeSelection,
  TradeSide,
} from "@/types/market-detail";

export interface TradeTicket {
  marketId: string;
  request: Omit<SubmitOrderRequest, "ephemeralPubkey">;
}

export type TradeTicketErrorCode =
  | "missing-selection"
  | "invalid-amount"
  | "unsupported-market"
  | "no-market-liquidity"
  | "missing-order-book";

export class TradeTicketError extends Error {
  constructor(
    public readonly code: TradeTicketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TradeTicketError";
  }
}

function canonicalOutcomeName(
  market: MarketDetail,
  selection: TradeSelection,
): string | null {
  if (market.type === "yesno") {
    if (selection.side === "yes") return "YES";
    if (selection.side === "no") return "NO";
    return null;
  }

  if (market.type === "categorical") {
    const selected = market.outcomes.find((o) => o.id === selection.outcomeId);
    return selected?.label ?? null;
  }

  if (market.type === "numeric") {
    if (selection.side === "hi") return "HI";
    if (selection.side === "lo") return "LO";
  }

  return null;
}

function marketPriceFor(
  side: TradeSide,
  orderBook: OrderBook | null | undefined,
  complementaryOrderBook: OrderBook | null | undefined,
): number {
  const direct = side === "buy" ? orderBook?.asks[0] : orderBook?.bids[0];
  if (direct) return direct.price;

  // Buy-side complementary matching: buying outcome A can execute against a
  // resting buy for not-A when the two bid prices sum to at least 100. The
  // taker's limit price is therefore the complement of the best opposite bid.
  if (side === "buy") {
    const complementaryBid = complementaryOrderBook?.bids[0];
    if (complementaryBid) return 100 - complementaryBid.price;
  }

  if (!orderBook && !complementaryOrderBook) {
    throw new TradeTicketError(
      "missing-order-book",
      "No live order book is loaded for this outcome yet. Use Limit to post an order, or try again after the book loads.",
    );
  }

  throw new TradeTicketError(
    "no-market-liquidity",
    "No matching liquidity is available right now. Switch to Limit to post an order to the book.",
  );
}

export function buildTradeTicket(params: {
  market: MarketDetail;
  selection: TradeSelection | null;
  amountSats: number;
  side: TradeSide;
  orderType: OrderType;
  limitPrice: number;
  orderBook?: OrderBook | null;
  complementaryOrderBook?: OrderBook | null;
}): TradeTicket {
  const {
    market,
    selection,
    amountSats,
    side,
    orderType,
    limitPrice,
    orderBook,
    complementaryOrderBook,
  } = params;

  if (!selection) {
    throw new TradeTicketError(
      "missing-selection",
      "Choose an outcome before placing an order.",
    );
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new TradeTicketError(
      "invalid-amount",
      "Enter an amount greater than zero.",
    );
  }
  if (!Number.isInteger(amountSats) || amountSats % 100 !== 0) {
    throw new TradeTicketError(
      "invalid-amount",
      "Enter an amount in 100 sat increments.",
    );
  }

  const outcomeName = canonicalOutcomeName(market, selection);
  if (!outcomeName) {
    throw new TradeTicketError(
      "unsupported-market",
      "This market type is not supported by the trading form yet.",
    );
  }

  const price =
    orderType === "limit"
      ? Math.min(Math.max(Math.round(limitPrice), 1), 99)
      : marketPriceFor(side, orderBook, complementaryOrderBook);

  return {
    marketId: `${market.id}-${outcomeName}`,
    request: {
      outcomeId: outcomeName,
      side: side === "buy" ? "Buy" : "Sell",
      price,
      amountSats,
      timeInForce: orderType === "market" ? "FAK" : "GTC",
    },
  };
}
