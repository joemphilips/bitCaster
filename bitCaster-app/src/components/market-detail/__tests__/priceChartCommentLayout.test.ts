import { describe, expect, it } from "vitest";
import { layoutChartComments } from "../priceChartCommentLayout";
import type { CommentGroup, Series } from "../priceChartModel";

const plot = { x: 20, y: 10, width: 1000, height: 180 };
const scales = { x: (time: number) => 20 + time, y: (price: number) => 190 - price * 1.8 };
const group = (id: string, timestamp: number, price = 50): CommentGroup => ({
  id,
  timestamp,
  price,
  seriesId: "yes",
  seriesLabel: "YES",
  comments: [],
});
const series: Series[] = [
  {
    id: "yes",
    label: "YES",
    color: "blue",
    data: [0, 1000].map((time) => ({
      timestampMs: time,
      timestamp: new Date(time).toISOString(),
      eventOrder: String(time),
      x: time,
      y: 50,
      price: 50,
    })),
  },
];
function assertSeparated(groups: ReturnType<typeof layoutChartComments>["groups"]) {
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i],
        b = groups[j];
      expect(
        a.left + a.width! <= b.left ||
          b.left + b.width! <= a.left ||
          a.top + a.height! <= b.top ||
          b.top + b.height! <= a.top,
      ).toBe(true);
    }
}
describe("chronological chart comment placement", () => {
  it("places chronological bodies near unchanged anchors and outside the price line", () => {
    const result = layoutChartComments(
      [group("later", 700), group("first", 100), group("middle", 400)],
      series,
      plot,
      scales,
      224,
    );
    expect(result.overflowHeight).toBe(0);
    expect(result.groups.map((g) => g.id)).toEqual(["first", "middle", "later"]);
    expect(result.groups.map((g) => g.anchorLeft)).toEqual([120, 420, 720]);
    expect(result.groups.map((g) => g.anchorTop)).toEqual([100, 100, 100]);
    expect(result.groups[0].left).toBeLessThan(result.groups[1].left);
    expect(result.groups[1].left).toBeLessThan(result.groups[2].left);
    for (const body of result.groups)
      expect(body.top + body.height! < 96 || body.top > 104).toBe(true);
    assertSeparated(result.groups);
  });
  it("keeps all ten clustered bodies in deterministic row-major overflow", () => {
    const groups = Array.from({ length: 10 }, (_, i) => group(String(i), 999 + i / 100));
    const result = layoutChartComments(groups, series, plot, scales, 224);
    expect(result.overflowHeight).toBeGreaterThan(0);
    expect(result.groups).toHaveLength(10);
    expect(result.groups.map((g) => g.id)).toEqual(groups.map((g) => g.id));
    for (const body of result.groups) expect(body.top).toBeGreaterThan(224);
    for (let i = 1; i < result.groups.length; i++) {
      const a = result.groups[i - 1],
        b = result.groups[i];
      expect(b.top > a.top || (b.top === a.top && b.left > a.left)).toBe(true);
    }
    assertSeparated(result.groups);
    expect(layoutChartComments(groups, series, plot, scales, 224)).toEqual(result);
  });
  it("uses one narrow overflow column with stable equal-time ties", () => {
    const narrow = { ...plot, width: 250 };
    const groups = Array.from({ length: 10 }, (_, i) => group(String(9 - i), 100));
    const result = layoutChartComments(groups, series, narrow, scales, 224);
    expect(result.groups.map((g) => g.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(new Set(result.groups.map((g) => g.left)).size).toBe(1);
    expect(result.groups.at(-1)!.top + 44).toBeLessThanOrEqual(224 + result.overflowHeight);
    assertSeparated(result.groups);
  });
  it("does not change scales or remove bodies when crossing lines occupy the plot", () => {
    const crossing = Array.from({ length: 6 }, (_, index) => ({
      ...series[0],
      id: String(index),
      data: Array.from({ length: 12 }, (_, i) => ({
        timestampMs: i * 90,
        timestamp: new Date(i * 90).toISOString(),
        eventOrder: String(i),
        x: i * 90,
        y: 0,
        price: (i % 2 ? 95 : 5) + index / 2,
      })),
    }));
    const groups = Array.from({ length: 10 }, (_, i) => group(String(i), 990 + i, 5 + i * 10));
    const result = layoutChartComments(groups, crossing, plot, scales, 224);
    expect(result.groups.map((g) => [g.anchorLeft, g.anchorTop])).toEqual(
      groups.map((g) => [20 + g.timestamp, 190 - g.price * 1.8]),
    );
    assertSeparated(result.groups);
  });
});
