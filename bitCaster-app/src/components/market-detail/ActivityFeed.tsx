import { useRef, useState, useEffect } from 'react'
import { ArrowUpRight, ArrowDownRight, ChevronUp, ChevronDown } from 'lucide-react'
import type { Trade } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'

interface ActivityFeedProps {
  trades: Trade[]
  onLoadMoreTrades?: () => void
}

function formatTimeAgo(timestamp: string): string {
  const now = new Date()
  const date = new Date(timestamp)
  const diff = now.getTime() - date.getTime()

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function TradeRow({ trade }: { trade: Trade }) {
  const isYes = trade.side === 'yes'

  return (
    <div className="flex items-center gap-3 py-3 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
      {/* Side Icon */}
      <div className={`p-1.5 rounded-lg ${isYes ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
        {isYes ? (
          <ArrowUpRight className="w-4 h-4 text-emerald-500" />
        ) : (
          <ArrowDownRight className="w-4 h-4 text-red-500" />
        )}
      </div>

      {/* Trade Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900 dark:text-white truncate">
            {trade.userDisplayName}
          </span>
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            isYes
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-red-500/10 text-red-600 dark:text-red-400'
          }`}>
            {trade.side.toUpperCase()}
          </span>
          {trade.outcomeId && (
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
              ({trade.outcomeId})
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {formatBtc(trade.amount)} @ {trade.price.toFixed(1)}%
        </p>
      </div>

      {/* Timestamp */}
      <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
        {formatTimeAgo(trade.timestamp)}
      </span>
    </div>
  )
}

export function ActivityFeed({
  trades,
  onLoadMoreTrades,
}: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      setCanScrollUp(scrollTop > 2)
      setCanScrollDown(scrollTop < scrollHeight - clientHeight - 2)
    }
  }

  useEffect(() => {
    checkScroll()
    const resizeObserver = new ResizeObserver(checkScroll)
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current)
    }
    return () => resizeObserver.disconnect()
  }, [trades])

  const scroll = (direction: 'up' | 'down') => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({
        top: direction === 'up' ? -100 : 100,
        behavior: 'smooth',
      })
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          Recent Trades
          <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500 font-normal">
            ({trades.length})
          </span>
        </h3>
      </div>

      {/* Content */}
      <div className="relative group/trades">
        {canScrollUp && (
          <button
            onClick={() => scroll('up')}
            className="absolute left-1/2 -translate-x-1/2 top-1 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/trades:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
        )}

        <div
          ref={scrollRef}
          onScroll={checkScroll}
          className="p-4 max-h-96 overflow-y-auto scrollbar-hide"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {trades.length === 0 ? (
            <p className="text-center text-sm text-slate-400 dark:text-slate-500 py-8">
              No trades yet
            </p>
          ) : (
            <>
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
              {trades.length >= 5 && (
                <button
                  onClick={onLoadMoreTrades}
                  className="w-full py-3 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
                >
                  Load more trades
                </button>
              )}
            </>
          )}
        </div>

        {canScrollDown && (
          <button
            onClick={() => scroll('down')}
            className="absolute left-1/2 -translate-x-1/2 bottom-1 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/trades:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
