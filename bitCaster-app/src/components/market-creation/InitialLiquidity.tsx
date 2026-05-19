import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface InitialLiquidityProps {
  liquiditySats: number
  onLiquiditySatsChange?: (sats: number) => void
  onNext?: () => void
  onSkip?: () => void
}

export function InitialLiquidity({ onNext }: InitialLiquidityProps) {
  const { t } = useTranslation()

  return (
    <div className="w-full max-w-xl">
      <h2 className="mb-2 text-xl font-bold text-white sm:text-2xl">
        {t('marketCreation.ammTbdTitle')}
      </h2>
      <p className="mb-8 text-sm text-slate-400">
        {t('marketCreation.ammTbdDesc')}
      </p>

      <div className="mb-8 rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" strokeWidth={1.5} />
          <div>
            <p className="mb-1 text-sm font-medium text-blue-200">
              {t('marketCreation.ammTbdPanelTitle')}
            </p>
            <p className="text-xs leading-relaxed text-blue-200/75">
              {t('marketCreation.ammTbdPanelDesc')}
            </p>
          </div>
        </div>
      </div>

      <button
        data-testid="continue-without-amm"
        type="button"
        onClick={() => onNext?.()}
        className="w-full rounded-full bg-blue-600 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-colors hover:bg-blue-700"
      >
        {t('common.next')}
      </button>
    </div>
  )
}
