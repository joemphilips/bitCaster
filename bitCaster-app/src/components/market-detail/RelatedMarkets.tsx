import { ChevronRight, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RelatedMarket } from '@/types/market-detail'
import { formatMarketSubunits } from '@bitcaster/client-sdk/marketUnits'

interface RelatedMarketsProps {
  markets: RelatedMarket[]
  onMarketClick?: (marketId: string) => void
}

function formatClosingDate(
  dateStr: string,
  t: (key: string) => string,
  locale: string,
): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = date.getTime() - now.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days < 0) return t('common.closed')
  if (days === 0) return t('market.today')
  if (days === 1) return t('market.tomorrow')
  if (days < 7) return `${days}d`

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function RelatedMarketCard({
  market,
  onClick,
}: {
  market: RelatedMarket
  onClick?: () => void
}) {
  const { t, i18n } = useTranslation()
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
            {t('common.yes')} {market.currentOdds.yes.toFixed(2)}%
          </span>
          <span className="px-2 py-1 rounded-md bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium">
            {t('common.no')} {market.currentOdds.no.toFixed(2)}%
          </span>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-1">
          <TrendingUp className="w-3.5 h-3.5" />
          <span>{formatMarketSubunits(market.volume, market.baseAsset ?? 'sat')}</span>
        </div>
        <span>{formatClosingDate(market.closingDate, t, i18n.language)}</span>
      </div>
    </button>
  )
}

export function RelatedMarkets({ markets, onMarketClick }: RelatedMarketsProps) {
  const { t } = useTranslation()
  if (markets.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {t('market.relatedMarkets')}
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
