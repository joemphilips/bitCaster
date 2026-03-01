import type { ActivityItem, ActivityType } from '@/types/portfolio'
import { formatBtc } from '@/lib/format'
import {
  ArrowDownLeft,
  ArrowUpRight,
  ShoppingCart,
  Tag,
  Trophy,
  Coins,
} from 'lucide-react'

const TYPE_CONFIG: Record<ActivityType, { icon: typeof ArrowDownLeft; label: string; colorClass: string }> = {
  deposit: { icon: ArrowDownLeft, label: 'Deposit', colorClass: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30' },
  withdrawal: { icon: ArrowUpRight, label: 'Withdrawal', colorClass: 'text-rose-500 bg-rose-100 dark:bg-rose-900/30' },
  buy: { icon: ShoppingCart, label: 'Buy', colorClass: 'text-blue-500 bg-blue-100 dark:bg-blue-900/30' },
  sell: { icon: Tag, label: 'Sell', colorClass: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30' },
  payout_claimed: { icon: Trophy, label: 'Payout Claimed', colorClass: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30' },
  creator_fee_claimed: { icon: Coins, label: 'Creator Fee', colorClass: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30' },
}

const STATUS_BADGES: Record<string, string> = {
  completed: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  failed: 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400',
}

interface ActivityFeedProps {
  activity: ActivityItem[]
  onViewActivity?: (activityId: string) => void
}

export function ActivityFeed({ activity, onViewActivity }: ActivityFeedProps) {
  if (activity.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        No activity yet
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {activity.map((item) => {
        const config = TYPE_CONFIG[item.type]
        const Icon = config.icon
        const date = new Date(item.date).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })

        return (
          <button
            key={item.id}
            onClick={() => onViewActivity?.(item.id)}
            className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg transition-colors text-left"
          >
            {/* Type Icon */}
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${config.colorClass}`}>
              <Icon className="w-4 h-4" />
            </div>

            {/* Description */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {config.label}
              </p>
              {item.marketTitle && (
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {item.marketTitle}
                </p>
              )}
              {item.txId && (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                  TX: {item.txId.slice(0, 8)}...
                </p>
              )}
              {item.lightningInvoice && !item.txId && (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                  LN: {item.lightningInvoice.slice(0, 16)}...
                </p>
              )}
              {item.failureReason && (
                <p className="text-xs text-rose-500 truncate">{item.failureReason}</p>
              )}
            </div>

            {/* Amount & Status */}
            <div className="text-right shrink-0">
              <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
                {item.type === 'deposit' || item.type === 'payout_claimed' || item.type === 'creator_fee_claimed'
                  ? '+' : '-'}{formatBtc(item.amountSats)}
              </div>
              <div className="flex items-center justify-end gap-1 mt-0.5">
                <span className="text-xs text-slate-400 dark:text-slate-500">{date}</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGES[item.status] ?? ''}`}>
                  {item.status}
                </span>
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
