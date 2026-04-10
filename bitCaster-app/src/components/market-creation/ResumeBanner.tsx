import { Clock, X } from 'lucide-react'
import { formatTimeAgo } from '@/lib/format'

interface ResumeBannerProps {
  lastModified: string
  onDismiss: () => void
  onStartOver: () => void
}

export function ResumeBanner({ lastModified, onDismiss, onStartOver }: ResumeBannerProps) {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-4">
      <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
        <div className="flex items-center gap-2.5 min-w-0">
          <Clock className="w-4 h-4 text-blue-400 flex-shrink-0" strokeWidth={1.75} />
          <p className="text-xs text-slate-300 truncate">
            Picked up where you left off{' '}
            <span className="text-slate-500">· {formatTimeAgo(lastModified)}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onStartOver}
            className="px-3 py-1 text-xs font-medium text-slate-400 hover:text-white transition-colors"
          >
            Start over
          </button>
          <button
            onClick={onDismiss}
            aria-label="Dismiss resume banner"
            className="p-1 rounded text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  )
}
