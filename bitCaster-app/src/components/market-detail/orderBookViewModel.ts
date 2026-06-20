import type { Order, OrderBook } from "@/types/market-detail";
import { DEFAULT_MARKET_DIVISIBILITY } from "@bitcaster/client-sdk/marketUnits";

export type OrderBookCompleteness = "direct" | "executable";

export function deriveExecutableOrderBook(input: {
  book: OrderBook;
  complementBook?: OrderBook | null;
  divisibility?: number;
  completeness: OrderBookCompleteness;
}): OrderBook {
  const book = recomputeBookTotals(input.book);
  if (input.completeness === "executable" || !input.complementBook) {
    return book;
  }

  const asks = mergeOrdersByPrice(
    [
      ...book.asks,
      ...ordersFromComplementBids(
        input.complementBook.bids,
        input.divisibility ?? DEFAULT_MARKET_DIVISIBILITY,
      ),
    ],
    "ask",
  );
  return withSpread({ ...book, asks });
}

export function recomputeBookTotals(orderBook: OrderBook): OrderBook {
  const bids = mergeOrdersByPrice(orderBook.bids, "bid");
  const asks = mergeOrdersByPrice(orderBook.asks, "ask");
  return withSpread({ ...orderBook, bids, asks });
}

export function mergeOrdersByPrice(
  orders: Order[],
  side: "bid" | "ask",
): Order[] {
  const byPrice = new Map<number, number>();
  for (const order of orders) {
    byPrice.set(order.price, (byPrice.get(order.price) ?? 0) + order.amount);
  }
  let total = 0;
  return [...byPrice.entries()]
    .map(([price, amount]) => ({ price, amount }))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price))
    .map(({ price, amount }) => {
      total += amount;
      return { price, amount, total };
    });
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

function ordersFromComplementBids(
  orders: Order[],
  divisibility: number,
): Order[] {
  const denominator =
    Number.isFinite(divisibility) && divisibility > 0
      ? divisibility
      : DEFAULT_MARKET_DIVISIBILITY;
  return orders.map((order) => ({
    price: denominator - order.price,
    amount: order.amount,
    total: order.amount,
  }));
}
