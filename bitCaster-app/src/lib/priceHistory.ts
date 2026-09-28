import type { PriceHistory, PricePoint } from "@/types/market-detail";

const MAX_PRICE_HISTORY_POINTS_PER_OUTCOME = 1000;

// Width of each timeframe window in milliseconds. The chart X-axis scale is
// derived from the visible point span, so trimming the series to the active
// window keeps the date ticks proportional to the selected timeframe instead
// of always spanning the full retained history. `all` keeps the newest capped
// retained points so live tabs cannot grow without bound.
const TIMEFRAME_WINDOW_MS: Record<PriceHistory["timeframe"], number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * Trim a price series to the active timeframe window. Anchored on the newest
 * sample (not wall-clock now) so a series whose latest point is older than the
 * window still renders. One pre-window point is retained so the step line has a
 * defined starting value at the left edge of the window.
 */
export function windowPriceHistory(history: PriceHistory): PriceHistory {
  const windowMs = TIMEFRAME_WINDOW_MS[history.timeframe];
  if (history.data.length === 0) return history;
  const sorted = latestPricePointsPerSecond(history.data);
  if (windowMs === null) {
    return {
      ...history,
      data: sorted.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
    };
  }
  const newest = new Date(sorted[sorted.length - 1].timestamp).getTime();
  const cutoff = newest - windowMs;
  const firstInWindow = sorted.findIndex((p) => new Date(p.timestamp).getTime() >= cutoff);
  if (firstInWindow <= 0) {
    return {
      ...history,
      data: sorted.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
    };
  }
  // Keep one point before the cutoff so the line has a left-edge value.
  return {
    ...history,
    data: sorted.slice(firstInWindow - 1).slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
  };
}

export function latestPricePointsPerSecond(points: readonly PricePoint[]): PricePoint[] {
  const bySecond = new Map<number, PricePoint>();
  for (const point of points) {
    const second = Math.floor(Date.parse(point.timestamp) / 1000);
    const previous = bySecond.get(second);
    // Arrival order cannot settle ties between REST and live trade updates.
    if (!previous || point.eventOrder > previous.eventOrder) bySecond.set(second, point);
  }
  return [...bySecond.entries()].sort(([left], [right]) => left - right).map(([, point]) => point);
}
