import { Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface InsufficientBalanceModalProps {
  /** How many base-asset subunits the user has in the active mint. */
  balance: number
  /** What the pending trade will cost in base-asset subunits, all-in. */
  required: number
  title?: string
  requiredDescription?: string
  formatAmount?: (amount: number) => string
  onCancel: () => void
  onTopUp: () => void
}

/**
 * Gate shown when the user presses Confirm but the active mint's balance is
 * below the order's total cost. Mirrors `WalletRequiredModal` so the two feel
 * like variants of the same pattern. Actual top-up happens in the overlay the
 * caller mounts from `onTopUp`.
 */
export function InsufficientBalanceModal({
  balance,
  required,
  title,
  requiredDescription,
  formatAmount,
  onCancel,
  onTopUp,
}: InsufficientBalanceModalProps) {
  const { t } = useTranslation()
  const deficit = Math.max(required - balance, 0)
  const renderAmount = formatAmount ?? ((amount) => t('insufficientBalance.sats', { count: amount }))

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      <div className="relative bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-w-sm mx-4 text-center">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
          <Zap className="w-8 h-8 text-[#f7931a]" />
        </div>

        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
          {title ?? t('insufficientBalance.title')}
        </h2>

        <p className="text-slate-500 dark:text-slate-400 text-sm mb-1">
          {requiredDescription ?? t('insufficientBalance.tradeNeeds')}{' '}
          <span className="font-mono text-slate-700 dark:text-slate-200">
            {renderAmount(required)}
          </span>
          .
        </p>
        <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
          {t('insufficientBalance.youHave')}{' '}
          <span className="font-mono text-slate-700 dark:text-slate-200">
            {renderAmount(balance)}
          </span>
          {deficit > 0 && (
            <>
              {' '}— {t('insufficientBalance.shortBy')}{' '}
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {renderAmount(deficit)}
              </span>
            </>
          )}
          .
        </p>

        <div className="flex gap-3">
          <button
            data-testid="insufficient-balance-cancel"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            data-testid="insufficient-balance-top-up"
            onClick={onTopUp}
            className="flex-1 py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] text-white font-semibold transition-colors"
          >
            {t('insufficientBalance.topUp')}
          </button>
        </div>
      </div>
    </div>
  )
}
