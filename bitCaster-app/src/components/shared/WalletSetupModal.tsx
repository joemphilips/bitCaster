import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'

interface WalletSetupModalProps {
  isCreating?: boolean
  error?: string | null
  onClose: () => void
  onCreateNew: () => void
  onImportSeed: (words: string[]) => void
}

export function WalletSetupModal({
  isCreating = false,
  error,
  onClose,
  onCreateNew,
  onImportSeed,
}: WalletSetupModalProps) {
  const { t } = useTranslation()
  const [showImport, setShowImport] = useState(false)
  const [seedPhrase, setSeedPhrase] = useState('')

  const words = seedPhrase.trim().split(/\s+/).filter(Boolean)

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {t('wallet.setupTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t('wallet.setupDesc')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
            aria-label={t('common.close')}
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
            onClick={onCreateNew}
            disabled={isCreating}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isCreating && !showImport && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('wallet.createNewWallet')}
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-700"
          >
            {t('wallet.importExistingWallet')}
          </button>

          {showImport && (
            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left dark:border-slate-700 dark:bg-slate-900/60">
              <label
                htmlFor="wallet-seed-phrase"
                className="block text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                {t('wallet.enterSeedPhrase')}
              </label>
              <textarea
                id="wallet-seed-phrase"
                value={seedPhrase}
                onChange={(event) => setSeedPhrase(event.target.value)}
                rows={4}
                className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                placeholder={t('wallet.enterSeedPhrase')}
              />
              <button
                type="button"
                onClick={() => onImportSeed(words)}
                disabled={isCreating || words.length === 0}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating && showImport && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('wallet.restoreWallet')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
