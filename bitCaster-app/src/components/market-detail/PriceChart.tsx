import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { PriceHistory, ChartTimeframe, Comment, PricePoint } from '@/types/market-detail'

interface PriceChartProps {
  priceHistory: PriceHistory
  chartTimeframe: ChartTimeframe
  onTimeframeChange?: (timeframe: ChartTimeframe) => void
  outcomePriceHistories?: Record<string, PriceHistory>
  outcomes?: Array<{ id: string; label: string; odds: number }>
  currentDisplay?: string
  comments?: Comment[]
  unit?: string
}

const TIMEFRAMES: ChartTimeframe[] = ['1h', '24h', '7d', '30d', 'all']

const TIMEFRAME_LABELS: Record<ChartTimeframe, string> = {
  '1h': '1H',
  '24h': '24H',
  '7d': '7D',
  '30d': '1 Month',
  'all': 'ALL',
}

const OUTCOME_COLORS = [
  'rgb(59, 130, 246)',
  'rgb(16, 185, 129)',
  'rgb(245, 158, 11)',
  'rgb(239, 68, 68)',
  'rgb(139, 92, 246)',
  'rgb(236, 72, 153)',
  'rgb(20, 184, 166)',
  'rgb(244, 63, 94)',
]

const CHART_HEIGHT = 224

type Series = { id: string; label: string; color: string; data: PricePoint[] }

function timeOf(point: PricePoint): number {
  return new Date(point.timestamp).getTime()
}

function sortAscending(data: PricePoint[]): PricePoint[] {
  return [...data].sort((a, b) => timeOf(a) - timeOf(b))
}

function toUnixSeconds(point: PricePoint): number {
  return Math.floor(timeOf(point) / 1000)
}

function buildSeries(input: {
  priceHistory: PriceHistory
  outcomePriceHistories?: Record<string, PriceHistory>
  outcomes?: Array<{ id: string; label: string; odds: number }>
}): Series[] {
  const isMultiLine = !!(
    input.outcomePriceHistories &&
    input.outcomes &&
    input.outcomes.length > 0
  )

  if (isMultiLine && input.outcomePriceHistories && input.outcomes) {
    return input.outcomes
      .slice(0, 8)
      .map((outcome, idx) => ({
        id: outcome.id,
        label: outcome.label,
        color: OUTCOME_COLORS[idx % OUTCOME_COLORS.length],
        data: sortAscending(input.outcomePriceHistories?.[outcome.id]?.data ?? []),
      }))
      .filter((series) => series.data.length > 0)
  }

  return [
    {
      id: 'primary',
      label: '',
      color: OUTCOME_COLORS[0],
      data: sortAscending(input.priceHistory.data),
    },
  ].filter((series) => series.data.length > 0)
}

function alignSeries(series: Series[]): uPlot.AlignedData {
  const times = [
    ...new Set(series.flatMap((s) => s.data.map((point) => toUnixSeconds(point)))),
  ].sort((a, b) => a - b)

  const yValues = series.map((s) => {
    const byTime = new Map(s.data.map((point) => [toUnixSeconds(point), point.price]))
    return times.map((time) => byTime.get(time) ?? null)
  })

  return [times, ...yValues] as uPlot.AlignedData
}

function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`
}

export function PriceChart({
  priceHistory,
  chartTimeframe,
  onTimeframeChange,
  outcomePriceHistories,
  outcomes,
  currentDisplay,
}: PriceChartProps) {
  const { t } = useTranslation()
  const chartEl = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const series = useMemo(
    () => buildSeries({ priceHistory, outcomePriceHistories, outcomes }),
    [priceHistory, outcomePriceHistories, outcomes],
  )
  const chartData = useMemo(() => alignSeries(series), [series])
  const hasChartData = series.length > 0 && chartData[0].length > 0
  const latestValues = series
    .map((s) => {
      const latest = s.data[s.data.length - 1]
      return latest ? { id: s.id, label: s.label, value: latest.price, color: s.color } : null
    })
    .filter((value): value is { id: string; label: string; value: number; color: string } => value !== null)

  const seriesSignature = series.map((s) => `${s.id}:${s.label}:${s.color}`).join('|')

  useEffect(() => {
    const container = chartEl.current
    if (!container || !hasChartData) return

    plotRef.current?.destroy()
    resizeObserverRef.current?.disconnect()

    const width = Math.max(Math.floor(container.clientWidth || container.getBoundingClientRect().width), 1)
    const steppedPaths = uPlot.paths.stepped?.({ align: 1 })
    const plot = new uPlot(
      {
        width,
        height: CHART_HEIGHT,
        cursor: {
          drag: { setScale: false },
        },
        legend: { show: false },
        scales: {
          x: { time: true },
          y: { range: [0, 100] },
        },
        axes: [
          {
            stroke: '#64748b',
            grid: { show: false },
          },
          {
            side: 1,
            stroke: '#64748b',
            values: (_u, values) => values.map((value) => formatPercent(value)),
            splits: () => [0, 50, 100],
          },
        ],
        series: [
          {},
          ...series.map((s) => ({
            label: s.label || t('market.priceChart'),
            stroke: s.color,
            width: 2,
            points: { show: false },
            paths: steppedPaths,
            value: (_u: uPlot, value: number | null) => (value == null ? '' : formatPercent(value)),
          })),
        ],
      },
      chartData,
      container,
    )

    plotRef.current = plot
    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(Math.floor(entry.contentRect.width), 1)
      plot.setSize({ width: nextWidth, height: CHART_HEIGHT })
    })
    resizeObserver.observe(container)
    resizeObserverRef.current = resizeObserver

    return () => {
      resizeObserver.disconnect()
      plot.destroy()
      if (plotRef.current === plot) plotRef.current = null
      if (resizeObserverRef.current === resizeObserver) resizeObserverRef.current = null
    }
  }, [hasChartData, seriesSignature])

  useEffect(() => {
    if (!plotRef.current || !hasChartData) return
    plotRef.current.setData(chartData)
  }, [chartData, hasChartData])

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
              {t('market.priceChart')}
            </h3>
          )}
        </div>
      </div>

      <div className="relative h-56 mb-4 rounded-xl bg-slate-50 dark:bg-slate-900 overflow-hidden">
        {!hasChartData ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
            {t('market.noDataAvailable')}
          </div>
        ) : (
          <>
            <div ref={chartEl} data-testid="price-chart-uplot" className="h-full w-full [&_.u-over]:rounded-xl" />
          </>
        )}
      </div>

      {latestValues.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4" data-testid="latest-price-pills">
          {latestValues.map((latest) => (
            <span
              key={latest.id}
              data-testid="latest-price-pill"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-white"
              style={{ backgroundColor: latest.color }}
            >
              {latest.label && <span>{latest.label}</span>}
              <span>{formatPercent(latest.value)}</span>
            </span>
          ))}
        </div>
      )}

      {outcomes && outcomes.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {outcomes.slice(0, 8).map((outcome, idx) => (
            <div key={outcome.id} className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: OUTCOME_COLORS[idx % OUTCOME_COLORS.length] }}
              />
              <span className="text-xs text-slate-600 dark:text-slate-400">{outcome.label}</span>
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
                ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {TIMEFRAME_LABELS[tf]}
          </button>
        ))}
      </div>
    </div>
  )
}
