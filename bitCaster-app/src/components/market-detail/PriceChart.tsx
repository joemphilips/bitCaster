import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmedPriceAtOrBefore, TIMEFRAME_WINDOW_MS } from "@/lib/priceHistory";
import type { Outcome } from "@/types/market";
import { normalizeOutcomeColor, OutcomeLabel } from "@/components/shared/OutcomeLabel";
import type { PriceHistory, ChartTimeframe, Comment } from "@/types/market-detail";
import { PriceChartAnnotations, type ChartProfileRequests } from "./PriceChartAnnotations";
import { PriceChartCanvas, type PriceChartRender } from "./PriceChartCanvas";
import {
  preparePriceSeries,
  windowPriceSeries,
  chartDomain,
  createChartAxisTimeFormatter,
  formatPercent,
  groupComments,
  commentLayout,
} from "./priceChartModel";

interface PriceChartProps {
  priceHistory: PriceHistory;
  chartTimeframe: ChartTimeframe;
  onTimeframeChange?: (timeframe: ChartTimeframe) => void;
  outcomePriceHistories?: Record<string, PriceHistory>;
  outcomes?: Outcome[];
  currentDisplay?: string;
  emptyDisplay?: string;
  comments?: Comment[];
  divisibility?: number;
  historyStatus?: "loading" | "refreshing" | "ready" | "unavailable";
  priceRefreshUnavailable?: boolean;
  priceAuthorityUnavailable?: boolean;
  hasConfirmedTrades?: boolean;
  unit?: string;
  /** Numeric markets remain disabled until a native numeric trade exists. */
  disabledNumeric?: boolean;
}

const TIMEFRAMES: ChartTimeframe[] = ["1h", "24h", "7d", "30d", "all"];
const TIMEFRAME_LABELS: Record<ChartTimeframe, string> = {
  "1h": "1H",
  "24h": "24H",
  "7d": "7D",
  "30d": "1 Month",
  all: "ALL",
};

const EMPTY_COMMENTS: Comment[] = [];

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
  divisibility,
  historyStatus,
  priceRefreshUnavailable = false,
  priceAuthorityUnavailable = false,
  hasConfirmedTrades,
}: PriceChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [chartRender, setChartRender] = useState<PriceChartRender | null>(null);
  // Reuse selected-author requests across card changes; annotations prune obsolete authors.
  const profileRequests = useRef<ChartProfileRequests>(new Map());
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
  const preparedSeries = useMemo(
    () =>
      disabledNumeric ? [] : preparePriceSeries({ priceHistory, outcomePriceHistories, outcomes }),
    [priceHistory, outcomePriceHistories, outcomes, disabledNumeric],
  );
  const expiryTimes = useMemo(() => {
    const windowMs = TIMEFRAME_WINDOW_MS[chartTimeframe];
    if (windowMs === null) return [];
    // Sort only this auxiliary schedule. The rendered fill order stays intact.
    return preparedSeries
      .flatMap((item) => item.data.map((point) => point.timestampMs + windowMs + 1))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
  }, [preparedSeries, chartTimeframe]);
  useEffect(() => {
    if (clock.asOfMs === null || expiryTimes.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const schedule = () => {
      const now = clock.asOfMs! + Math.floor(Math.max(0, performance.now() - clock.receivedAt));
      let first = 0;
      let last = expiryTimes.length;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        if (expiryTimes[middle] <= now) first = middle + 1;
        else last = middle;
      }
      const nextExpiry = expiryTimes[first];
      if (nextExpiry === undefined || !Number.isFinite(nextExpiry)) return;
      timer = setTimeout(
        () => {
          // Expiries can cluster between paints. Read the real clock once the
          // pending frame invalidates the chart, retaining every due cutoff.
          if (frame === undefined) {
            frame = requestAnimationFrame(() => {
              frame = undefined;
              setExpiryTick((tick) => tick + 1);
            });
          }
          schedule();
        },
        Math.min(2_147_483_647, Math.max(1, nextExpiry - now)),
      );
    };
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [clock, expiryTimes]);

  const series = useMemo(
    () => windowPriceSeries(preparedSeries, chartTimeframe, evaluationMs),
    [preparedSeries, chartTimeframe, evaluationMs],
  );

  const domain = useMemo(
    () => chartDomain(series, chartTimeframe, evaluationMs),
    [series, chartTimeframe, evaluationMs],
  );
  const isCategorical = Boolean(outcomes && outcomes.length > 0 && !disabledNumeric);
  const commentGroupResult = useMemo(
    () => groupComments(comments, domain, series, isCategorical),
    [comments, domain, series, isCategorical],
  );
  const measuredPlot = chartRender?.chart.chartArea;
  const requiredPlotHeight = measuredPlot
    ? commentLayout(measuredPlot.width, commentGroupResult.groups.length).requiredPlotHeight
    : 0;
  const chartHeight = Math.max(
    224,
    Math.ceil(
      requiredPlotHeight +
        (measuredPlot && chartRender ? chartRender.chart.height - measuredPlot.height : 0),
    ),
  );
  const hasChartData = domain !== null;
  const formatTimeTick = useMemo(
    () => createChartAxisTimeFormatter(locale, chartTimeframe, domain),
    [locale, chartTimeframe, domain],
  );
  const displayedSeries = isCategorical
    ? (outcomes ?? []).slice(0, 8).map((outcome) => ({
        id: outcome.id,
        label: outcome.label,
        color: normalizeOutcomeColor(outcome.color),
        data: series.find((item) => item.id === outcome.id)?.data ?? [],
      }))
    : series;
  const latestValues = displayedSeries.map((item) => {
    const odds = outcomes?.find((outcome) => outcome.id === item.id)?.odds;
    const currentValue =
      odds != null && divisibility != null && divisibility > 1 && odds > 0 && odds < divisibility
        ? (odds * 100) / divisibility
        : null;
    return {
      id: item.id,
      label: item.label,
      color: item.color,
      neverTraded: isCategorical && odds === null && !priceAuthorityUnavailable,
      value:
        cursorTime !== null
          ? confirmedPriceAtOrBefore(item.data, cursorTime / 1000)
          : isCategorical
            ? currentValue
            : (item.data[item.data.length - 1]?.price ?? null),
    };
  });
  const freshnessMessage = disabledNumeric
    ? null
    : historyStatus === "unavailable" || priceRefreshUnavailable
      ? t("market.priceRefreshUnavailable")
      : historyStatus === "refreshing"
        ? t("market.priceHistoryUpdating")
        : null;
  const emptyMessage = disabledNumeric
    ? t("trade.priceUnavailable")
    : historyStatus === "loading" || historyStatus === "refreshing"
      ? t("market.priceHistoryLoading")
      : historyStatus === "unavailable"
        ? t("trade.priceUnavailable")
        : (emptyDisplay ??
          (hasConfirmedTrades === false
            ? t("trade.noTrades")
            : chartTimeframe !== "all" && hasConfirmedTrades === true
              ? t("market.noTradesInPeriod")
              : t("market.noDataAvailable")));
  useEffect(() => {
    setCursorTime(null);
  }, [chartTimeframe, hasChartData]);
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
        data-testid="price-chart-region"
        className="relative mb-4 rounded-xl bg-slate-50 dark:bg-slate-900 overflow-hidden"
        style={{ height: chartHeight }}
      >
        {!hasChartData ? (
          <div
            data-testid="price-chart-empty-state"
            className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm"
          >
            {emptyMessage}
          </div>
        ) : (
          <div data-testid="price-chart-chartjs" className="h-full w-full">
            <PriceChartCanvas
              series={series}
              domain={domain!}
              formatTime={formatTimeTick}
              onRender={setChartRender}
              height={chartHeight}
            />
            <PriceChartAnnotations
              renderState={chartRender}
              layoutReady={
                chartRender !== null &&
                chartRender.isActive() &&
                chartRender.series === series &&
                chartRender.domain === domain
              }
              profileRequests={profileRequests.current}
              overlay={overlay}
              commentGroupResult={commentGroupResult}
              series={series}
              chartTimeframe={chartTimeframe}
              isCategorical={isCategorical}
              cursorTime={cursorTime}
              onCursorTime={setCursorTime}
            />
          </div>
        )}
        <div
          ref={setOverlay}
          data-testid="price-chart-overlay"
          className="pointer-events-none absolute inset-0"
        />
      </div>

      <div className="mb-4 grid text-sm text-slate-500 dark:text-slate-400">
        {/* Reserve the translated messages' height so refreshes do not move controls. */}
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {t("market.priceHistoryUpdating")}
        </span>
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {t("market.priceRefreshUnavailable")}
        </span>
        {freshnessMessage && (
          <p role="status" className="col-start-1 row-start-1">
            {freshnessMessage}
          </p>
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
                {latest.value === null
                  ? t(latest.neverTraded ? "trade.noTrades" : "trade.priceUnavailable")
                  : formatPercent(latest.value)}
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
