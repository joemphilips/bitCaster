import { fetchOrderBook } from "@/lib/markets";
import type { OrderBook } from "@/types/market-detail";

const inFlightByMarket = new Map<string, Promise<OrderBook>>();
const inFlightBySignal = new WeakMap<AbortSignal, Map<string, Promise<OrderBook>>>();

export function refreshOrderBook(marketId: string, signal?: AbortSignal): Promise<OrderBook> {
  let requests = signal ? inFlightBySignal.get(signal) : inFlightByMarket;
  if (!requests) {
    requests = new Map();
    inFlightBySignal.set(signal!, requests);
  }
  const existing = requests.get(marketId);
  if (existing) return existing;

  const request = (signal ? fetchOrderBook(marketId, signal) : fetchOrderBook(marketId)).finally(
    () => {
      if (requests.get(marketId) === request) {
        requests.delete(marketId);
      }
    },
  );
  requests.set(marketId, request);
  return request;
}
