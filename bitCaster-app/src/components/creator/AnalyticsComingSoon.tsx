import { LineChart, Clock } from 'lucide-react'

/**
 * Placeholder for the creator analytics tab. The design calls for a volume
 * chart and per-market breakdown, but those require historical fill data the
 * matching engine does not persist yet. For v1 we render a friendly
 * "coming soon" card so the tab isn't empty.
 */
export function AnalyticsComingSoon() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900/50">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <LineChart className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-bold text-slate-900 dark:text-white">
        Analytics coming soon
      </h3>
      <p className="mx-auto mt-2 max-w-md text-slate-500 dark:text-slate-400">
        Volume charts, per-market breakdowns, and fee tracking will arrive in a
        future release. Check back after you've created a few markets to see
        aggregated trends.
      </p>
      <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-100 px-4 py-1.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
        <Clock className="h-3.5 w-3.5" />
        In progress
      </div>
    </div>
  )
}
