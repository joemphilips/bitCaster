import { fetchOrderBook } from "@/lib/markets";
import type { OrderBook } from "@/types/market-detail";

const inFlightByMarket = new Map<string, Promise<OrderBook>>();

export function refreshOrderBook(marketId: string): Promise<OrderBook> {
  const existing = inFlightByMarket.get(marketId);
  if (existing) return existing;

  const request = fetchOrderBook(marketId).finally(() => {
    if (inFlightByMarket.get(marketId) === request) {
      inFlightByMarket.delete(marketId);
    }
  });
  inFlightByMarket.set(marketId, request);
  return request;
}
