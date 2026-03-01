import { Check } from 'lucide-react'
import type { SetupStep } from '@/types/wallet-setup'

interface StepIndicatorProps {
  currentStep: SetupStep
}

const steps: { step: SetupStep; label: string; display: number }[] = [
  { step: 3, label: 'Choice', display: 1 },
  { step: 4, label: 'Seed', display: 2 },
  { step: 5, label: 'Mint Setup', display: 3 },
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
            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                  isCompleted
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/25'
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
                className={`text-xs font-medium transition-colors ${
                  isFuture
                    ? 'text-slate-400 dark:text-slate-500'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                {label}
              </span>
            </div>

            {/* Connector line */}
            {index < steps.length - 1 && (
              <div
                className={`w-16 sm:w-24 h-0.5 mx-3 mb-5 rounded-full transition-colors duration-300 ${
                  isCompleted
                    ? 'bg-blue-600'
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
