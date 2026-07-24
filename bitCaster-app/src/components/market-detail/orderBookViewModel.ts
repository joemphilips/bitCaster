import type { Order, OrderBook } from "@/types/market-detail";

export type OrderBookCompleteness = "direct" | "executable";

export type OrderBookDepthSide = "bid" | "ask";

export interface OrderBookDepthRow {
  side: OrderBookDepthSide;
  order: Order;
  depthPercent: number;
}

export function buildOrderBookDepthRows(
  orders: Order[],
  side: OrderBookDepthSide,
  comparisonOrders: Order[] = orders,
): OrderBookDepthRow[] {
  const maxAmount = Math.max(
    ...orders.map((order) => order.amount),
    ...comparisonOrders.map((order) => order.amount),
    0,
  );
  return orders.map((order) => ({
    side,
    order,
    depthPercent: maxAmount > 0 ? Math.round((order.amount / maxAmount) * 100) : 0,
  }));
}

export function computeSpreadMidpoint(orderBook: OrderBook | null | undefined): number | null {
  const bestBid = orderBook?.bids[0]?.price;
  const bestAsk = orderBook?.asks[0]?.price;
  if (
    typeof bestBid !== "number" ||
    typeof bestAsk !== "number" ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk)
  ) {
    return null;
  }
  return (bestBid + bestAsk) / 2;
}

export function deriveExecutableOrderBook(input: {
  book: OrderBook;
  complementBook?: OrderBook | null;
  divisibility?: number;
  completeness: OrderBookCompleteness;
}): OrderBook {
  const depthLimit = normalizeDepthLimit(input.book.depthLimit);
  const book = recomputeBookTotals(input.book, depthLimit);
  if (input.completeness === "executable" || !input.complementBook) {
    return book;
  }

  const asks = mergeOrdersByPrice(
    [
      ...book.asks,
      ...ordersFromComplementBids(input.complementBook.bids, input.divisibility ?? 10_000),
    ],
    "ask",
    depthLimit,
  );
  return withSpread({ ...book, asks, depthLimit: input.book.depthLimit });
}

export function recomputeBookTotals(
  orderBook: OrderBook,
  limit = normalizeDepthLimit(orderBook.depthLimit),
): OrderBook {
  const bids = mergeOrdersByPrice(orderBook.bids, "bid", limit);
  const asks = mergeOrdersByPrice(orderBook.asks, "ask", limit);
  return withSpread({ ...orderBook, bids, asks });
}

export function mergeOrdersByPrice(orders: Order[], side: "bid" | "ask", limit?: number): Order[] {
  const byPrice = new Map<number, number>();
  for (const order of orders) {
    byPrice.set(order.price, (byPrice.get(order.price) ?? 0) + order.amount);
  }
  let total = 0;
  const sorted = [...byPrice.entries()]
    .map(([price, amount]) => ({ price, amount }))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return (limit ? sorted.slice(0, limit) : sorted).map(({ price, amount }) => {
    total += amount;
    return { price, amount, total };
  });
}

function normalizeDepthLimit(limit: number | undefined): number | undefined {
  return Number.isFinite(limit) && limit !== undefined && limit > 0 ? Math.floor(limit) : undefined;
}

function withSpread(orderBook: OrderBook): OrderBook {
  return {
    ...orderBook,
    spread:
      orderBook.bids.length > 0 && orderBook.asks.length > 0
        ? Math.max(0, orderBook.asks[0].price - orderBook.bids[0].price)
        : orderBook.spread,
  };
}

function ordersFromComplementBids(orders: Order[], divisibility: number): Order[] {
  const denominator = Number.isFinite(divisibility) && divisibility > 0 ? divisibility : 10_000;
  return orders.map((order) => ({
    price: denominator - order.price,
    amount: order.amount,
    total: order.amount,
  }));
}
