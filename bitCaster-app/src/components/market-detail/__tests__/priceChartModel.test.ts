import { describe, expect, it } from "vitest";
import type { Comment } from "@/types/market-detail";
import {
  createChartAxisTimeFormatter,
  createChartTimeFormatter,
  groupComments,
  type Series,
} from "../priceChartModel";

const timestamp = Date.parse("2026-10-08T12:00:00Z");
const bounds = { min: timestamp - 60_000, max: timestamp + 60_000 };
function comment(
  id: string,
  amount: number | null | undefined = 1,
  trade: Partial<NonNullable<Comment["trade"]>> = {},
): Comment {
  return {
    id,
    userId: `author-${id}`,
    userDisplayName: `Author ${id}`,
    content: `Comment ${id}`,
    timestamp: new Date(timestamp).toISOString(),
    likeCount: 0,
    isLiked: false,
    trade: {
      fillId: `fill-${id}`,
      outcomeId: "yes",
      executedAt: new Date(timestamp).toISOString(),
      price: 50,
      priceDenominator: 100,
      faceAmountSubunits: amount,
      ...trade,
    },
  };
}
const selectedIds = (comments: Comment[]) =>
  groupComments(comments, bounds, [], false).groups.flatMap((group) =>
    group.comments.map((item) => item.id),
  );

describe("individual chart comment selection", () => {
  it.each([0, 1, 10, 11, 150])(
    "selects at most ten of %i coincident comments before grouping",
    (count) => {
      const comments = Array.from({ length: count }, (_, index) =>
        comment(`comment-${index}`, index + 1),
      );
      const original = [...comments];
      const result = groupComments(comments, bounds, [], false);
      expect(result.groups).toHaveLength(count === 0 ? 0 : 1);
      expect(result.groups.flatMap((group) => group.comments.map((item) => item.id))).toEqual(
        original
          .slice(-10)
          .reverse()
          .map((item) => item.id),
      );
      expect(result.hiddenCount).toBe(Math.max(0, count - 10));
      expect(comments).toEqual(original);
    },
  );

  it("ranks known positive safe integers before unknown amounts and preserves group order", () => {
    const invalid = [null, undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    const comments = invalid.map((amount, index) =>
      comment(`unknown-${index}`, 1, { faceAmountSubunits: amount }),
    );
    comments.push(comment("small-known", 1), comment("large-known", Number.MAX_SAFE_INTEGER));
    expect(selectedIds(comments)).toEqual([
      "large-known",
      "small-known",
      ...invalid.map((_, index) => `unknown-${index}`),
    ]);
    const extra = comment("middle-known", 2);
    const result = groupComments([...comments, extra], bounds, [], false);
    expect(result.groups[0].comments.map((item) => item.id)).toEqual([
      "large-known",
      "middle-known",
      "small-known",
      ...invalid.slice(0, 7).map((_, index) => `unknown-${index}`),
    ]);
    expect(result.hiddenCount).toBe(1);
  });

  it("uses confirmed execution time descending, then lexical comment ID for equal amounts", () => {
    const comments = Array.from({ length: 11 }, (_, index) =>
      comment(`tie-${index.toString().padStart(2, "0")}`, 10),
    ).reverse();
    const newest = comment("newest", 10, {
      executedAt: new Date(timestamp + 1).toISOString(),
    });
    // A comment's publication time does not move its confirmed trade anchor or ranking.
    comments[0].timestamp = new Date(timestamp + 50_000).toISOString();
    const result = groupComments([...comments, newest], bounds, [], false);
    expect(result.groups[0].comments.map((item) => item.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `tie-${index.toString().padStart(2, "0")}`),
    );
    expect(result.groups[1].comments.map((item) => item.id)).toEqual(["newest"]);
    expect(result.hiddenCount).toBe(2);
    expect(groupComments([newest, ...comments.reverse()], bounds, [], false)).toEqual(result);
  });

  it("counts omitted eligible comments rather than omitted coordinate groups", () => {
    const comments = [
      ...Array.from({ length: 10 }, (_, index) => comment(`selected-${index}`, 100)),
      ...Array.from({ length: 20 }, (_, index) => comment(`omitted-${index}`, 1)),
      comment("other-coordinate", 1, { price: 25 }),
    ];
    const result = groupComments(comments, bounds, [], false);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].comments).toHaveLength(10);
    expect(result.hiddenCount).toBe(21);
  });

  it("filters invalid anchors and outside-range comments before selection and hidden counting", () => {
    const comments = [
      comment("valid", 1),
      { ...comment("unlinked", 1000), trade: null },
      comment("invalid-time", 1000, { executedAt: "invalid" }),
      comment("before", 1000, {
        executedAt: new Date(bounds.min - 1).toISOString(),
      }),
      comment("after", 1000, {
        executedAt: new Date(bounds.max + 1).toISOString(),
      }),
      comment("fraction-price", 1000, { price: 0.5 }),
      comment("negative-price", 1000, { price: -1 }),
      comment("too-high-price", 1000, { price: 101 }),
      comment("zero-denominator", 1000, { priceDenominator: 0 }),
      comment("unsupported-outcome", 1000, { outcomeId: "yes|no" }),
    ];
    const result = groupComments(comments, bounds, [], false);
    expect(result.groups.flatMap((group) => group.comments.map((item) => item.id))).toEqual([
      "valid",
    ]);
    expect(result.hiddenCount).toBe(0);
    expect(groupComments(comments, null, [], false)).toEqual({
      groups: [],
      hiddenCount: 0,
    });
  });

  it("preserves exact binary complement coordinates, stable IDs, and ranked group previews", () => {
    const yes = comment("yes", 10, { outcomeId: "YES", price: 75 });
    const no = comment("no", 100, { outcomeId: "No", price: 25 });
    const result = groupComments([yes, no], bounds, [], false);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      timestamp,
      price: 75,
      seriesId: "primary",
    });
    expect(result.groups[0].comments.map((item) => item.id)).toEqual(["no", "yes"]);
    expect(decodeURIComponent(result.groups[0].id)).toBe(
      JSON.stringify(["primary", timestamp, 75]),
    );
    expect(groupComments([no, yes], bounds, [], false)).toEqual(result);
    const inserted = comment("inserted", 1000, { price: 80 });
    expect(groupComments([inserted, yes, no], bounds, [], false).groups[0].id).toBe(
      result.groups[0].id,
    );
  });

  it("keeps categorical series identity and excludes unmatched series before counting", () => {
    const series: Series[] = [{ id: "A", label: "Outcome A", color: "#112233", data: [] }];
    const comments = [
      comment("a", 1, { outcomeId: "A", price: 31 }),
      comment("b", 1000, { outcomeId: "B" }),
      comment("complement", 1000, { outcomeId: "A|B" }),
    ];
    const result = groupComments(comments, bounds, series, true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      price: 31,
      seriesId: "A",
      seriesLabel: "Outcome A",
    });
    expect(result.groups[0].comments.map((item) => item.id)).toEqual(["a"]);
    expect(result.hiddenCount).toBe(0);
  });
});

describe("axis timestamp context", () => {
  it.each(["en", "ja"])("distinguishes subminute ALL ticks in %s", (locale) => {
    const first = new Date(2026, 9, 8, 10, 0, 5).getTime();
    const last = new Date(2026, 9, 8, 10, 0, 25).getTime();
    const format = createChartAxisTimeFormatter(locale, "all", { min: first, max: last });
    expect(format(first)).toContain(":00:05");
    expect(format(last)).toContain(":00:25");
    expect(format(first)).not.toBe(format(last));
    expect(createChartTimeFormatter(locale, "all")(first)).toContain(":00:05");
  });
  it.each(["en", "ja"])("keeps year context across ALL years in %s", (locale) => {
    const first = new Date(2026, 11, 31, 12).getTime();
    const last = new Date(2027, 0, 1, 12).getTime();
    const format = createChartAxisTimeFormatter(locale, "all", { min: first, max: last });
    expect(format(first)).toContain("26");
    expect(format(last)).toContain("27");
    expect(format(first)).not.toBe(format(last));
  });
});

it.each(["en", "ja"])("uses native tick precision at ALL span boundaries in %s", (locale) => {
  const first = new Date(2026, 9, 8, 10, 0, 15).getTime();
  const ticks = [first, first + 30_000, first + 90_000];
  const format = createChartAxisTimeFormatter(locale, "all", { min: first, max: ticks[2] });
  expect(format(ticks[0], ticks)).toContain(":00:15");
  expect(format(ticks[1], ticks)).toContain(":00:45");
  const longTicks = [first, first + 6 * 3_600_000, first + 30 * 3_600_000];
  const longFormat = createChartAxisTimeFormatter(locale, "all", { min: first, max: longTicks[2] });
  expect(new Set(longTicks.map((tick) => longFormat(tick, longTicks))).size).toBe(3);
  expect(longFormat(first, longTicks)).toContain(":00");
});
