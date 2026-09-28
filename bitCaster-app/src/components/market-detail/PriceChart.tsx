import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { canonicalizeOutcomeSet } from "@/lib/outcomeSets";
import { latestPricePointsPerSecond } from "@/lib/priceHistory";
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
const MAX_PRICE_HISTORY_POINTS_PER_OUTCOME = 1000;
const MAX_COMMENT_MARKERS = 40;
const COMMENT_MARKER_LANES = 4;
const COMMENT_MARKER_SPACING = 24;
const EMPTY_COMMENTS: Comment[] = [];

type Series = { id: string; label: string; color: string; data: PricePoint[] };
type CommentGroup = { timestamp: number; comments: Comment[] };
type PositionedCommentGroup = CommentGroup & { left: number; top: number; plotLeft: number };
type PositionedCommentCluster = {
  id: number;
  groups: PositionedCommentGroup[];
  left: number;
  top: number;
};
type CursorSample = { label: string; color: string; value: number };
type CursorReadout = {
  time: number;
  price: number;
  sampleTime: number;
  samples: CursorSample[];
  tooltipLeft: number;
  tooltipTop: number;
  xLabelLeft: number;
  xLabelTop: number;
  yLabelLeft: number;
  yLabelTop: number;
};

function groupComments(
  comments: readonly Comment[],
  xScale: { min: number; max: number } | null,
): { groups: CommentGroup[]; hiddenCount: number } {
  if (!xScale) return { groups: [], hiddenCount: 0 };
  const groupsBySecond = new Map<number, Comment[]>();
  for (const comment of comments) {
    const timestampMs = Date.parse(comment.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    const timestamp = Math.floor(timestampMs / 1000);
    if (timestamp < xScale.min || timestamp > xScale.max) continue;
    const group = groupsBySecond.get(timestamp) ?? [];
    group.push(comment);
    groupsBySecond.set(timestamp, group);
  }
  const groups = [...groupsBySecond]
    .map(([timestamp, groupedComments]) => ({ timestamp, comments: groupedComments }))
    .sort((left, right) => left.timestamp - right.timestamp);
  return {
    groups: groups.slice(-MAX_COMMENT_MARKERS),
    hiddenCount: Math.max(0, groups.length - MAX_COMMENT_MARKERS),
  };
}

function formatChartTime(timestampSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(timestampSeconds * 1000),
  );
}

function formatCommentTime(timestampSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(
    new Date(timestampSeconds * 1000),
  );
}

function clampPosition(value: number, elementSize: number, availableSize: number): number {
  const padding = Math.min(4, availableSize / 2);
  return Math.max(
    padding,
    Math.min(value, Math.max(padding, availableSize - elementSize - padding)),
  );
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

function normalizeSeriesData(data: PricePoint[], timeframe: ChartTimeframe): PricePoint[] {
  const sorted = latestPricePointsPerSecond(data);
  if (sorted.length === 0) return sorted;

  if (timeframe === "all") {
    return sorted.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME);
  }

  const newest = timeOf(sorted[sorted.length - 1]);
  const cutoff = newest - TIMEFRAME_SECONDS[timeframe] * 1000;
  const firstInWindow = sorted.findIndex((point) => timeOf(point) >= cutoff);
  const windowed = firstInWindow <= 0 ? sorted : sorted.slice(firstInWindow - 1);
  return windowed.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME);
}

function toUnixSeconds(point: PricePoint): number {
  return Math.floor(timeOf(point) / 1000);
}

function buildSeries(input: {
  priceHistory: PriceHistory;
  timeframe: ChartTimeframe;
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
        data: normalizeSeriesData(
          input.outcomePriceHistories?.[canonicalizeOutcomeSet([outcome.label])]?.data ?? [],
          input.timeframe,
        ),
      }))
      .filter((series) => series.data.length > 0);
  }

  return [
    {
      id: "primary",
      label: "",
      color: PRIMARY_SERIES_COLOR,
      data: normalizeSeriesData(input.priceHistory.data, input.timeframe),
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
): { min: number; max: number } | null {
  const times = data[0] as number[];
  if (times.length === 0) return null;
  if (timeframe !== "all") {
    const windowSeconds = TIMEFRAME_SECONDS[timeframe];
    const max = times[times.length - 1];
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
  const plotRef = useRef<uPlot | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const markerRefreshRef = useRef<((plot: uPlot) => void) | null>(null);
  const [cursorReadout, setCursorReadout] = useState<CursorReadout | null>(null);
  const [positionedCommentClusters, setPositionedCommentClusters] = useState<
    PositionedCommentCluster[]
  >([]);
  const [activeCommentTimestamp, setActiveCommentTimestamp] = useState<number | null>(null);
  const [activeCommentClusterId, setActiveCommentClusterId] = useState<number | null>(null);
  const [pinnedCommentClusterId, setPinnedCommentClusterId] = useState<number | null>(null);

  const series = useMemo(
    () =>
      disabledNumeric
        ? []
        : buildSeries({ priceHistory, timeframe: chartTimeframe, outcomePriceHistories, outcomes }),
    [priceHistory, chartTimeframe, outcomePriceHistories, outcomes, disabledNumeric],
  );
  const chartData = useMemo(() => alignSeries(series), [series]);
  const xScale = useMemo(() => xScaleFor(chartData, chartTimeframe), [chartData, chartTimeframe]);
  const commentGroupResult = useMemo(() => groupComments(comments, xScale), [comments, xScale]);
  const hasChartData = series.length > 0 && chartData[0].length > 0;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const activeCommentCluster = positionedCommentClusters.find(
    (cluster) => cluster.id === activeCommentClusterId,
  );
  const activeCommentGroup = activeCommentCluster?.groups.find(
    (group) => group.timestamp === activeCommentTimestamp,
  );
  const activePositionedCommentGroup = activeCommentGroup;
  const chartRegionWidth = measuredRegionSize(chartRegionRef.current, "width", 320);
  const chartRegionHeight = measuredRegionSize(chartRegionRef.current, "height", CHART_HEIGHT);
  const commentPopoverWidth = Math.max(1, Math.min(288, chartRegionWidth - 8));
  const commentPopoverHeight = Math.max(1, Math.min(176, chartRegionHeight - 8));
  const commentPopoverLeft = activePositionedCommentGroup
    ? clampPosition(
        activePositionedCommentGroup.left + COMMENT_MARKER_SPACING / 2,
        commentPopoverWidth,
        chartRegionWidth,
      )
    : 4;
  const commentPopoverTop = activePositionedCommentGroup
    ? clampPosition(
        activePositionedCommentGroup.top + COMMENT_MARKER_SPACING + 4 + commentPopoverHeight <=
          chartRegionHeight - 4
          ? activePositionedCommentGroup.top + COMMENT_MARKER_SPACING + 4
          : activePositionedCommentGroup.top - commentPopoverHeight - 4,
        commentPopoverHeight,
        chartRegionHeight,
      )
    : 4;
  const latestValues = series
    .map((s) => {
      const latest = s.data[s.data.length - 1];
      return latest ? { id: s.id, label: s.label, value: latest.price, color: s.color } : null;
    })
    .filter(
      (value): value is { id: string; label: string; value: number; color: string } =>
        value !== null,
    );

  const seriesSignature = series.map((s) => `${s.id}:${s.label}:${s.color}`).join("|");

  const closeCommentPopover = (restoreFocus: boolean) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    setPinnedCommentClusterId(null);
    setActiveCommentClusterId(null);
    setActiveCommentTimestamp(null);
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
      top: Math.max(plot.over.clientHeight, 1) / 2,
    });
  };

  const activateCommentMarker = (cluster: PositionedCommentCluster, marker: HTMLButtonElement) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    activeMarkerRef.current = marker;
    setActiveCommentClusterId(cluster.id);
    const selectedGroup = cluster.groups.find(
      (group) => group.timestamp === activeCommentTimestamp,
    );
    const group = selectedGroup ?? cluster.groups[0];
    setActiveCommentTimestamp(group.timestamp);
    setCommentCursor(group);
  };

  const selectCommentTimestamp = (group: PositionedCommentGroup) => {
    setActiveCommentTimestamp(group.timestamp);
    setCommentCursor(group);
  };

  const scheduleCommentPopoverDismiss = () => {
    if (pinnedCommentClusterId !== null || dismissTimerRef.current !== null) return;
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      setActiveCommentTimestamp(null);
    }, 120);
  };

  useEffect(() => {
    const container = chartEl.current;
    if (!container || !hasChartData) return;

    plotRef.current?.destroy();
    resizeObserverRef.current?.disconnect();
    setCursorReadout(null);
    setPositionedCommentClusters([]);

    const width = Math.max(
      Math.floor(container.clientWidth || container.getBoundingClientRect().width),
      1,
    );
    const steppedPaths = uPlot.paths.stepped?.({ align: 1 });
    const updateCursorReadout = (plot: uPlot) => {
      const { left, top, idx } = plot.cursor;
      if (left == null || top == null || left < 0 || idx == null) {
        setCursorReadout(null);
        return;
      }

      const axisTime = plot.posToVal(left, "x");
      const axisPrice = plot.posToVal(top, "y");
      const sampledTime = plot.data[0]?.[idx];
      if (typeof sampledTime !== "number") {
        setCursorReadout(null);
        return;
      }
      const samples = series.flatMap((item, index) => {
        const value = plot.data[index + 1]?.[idx];
        return typeof value === "number" ? [{ label: item.label, color: item.color, value }] : [];
      });
      const region = chartRegionRef.current;
      const regionRect = region?.getBoundingClientRect();
      const overRect = plot.over.getBoundingClientRect();
      const width = Math.max(region?.clientWidth ?? regionRect?.width ?? 1, 1);
      const height = Math.max(region?.clientHeight ?? regionRect?.height ?? CHART_HEIGHT, 1);
      const plotLeft = overRect.left - (regionRect?.left ?? 0);
      const plotTop = overRect.top - (regionRect?.top ?? 0);
      const xPosition = plotLeft + plot.valToPos(axisTime, "x");
      const yPosition = plotTop + plot.valToPos(axisPrice, "y");
      const tooltipWidth = Math.max(1, Math.min(240, width - 8));
      const tooltipHeight = Math.max(1, Math.min(112, height - 8));
      const xLabelWidth = Math.max(1, Math.min(96, width - 8));
      const yLabelWidth = Math.max(1, Math.min(72, width - 8));

      setCursorReadout({
        time: axisTime,
        price: axisPrice,
        sampleTime: sampledTime,
        samples,
        tooltipLeft: clampPosition(xPosition + 12, tooltipWidth, width),
        tooltipTop: clampPosition(yPosition - tooltipHeight - 10, tooltipHeight, height),
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
  }, [chartData, hasChartData, xScale]);

  useEffect(() => {
    const plot = plotRef.current;
    const region = chartRegionRef.current;
    if (!plot || !region || !hasChartData) {
      setPositionedCommentClusters([]);
      return;
    }

    const refreshPositions = (currentPlot: uPlot) => {
      const regionRect = region.getBoundingClientRect();
      const overRect = currentPlot.over.getBoundingClientRect();
      const offsetLeft = overRect.left - regionRect.left;
      const offsetTop = overRect.top - regionRect.top;
      const laneRightEdges = Array<number>(COMMENT_MARKER_LANES).fill(Number.NEGATIVE_INFINITY);
      const positioned: Array<PositionedCommentCluster & { lane: number }> = [];
      for (const group of commentGroupResult.groups) {
        const plotLeft = currentPlot.valToPos(group.timestamp, "x");
        const positionedGroup: PositionedCommentGroup = {
          ...group,
          plotLeft,
          left: clampPosition(
            offsetLeft + plotLeft - 12,
            24,
            measuredRegionSize(region, "width", 320),
          ),
          top: 0,
        };
        const lane = laneRightEdges.findIndex(
          (rightEdge) => plotLeft - rightEdge >= COMMENT_MARKER_SPACING,
        );
        if (lane < 0) {
          const nearestCluster = positioned.reduce((nearest, cluster) => {
            const clusterX = cluster.groups[0].plotLeft;
            return Math.abs(plotLeft - clusterX) < Math.abs(plotLeft - nearest.groups[0].plotLeft)
              ? cluster
              : nearest;
          });
          nearestCluster.groups.push(positionedGroup);
          positionedGroup.top = nearestCluster.top;
          laneRightEdges[nearestCluster.lane] = plotLeft + COMMENT_MARKER_SPACING;
          continue;
        }
        laneRightEdges[lane] = plotLeft + COMMENT_MARKER_SPACING;
        const markerWidth = 24;
        positionedGroup.top = offsetTop + 4 + lane * COMMENT_MARKER_SPACING;
        positioned.push({
          id: group.timestamp,
          groups: [positionedGroup],
          left: clampPosition(
            offsetLeft + plotLeft - markerWidth / 2,
            markerWidth,
            measuredRegionSize(region, "width", 320),
          ),
          top: positionedGroup.top,
          lane,
        });
      }
      setPositionedCommentClusters(positioned);
    };

    markerRefreshRef.current = refreshPositions;
    refreshPositions(plot);
    return () => {
      if (markerRefreshRef.current === refreshPositions) markerRefreshRef.current = null;
    };
  }, [commentGroupResult, hasChartData, seriesSignature, xScale]);

  useEffect(() => {
    if (activeCommentClusterId === null) return;
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
  }, [activeCommentClusterId]);

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
                  data-testid="price-chart-cursor-tooltip"
                  role="tooltip"
                  aria-hidden={activeCommentGroup !== undefined}
                  className={`absolute z-10 max-h-28 overflow-y-auto rounded-md border border-slate-200 bg-white/95 p-2 text-xs text-slate-700 shadow-md dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-100 ${activeCommentGroup ? "hidden" : ""}`}
                  style={{
                    left: cursorReadout.tooltipLeft,
                    top: cursorReadout.tooltipTop,
                    width: Math.max(1, Math.min(240, chartRegionWidth - 8)),
                    pointerEvents: "none",
                  }}
                >
                  <div>
                    <span className="font-semibold">{t("market.chartCursorTime")}:</span>{" "}
                    {formatChartTime(cursorReadout.time, locale)}
                  </div>
                  <div>
                    <span className="font-semibold">{t("market.chartCursorPrice")}:</span>{" "}
                    {formatPercent(cursorReadout.price)}
                  </div>
                  {cursorReadout.samples.length === 0 ? (
                    <p className="mt-1 text-slate-500 dark:text-slate-400">
                      {t("market.chartNoSampleAtCursor")}
                    </p>
                  ) : (
                    <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-600">
                      <div className="text-slate-500 dark:text-slate-400">
                        {t("market.chartSampledTime")}:{" "}
                        {formatChartTime(cursorReadout.sampleTime, locale)}
                      </div>
                      {cursorReadout.samples.map((sample, index) => (
                        <div
                          key={`${sample.label}:${index}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="truncate">
                            {sample.label || t("market.chartSampledPrice")}:{" "}
                          </span>
                          <span className="shrink-0 font-semibold" style={{ color: sample.color }}>
                            {formatPercent(sample.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div
                  data-testid="price-chart-x-axis-cursor-label"
                  aria-hidden="true"
                  className="pointer-events-none absolute z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white shadow"
                  style={{ left: cursorReadout.xLabelLeft, top: cursorReadout.xLabelTop }}
                >
                  {formatChartTime(cursorReadout.time, locale)}
                </div>
                {!activeCommentGroup && (
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
              {positionedCommentClusters.map((cluster) => {
                const firstGroup = cluster.groups[0];
                const label =
                  cluster.groups.length === 1
                    ? t("market.chartCommentMarker", {
                        time: formatCommentTime(firstGroup.timestamp, locale),
                        count: firstGroup.comments.length,
                      })
                    : t("market.chartCommentClusterMarker", {
                        count: cluster.groups.length,
                        start: formatCommentTime(firstGroup.timestamp, locale),
                        end: formatCommentTime(
                          cluster.groups[cluster.groups.length - 1].timestamp,
                          locale,
                        ),
                      });
                const expanded = activeCommentClusterId === cluster.id;
                return (
                  <button
                    key={cluster.id}
                    type="button"
                    data-testid="price-chart-comment-marker"
                    data-chart-comment-marker="true"
                    aria-label={label}
                    aria-haspopup="dialog"
                    aria-expanded={expanded}
                    aria-controls={`price-chart-comments-${cluster.id}`}
                    title={label}
                    className="pointer-events-auto absolute flex h-5 min-w-5 items-center justify-center rounded-full border border-amber-700 bg-amber-100 px-1 text-[10px] font-bold leading-none text-amber-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-amber-300 dark:bg-amber-300 dark:text-slate-900"
                    style={{ left: cluster.left, top: cluster.top }}
                    onPointerEnter={(event) => activateCommentMarker(cluster, event.currentTarget)}
                    onPointerLeave={scheduleCommentPopoverDismiss}
                    onFocus={(event) => {
                      if (ignoreNextMarkerFocusRef.current) {
                        ignoreNextMarkerFocusRef.current = false;
                        return;
                      }
                      activateCommentMarker(cluster, event.currentTarget);
                    }}
                    onBlur={scheduleCommentPopoverDismiss}
                    onClick={(event) => {
                      if (pinnedCommentClusterId === cluster.id) {
                        closeCommentPopover(false);
                      } else {
                        setPinnedCommentClusterId(cluster.id);
                        activateCommentMarker(cluster, event.currentTarget);
                      }
                    }}
                  >
                    {cluster.groups.length > 1
                      ? cluster.groups.length
                      : firstGroup.comments.length > 1
                        ? firstGroup.comments.length
                        : "•"}
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
            {activeCommentCluster && activeCommentGroup && activePositionedCommentGroup && (
              <div
                ref={commentPopoverRef}
                id={`price-chart-comments-${activeCommentCluster.id}`}
                data-testid="price-chart-comment-popover"
                role="dialog"
                aria-label={t("market.chartCommentsAt", {
                  time: formatCommentTime(activeCommentGroup.timestamp, locale),
                })}
                className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                style={{
                  left: commentPopoverLeft,
                  top: commentPopoverTop,
                  width: commentPopoverWidth,
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
                <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-600">
                  <h4 className="text-xs font-semibold">
                    {t("market.chartCommentsAt", {
                      time: formatCommentTime(activeCommentGroup.timestamp, locale),
                    })}
                  </h4>
                  <button
                    type="button"
                    className="shrink-0 rounded px-1 text-xs text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-300 dark:hover:bg-slate-700"
                    onClick={() => closeCommentPopover(true)}
                  >
                    {t("common.close")}
                  </button>
                </div>
                <div
                  role="region"
                  aria-label={t("market.chartCommentsAt", {
                    time: formatCommentTime(activeCommentGroup.timestamp, locale),
                  })}
                  tabIndex={0}
                  className="min-h-0 overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-blue-300"
                >
                  {activeCommentCluster.groups.length > 1 && (
                    <div
                      role="group"
                      aria-label={t("market.chartCommentTimes")}
                      className="mb-3 flex flex-wrap gap-1 border-b border-slate-200 pb-2 dark:border-slate-600"
                    >
                      {activeCommentCluster.groups.map((group) => (
                        <button
                          key={group.timestamp}
                          type="button"
                          data-testid="price-chart-comment-time-choice"
                          aria-pressed={group.timestamp === activeCommentGroup.timestamp}
                          className="rounded bg-slate-100 px-1.5 py-1 text-[10px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-slate-100"
                          onClick={() => selectCommentTimestamp(group)}
                        >
                          {formatCommentTime(group.timestamp, locale)}
                        </button>
                      ))}
                    </div>
                  )}
                  <ul className="space-y-3">
                    {activeCommentGroup.comments.map((comment) => (
                      <li
                        key={comment.id}
                        className="border-b border-slate-100 pb-2 last:border-0 last:pb-0 dark:border-slate-700"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="truncate font-medium">{comment.userDisplayName}</span>
                          <time className="shrink-0" dateTime={comment.timestamp}>
                            {formatCommentTime(
                              Math.floor(Date.parse(comment.timestamp) / 1000),
                              locale,
                            )}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-xs">{comment.content}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
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
              <span>{formatPercent(latest.value)}</span>
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
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
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
