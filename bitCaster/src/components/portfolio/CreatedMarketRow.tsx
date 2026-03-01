import type { CreatedMarket, CreatedMarketStatus } from '@/types/portfolio'
import { formatBtc } from '@/lib/format'

const STATUS_STYLES: Record<CreatedMarketStatus, string> = {
  active: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  resolved: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  refunded: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
}

interface CreatedMarketRowProps {
  market: CreatedMarket
  onView?: (marketId: string) => void
  onClaimFees?: (marketId: string) => void
}

export function CreatedMarketRow({ market, onView, onClaimFees }: CreatedMarketRowProps) {
  const canClaimFees = market.status === 'resolved' && market.creatorFeesEarned > 0

  return (
    <button
      onClick={() => onView?.(market.id)}
      className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg transition-colors text-left"
    >
      {/* Market Image */}
      <div className="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 overflow-hidden shrink-0">
        <img
          src={market.imageUrl}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      </div>

      {/* Market Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
          {market.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_STYLES[market.status]}`}>
            {market.status}
          </span>
          {market.volume > 0 && (
            <span className="text-xs text-slate-400 dark:text-slate-500">
              Vol: {formatBtc(market.volume)}
            </span>
          )}
        </div>
      </div>

      {/* Fees & Action */}
      <div className="text-right shrink-0">
        {market.creatorFeesEarned > 0 && (
          <div className="text-sm font-mono text-amber-600 dark:text-amber-400">
            {formatBtc(market.creatorFeesEarned)}
          </div>
        )}
        <div className="text-xs text-slate-400 dark:text-slate-500">
          {market.creatorFeePercent}% fee
        </div>
      </div>

      {canClaimFees && onClaimFees && (
        <button
          onClick={(e) => { e.stopPropagation(); onClaimFees(market.id) }}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition-colors"
        >
          Claim Fees
        </button>
      )}
    </button>
  )
}
