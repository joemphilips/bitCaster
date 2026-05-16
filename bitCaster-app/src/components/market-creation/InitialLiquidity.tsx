import { Coins, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface InitialLiquidityProps {
  liquiditySats: number
  onLiquiditySatsChange?: (sats: number) => void
  onNext?: () => void
  onSkip?: () => void
}

const quickAmounts = [1_000, 5_000, 10_000, 50_000]

export function InitialLiquidity({
  liquiditySats,
  onLiquiditySatsChange,
  onNext,
  onSkip,
}: InitialLiquidityProps) {
  const { t } = useTranslation()
  const canProceed = liquiditySats > 0

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">{t('marketCreation.initialLiquidity')}</h2>
      <p className="text-sm text-slate-400 mb-8">
        {t('marketCreation.initialLiquidityDesc')}
      </p>

      <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 mb-8">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-medium text-blue-300 mb-1">{t('marketCreation.whySeedLiquidity')}</p>
            <p className="text-xs text-blue-300/70 leading-relaxed">
              {t('marketCreation.seedLiquidityExplanation')}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-300 mb-2">{t('marketCreation.amountSats')}</label>
        <div className="relative">
          <Coins className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" strokeWidth={1.5} />
          <input
            type="number"
            min={0}
            value={liquiditySats || ''}
            onChange={(e) => onLiquiditySatsChange?.(Math.max(0, Number(e.target.value)))}
            placeholder="0"
            className="w-full pl-11 pr-16 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium">{t('marketCreation.satsSuffix')}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-8">
        {quickAmounts.map((amount) => (
          <button
            key={amount}
            onClick={() => onLiquiditySatsChange?.(amount)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              liquiditySats === amount
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            {amount.toLocaleString()}
          </button>
        ))}
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
        {t('common.next')}
      </button>

      <button
        data-testid="skip-liquidity"
        type="button"
        onClick={() => onSkip?.()}
        className="mt-3 w-full py-3 rounded-full border border-slate-700 text-sm font-semibold text-slate-200 hover:bg-slate-800 transition-colors"
      >
        {t('marketCreation.skipLiquidityProvisioning')}
      </button>
    </div>
  )
}
