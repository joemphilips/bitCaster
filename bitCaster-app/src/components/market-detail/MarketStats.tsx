import { TrendingUp, Droplets, Users, Calendar, Clock, CheckCircle } from 'lucide-react'
import type { MarketDetail } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'

interface MarketStatsProps {
  market: MarketDetail
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function getTimeRemaining(closingDate: string): { text: string; isUrgent: boolean } {
  const now = new Date()
  const close = new Date(closingDate)
  const diff = close.getTime() - now.getTime()

  if (diff < 0) return { text: 'Closed', isUrgent: false }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 7) {
    return { text: `${days} days`, isUrgent: false }
  }
  if (days > 0) {
    return { text: `${days}d ${hours}h`, isUrgent: true }
  }
  if (hours > 0) {
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    return { text: `${hours}h ${minutes}m`, isUrgent: true }
  }

  const minutes = Math.floor(diff / (1000 * 60))
  return { text: `${minutes}m`, isUrgent: true }
}

export function MarketStats({ market }: MarketStatsProps) {
  const timeRemaining = getTimeRemaining(market.closingDate)

  const stats = [
    {
      icon: TrendingUp,
      label: 'Volume',
      value: formatBtc(market.volume),
      color: 'text-blue-500',
    },
    {
      icon: Droplets,
      label: 'Liquidity',
      value: formatBtc(market.liquidity),
      color: 'text-cyan-500',
    },
    {
      icon: Users,
      label: 'Traders',
      value: market.traderCount.toLocaleString(),
      color: 'text-violet-500',
    },
    {
      icon: Calendar,
      label: 'Created',
      value: formatDate(market.createdDate),
      color: 'text-slate-400',
    },
    {
      icon: CheckCircle,
      label: 'Active Since',
      value: formatDate(market.activeSince),
      color: 'text-emerald-500',
    },
    {
      icon: Clock,
      label: 'Time Left',
      value: timeRemaining.text,
      color: timeRemaining.isUrgent ? 'text-amber-500' : 'text-slate-400',
      highlight: timeRemaining.isUrgent,
    },
  ]

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
        Market Statistics
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className={`relative p-3 rounded-xl ${
              stat.highlight
                ? 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
                : 'bg-slate-50 dark:bg-slate-900'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
              <span className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {stat.label}
              </span>
            </div>
            <p className={`text-lg font-semibold ${
              stat.highlight
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-slate-900 dark:text-white'
            }`}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
