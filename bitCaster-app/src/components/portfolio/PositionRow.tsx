import type { Position } from '@/types/portfolio'
import { formatBtc } from '@/lib/format'

interface PositionRowProps {
  position: Position
  onSell?: (positionId: string) => void
  onClaim?: (positionId: string) => void
  onView?: (positionId: string) => void
}

export function PositionRow({ position, onSell, onClaim, onView }: PositionRowProps) {
  const isPositive = position.profitLossSats >= 0
  const isWinner = position.status === 'closed' && position.profitLossSats > 0

  return (
    <button
      onClick={() => onView?.(position.id)}
      className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg transition-colors text-left"
    >
      {/* Market Image */}
      <div className="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 overflow-hidden shrink-0">
        <img
          src={position.marketImageUrl}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      </div>

      {/* Market Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
          {position.marketTitle}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
            position.side === 'yes'
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400'
          }`}>
            {position.side.toUpperCase()}
          </span>
          {position.outcomeLabel && (
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {position.outcomeLabel}
            </span>
          )}
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {position.shares} shares
          </span>
        </div>
      </div>

      {/* Value & P/L */}
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
          {formatBtc(position.currentValueSats)}
        </div>
        <div className={`text-xs font-mono ${isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
          {isPositive ? '+' : ''}{formatBtc(position.profitLossSats)} ({isPositive ? '+' : ''}{position.profitLossPercent.toFixed(1)}%)
        </div>
      </div>

      {/* Action Button */}
      {position.status === 'active' && onSell && (
        <button
          onClick={(e) => { e.stopPropagation(); onSell(position.id) }}
          aria-label={`Sell ${position.marketTitle}`}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
        >
          Sell
        </button>
      )}
      {isWinner && onClaim && (
        <button
          onClick={(e) => { e.stopPropagation(); onClaim(position.id) }}
          aria-label={`Claim payout for ${position.marketTitle}`}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition-colors"
        >
          Claim
        </button>
      )}
    </button>
  )
}
