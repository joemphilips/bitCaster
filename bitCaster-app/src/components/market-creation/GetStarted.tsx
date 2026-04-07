import { ToggleLeft, LayoutGrid, SlidersHorizontal } from 'lucide-react'
import type { OutcomeType } from '@/types/market-creation'

interface GetStartedProps {
  outcomeType: OutcomeType | null
  onOutcomeTypeSelect?: (type: OutcomeType) => void
  onNext?: () => void
}

const options: { type: OutcomeType; icon: typeof ToggleLeft; label: string; description: string }[] = [
  {
    type: 'yesno',
    icon: ToggleLeft,
    label: 'Yes / No',
    description: 'A simple binary market with two outcomes. Example: "Will Bitcoin reach $200k by 2027?"',
  },
  {
    type: 'categorical',
    icon: LayoutGrid,
    label: 'Categorical',
    description: 'Multiple possible outcomes. Example: "Which team will win the Champions League?"',
  },
  {
    type: 'numeric',
    icon: SlidersHorizontal,
    label: 'Numeric',
    description: 'A range-based market. Example: "What will be the price of BTC on June 30?"',
  },
]

export function GetStarted({ outcomeType, onOutcomeTypeSelect, onNext }: GetStartedProps) {
  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Get Started</h2>
      <p className="text-sm text-slate-400 mb-8">
        Choose the type of market you want to create.
      </p>

      <div className="space-y-4 mb-8">
        {options.map(({ type, icon: Icon, label, description }) => (
          <button
            key={type}
            onClick={() => onOutcomeTypeSelect?.(type)}
            className={`w-full p-5 rounded-xl border-2 transition-all text-left ${
              outcomeType === type
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-900 hover:border-slate-600'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`p-2.5 rounded-lg ${outcomeType === type ? 'bg-blue-500/20' : 'bg-slate-800'}`}>
                <Icon className={`w-6 h-6 ${outcomeType === type ? 'text-blue-400' : 'text-slate-500'}`} strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-semibold text-white mb-1">{label}</p>
                <p className="text-sm text-slate-400">{description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={() => onNext?.()}
        disabled={!outcomeType}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
          outcomeType
            ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25'
            : 'bg-slate-800 text-slate-500 cursor-not-allowed'
        }`}
      >
        Next
      </button>
    </div>
  )
}
