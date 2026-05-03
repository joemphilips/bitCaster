import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'

/**
 * Shared inline add-mint form. Lifted out of `Settings.tsx` (P5.2) so the
 * portfolio's mint selector can offer the same flow without duplicating
 * the URL-validation, in-flight-spinner, error-surface logic.
 *
 * The form is "trigger button → expanded input row" — same shape as the
 * Settings page version. The single shared piece of state (the actual mint
 * row) lives in `useWalletStore.addMint`; this component is purely the UX
 * shell around the async call. That keeps the component dumb and the wallet
 * store the single source of truth, satisfying T5.2.c (no duplicate state).
 */
interface AddMintFormProps {
  /** Async add-mint callback. Resolves on success, rejects on failure. */
  onAddMint: (url: string) => Promise<void>
  /** Surface customisation. The collapsed trigger reads `triggerLabel`. */
  triggerLabel?: string
  /** Tone variant — `inline` for Settings rows, `sheet` for bottom-sheet dialogs. */
  variant?: 'inline' | 'sheet'
}

export function AddMintForm({
  onAddMint,
  triggerLabel = 'Add Mint',
  variant = 'inline',
}: AddMintFormProps) {
  const [showInput, setShowInput] = useState(false)
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      await onAddMint(trimmed)
      setUrl('')
      setShowInput(false)
    } catch (e) {
      setError((e as Error).message || 'Failed to connect to mint')
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = () => {
    setShowInput(false)
    setUrl('')
    setError(null)
  }

  if (!showInput) {
    return (
      <button
        onClick={() => setShowInput(true)}
        data-testid="add-mint-trigger"
        className={
          variant === 'inline'
            ? 'flex items-center gap-2 px-3 py-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors'
            : 'w-full flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-slate-600 text-blue-400 hover:bg-slate-800 hover:border-blue-500 text-sm font-medium transition-colors'
        }
      >
        <Plus className="w-4 h-4" />
        {triggerLabel}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="https://mint.example.com"
          disabled={submitting}
          data-testid="add-mint-url-input"
          className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          autoFocus
        />
        <button
          onClick={submit}
          disabled={submitting}
          data-testid="add-mint-submit"
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          Add
        </button>
        <button
          onClick={cancel}
          disabled={submitting}
          className="px-3 py-2 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-sm transition-colors disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-500 dark:text-red-400" data-testid="add-mint-error">
          {error}
        </p>
      )}
    </div>
  )
}
