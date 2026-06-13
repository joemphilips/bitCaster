import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WizardStep } from '@/types/market-creation'

interface StepIndicatorProps {
  currentStep: WizardStep
}

const steps: { step: WizardStep; labelKey: string; display: number }[] = [
  { step: 1, labelKey: 'marketCreation.getStarted', display: 1 },
  { step: 2, labelKey: 'marketCreation.stepBasicInfo', display: 2 },
  { step: 3, labelKey: 'marketCreation.stepOutcomes', display: 3 },
  { step: 4, labelKey: 'marketCreation.stepReview', display: 4 },
]

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-center gap-0">
      {steps.map(({ step, labelKey, display }, index) => {
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
                {t(labelKey)}
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
