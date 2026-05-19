import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface DepositStepProps {
  /** The just-created market's condition id, returned by `createMarket`. */
  conditionId: string
  /** Kept for wizard prop compatibility while AMM funding is disabled. */
  defaultAmountSats: number
}

export function DepositStep({ conditionId }: DepositStepProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const onContinue = useCallback(() => {
    navigate(`/markets/${conditionId}`)
  }, [navigate, conditionId])

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t('marketCreation.ammTbdTitle')}
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        {t('marketCreation.ammTbdDesc')}
      </p>

      <div className="mb-6 rounded-lg border border-blue-500/20 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-medium text-blue-200">
              {t('marketCreation.ammTbdPanelTitle')}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-blue-200/75">
              {t('marketCreation.ammTbdPanelDesc')}
            </p>
          </div>
        </div>
      </div>

      <div data-testid="condition-id" className="mb-6 rounded-lg border border-slate-800 bg-slate-900 p-3">
        <p className="mb-1 text-xs text-slate-500">
          {t('marketCreation.marketCreatedLabel')}
        </p>
        <p className="break-all font-mono text-xs text-slate-300">{conditionId}</p>
      </div>

      <button
        data-testid="continue-to-market"
        type="button"
        onClick={onContinue}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500"
      >
        {t('marketCreation.continueToMarket')}
      </button>
    </div>
  )
}
