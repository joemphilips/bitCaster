import { Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'

interface WalletRequiredModalProps {
  onClose: () => void
}

export function WalletRequiredModal({ onClose }: WalletRequiredModalProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      data-testid="wallet-required-modal"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-w-sm mx-4 text-center">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
          <Wallet className="w-8 h-8 text-[#f7931a]" />
        </div>

        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
          {t('wallet.required')}
        </h2>

        <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
          {t('wallet.requiredDesc')}
        </p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onClose()
              navigate('/setup', { state: { from: location.pathname + location.search } })
            }}
            data-testid="wallet-required-create"
            className="flex-1 py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] text-white font-semibold transition-colors"
          >
            {t('wallet.createWallet')}
          </button>
        </div>
      </div>
    </div>
  )
}
