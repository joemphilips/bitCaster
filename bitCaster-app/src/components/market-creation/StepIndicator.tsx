import { Check } from 'lucide-react'
import type { WizardStep } from '@/types/market-creation'

interface StepIndicatorProps {
  currentStep: WizardStep
}

const steps: { step: WizardStep; label: string; display: number }[] = [
  { step: 2, label: 'Get Started', display: 1 },
  { step: 3, label: 'Basic Info', display: 2 },
  { step: 4, label: 'Outcomes', display: 3 },
  { step: 5, label: 'Liquidity', display: 4 },
  { step: 6, label: 'Review', display: 5 },
]

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-0">
      {steps.map(({ step, label, display }, index) => {
        const isCompleted = step < currentStep
        const isCurrent = step === currentStep
        const isFuture = step > currentStep

        return (
          <div key={step} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                  isCompleted
                    ? 'bg-green-600 text-white shadow-md shadow-green-600/25'
                    : isCurrent
                      ? 'bg-blue-600 text-white ring-4 ring-blue-600/20 dark:ring-blue-400/20 shadow-md shadow-blue-600/25'
                      : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500'
                }`}
              >
                {isCompleted ? (
                  <Check className="w-4 h-4" strokeWidth={2.5} />
                ) : (
                  display
                )}
              </div>
              <span
                className={`text-[10px] sm:text-xs font-medium transition-colors whitespace-nowrap ${
                  isFuture
                    ? 'text-slate-400 dark:text-slate-500'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                {label}
              </span>
            </div>

            {index < steps.length - 1 && (
              <div
                className={`w-8 sm:w-12 h-0.5 mx-1.5 sm:mx-2 mb-5 rounded-full transition-colors duration-300 ${
                  isCompleted
                    ? 'bg-green-600'
                    : 'bg-slate-200 dark:bg-slate-700'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
