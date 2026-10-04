import { describe, expect, it } from "vitest";
import { confirmedPriceAtOrBefore, windowPriceHistory, TIMEFRAME_WINDOW_MS } from "../priceHistory";

describe("authoritative history windows", () => {
  it.each(["1h", "24h", "7d", "30d", "all"] as const)(
    "%s preserves server buckets and the inclusive server cutoff",
    (timeframe) => {
      const asOf = Date.parse("2026-09-27T12:00:00Z");
      const width = TIMEFRAME_WINDOW_MS[timeframe];
      const cutoff = asOf - (width ?? 60_000);
      const points = [-1, 0, 1, 500].map((offset, index) => ({
        timestamp: new Date(cutoff + offset).toISOString(),
        eventOrder: ["opaque-z", "opaque-a", "opaque-m", "opaque-m"][index],
        price: 40 + index,
      }));
      const history = { timeframe, asOf: new Date(asOf).toISOString(), data: points };
      expect(windowPriceHistory(history).data).toEqual(width === null ? points : points.slice(1));
      expect(windowPriceHistory(history, asOf + 1).data).toEqual(
        width === null ? points : points.slice(2),
      );
      expect(history.data).toEqual(points);
    },
  );
  it("retains every all sample without browser compaction", () => {
    const data = Array.from({ length: 1002 }, (_, index) => ({
      timestamp: new Date(index).toISOString(),
      eventOrder: "opaque",
      price: index % 100,
    }));
    const history = { timeframe: "all" as const, data };
    expect(windowPriceHistory(history)).toBe(history);
  });
});

describe("confirmed historical readout", () => {
  const points = [
    { eventOrder: "001", timestamp: "2026-09-27T00:00:00.100Z", price: 40 },
    { eventOrder: "002", timestamp: "2026-09-27T00:00:01.900Z", price: 55 },
  ];

  it.each([
    ["2026-09-27T00:00:00.000Z", null],
    ["2026-09-27T00:00:00.100Z", 40],
    ["2026-09-27T00:00:01.899Z", 40],
    ["2026-09-27T00:00:01.900Z", 55],
    ["2026-09-27T00:00:02.000Z", 55],
  ])("uses only a point confirmed at or before %s", (timestamp, expected) => {
    expect(confirmedPriceAtOrBefore(points, Date.parse(timestamp) / 1000)).toBe(expected);
  });

  it("keeps an untraded outcome unavailable", () => {
    expect(confirmedPriceAtOrBefore([], Date.parse(points[0].timestamp) / 1000)).toBeNull();
  });
});
