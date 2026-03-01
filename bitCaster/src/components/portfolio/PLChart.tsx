import type { PLChartData, PLTimeSelector } from '@/types/portfolio'
import { formatBtc } from '@/lib/format'

const TIME_RANGES: PLTimeSelector[] = ['1D', '1W', '1M', 'ALL']

interface PLChartProps {
  chartData: PLChartData
  selectedTimeRange: PLTimeSelector
  onTimeRangeChange?: (range: PLTimeSelector) => void
}

export function PLChart({ chartData, selectedTimeRange, onTimeRangeChange }: PLChartProps) {
  const data = chartData[selectedTimeRange]
  const currentPL = data.length > 0 ? data[data.length - 1].cumulativePL : 0
  const startPL = data.length > 0 ? data[0].cumulativePL : 0
  const periodChange = currentPL - startPL
  const isPositive = currentPL >= 0
  const periodPositive = periodChange >= 0

  // SVG chart generation
  const values = data.map((d) => d.cumulativePL)
  const minVal = Math.min(...values, 0)
  const maxVal = Math.max(...values, 1)
  const range = maxVal - minVal || 1

  const width = 100
  const height = 100
  const padding = 4

  const points = data.map((d, i) => {
    const x = padding + ((width - 2 * padding) * i) / (data.length - 1 || 1)
    const y = height - padding - ((d.cumulativePL - minVal) / range) * (height - 2 * padding)
    return { x, y }
  })

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? width - padding} ${height} L ${points[0]?.x ?? padding} ${height} Z`

  const lineColor = isPositive ? 'rgb(16, 185, 129)' : 'rgb(239, 68, 68)'

  return (
    <div>
      {/* P/L Amount */}
      <div className="mb-3">
        <div className={`text-2xl font-bold font-mono ${isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
          {isPositive ? '+' : ''}{formatBtc(currentPL)}
        </div>
        <div className={`text-sm font-mono ${periodPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
          {periodPositive ? '+' : ''}{formatBtc(periodChange)} this period
        </div>
      </div>

      {/* SVG Chart */}
      <div className="relative h-32 bg-slate-50 dark:bg-slate-900/50 rounded-xl overflow-hidden mb-3">
        {data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
            No data
          </div>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full">
            <defs>
              <linearGradient id="plAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity="0.2" />
                <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#plAreaGradient)" />
            <path d={linePath} fill="none" stroke={lineColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>

      {/* Time Range Selector */}
      <div className="flex rounded-lg bg-slate-100 dark:bg-slate-700 p-1">
        {TIME_RANGES.map((range) => (
          <button
            key={range}
            onClick={() => onTimeRangeChange?.(range)}
            aria-pressed={selectedTimeRange === range}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              selectedTimeRange === range
                ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {range}
          </button>
        ))}
      </div>
    </div>
  )
}
