import { Info, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ResolutionDetails } from '@/types/market-detail'

interface ResolutionInfoProps {
  resolution: ResolutionDetails
}

export function ResolutionInfo({ resolution }: ResolutionInfoProps) {
  const { t, i18n } = useTranslation()

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(i18n.language, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {t('market.resolution')}
        </h3>
      </div>

      {/* Final Outcome (if resolved) */}
      {resolution.status === 'resolved' && resolution.finalOutcome && (
        <div className="mb-4 p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-200 dark:border-emerald-500/30">
          <p className="text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
            {t('market.finalOutcome')}
          </p>
          <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300">
            {resolution.finalOutcome}
          </p>
        </div>
      )}

      {/* Resolution Criteria */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {t('market.resolutionCriteria')}
          </span>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed pl-6">
          {resolution.criteria}
        </p>
      </div>

      <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
            {t('market.resolutionDate')}
          </p>
          <p className="text-sm font-medium text-slate-900 dark:text-white">
            {formatDate(resolution.resolutionDate)}
          </p>
        </div>
      </div>

      {/* Dispute Deadline (if disputed) */}
      {resolution.status === 'disputed' && resolution.disputeDeadline && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200 dark:border-red-500/30">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <span className="text-sm text-red-700 dark:text-red-400">
              {t('market.disputeDeadline', { date: formatDate(resolution.disputeDeadline) })}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
