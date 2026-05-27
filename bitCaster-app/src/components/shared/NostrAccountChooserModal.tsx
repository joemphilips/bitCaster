import { Loader2, X } from 'lucide-react'

interface NostrAccountChooserModalProps {
  isCreating?: boolean
  error?: string | null
  onUseExisting: () => void
  onCreateImplicit: () => void
  onClose: () => void
}

export function NostrAccountChooserModal({
  isCreating = false,
  error,
  onUseExisting,
  onCreateImplicit,
  onClose,
}: NostrAccountChooserModalProps) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Do you have a Nostr account?
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              bitCaster signs orders with Nostr. Use an existing account or create a local one for this browser.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={onUseExisting}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-700"
          >
            Yes, connect my account
          </button>
          <button
            onClick={onCreateImplicit}
            disabled={isCreating}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
            No, create one for me
          </button>
        </div>
      </div>
    </div>
  )
}
