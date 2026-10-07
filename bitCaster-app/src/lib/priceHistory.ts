import type { PriceHistory, PricePoint } from "@/types/market-detail";

export const TIMEFRAME_WINDOW_MS: Record<PriceHistory["timeframe"], number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export function windowPriceHistory(
  history: PriceHistory,
  evaluationMs = history.asOf ? Date.parse(history.asOf) : null,
): PriceHistory {
  const windowMs = TIMEFRAME_WINDOW_MS[history.timeframe];
  if (windowMs === null || evaluationMs === null) return history;
  const cutoff = evaluationMs - windowMs;
  return {
    ...history,
    data: history.data.filter((point) => Date.parse(point.timestamp) >= cutoff),
  };
}

// Points must use ascending timestamp order.
export function confirmedPriceAtOrBefore(
  points: readonly PricePoint[],
  timestampSeconds: number,
): number | null {
  let first = 0;
  let last = points.length - 1;
  let price: number | null = null;
  while (first <= last) {
    const middle = Math.floor((first + last) / 2);
    const point = points[middle];
    if (Date.parse(point.timestamp) / 1000 <= timestampSeconds) {
      price = point.price;
      first = middle + 1;
    } else {
      last = middle - 1;
    }
  }
  return price;
}
