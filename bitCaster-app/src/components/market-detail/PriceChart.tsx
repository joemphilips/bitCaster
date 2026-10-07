import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { canonicalizeOutcomeSet } from "@/lib/outcomeSets";
import {
  confirmedPriceAtOrBefore,
  TIMEFRAME_WINDOW_MS,
  windowPriceHistory,
} from "@/lib/priceHistory";
import { fetchPublicNostrProfile, type PublicNostrProfile } from "@/lib/nostr";
import type { Outcome } from "@/types/market";
import { normalizeOutcomeColor, OutcomeLabel } from "@/components/shared/OutcomeLabel";
import type { PriceHistory, ChartTimeframe, Comment, PricePoint } from "@/types/market-detail";

interface PriceChartProps {
  priceHistory: PriceHistory;
  chartTimeframe: ChartTimeframe;
  onTimeframeChange?: (timeframe: ChartTimeframe) => void;
  outcomePriceHistories?: Record<string, PriceHistory>;
  outcomes?: Outcome[];
  currentDisplay?: string;
  emptyDisplay?: string;
  comments?: Comment[];
  unit?: string;
  /** Numeric markets remain disabled until a native numeric trade exists. */
  disabledNumeric?: boolean;
}

const TIMEFRAMES: ChartTimeframe[] = ["1h", "24h", "7d", "30d", "all"];
const TIMEFRAME_SECONDS: Record<Exclude<ChartTimeframe, "all">, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

const TIMEFRAME_LABELS: Record<ChartTimeframe, string> = {
  "1h": "1H",
  "24h": "24H",
  "7d": "7D",
  "30d": "1 Month",
  all: "ALL",
};

const PRIMARY_SERIES_COLOR = "rgb(59, 130, 246)";
const CHART_HEIGHT = 224;
const MAX_COMMENT_MARKERS = 40;
const MAX_AUTHOR_PROFILE_LOOKUPS = 40;
const EMPTY_COMMENTS: Comment[] = [];

type Series = { id: string; label: string; color: string; data: PricePoint[] };
type CommentGroup = {
  id: string;
  timestamp: number;
  price: number;
  seriesId: string;
  seriesLabel: string;
  linkedFillSize: number | null;
  comments: Comment[];
};
type PositionedCommentGroup = CommentGroup & {
  plotLeft: number;
  plotTop: number;
  anchorLeft: number;
  anchorTop: number;
  left: number;
  top: number;
};
type CommentGroupResult = { groups: CommentGroup[]; hiddenCount: number };
type CursorReadout = {
  time: number;
  price: number | null;
  xLabelLeft: number;
  xLabelTop: number;
  yLabelLeft: number;
  yLabelTop: number;
};

const COMMENT_MARKER_WIDTH = 24;
const COMMENT_MARKER_HEIGHT = 18;
const COMMENT_MARKER_OFFSETS: Array<[number, number]> = [
  [0, -28],
  [0, 28],
  [-32, -24],
  [32, -24],
  [-32, 24],
  [32, 24],
  [-48, 0],
  [48, 0],
  [0, -52],
  [0, 52],
  [-56, -28],
  [56, -28],
  [-56, 28],
  [56, 28],
  [-80, 0],
  [80, 0],
];

function groupComments(
  comments: readonly Comment[],
  xScale: { min: number; max: number } | null,
  series: readonly Series[],
  isCategorical: boolean,
): CommentGroupResult {
  if (!xScale) return { groups: [], hiddenCount: 0 };
  const groupsByCoordinate = new Map<string, Omit<CommentGroup, "id">>();
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
    const timestamp = timestampMs / 1000;
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
    const coordinateKey = JSON.stringify([seriesId, timestampMs, price]);
    const group = groupsByCoordinate.get(coordinateKey) ?? {
      timestamp,
      price,
      seriesId,
      seriesLabel,
      linkedFillSize: null,
      comments: [],
    };
    const fillSize = trade.faceAmountSubunits;
    if (typeof fillSize === "number" && Number.isFinite(fillSize) && fillSize > 0) {
      group.linkedFillSize = Math.max(group.linkedFillSize ?? 0, fillSize);
    }
    group.comments.push(comment);
    groupsByCoordinate.set(coordinateKey, group);
  }
  const groups = [...groupsByCoordinate.entries()].map(([key, group]) => ({
    ...group,
    id: encodeURIComponent(key),
  }));
  const selected = groups
    .sort(
      (left, right) =>
        (right.linkedFillSize ?? 0) - (left.linkedFillSize ?? 0) ||
        right.timestamp - left.timestamp ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .slice(0, MAX_COMMENT_MARKERS)
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.seriesId.localeCompare(right.seriesId) ||
        left.price - right.price,
    );
  return {
    groups: selected,
    hiddenCount: Math.max(0, groups.length - MAX_COMMENT_MARKERS),
  };
}

function formatChartTime(
  timestampSeconds: number,
  locale: string,
  timeframe: ChartTimeframe,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    ...(timeframe === "30d" || timeframe === "all" ? {} : { timeStyle: "short" as const }),
  }).format(new Date(timestampSeconds * 1000));
}

function formatCommentTime(
  timestampSeconds: number,
  locale: string,
  timeframe: ChartTimeframe,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    ...(timeframe === "30d" || timeframe === "all" ? {} : { timeStyle: "medium" as const }),
  }).format(new Date(timestampSeconds * 1000));
}

function clampPosition(value: number, elementSize: number, availableSize: number): number {
  const padding = Math.min(4, availableSize / 2);
  return Math.max(
    padding,
    Math.min(value, Math.max(padding, availableSize - elementSize - padding)),
  );
}

function markerBodiesOverlap(left: number, top: number, right: number, bottom: number): boolean {
  const separation = 4;
  return (
    left < right + COMMENT_MARKER_WIDTH + separation &&
    left + COMMENT_MARKER_WIDTH + separation > right &&
    top < bottom + COMMENT_MARKER_HEIGHT + separation &&
    top + COMMENT_MARKER_HEIGHT + separation > bottom
  );
}

function chooseMarkerBodyPosition(
  anchorLeft: number,
  anchorTop: number,
  chartWidth: number,
  chartHeight: number,
  positioned: readonly PositionedCommentGroup[],
): { left: number; top: number } {
  let bestPosition: { left: number; top: number } | null = null;
  let fewestOverlaps = Number.POSITIVE_INFINITY;
  for (const [offsetLeft, offsetTop] of COMMENT_MARKER_OFFSETS) {
    const candidate = {
      left: clampPosition(
        anchorLeft + offsetLeft - COMMENT_MARKER_WIDTH / 2,
        COMMENT_MARKER_WIDTH,
        chartWidth,
      ),
      top: clampPosition(
        anchorTop + offsetTop - COMMENT_MARKER_HEIGHT / 2,
        COMMENT_MARKER_HEIGHT,
        chartHeight,
      ),
    };
    const overlaps = positioned.filter((item) =>
      markerBodiesOverlap(candidate.left, candidate.top, item.left, item.top),
    ).length;
    if (overlaps < fewestOverlaps) {
      bestPosition = candidate;
      fewestOverlaps = overlaps;
      if (overlaps === 0) return candidate;
    }
  }
  return bestPosition ?? { left: anchorLeft, top: anchorTop };
}

function commentTailPath(
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

function measuredRegionSize(
  element: HTMLDivElement | null,
  dimension: "width" | "height",
  fallback: number,
): number {
  if (!element) return fallback;
  const clientSize = dimension === "width" ? element.clientWidth : element.clientHeight;
  const rect = element.getBoundingClientRect();
  const rectSize = dimension === "width" ? rect.width : rect.height;
  const measuredSize = clientSize > 0 ? clientSize : rectSize;
  return measuredSize > 0 ? measuredSize : fallback;
}

function timeOf(point: PricePoint): number {
  return new Date(point.timestamp).getTime();
}

function toUnixSeconds(point: PricePoint): number {
  return timeOf(point) / 1000;
}

function buildSeries(input: {
  priceHistory: PriceHistory;
  timeframe: ChartTimeframe;
  evaluationMs: number | null;
  outcomePriceHistories?: Record<string, PriceHistory>;
  outcomes?: Outcome[];
}): Series[] {
  const isMultiLine = !!(
    input.outcomePriceHistories &&
    input.outcomes &&
    input.outcomes.length > 0
  );

  if (isMultiLine && input.outcomePriceHistories && input.outcomes) {
    return input.outcomes
      .slice(0, 8)
      .map((outcome) => ({
        id: outcome.id,
        label: outcome.label,
        color: normalizeOutcomeColor(outcome.color),
        data: windowPriceHistory(
          {
            ...(input.outcomePriceHistories?.[canonicalizeOutcomeSet([outcome.label])] ?? {
              data: [],
            }),
            timeframe: input.timeframe,
          },
          input.evaluationMs,
        ).data,
      }))
      .filter((series) => series.data.length > 0);
  }

  return [
    {
      id: "primary",
      label: "",
      color: PRIMARY_SERIES_COLOR,
      data: windowPriceHistory(
        { ...input.priceHistory, timeframe: input.timeframe },
        input.evaluationMs,
      ).data,
    },
  ].filter((series) => series.data.length > 0);
}

function alignSeries(series: Series[]): uPlot.AlignedData {
  const times = [
    ...new Set(series.flatMap((s) => s.data.map((point) => toUnixSeconds(point)))),
  ].sort((a, b) => a - b);

  const yValues = series.map((s) => {
    const byTime = new Map(s.data.map((point) => [toUnixSeconds(point), point.price]));
    return times.map((time) => byTime.get(time) ?? null);
  });

  return [times, ...yValues] as uPlot.AlignedData;
}

function xScaleFor(
  data: uPlot.AlignedData,
  timeframe: ChartTimeframe,
  evaluationMs: number | null,
): { min: number; max: number } | null {
  const times = data[0] as number[];
  if (times.length === 0) return null;
  if (timeframe !== "all") {
    if (evaluationMs === null) return null;
    const windowSeconds = TIMEFRAME_SECONDS[timeframe];
    const max = evaluationMs / 1000;
    return { min: max - windowSeconds, max };
  }
  const max = times[times.length - 1];
  const min = times[0];
  if (min === max) {
    return { min: min - 60 * 60, max: max + 60 * 60 };
  }
  return { min, max };
}

function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function PriceChart({
  priceHistory,
  chartTimeframe,
  onTimeframeChange,
  outcomePriceHistories,
  outcomes,
  currentDisplay,
  emptyDisplay,
  comments = EMPTY_COMMENTS,
  disabledNumeric = false,
}: PriceChartProps) {
  const { t, i18n } = useTranslation();
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRegionRef = useRef<HTMLDivElement | null>(null);
  const commentMarkerLayerRef = useRef<HTMLDivElement | null>(null);
  const commentPopoverRef = useRef<HTMLDivElement | null>(null);
  const activeMarkerRef = useRef<HTMLButtonElement | null>(null);
  const ignoreNextMarkerFocusRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);
  const pinnedCommentGroupIdRef = useRef<string | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const markerRefreshRef = useRef<((plot: uPlot) => void) | null>(null);
  const cursorRefreshRef = useRef<((plot: uPlot) => void) | null>(null);
  const [cursorReadout, setCursorReadout] = useState<CursorReadout | null>(null);
  const [positionedCommentGroups, setPositionedCommentGroups] = useState<PositionedCommentGroup[]>(
    [],
  );
  const [activeCommentGroupId, setActiveCommentGroupId] = useState<string | null>(null);
  const authorProfileRequests = useRef(new Map<string, Promise<PublicNostrProfile | null>>());
  const [authorProfiles, setAuthorProfiles] = useState(
    new Map<string, PublicNostrProfile | null>(),
  );

  const clock = useMemo(
    () => ({
      asOfMs: priceHistory.asOf ? Date.parse(priceHistory.asOf) : null,
      receivedAt: priceHistory.receivedAt ?? performance.now(),
    }),
    [priceHistory],
  );
  const [expiryTick, setExpiryTick] = useState(0);
  const evaluationMs = useMemo(
    () =>
      clock.asOfMs === null
        ? null
        : clock.asOfMs + Math.floor(Math.max(0, performance.now() - clock.receivedAt)),
    [clock, expiryTick],
  );
  useEffect(() => {
    const windowMs = TIMEFRAME_WINDOW_MS[chartTimeframe];
    if (clock.asOfMs === null || windowMs === null) return;
    const points = outcomePriceHistories
      ? Object.values(outcomePriceHistories).flatMap((history) => history.data)
      : priceHistory.data;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const now = clock.asOfMs! + Math.floor(Math.max(0, performance.now() - clock.receivedAt));
      const nextExpiry = points.reduce((next, point) => {
        const expiry = Date.parse(point.timestamp) + windowMs + 1;
        return expiry > now ? Math.min(next, expiry) : next;
      }, Infinity);
      if (!Number.isFinite(nextExpiry)) return;
      timer = setTimeout(
        () => {
          setExpiryTick((tick) => tick + 1);
          schedule();
        },
        Math.min(2_147_483_647, Math.max(1, nextExpiry - now)),
      );
    };
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [chartTimeframe, clock, priceHistory, outcomePriceHistories]);

  const series = useMemo(
    () =>
      disabledNumeric
        ? []
        : buildSeries({
            priceHistory,
            timeframe: chartTimeframe,
            evaluationMs,
            outcomePriceHistories,
            outcomes,
          }),
    [
      priceHistory,
      chartTimeframe,
      outcomePriceHistories,
      outcomes,
      disabledNumeric,
      evaluationMs,
      expiryTick,
    ],
  );
  const chartData = useMemo(() => alignSeries(series), [series]);
  const xScale = useMemo(
    () => xScaleFor(chartData, chartTimeframe, evaluationMs),
    [chartData, chartTimeframe, evaluationMs],
  );
  const isCategorical = Boolean(
    outcomePriceHistories && outcomes && outcomes.length > 0 && !disabledNumeric,
  );
  const historyRef = useRef(series);
  historyRef.current = series;
  const commentGroupResult = useMemo(
    () => groupComments(comments, xScale, series, isCategorical),
    [comments, xScale, series, isCategorical],
  );
  const hasChartData = series.length > 0 && chartData[0].length > 0;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const activeCommentGroup = positionedCommentGroups.find(
    (group) => group.id === activeCommentGroupId,
  );
  useEffect(() => {
    if (!activeCommentGroup) return undefined;
    let cancelled = false;
    const authors = [
      ...new Set(activeCommentGroup.comments.map((comment) => comment.userId)),
    ].filter((author) => /^[0-9a-f]{64}$/.test(author));
    const requests = authorProfileRequests.current;
    for (const author of authors) {
      if (requests.has(author)) continue;
      // Best-effort display enrichment must remain bounded even across repeated group changes.
      if (requests.size >= MAX_AUTHOR_PROFILE_LOOKUPS) break;
      requests.set(
        author,
        fetchPublicNostrProfile(author).catch(() => null),
      );
    }
    if (!authors.some((author) => requests.has(author))) return undefined;
    void Promise.all(
      authors
        .filter((author) => requests.has(author))
        .map(async (author) => [author, (await requests.get(author)) ?? null] as const),
    ).then((profiles) => {
      if (!cancelled) setAuthorProfiles(new Map(profiles));
    });
    return () => {
      cancelled = true;
    };
  }, [activeCommentGroup]);
  const chartRegionWidth = measuredRegionSize(chartRegionRef.current, "width", 320);
  const chartRegionHeight = measuredRegionSize(chartRegionRef.current, "height", CHART_HEIGHT);
  const commentPopoverWidth = Math.max(1, Math.min(288, chartRegionWidth - 8));
  const commentPopoverBelow = activeCommentGroup
    ? chartRegionHeight - activeCommentGroup.anchorTop >= activeCommentGroup.anchorTop
    : true;
  const commentPopoverSpace = activeCommentGroup
    ? (commentPopoverBelow
        ? chartRegionHeight - activeCommentGroup.anchorTop
        : activeCommentGroup.anchorTop) - 12
    : chartRegionHeight - 8;
  const commentPopoverHeight = Math.max(1, Math.min(176, commentPopoverSpace));
  const commentPopoverLeft = activeCommentGroup
    ? clampPosition(activeCommentGroup.anchorLeft + 8, commentPopoverWidth, chartRegionWidth)
    : 4;
  const commentPopoverTop = activeCommentGroup
    ? clampPosition(
        commentPopoverBelow
          ? activeCommentGroup.anchorTop + 8
          : activeCommentGroup.anchorTop - commentPopoverHeight - 8,
        commentPopoverHeight,
        chartRegionHeight,
      )
    : 4;
  const displayedSeries = isCategorical
    ? (outcomes ?? []).slice(0, 8).map((outcome) => ({
        id: outcome.id,
        label: outcome.label,
        color: normalizeOutcomeColor(outcome.color),
        data: series.find((item) => item.id === outcome.id)?.data ?? [],
      }))
    : series;
  const latestValues = displayedSeries.map((item) => ({
    id: item.id,
    label: item.label,
    color: item.color,
    value: cursorReadout
      ? confirmedPriceAtOrBefore(item.data, cursorReadout.time)
      : (item.data[item.data.length - 1]?.price ?? null),
  }));

  const seriesSignature = series.map((s) => `${s.id}:${s.label}:${s.color}`).join("|");

  const closeCommentPopover = (restoreFocus: boolean) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    pinnedCommentGroupIdRef.current = null;
    setActiveCommentGroupId(null);
    if (
      restoreFocus &&
      activeMarkerRef.current &&
      document.activeElement !== activeMarkerRef.current
    ) {
      ignoreNextMarkerFocusRef.current = true;
      activeMarkerRef.current.focus();
    }
  };

  const setCommentCursor = (group: PositionedCommentGroup) => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setCursor({
      left: group.plotLeft,
      top: group.plotTop,
    });
  };

  const activateCommentMarker = (group: PositionedCommentGroup, marker: HTMLButtonElement) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    activeMarkerRef.current = marker;
    setActiveCommentGroupId(group.id);
    setCommentCursor(group);
  };

  const scheduleCommentPopoverDismiss = () => {
    if (pinnedCommentGroupIdRef.current !== null || dismissTimerRef.current !== null) return;
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      setActiveCommentGroupId(null);
    }, 120);
  };

  useEffect(() => {
    const container = chartEl.current;
    if (!container || !hasChartData) return;

    plotRef.current?.destroy();
    resizeObserverRef.current?.disconnect();
    setCursorReadout(null);
    setPositionedCommentGroups([]);

    const width = Math.max(
      Math.floor(container.clientWidth || container.getBoundingClientRect().width),
      1,
    );
    const steppedPaths = uPlot.paths.stepped?.({ align: 1 });
    const updateCursorReadout = (plot: uPlot) => {
      const { left } = plot.cursor;
      if (left == null || left < 0) {
        setCursorReadout(null);
        return;
      }

      const axisTime = plot.posToVal(left, "x");
      const axisPrice = confirmedPriceAtOrBefore(historyRef.current[0]?.data ?? [], axisTime);
      const region = chartRegionRef.current;
      const regionRect = region?.getBoundingClientRect();
      const overRect = plot.over.getBoundingClientRect();
      const width = Math.max(region?.clientWidth ?? regionRect?.width ?? 1, 1);
      const height = Math.max(region?.clientHeight ?? regionRect?.height ?? CHART_HEIGHT, 1);
      const plotLeft = overRect.left - (regionRect?.left ?? 0);
      const plotTop = overRect.top - (regionRect?.top ?? 0);
      const xPosition = plotLeft + plot.valToPos(axisTime, "x");
      const yPosition = plotTop + (axisPrice === null ? 0 : plot.valToPos(axisPrice, "y"));
      const xLabelWidth = Math.max(1, Math.min(96, width - 8));
      const yLabelWidth = Math.max(1, Math.min(72, width - 8));

      setCursorReadout({
        time: axisTime,
        price: axisPrice,
        xLabelLeft: clampPosition(xPosition - xLabelWidth / 2, xLabelWidth, width),
        xLabelTop: clampPosition(plotTop + plot.over.clientHeight - 24, 20, height),
        yLabelLeft: clampPosition(
          plotLeft + plot.over.clientWidth - yLabelWidth,
          yLabelWidth,
          width,
        ),
        yLabelTop: clampPosition(yPosition - 10, 20, height),
      });
    };
    const plot = new uPlot(
      {
        width,
        height: CHART_HEIGHT,
        cursor: {
          show: true,
          x: true,
          y: true,
          drag: { setScale: false },
        },
        legend: { show: false },
        scales: {
          x: { time: true, min: xScale?.min, max: xScale?.max },
          y: { range: [0, 100] },
        },
        axes: [
          {
            stroke: "#64748b",
            grid: { show: false },
          },
          {
            side: 1,
            size: 64,
            stroke: "#64748b",
            values: (_u, values) => values.map((value) => formatPercent(value)),
            splits: () => [0, 50, 100],
          },
        ],
        series: [
          {},
          ...series.map((s) => ({
            label: s.label || t("market.priceChart"),
            stroke: s.color,
            width: 2,
            points: { show: true },
            spanGaps: true,
            paths: steppedPaths,
            value: (_u: uPlot, value: number | null) => (value == null ? "" : formatPercent(value)),
          })),
        ],
        hooks: {
          setCursor: [(currentPlot: uPlot) => updateCursorReadout(currentPlot)],
          setSize: [
            (currentPlot: uPlot) => {
              updateCursorReadout(currentPlot);
              markerRefreshRef.current?.(currentPlot);
            },
          ],
        },
      },
      chartData,
      container,
    );

    plotRef.current = plot;
    cursorRefreshRef.current = updateCursorReadout;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(Math.floor(entry.contentRect.width), 1);
      plot.setSize({ width: nextWidth, height: CHART_HEIGHT });
    });
    resizeObserver.observe(container);
    resizeObserverRef.current = resizeObserver;

    return () => {
      resizeObserver.disconnect();
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
      if (cursorRefreshRef.current === updateCursorReadout) cursorRefreshRef.current = null;
      if (resizeObserverRef.current === resizeObserver) resizeObserverRef.current = null;
      if (markerRefreshRef.current) markerRefreshRef.current = null;
    };
  }, [hasChartData, seriesSignature]);

  useEffect(() => {
    if (!plotRef.current || !hasChartData) return;
    plotRef.current.setData(chartData);
    if (xScale) {
      plotRef.current.setScale("x", xScale);
    }
    cursorRefreshRef.current?.(plotRef.current);
  }, [chartData, hasChartData, xScale]);

  useEffect(() => {
    const plot = plotRef.current;
    const region = chartRegionRef.current;
    if (!plot || !region || !hasChartData) {
      setPositionedCommentGroups([]);
      return;
    }

    const refreshPositions = (currentPlot: uPlot) => {
      const regionRect = region.getBoundingClientRect();
      const overRect = currentPlot.over.getBoundingClientRect();
      const offsetLeft = overRect.left - regionRect.left;
      const offsetTop = overRect.top - regionRect.top;
      const positioned: PositionedCommentGroup[] = [];
      const regionWidth = measuredRegionSize(region, "width", 320);
      const regionHeight = measuredRegionSize(region, "height", CHART_HEIGHT);
      for (const group of commentGroupResult.groups) {
        const plotLeft = currentPlot.valToPos(group.timestamp, "x");
        const plotTop = currentPlot.valToPos(group.price, "y");
        const anchorLeft = offsetLeft + plotLeft;
        const anchorTop = offsetTop + plotTop;
        const bodyPosition = chooseMarkerBodyPosition(
          anchorLeft,
          anchorTop,
          regionWidth,
          regionHeight,
          positioned,
        );
        const positionedGroup: PositionedCommentGroup = {
          ...group,
          plotLeft,
          plotTop,
          anchorLeft,
          anchorTop,
          ...bodyPosition,
        };
        positioned.push(positionedGroup);
      }
      setPositionedCommentGroups(positioned);
    };

    markerRefreshRef.current = refreshPositions;
    refreshPositions(plot);
    return () => {
      if (markerRefreshRef.current === refreshPositions) markerRefreshRef.current = null;
    };
  }, [commentGroupResult, hasChartData, seriesSignature, xScale]);

  useEffect(() => {
    if (
      activeCommentGroupId === null ||
      positionedCommentGroups.some((group) => group.id === activeCommentGroupId)
    ) {
      return;
    }
    pinnedCommentGroupIdRef.current = null;
    setActiveCommentGroupId(null);
  }, [activeCommentGroupId, positionedCommentGroups]);

  useEffect(() => {
    if (activeCommentGroupId === null) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        commentPopoverRef.current?.contains(target) ||
        commentMarkerLayerRef.current?.contains(target)
      ) {
        return;
      }
      closeCommentPopover(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeCommentPopover(true);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [activeCommentGroupId]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          {currentDisplay ? (
            <div className="text-3xl font-bold text-slate-900 dark:text-white">
              {currentDisplay}
            </div>
          ) : (
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              {t("market.priceChart")}
            </h3>
          )}
        </div>
      </div>

      <div
        ref={chartRegionRef}
        data-testid="price-chart-region"
        className="relative h-56 mb-4 rounded-xl bg-slate-50 dark:bg-slate-900 overflow-hidden"
      >
        {!hasChartData ? (
          <div
            data-testid="price-chart-empty-state"
            className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm"
          >
            {emptyDisplay ?? t("market.noDataAvailable")}
          </div>
        ) : (
          <>
            <div
              ref={chartEl}
              data-testid="price-chart-uplot"
              className="h-full w-full [&_.u-over]:rounded-xl"
            />
            {cursorReadout && (
              <>
                <div
                  data-testid="price-chart-x-axis-cursor-label"
                  aria-hidden="true"
                  className="pointer-events-none absolute z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white shadow"
                  style={{ left: cursorReadout.xLabelLeft, top: cursorReadout.xLabelTop }}
                >
                  {formatChartTime(cursorReadout.time, locale, chartTimeframe)}
                </div>
                {!isCategorical && cursorReadout.price !== null && (
                  <div
                    data-testid="price-chart-y-axis-cursor-label"
                    aria-hidden="true"
                    className="pointer-events-none absolute z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white shadow"
                    style={{ left: cursorReadout.yLabelLeft, top: cursorReadout.yLabelTop }}
                  >
                    {formatPercent(cursorReadout.price)}
                  </div>
                )}
              </>
            )}
            <div
              ref={commentMarkerLayerRef}
              data-testid="price-chart-comment-markers"
              aria-label={t("market.chartComments")}
              className="pointer-events-none absolute inset-0 z-20"
            >
              <svg
                data-testid="price-chart-comment-tails"
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
                preserveAspectRatio="none"
              >
                {positionedCommentGroups.map((group) => (
                  <path
                    key={group.id}
                    data-testid="price-chart-comment-tail"
                    data-anchor-x={group.anchorLeft}
                    data-anchor-y={group.anchorTop}
                    data-series-id={group.seriesId}
                    d={commentTailPath(group)}
                    className="fill-slate-400/60 stroke-slate-600 dark:fill-slate-500/60 dark:stroke-slate-300"
                    strokeWidth="1"
                  />
                ))}
              </svg>
              {positionedCommentGroups.map((group) => {
                const markerText = t("market.chartCommentMarker", {
                  time: formatCommentTime(group.timestamp, locale, chartTimeframe),
                  count: group.comments.length,
                });
                const label = group.seriesLabel
                  ? `${group.seriesLabel}: ${markerText}`
                  : markerText;
                const expanded = activeCommentGroupId === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    data-testid="price-chart-comment-marker"
                    data-chart-comment-marker="true"
                    data-series-id={group.seriesId}
                    data-anchor-x={group.anchorLeft}
                    data-anchor-y={group.anchorTop}
                    aria-label={label}
                    aria-haspopup="dialog"
                    aria-expanded={expanded}
                    aria-controls={`price-chart-comments-${group.id}`}
                    title={label}
                    className="pointer-events-auto absolute flex h-[18px] w-6 items-center justify-center rounded-full border border-slate-600 bg-slate-400/60 px-1 text-[10px] font-bold leading-none text-slate-950 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-300 dark:bg-slate-500/60 dark:text-white"
                    style={{ left: group.left, top: group.top }}
                    onPointerEnter={(event) => activateCommentMarker(group, event.currentTarget)}
                    onPointerLeave={scheduleCommentPopoverDismiss}
                    onFocus={(event) => {
                      if (ignoreNextMarkerFocusRef.current) {
                        ignoreNextMarkerFocusRef.current = false;
                        return;
                      }
                      activateCommentMarker(group, event.currentTarget);
                    }}
                    onBlur={scheduleCommentPopoverDismiss}
                    onClick={(event) => {
                      if (pinnedCommentGroupIdRef.current === group.id) {
                        closeCommentPopover(false);
                      } else {
                        pinnedCommentGroupIdRef.current = group.id;
                        activateCommentMarker(group, event.currentTarget);
                      }
                    }}
                  >
                    {group.comments.length > 1 ? group.comments.length : "•"}
                  </button>
                );
              })}
              {commentGroupResult.hiddenCount > 0 && (
                <div
                  data-testid="price-chart-comment-markers-hidden"
                  className="pointer-events-none absolute bottom-1 left-1 rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-white"
                >
                  {t("market.chartCommentMarkersHidden", {
                    count: commentGroupResult.hiddenCount,
                  })}
                </div>
              )}
            </div>
            {activeCommentGroup && (
              <>
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-30 h-full w-full"
                  viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
                  preserveAspectRatio="none"
                >
                  <path
                    data-testid="price-chart-comment-panel-tail"
                    data-anchor-x={activeCommentGroup.anchorLeft}
                    data-anchor-y={activeCommentGroup.anchorTop}
                    d={commentTailPath(
                      {
                        ...activeCommentGroup,
                        left: commentPopoverLeft,
                        top: commentPopoverTop,
                      },
                      commentPopoverWidth,
                      commentPopoverHeight,
                    )}
                    className="fill-white stroke-slate-200 dark:fill-slate-800 dark:stroke-slate-600"
                  />
                </svg>
                <div
                  ref={commentPopoverRef}
                  id={`price-chart-comments-${activeCommentGroup.id}`}
                  data-testid="price-chart-comment-popover"
                  role="dialog"
                  aria-label={t("market.chartCommentsAt", {
                    time: formatCommentTime(activeCommentGroup.timestamp, locale, chartTimeframe),
                  })}
                  className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  style={{
                    left: commentPopoverLeft,
                    top: commentPopoverTop,
                    width: commentPopoverWidth,
                    height: commentPopoverHeight,
                    maxHeight: commentPopoverHeight,
                  }}
                  onPointerEnter={() => {
                    if (dismissTimerRef.current !== null)
                      window.clearTimeout(dismissTimerRef.current);
                    dismissTimerRef.current = null;
                  }}
                  onPointerLeave={scheduleCommentPopoverDismiss}
                  onFocusCapture={() => {
                    if (dismissTimerRef.current !== null)
                      window.clearTimeout(dismissTimerRef.current);
                    dismissTimerRef.current = null;
                  }}
                  onBlurCapture={scheduleCommentPopoverDismiss}
                >
                  <div className="flex items-center justify-between gap-2 px-3 pt-2">
                    <time
                      className="text-[11px] text-slate-500 dark:text-slate-400"
                      dateTime={new Date(activeCommentGroup.timestamp * 1000).toISOString()}
                    >
                      {formatCommentTime(activeCommentGroup.timestamp, locale, chartTimeframe)}
                    </time>
                    <button
                      type="button"
                      aria-label={t("common.close")}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-300 dark:hover:bg-slate-700"
                      onClick={() => closeCommentPopover(true)}
                    >
                      <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                  <div
                    role="region"
                    aria-label={t("market.chartCommentsAt", {
                      time: formatCommentTime(activeCommentGroup.timestamp, locale, chartTimeframe),
                    })}
                    tabIndex={0}
                    className="min-h-0 overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-blue-300"
                  >
                    <ul className="space-y-3">
                      {activeCommentGroup.comments.map((comment) => (
                        <li
                          key={comment.id}
                          className="border-b border-slate-100 pb-2 last:border-0 last:pb-0 dark:border-slate-700"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span
                              className="truncate font-medium"
                              data-testid="price-chart-comment-author"
                              title={comment.userId}
                            >
                              {authorProfiles.get(comment.userId)?.displayName.trim() ||
                                comment.userDisplayName}
                            </span>
                            <time className="shrink-0" dateTime={comment.timestamp}>
                              {formatCommentTime(
                                Math.floor(Date.parse(comment.timestamp) / 1000),
                                locale,
                                chartTimeframe,
                              )}
                            </time>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-xs">
                            {comment.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {latestValues.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4" data-testid="latest-price-pills">
          {latestValues.map((latest) => (
            <span
              key={latest.id}
              data-testid="latest-price-pill"
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
            >
              <OutcomeLabel
                outcome={{ label: latest.label, color: latest.color }}
                className="font-medium"
                labelClassName="text-slate-700 dark:text-slate-200"
              />
              <span>
                {latest.value === null ? t("trade.priceUnavailable") : formatPercent(latest.value)}
              </span>
            </span>
          ))}
        </div>
      )}

      {outcomes && outcomes.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {outcomes.slice(0, 8).map((outcome) => (
            <div key={outcome.id}>
              <OutcomeLabel
                outcome={outcome}
                className="text-xs"
                labelClassName="text-slate-600 dark:text-slate-400"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex rounded-lg bg-slate-100 dark:bg-slate-700 p-1">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => onTimeframeChange?.(tf)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors motion-reduce:transition-none ${
              chartTimeframe === tf
                ? "bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            {TIMEFRAME_LABELS[tf]}
          </button>
        ))}
      </div>
    </div>
  );
}
