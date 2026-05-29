import { useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PriceHistory, ChartTimeframe, Comment, PricePoint } from '@/types/market-detail'

interface PriceChartProps {
  priceHistory: PriceHistory
  chartTimeframe: ChartTimeframe
  onTimeframeChange?: (timeframe: ChartTimeframe) => void
  // For categorical markets
  outcomePriceHistories?: Record<string, PriceHistory>
  outcomes?: Array<{ id: string; label: string; odds: number }>
  // Current display: percentage or resolved outcome text
  currentDisplay?: string
  // Comments to display as bubbles on the chart
  comments?: Comment[]
  // Unit for numeric markets (e.g. "USD") — changes Y-axis labels
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
  'rgb(59, 130, 246)', // blue
  'rgb(16, 185, 129)', // emerald
  'rgb(245, 158, 11)', // amber
  'rgb(239, 68, 68)',  // red
  'rgb(139, 92, 246)', // violet
  'rgb(236, 72, 153)', // pink
]

// SVG coordinate system. A fixed viewBox (no preserveAspectRatio="none") keeps
// step strokes and pills geometrically correct — the previous chart squashed a
// 0..100 box to the container aspect ratio and distorted every stroke.
const VIEW_W = 1000
const VIEW_H = 300
const PAD_TOP = 16
const PAD_BOTTOM = 40 // room for X-axis tick labels
const PAD_LEFT = 8
const PAD_RIGHT = 88 // room for the latest-value pills + right Y-axis labels
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM

type Series = { id: string; label: string; color: string; data: PricePoint[] }

function timeOf(point: PricePoint): number {
  return new Date(point.timestamp).getTime()
}

// Ensure points are ascending in time so the newest sits at the right edge.
function sortAscending(data: PricePoint[]): PricePoint[] {
  return [...data].sort((a, b) => timeOf(a) - timeOf(b))
}

export function PriceChart({
  priceHistory,
  chartTimeframe,
  onTimeframeChange,
  outcomePriceHistories,
  outcomes,
  currentDisplay,
  comments,
  unit,
}: PriceChartProps) {
  const { t } = useTranslation()
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null)

  // Build the series list (time-ascending). Categorical markets render one
  // line per outcome; everything else renders a single primary line.
  const isMultiLine = !!(outcomePriceHistories && outcomes && outcomes.length > 0)
  const series: Series[] = isMultiLine && outcomePriceHistories && outcomes
    ? outcomes
        .slice(0, 6)
        .map((outcome, idx) => ({
          id: outcome.id,
          label: outcome.label,
          color: OUTCOME_COLORS[idx % OUTCOME_COLORS.length],
          data: sortAscending(outcomePriceHistories[outcome.id]?.data ?? []),
        }))
        .filter((s) => s.data.length > 0)
    : [
        {
          id: 'primary',
          label: '',
          color: OUTCOME_COLORS[0],
          data: sortAscending(priceHistory.data),
        },
      ].filter((s) => s.data.length > 0)

  const allPoints = series.flatMap((s) => s.data)
  const hasChartData = allPoints.length > 0

  // Y-axis bounds (probability charts default to the 0..100 box).
  const prices = allPoints.map((p) => p.price)
  const minPrice = Math.min(...prices, 0)
  const maxPrice = Math.max(...prices, 100)
  const priceRange = maxPrice - minPrice || 1

  // X-axis time bounds. With a single point we still want a visible horizontal
  // line spanning the full plot, so we synthesize a 1-step span.
  const times = allPoints.map(timeOf)
  const timeMin = times.length ? Math.min(...times) : 0
  const timeMaxRaw = times.length ? Math.max(...times) : 1
  const timeMax = timeMaxRaw > timeMin ? timeMaxRaw : timeMin + 1
  const timeSpan = timeMax - timeMin

  function xOf(timeMs: number): number {
    if (timeSpan <= 0) return PAD_LEFT + PLOT_W
    return PAD_LEFT + ((timeMs - timeMin) / timeSpan) * PLOT_W
  }

  function yOf(price: number): number {
    return PAD_TOP + (1 - (price - minPrice) / priceRange) * PLOT_H
  }

  // Step path: hold the previous price until the next sample's timestamp, then
  // jump — the "step-after" shape Predyx uses. A single point becomes a
  // full-width horizontal line at its price.
  function stepPath(data: PricePoint[]): string {
    if (data.length === 0) return ''
    if (data.length === 1) {
      const y = yOf(data[0].price)
      return `M ${PAD_LEFT} ${y} H ${PAD_LEFT + PLOT_W}`
    }
    let d = ''
    data.forEach((point, i) => {
      const x = xOf(timeOf(point))
      const y = yOf(point.price)
      if (i === 0) {
        d += `M ${x} ${y}`
      } else {
        // horizontal to the new x at the previous y, then vertical to new y
        d += ` H ${x} V ${y}`
      }
    })
    return d
  }

  // X-axis date ticks across the visible window.
  const X_TICK_COUNT = 5
  const xTicks = hasChartData
    ? Array.from({ length: X_TICK_COUNT }, (_, i) => {
        const time = timeMin + (timeSpan * i) / (X_TICK_COUNT - 1)
        return { x: xOf(time), time }
      })
    : []

  function formatTick(timeMs: number): string {
    const date = new Date(timeMs)
    // Short window → time of day; longer windows → month/day.
    if (chartTimeframe === '1h' || chartTimeframe === '24h') {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  function formatPrice(value: number): string {
    if (unit === 'USD') return `$${value.toLocaleString()}`
    if (unit) return `${value.toLocaleString()} ${unit}`
    return `${value.toFixed(0)}%`
  }

  function formatPill(value: number): string {
    if (unit === 'USD') return `$${value.toLocaleString()}`
    if (unit) return `${value.toLocaleString()}`
    return value.toFixed(2)
  }

  // Latest value pill per series, anchored at the rightmost (newest) sample.
  const pills = series
    .map((s) => {
      const latest = s.data[s.data.length - 1]
      return latest ? { id: s.id, color: s.color, value: latest.price, y: yOf(latest.price) } : null
    })
    .filter((p): p is { id: string; color: string; value: number; y: number } => p !== null)

  const yLabels = [maxPrice, (maxPrice + minPrice) / 2, minPrice]

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        {/* Current Display: percentage or resolved outcome */}
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

      {/* Chart Area */}
      <div className="relative h-56 mb-4 bg-slate-50 dark:bg-slate-900 rounded-xl overflow-hidden">
        {!hasChartData ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
            {t('market.noDataAvailable')}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="w-full h-full"
            data-testid="price-chart-svg"
          >
            {/* Horizontal grid lines aligned with the right-edge Y labels */}
            {yLabels.map((value, i) => {
              const y = yOf(value)
              return (
                <line
                  key={`grid-${i}`}
                  x1={PAD_LEFT}
                  y1={y}
                  x2={PAD_LEFT + PLOT_W}
                  y2={y}
                  stroke="currentColor"
                  className="text-slate-200 dark:text-slate-700"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}

            {/* X-axis baseline */}
            <line
              x1={PAD_LEFT}
              y1={PAD_TOP + PLOT_H}
              x2={PAD_LEFT + PLOT_W}
              y2={PAD_TOP + PLOT_H}
              stroke="currentColor"
              className="text-slate-300 dark:text-slate-600"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />

            {/* X-axis tick marks + date labels */}
            {xTicks.map((tick, i) => (
              <g key={`xtick-${i}`} data-testid="x-axis-tick">
                <line
                  x1={tick.x}
                  y1={PAD_TOP + PLOT_H}
                  x2={tick.x}
                  y2={PAD_TOP + PLOT_H + 4}
                  stroke="currentColor"
                  className="text-slate-300 dark:text-slate-600"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={tick.x}
                  y={PAD_TOP + PLOT_H + 22}
                  textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
                  className="fill-slate-400 dark:fill-slate-500"
                  fontSize="14"
                >
                  {formatTick(tick.time)}
                </text>
              </g>
            ))}

            {/* Series step lines */}
            {series.map((s) => (
              <path
                key={`line-${s.id}`}
                d={stepPath(s.data)}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                data-testid="series-line"
              />
            ))}

            {/* Latest-value pills anchored at the right edge per series */}
            {pills.map((pill) => {
              const pillX = PAD_LEFT + PLOT_W + 4
              const pillW = 70
              const pillH = 22
              const pillY = Math.min(
                Math.max(pill.y - pillH / 2, PAD_TOP),
                PAD_TOP + PLOT_H - pillH,
              )
              return (
                <g key={`pill-${pill.id}`} data-testid="latest-price-pill">
                  <rect
                    x={pillX}
                    y={pillY}
                    width={pillW}
                    height={pillH}
                    rx={6}
                    fill={pill.color}
                  />
                  <text
                    x={pillX + pillW / 2}
                    y={pillY + pillH / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize="15"
                    fontWeight="600"
                  >
                    {formatPill(pill.value)}
                  </text>
                </g>
              )
            })}
          </svg>
        )}

        {/* Y-Axis Labels (right side, matching the reference layout) */}
        {hasChartData && (
          <div className="absolute inset-y-0 right-1 flex flex-col justify-between py-3 text-[10px] text-slate-400 dark:text-slate-500 font-mono pointer-events-none">
            {yLabels.map((value, i) => (
              <span key={`ylabel-${i}`}>{formatPrice(value)}</span>
            ))}
          </div>
        )}

        {/* Comment Bubbles */}
        {comments && comments.length > 0 && allPoints.length >= 2 && (() => {
          const maxLikes = Math.max(...comments.map((c) => c.likeCount), 1)

          const visibleComments = comments.filter((c) => {
            const ct = new Date(c.timestamp).getTime()
            return ct >= timeMin && ct <= timeMax
          })

          return visibleComments.map((comment) => {
            const commentTime = new Date(comment.timestamp).getTime()
            const xPercent = ((commentTime - timeMin) / timeSpan) * 90 + 2
            const size = 24 + 16 * (comment.likeCount / maxLikes)
            const opacity = 0.4 + 0.6 * (comment.likeCount / maxLikes)
            const isHovered = hoveredCommentId === comment.id

            return (
              <div
                key={comment.id}
                className="absolute group"
                style={{
                  left: `${xPercent}%`,
                  bottom: '28px',
                  transform: 'translateX(-50%)',
                }}
                onMouseEnter={() => setHoveredCommentId(comment.id)}
                onMouseLeave={() => setHoveredCommentId(null)}
              >
                <div
                  className="flex items-center justify-center rounded-full bg-blue-500 text-white cursor-pointer transition-transform hover:scale-125"
                  style={{
                    width: `${size}px`,
                    height: `${size}px`,
                    opacity,
                  }}
                >
                  <MessageCircle className="w-3 h-3" />
                </div>

                {/* Tooltip */}
                {isHovered && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-slate-800 dark:bg-slate-700 text-white text-xs rounded-lg p-2.5 shadow-lg z-10 pointer-events-none">
                    <p className="font-medium mb-0.5">{comment.userDisplayName}</p>
                    <p className="text-slate-300 line-clamp-2">{comment.content}</p>
                    <p className="text-slate-400 mt-1">{t('market.likes', { count: comment.likeCount })}</p>
                  </div>
                )}
              </div>
            )
          })
        })()}
      </div>

      {/* Legend for Categorical Markets */}
      {isMultiLine && outcomes && (
        <div className="flex flex-wrap gap-3 mb-4">
          {outcomes.slice(0, 6).map((outcome, idx) => (
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

      {/* Timeframe Selector */}
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
