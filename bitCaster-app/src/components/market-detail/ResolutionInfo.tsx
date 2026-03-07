import { Info, CheckCircle2, AlertCircle, Clock, AlertTriangle } from 'lucide-react'
import type { ResolutionDetails, ResolutionSource, ResolutionStatus } from '@/types/market-detail'

interface ResolutionInfoProps {
  resolution: ResolutionDetails
}

const sourceLabels: Record<ResolutionSource, string> = {
  oracle: 'Oracle',
  manual: 'Manual',
  community: 'Community Vote',
  smart_contract: 'Smart Contract',
}

const statusConfig: Record<ResolutionStatus, { label: string; icon: typeof CheckCircle2; color: string }> = {
  open: {
    label: 'Open',
    icon: Clock,
    color: 'text-blue-500 bg-blue-500/10 border-blue-500/30',
  },
  pending_resolution: {
    label: 'Pending Resolution',
    icon: AlertCircle,
    color: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
  },
  resolved: {
    label: 'Resolved',
    icon: CheckCircle2,
    color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30',
  },
  disputed: {
    label: 'Disputed',
    icon: AlertTriangle,
    color: 'text-red-500 bg-red-500/10 border-red-500/30',
  },
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ResolutionInfo({ resolution }: ResolutionInfoProps) {
  const status = statusConfig[resolution.status]
  const StatusIcon = status.icon

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          Resolution
        </h3>

        {/* Status Badge */}
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${status.color}`}>
          <StatusIcon className="w-3.5 h-3.5" />
          {status.label}
        </span>
      </div>

      {/* Final Outcome (if resolved) */}
      {resolution.status === 'resolved' && resolution.finalOutcome && (
        <div className="mb-4 p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-200 dark:border-emerald-500/30">
          <p className="text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
            Final Outcome
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
            Resolution Criteria
          </span>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed pl-6">
          {resolution.criteria}
        </p>
      </div>

      {/* Source & Date */}
      <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-200 dark:border-slate-700">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
            Source
          </p>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-900 dark:text-white">
              {sourceLabels[resolution.source]}
            </span>
            {resolution.sourceDescription && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                ({resolution.sourceDescription})
              </span>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
            Resolution Date
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
              Dispute deadline: {formatDate(resolution.disputeDeadline)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
