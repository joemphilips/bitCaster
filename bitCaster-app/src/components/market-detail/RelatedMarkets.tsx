import { ChevronRight, TrendingUp } from 'lucide-react'
import type { RelatedMarket } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'

interface RelatedMarketsProps {
  markets: RelatedMarket[]
  onMarketClick?: (marketId: string) => void
}

function formatClosingDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = date.getTime() - now.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days < 0) return 'Closed'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 7) return `${days}d`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function RelatedMarketCard({
  market,
  onClick,
}: {
  market: RelatedMarket
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 w-64 p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-500/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all text-left group"
    >
      {/* Title */}
      <h4 className="text-sm font-medium text-slate-900 dark:text-white line-clamp-2 mb-3 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
        {market.title}
      </h4>

      {/* Odds (if available) */}
      {market.currentOdds && (
        <div className="flex gap-2 mb-3">
          <span className="px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            Yes {market.currentOdds.yes.toFixed(0)}%
          </span>
          <span className="px-2 py-1 rounded-md bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium">
            No {market.currentOdds.no.toFixed(0)}%
          </span>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1">
          <TrendingUp className="w-3.5 h-3.5" />
          <span>{formatBtc(market.volume)}</span>
        </div>
        <span>{formatClosingDate(market.closingDate)}</span>
      </div>
    </button>
  )
}

export function RelatedMarkets({ markets, onMarketClick }: RelatedMarketsProps) {
  if (markets.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          Related Markets
        </h3>
        <ChevronRight className="w-5 h-5 text-slate-400" />
      </div>

      {/* Horizontal Scrollable List */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-5 px-5 scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600">
        {markets.map((market) => (
          <RelatedMarketCard
            key={market.id}
            market={market}
            onClick={() => onMarketClick?.(market.id)}
          />
        ))}
      </div>
    </div>
  )
}
