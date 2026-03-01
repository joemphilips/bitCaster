import { useState } from 'react'
import { Check, X, Loader2, Plus, Trash2 } from 'lucide-react'
import type { MintConnectionTest, MintConnectionTestStatus } from '@/types/wallet-setup'

interface MintSetupProps {
  mintConnections: MintConnectionTest[]
  onAddMint?: (url: string) => void
  onRemoveMint?: (url: string) => void
  onFinishSetup?: () => void
}

function StatusBadge({ status }: { status: MintConnectionTestStatus }) {
  switch (status) {
    case 'connecting':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
          <Loader2 className="w-3 h-3 animate-spin" />
          Connecting
        </span>
      )
    case 'connected':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">
          <Check className="w-3 h-3" strokeWidth={2.5} />
          Connected
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
          <X className="w-3 h-3" strokeWidth={2.5} />
          Failed
        </span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
          Idle
        </span>
      )
  }
}

export function MintSetup({
  mintConnections,
  onAddMint,
  onRemoveMint,
  onFinishSetup,
}: MintSetupProps) {
  const [newMintUrl, setNewMintUrl] = useState('')
  const hasConnected = mintConnections.some((m) => m.status === 'connected')

  function handleAddMint() {
    const url = newMintUrl.trim()
    if (url) {
      onAddMint?.(url)
      setNewMintUrl('')
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Connect to a Mint
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          Add at least one Cashu mint to start using your wallet
        </p>
      </div>

      {/* Mint list */}
      <div className="space-y-3 mb-4">
        {mintConnections.map((mint) => (
          <div
            key={mint.url}
            className="flex items-center gap-3 p-3 rounded-xl bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-slate-900 dark:text-white truncate">
                {mint.url}
              </p>
              {mint.errorMessage && (
                <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">
                  {mint.errorMessage}
                </p>
              )}
            </div>
            <StatusBadge status={mint.status} />
            {mintConnections.length > 1 && (
              <button
                onClick={() => onRemoveMint?.(mint.url)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add mint input */}
      <div className="flex gap-2 mb-6">
        <input
          type="url"
          value={newMintUrl}
          onChange={(e) => setNewMintUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddMint()}
          placeholder="https://mint.example.com"
          className="flex-1 px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-sm font-mono text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
        />
        <button
          onClick={handleAddMint}
          disabled={!newMintUrl.trim()}
          className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-50 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      <button
        onClick={() => onFinishSetup?.()}
        disabled={!hasConnected}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white disabled:text-slate-500 dark:disabled:text-slate-500 font-semibold transition-colors"
      >
        Finish Setup
      </button>
    </div>
  )
}
