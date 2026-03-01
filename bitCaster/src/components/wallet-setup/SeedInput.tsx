import type { ClipboardEvent } from 'react'
import * as bip39 from '@/lib/bip39'

interface SeedInputProps {
  inputSeedWords: string[]
  onSeedWordInput?: (index: number, word: string) => void
  onSeedPhrasePaste?: (phrase: string) => void
  onRecover?: () => void
}

export function SeedInput({
  inputSeedWords,
  onSeedWordInput,
  onSeedPhrasePaste,
  onRecover,
}: SeedInputProps) {
  const allFilled = inputSeedWords.every((w) => w.trim().length > 0)
  const allValidWords = allFilled && inputSeedWords.every((w) => bip39.validateWord(w.trim()))
  const isValidMnemonic = allValidWords && bip39.validate(inputSeedWords.map((w) => w.trim()))

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').trim()
    const words = text.split(/[\s,]+/)
    if (words.length === 12) {
      e.preventDefault()
      onSeedPhrasePaste?.(text)
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Enter Your Seed Phrase
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          Enter your 12-word seed phrase to recover your wallet
        </p>
      </div>

      {/* Seed word inputs */}
      <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 mb-6">
        <div className="grid grid-cols-3 gap-3">
          {inputSeedWords.map((word, index) => (
            <div key={index} className="flex items-center gap-2 relative">
              <span className="text-xs font-medium text-slate-400 dark:text-slate-500 w-5 text-right tabular-nums shrink-0">
                {index + 1}.
              </span>
              <input
                type="text"
                value={word}
                onChange={(e) => onSeedWordInput?.(index, e.target.value.toLowerCase().trim())}
                onPaste={handlePaste}
                placeholder="word"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-2.5 py-2 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 text-sm font-mono font-semibold text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              />
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500 text-center">
          Tip: Paste your full 12-word phrase into any field to auto-fill all words
        </p>
      </div>

      {allFilled && !isValidMnemonic && (
        <p className="text-sm text-red-500 dark:text-red-400 mb-4 text-center">
          Invalid mnemonic phrase. Please check your words and try again.
        </p>
      )}

      <button
        onClick={() => onRecover?.()}
        disabled={!isValidMnemonic}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white disabled:text-slate-500 dark:disabled:text-slate-500 font-semibold transition-colors"
      >
        Recover Wallet
      </button>
    </div>
  )
}
