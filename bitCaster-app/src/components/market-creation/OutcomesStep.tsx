import { Plus, Trash2, Upload } from 'lucide-react'
import type { WizardOutcome, OutcomeType } from '@/types/market-creation'

interface OutcomesStepProps {
  outcomeType: OutcomeType
  outcomes: WizardOutcome[] | null
  loBound?: number
  hiBound?: number
  precision?: number
  unit?: string
  onAddOutcome?: () => void
  onRemoveOutcome?: (outcomeId: string) => void
  onOutcomeLabelChange?: (outcomeId: string, label: string) => void
  onOutcomeProbabilityChange?: (outcomeId: string, probability: number) => void
  onNormalizeProbabilities?: () => void
  onLoBoundChange?: (value: number) => void
  onHiBoundChange?: (value: number) => void
  onPrecisionChange?: (value: number) => void
  onUnitChange?: (value: string) => void
  onNext?: () => void
}

function ProbabilityBar({ outcomes }: { outcomes: WizardOutcome[] }) {
  const totalProbability = outcomes.reduce((sum, o) => sum + (o.probability ?? 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
        <span>Target Probability Summary</span>
        <span className={totalProbability === 100 ? 'text-green-400' : totalProbability > 100 ? 'text-red-400' : ''}>
          {totalProbability}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-800 overflow-hidden flex">
        {outcomes.map((outcome, i) => (
          <div
            key={outcome.id}
            className={`h-full ${
              outcomes.length === 2 && i === 0
                ? 'bg-green-500'
                : outcomes.length === 2 && i === 1
                  ? 'bg-red-500'
                  : 'bg-blue-500'
            } first:rounded-l-full last:rounded-r-full`}
            style={{ width: `${Math.min(outcome.probability ?? 0, 100)}%` }}
          />
        ))}
      </div>
    </div>
  )
}

export function OutcomesStep({
  outcomeType,
  outcomes,
  loBound,
  hiBound,
  precision,
  unit,
  onAddOutcome,
  onRemoveOutcome,
  onOutcomeLabelChange,
  onOutcomeProbabilityChange,
  onNormalizeProbabilities,
  onLoBoundChange,
  onHiBoundChange,
  onPrecisionChange,
  onUnitChange,
  onNext,
}: OutcomesStepProps) {
  // Numeric market
  if (outcomeType === 'numeric') {
    const canProceed =
      loBound !== undefined &&
      hiBound !== undefined &&
      hiBound > loBound

    return (
      <div className="w-full max-w-xl">
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Numeric Range</h2>
        <p className="text-sm text-slate-400 mb-8">
          Define the range and precision for your numeric market.
        </p>

        <div className="space-y-5 mb-8">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Low Bound</label>
              <input
                type="number"
                value={loBound ?? ''}
                onChange={(e) => onLoBoundChange?.(Number(e.target.value))}
                placeholder="0"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">High Bound</label>
              <input
                type="number"
                value={hiBound ?? ''}
                onChange={(e) => onHiBoundChange?.(Number(e.target.value))}
                placeholder="100"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Unit</label>
            <input
              type="text"
              value={unit ?? ''}
              onChange={(e) => onUnitChange?.(e.target.value)}
              placeholder="e.g. USD, BTC, %"
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Precision (decimal places)</label>
            <input
              type="number"
              min={0}
              max={8}
              value={precision ?? ''}
              onChange={(e) => onPrecisionChange?.(Number(e.target.value))}
              placeholder="0"
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1.5">Number of decimal places for the outcome value</p>
          </div>
        </div>

        <button
          onClick={() => onNext?.()}
          disabled={!canProceed}
          className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
            canProceed
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }`}
        >
          Next
        </button>
      </div>
    )
  }

  // Yes/No market
  if (outcomeType === 'yesno' && outcomes) {
    return (
      <div className="w-full max-w-xl">
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Market Outcomes</h2>
        <p className="text-sm text-slate-400 mb-8">
          Your Yes/No market has two fixed outcomes. Adjust initial probabilities below.
        </p>

        <div className="space-y-3 mb-4">
          {outcomes.map((outcome) => (
            <div key={outcome.id} className="p-4 rounded-lg bg-slate-900 border border-slate-700">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg ${outcome.id === 'yes' ? 'bg-green-500/15' : 'bg-red-500/15'} flex items-center justify-center`}>
                  <span className={`${outcome.id === 'yes' ? 'text-green-400' : 'text-red-400'} font-bold text-sm`}>
                    {outcome.id === 'yes' ? 'Y' : 'N'}
                  </span>
                </div>
                <div>
                  <p className="font-medium text-white text-sm">{outcome.label}</p>
                </div>
                <div className="ml-auto w-20 shrink-0">
                  <div className="relative">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={outcome.probability ?? ''}
                      onChange={(e) => onOutcomeProbabilityChange?.(outcome.id, Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm text-right pr-7 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end mb-4">
          <button
            onClick={() => onNormalizeProbabilities?.()}
            className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            Normalize to 100%
          </button>
        </div>

        <div className="mb-8">
          <ProbabilityBar outcomes={outcomes} />
        </div>

        <button
          onClick={() => onNext?.()}
          className="w-full py-3 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors shadow-lg shadow-blue-600/25"
        >
          Next
        </button>
      </div>
    )
  }

  // Categorical outcomes
  const canProceed = outcomes && outcomes.length >= 2 && outcomes.every((o) => o.label.trim().length > 0)

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Define Outcomes</h2>
      <p className="text-sm text-slate-400 mb-8">
        Add at least 2 possible outcomes for your categorical market.
      </p>

      <div className="space-y-3 mb-4">
        {outcomes?.map((outcome) => (
          <div key={outcome.id} className="p-4 rounded-lg bg-slate-900 border border-slate-700">
            <div className="flex items-start gap-3">
              <button className="w-12 h-12 shrink-0 rounded-lg border border-dashed border-slate-600 bg-slate-800 flex items-center justify-center text-slate-500 hover:border-slate-500 transition-colors">
                <Upload className="w-4 h-4" strokeWidth={1.5} />
              </button>

              <div className="flex-1">
                <input
                  type="text"
                  value={outcome.label}
                  onChange={(e) => onOutcomeLabelChange?.(outcome.id, e.target.value)}
                  placeholder="Outcome label..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
                />
              </div>

              <div className="w-20 shrink-0">
                <div className="relative">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={outcome.probability ?? ''}
                    onChange={(e) => onOutcomeProbabilityChange?.(outcome.id, Number(e.target.value))}
                    placeholder="0"
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm text-right pr-7 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
                </div>
              </div>

              <button
                onClick={() => onRemoveOutcome?.(outcome.id)}
                className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => onAddOutcome?.()}
        className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors mb-4"
      >
        <Plus className="w-4 h-4" strokeWidth={1.5} />
        Add Outcome
      </button>

      {outcomes && outcomes.length > 0 && (
        <>
          <div className="flex justify-end mb-4">
            <button
              onClick={() => onNormalizeProbabilities?.()}
              className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              Normalize to 100%
            </button>
          </div>
          <div className="mb-8">
            <ProbabilityBar outcomes={outcomes} />
          </div>
        </>
      )}

      <button
        onClick={() => onNext?.()}
        disabled={!canProceed}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
          canProceed
            ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25'
            : 'bg-slate-800 text-slate-500 cursor-not-allowed'
        }`}
      >
        Next
      </button>
    </div>
  )
}
