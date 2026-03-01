import type { PortfolioStats } from '@/types/portfolio'
import { formatBtc } from '@/lib/format'

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

export function StatsRow({ stats }: StatsRowProps) {
  return (
    <div className="flex items-stretch divide-x divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <StatCard label="Positions Value" value={formatBtc(stats.positionsValueSats)} />
      <StatCard label="Biggest Win" value={formatBtc(stats.biggestWinSats)} />
      <StatCard label="Predictions" value={stats.predictionsCount.toString()} />
    </div>
  )
}
