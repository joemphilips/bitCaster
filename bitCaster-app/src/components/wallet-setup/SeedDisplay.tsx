import { AlertTriangle, Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface SeedDisplayProps {
  seedWords: string[]
  seedSaved: boolean
  onSeedSavedToggle?: (saved: boolean) => void
  onContinue?: () => void
}

export function SeedDisplay({
  seedWords,
  seedSaved,
  onSeedSavedToggle,
  onContinue,
}: SeedDisplayProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const seedPhrase = seedWords.join(' ')

  const handleCopySeed = async () => {
    await navigator.clipboard.writeText(seedPhrase)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          {t('seed.yourSeedPhrase')}
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          {t('seed.seedPhraseDesc')}
        </p>
      </div>

      {/* Seed word grid */}
      <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 mb-5">
        <div className="grid grid-cols-3 gap-3">
          {seedWords.map((word, index) => (
            <div
              key={index}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700"
            >
              <span className="text-xs font-medium text-slate-400 dark:text-slate-500 w-5 text-right tabular-nums">
                {index + 1}.
              </span>
              <span className="text-sm font-mono font-semibold text-slate-900 dark:text-white">
                {word}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={handleCopySeed}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
          {copied ? t('common.copied') : t('seed.copySeedPhrase')}
        </button>
      </div>

      {/* Warning */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 mb-5">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" strokeWidth={1.5} />
        <p className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
          {t('seed.warning')}
        </p>
      </div>

      {/* Checkbox + Continue */}
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={seedSaved}
            onChange={(e) => onSeedSavedToggle?.(e.target.checked)}
            className="w-4.5 h-4.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
          />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
            {t('seed.savedConfirm')}
          </span>
        </label>

        <button
          onClick={() => onContinue?.()}
          disabled={!seedSaved}
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white disabled:text-slate-500 dark:disabled:text-slate-500 font-semibold transition-colors"
        >
          {t('common.continue')}
        </button>
      </div>
    </div>
  )
}
