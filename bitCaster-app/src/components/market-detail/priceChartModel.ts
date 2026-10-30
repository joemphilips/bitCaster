import { COMMENT_BODY_HEIGHT, COMMENT_BODY_WIDTH } from "./priceChartCommentLayout";
import { canonicalizeOutcomeSet } from "@/lib/outcomeSets";
import { TIMEFRAME_WINDOW_MS } from "@/lib/priceHistory";
import { normalizeOutcomeColor } from "@/components/shared/OutcomeLabel";
import type { Outcome } from "@/types/market";
import type { ChartTimeframe, Comment, PriceHistory, PricePoint } from "@/types/market-detail";

const PRIMARY_SERIES_COLOR = "rgb(59, 130, 246)";
const MAX_CHART_COMMENTS = 10;

export type ChartPoint = PricePoint & { timestampMs: number; x: number; y: number };
export type Series = { id: string; label: string; color: string; data: ChartPoint[] };
export type CommentGroup = {
  id: string;
  timestamp: number;
  price: number;
  seriesId: string;
  seriesLabel: string;
  comments: Comment[];
};
export type PositionedCommentGroup = CommentGroup & {
  plotLeft: number;
  plotTop: number;
  anchorLeft: number;
  anchorTop: number;
  left: number;
  top: number;
  width?: number;
  height?: number;
};
export type CommentGroupResult = { groups: CommentGroup[]; hiddenCount: number };
const COMMENT_MARKER_WIDTH = COMMENT_BODY_WIDTH;
const COMMENT_MARKER_HEIGHT = COMMENT_BODY_HEIGHT;
export function groupComments(
  comments: readonly Comment[],
  xScale: { min: number; max: number } | null,
  series: readonly Series[],
  isCategorical: boolean,
): CommentGroupResult {
  if (!xScale) return { groups: [], hiddenCount: 0 };
  const eligible: Array<{
    comment: Comment;
    timestamp: number;
    price: number;
    seriesId: string;
    seriesLabel: string;
    fillSize: number;
  }> = [];
  for (const comment of comments) {
    const trade = comment.trade;
    if (
      !trade ||
      !Number.isSafeInteger(trade.price) ||
      !Number.isSafeInteger(trade.priceDenominator) ||
      trade.priceDenominator <= 0 ||
      trade.price < 0 ||
      trade.price > trade.priceDenominator
    ) {
      continue;
    }

    const timestampMs = Date.parse(trade.executedAt);
    if (!Number.isFinite(timestampMs)) continue;
    const timestamp = timestampMs;
    if (timestamp < xScale.min || timestamp > xScale.max) continue;

    let price = (trade.price / trade.priceDenominator) * 100;
    let seriesId = "primary";
    let seriesLabel = "";
    if (isCategorical) {
      const matchedSeries = series.find((item) => item.id === trade.outcomeId);
      if (!matchedSeries) continue;
      seriesId = matchedSeries.id;
      seriesLabel = matchedSeries.label;
    } else {
      const primitiveOutcomeId = trade.outcomeId.toLowerCase();
      if (primitiveOutcomeId === "no") {
        price = 100 - price;
      } else if (primitiveOutcomeId !== "yes") {
        continue;
      }
    }

    if (!Number.isFinite(price) || price < 0 || price > 100) continue;
    const fillSize = trade.faceAmountSubunits;
    eligible.push({
      comment,
      timestamp,
      price,
      seriesId,
      seriesLabel,
      // Unknown amounts remain eligible but follow every known positive amount.
      fillSize:
        typeof fillSize === "number" && Number.isSafeInteger(fillSize) && fillSize > 0
          ? fillSize
          : 0,
    });
  }
  const selected = eligible
    .sort(
      (left, right) =>
        right.fillSize - left.fillSize ||
        right.timestamp - left.timestamp ||
        (left.comment.id < right.comment.id ? -1 : left.comment.id > right.comment.id ? 1 : 0),
    )
    .slice(0, MAX_CHART_COMMENTS);
  const groupsByCoordinate = new Map<string, CommentGroup>();
  // Select individual comments first. Coincident trades cannot increase the budget.
  for (const { comment, timestamp, price, seriesId, seriesLabel } of selected) {
    const coordinateKey = JSON.stringify([seriesId, timestamp, price]);
    const group = groupsByCoordinate.get(coordinateKey) ?? {
      id: encodeURIComponent(coordinateKey),
      timestamp,
      price,
      seriesId,
      seriesLabel,
      comments: [],
    };
    group.comments.push(comment);
    groupsByCoordinate.set(coordinateKey, group);
  }
  const groups = [...groupsByCoordinate.values()].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.seriesId.localeCompare(right.seriesId) ||
      left.price - right.price,
  );
  return {
    groups,
    hiddenCount: Math.max(0, eligible.length - selected.length),
  };
}

export function createChartTimeFormatter(
  locale: string,
  timeframe: ChartTimeframe,
): (timestampMs: number) => string {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    ...(timeframe === "30d"
      ? {}
      : { timeStyle: timeframe === "all" ? ("medium" as const) : ("short" as const) }),
  });
  return (timestampMs) => formatter.format(new Date(timestampMs));
}

/** Compact axis context follows the visible span; native ticks determine precision. */
export function createChartAxisTimeFormatter(
  locale: string,
  timeframe: ChartTimeframe,
  domain: { min: number; max: number } | null = null,
): (timestampMs: number, tickValues?: readonly number[]) => string {
  if (timeframe === "7d") {
    const formatter = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
    return (timestamp) => formatter.format(timestamp);
  }
  if (timeframe !== "all" || !domain) return createChartTimeFormatter(locale, timeframe);
  const sameDay = new Date(domain.min).toDateString() === new Date(domain.max).toDateString();
  const date: Intl.DateTimeFormatOptions = sameDay
    ? {}
    : {
        month: "numeric",
        day: "numeric",
        ...(new Date(domain.min).getFullYear() !== new Date(domain.max).getFullYear()
          ? { year: "2-digit" as const }
          : {}),
      };
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const options: Intl.DateTimeFormatOptions[] = [
    ...(sameDay ? [] : [date]),
    { ...date, ...time },
    { ...date, ...time, second: "2-digit" },
    { ...date, ...time, second: "2-digit", fractionalSecondDigits: 3 },
  ];
  const formatters = options.map((option) => new Intl.DateTimeFormat(locale, option));
  let signature = "";
  let selected = formatters[0];
  return (timestamp, tickValues = [domain.min, domain.max]) => {
    const nextSignature = tickValues.join(",");
    if (signature !== nextSignature) {
      signature = nextSignature;
      // Chart.js provides only its small native tick set, never history points.
      selected =
        formatters.find(
          (formatter) =>
            new Set(tickValues.map((value) => formatter.format(value))).size === tickValues.length,
        ) ?? formatters[formatters.length - 1];
    }
    return selected.format(timestamp);
  };
}

export function createCommentTimeFormatter(
  locale: string,
  timeframe: ChartTimeframe,
): (timestampMs: number) => string {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    ...(timeframe === "30d" || timeframe === "all" ? {} : { timeStyle: "medium" as const }),
  });
  return (timestampMs) => formatter.format(new Date(timestampMs));
}

export function clampPosition(value: number, elementSize: number, availableSize: number): number {
  const padding = Math.min(4, availableSize / 2);
  return Math.max(
    padding,
    Math.min(value, Math.max(padding, availableSize - elementSize - padding)),
  );
}

const commentSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Preview length is independent of the protocol's UTF-16 content limit. */
export function commentPreview(content: string): string {
  const graphemes = Array.from(commentSegmenter.segment(content), (part) => part.segment);
  return graphemes.length > 20 ? `${graphemes.slice(0, 20).join("")}…` : content;
}

/** Reaction weight affects opacity only, never text size, ranking, or anchors. */
export function commentMarkerPresentation(comments: readonly Comment[], availableWidth = 180) {
  const likes = comments.reduce(
    (total, comment) =>
      total + (Number.isFinite(comment.likeCount) ? Math.max(0, comment.likeCount) : 0),
    0,
  );
  const weight = Math.min(1, Math.log2(1 + likes) / 6);
  return {
    width: Math.max(1, Math.min(COMMENT_MARKER_WIDTH, availableWidth - 8)),
    height: COMMENT_MARKER_HEIGHT,
    opacity: 0.8 + 0.2 * weight,
  };
}

export function commentTailPath(
  group: Pick<PositionedCommentGroup, "left" | "top" | "anchorLeft" | "anchorTop">,
  width = COMMENT_MARKER_WIDTH,
  height = COMMENT_MARKER_HEIGHT,
): string {
  const centerLeft = group.left + width / 2;
  const centerTop = group.top + height / 2;
  const horizontalDistance = group.anchorLeft - centerLeft;
  const verticalDistance = group.anchorTop - centerTop;
  if (Math.abs(horizontalDistance) / width > Math.abs(verticalDistance) / height) {
    const edgeLeft = horizontalDistance < 0 ? group.left : group.left + width;
    const edgeTop = Math.max(group.top + 4, Math.min(group.anchorTop, group.top + height - 4));
    return `M ${group.anchorLeft} ${group.anchorTop} L ${edgeLeft} ${edgeTop - 4} L ${edgeLeft} ${edgeTop + 4} Z`;
  }

  const edgeTop = verticalDistance < 0 ? group.top : group.top + height;
  const edgeLeft = Math.max(group.left + 4, Math.min(group.anchorLeft, group.left + width - 4));
  return `M ${group.anchorLeft} ${group.anchorTop} L ${edgeLeft - 4} ${edgeTop} L ${edgeLeft + 4} ${edgeTop} Z`;
}

function toChartPoint(point: PricePoint): ChartPoint {
  // Keep every confirmed fill, including separate fills at the same millisecond.
  const timestampMs = Date.parse(point.timestamp);
  return { ...point, timestampMs, x: timestampMs, y: point.price };
}

function prepareHistory(points: readonly PricePoint[]): ChartPoint[] {
  const prepared = points.map(toChartPoint);
  if (
    prepared.some(
      (point, index) => index > 0 && point.timestampMs < prepared[index - 1].timestampMs,
    )
  ) {
    // Stable sorting retains the accepted fill order within one millisecond.
    prepared.sort((left, right) => left.timestampMs - right.timestampMs);
  }
  return prepared;
}

/** Bound nonzero turns without dropping coincident records or a seam's join. */
export function priceSeriesPieces(points: readonly ChartPoint[]): ChartPoint[][] {
  const pieces: ChartPoint[][] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + 256);
    while (
      end < points.length &&
      points[end - 2].timestampMs === points[end - 1].timestampMs &&
      points[end - 2].price === points[end - 1].price
    ) {
      end++;
    }
    pieces.push(points.slice(start, end));
    if (end === points.length) break;
    start = end - 2;
  }
  return pieces;
}

interface PriceSeriesInput {
  priceHistory: PriceHistory;
  outcomePriceHistories?: Record<string, PriceHistory>;
  outcomes?: Outcome[];
}

/** Normalize incoming history once. Expiry updates reuse these point objects. */
export function preparePriceSeries(input: PriceSeriesInput): Series[] {
  if (input.outcomePriceHistories && input.outcomes && input.outcomes.length > 0) {
    return input.outcomes.slice(0, 8).map((outcome) => ({
      id: outcome.id,
      label: outcome.label,
      color: normalizeOutcomeColor(outcome.color),
      data: prepareHistory(
        input.outcomePriceHistories?.[canonicalizeOutcomeSet([outcome.label])]?.data ?? [],
      ),
    }));
  }
  return [
    {
      id: "primary",
      label: "",
      color: PRIMARY_SERIES_COLOR,
      data: prepareHistory(input.priceHistory.data),
    },
  ];
}

export function windowPriceSeries(
  prepared: readonly Series[],
  timeframe: ChartTimeframe,
  evaluationMs: number | null,
): Series[] {
  const windowMs = TIMEFRAME_WINDOW_MS[timeframe];
  const cutoff = windowMs === null || evaluationMs === null ? null : evaluationMs - windowMs;
  return prepared
    .map((item) => {
      // Same inclusive lower bound as windowPriceHistory; no point coalescing.
      if (cutoff === null) return item;
      const data = item.data.filter((point) => point.timestampMs >= cutoff);
      return data.length === item.data.length ? item : { ...item, data };
    })
    .filter((item) => item.data.length > 0);
}

export function chartDomain(
  series: readonly Series[],
  timeframe: ChartTimeframe,
  evaluationMs: number | null,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const point of item.data) {
      min = Math.min(min, point.timestampMs);
      max = Math.max(max, point.timestampMs);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (timeframe !== "all") {
    if (evaluationMs === null) return null;
    return { min: evaluationMs - TIMEFRAME_WINDOW_MS[timeframe]!, max: evaluationMs };
  }
  return min === max ? { min: min - 3_600_000, max: max + 3_600_000 } : { min, max };
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}
