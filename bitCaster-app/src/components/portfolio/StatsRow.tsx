import { useTranslation } from 'react-i18next'
import type { PortfolioStats } from '@/types/portfolio'
import { formatAmount, type AmountByUnit } from '@/lib/formatAmount'

interface StatsRowProps {
  stats: PortfolioStats
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 text-center py-3">
      <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
        {value}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
        {label}
      </div>
    </div>
  )
}

function formatTotals(totals: AmountByUnit[] | undefined, fallbackSats: number): string {
  const values = totals?.filter((entry) => entry.amount !== 0) ?? []
  if (values.length === 0) return formatAmount(fallbackSats, 'sat')
  return values.map((entry) => formatAmount(entry.amount, entry.unit)).join(' / ')
}

export function StatsRow({ stats }: StatsRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-stretch divide-x divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <StatCard label={t('portfolio.totalValue')} value={formatTotals(stats.totalValueByUnit, stats.totalValueSats)} />
      <StatCard label={t('portfolio.positionsValue')} value={formatTotals(stats.positionsValueByUnit, stats.positionsValueSats)} />
      <StatCard label={t('portfolio.predictions')} value={stats.predictionsCount.toString()} />
    </div>
  )
}
