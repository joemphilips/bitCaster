import { TrendingUp, Droplets, Calendar, Clock, CheckCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketDetail } from '@/types/market-detail'
import {
  formatMarketSubunits,
  normalizeMarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'

interface MarketStatsProps {
  market: MarketDetail
}

function formatDate(dateStr: string, locale: string): string {
  return new Date(dateStr).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function getTimeRemaining(
  closingDate: string,
  now: Date,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { text: string; isUrgent: boolean } {
  const close = new Date(closingDate)
  const diff = close.getTime() - now.getTime()

  if (diff < 0) return { text: t('market.closed'), isUrgent: false }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 7) {
    return { text: `${days}d`, isUrgent: false }
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
  const { t, i18n } = useTranslation()
  const [now, setNow] = useState(() => new Date())
  const baseAsset = normalizeMarketBaseAsset(market.baseAsset)
  const timeRemaining = market.closingDate
    ? getTimeRemaining(market.closingDate, now, t)
    : null

  useEffect(() => {
    if (!market.closingDate) return
    setNow(new Date())
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [market.closingDate])

  const stats = [
    {
      icon: TrendingUp,
      label: t('market.volume'),
      value: formatMarketSubunits(market.volumeLifetimeSats, baseAsset),
      color: 'text-blue-500',
    },
    {
      icon: Droplets,
      label: t('market.liquidity'),
      value: formatMarketSubunits(market.liquiditySats, baseAsset),
      color: 'text-cyan-500',
    },
    {
      icon: Calendar,
      label: t('market.created'),
      value: formatDate(market.createdDate, i18n.language),
      color: 'text-slate-400',
    },
    {
      icon: CheckCircle,
      label: t('market.activeSince'),
      value: formatDate(market.activeSince, i18n.language),
      color: 'text-emerald-500',
    },
    ...(timeRemaining
      ? [
          {
            icon: Clock,
            label: t('market.timeLeft'),
            value: timeRemaining.text,
            color: timeRemaining.isUrgent ? 'text-amber-500' : 'text-slate-400',
            highlight: timeRemaining.isUrgent,
          },
        ]
      : []),
  ]

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
        {t('market.statistics')}
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
              <span aria-label={stat.label} title={stat.label}>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
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
