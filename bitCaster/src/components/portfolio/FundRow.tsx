import type { Fund } from '@/types/portfolio'
import { Coins, DollarSign } from 'lucide-react'
import { formatBtc } from '@/lib/format'

interface FundRowProps {
  fund: Fund
  onView?: (fundId: string) => void
}

export function FundRow({ fund, onView }: FundRowProps) {
  const mintHostname = new URL(fund.mintUrl).hostname

  return (
    <button
      onClick={() => onView?.(fund.id)}
      className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg transition-colors text-left"
    >
      {/* Icon */}
      <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center shrink-0">
        {fund.unit === 'sats' ? (
          <Coins className="w-5 h-5 text-amber-500" />
        ) : (
          <DollarSign className="w-5 h-5 text-emerald-500" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-white">
          {fund.unit === 'sats' ? 'Sats' : 'USD'}
        </p>
        <p className="text-xs font-mono text-slate-400 dark:text-slate-500 truncate">
          {mintHostname}
        </p>
      </div>

      {/* Amount */}
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
          {fund.unit === 'sats' ? formatBtc(fund.amount) : `$${(fund.amount / 100).toFixed(2)}`}
        </div>
      </div>
    </button>
  )
}
