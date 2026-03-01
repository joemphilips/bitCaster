import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'

const VERIFICATION_INDICES = [2, 6, 11] // word #3, #7, #12 (0-indexed)

interface SeedVerificationProps {
  seedWords: string[]
  onVerificationComplete: () => void
  onBack?: () => void
}

export function SeedVerification({
  seedWords,
  onVerificationComplete,
  onBack,
}: SeedVerificationProps) {
  const [subStep, setSubStep] = useState(0)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')

  const currentIndex = VERIFICATION_INDICES[subStep]
  const wordNumber = currentIndex + 1
  const isLastStep = subStep === VERIFICATION_INDICES.length - 1

  function handleSubmit() {
    if (input.toLowerCase().trim() !== seedWords[currentIndex]) {
      setError(`Incorrect. Please enter word #${wordNumber} from your seed phrase.`)
      return
    }

    setError('')
    setInput('')

    if (isLastStep) {
      onVerificationComplete()
    } else {
      setSubStep((s) => s + 1)
    }
  }

  function handleBack() {
    if (subStep > 0) {
      setSubStep((s) => s - 1)
      setInput('')
      setError('')
    } else {
      onBack?.()
    }
  }

  const isCorrect = input.toLowerCase().trim() === seedWords[currentIndex]

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={handleBack}
        className="flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
        Back
      </button>

      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Verify Your Seed Phrase
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          Step {subStep + 1} of {VERIFICATION_INDICES.length}
        </p>
      </div>

      <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 mb-6">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
          Enter word #{wordNumber}
        </label>
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setError('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && isCorrect && handleSubmit()}
          placeholder={`Word #${wordNumber}`}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="w-full px-4 py-3 rounded-xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 text-base font-mono font-semibold text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
        />
        {error && (
          <p className="mt-2 text-sm text-red-500 dark:text-red-400">{error}</p>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={!isCorrect}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white disabled:text-slate-500 dark:disabled:text-slate-500 font-semibold transition-colors"
      >
        {isLastStep ? 'Continue' : 'Next'}
      </button>
    </div>
  )
}
