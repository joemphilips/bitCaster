import { Shield, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface BackupSecretsReminderModalProps {
  includeWallet: boolean
  includeNostr: boolean
  onOpenSettings: () => void
  onDismiss: () => void
}

export function BackupSecretsReminderModal({
  includeWallet,
  includeNostr,
  onOpenSettings,
  onDismiss,
}: BackupSecretsReminderModalProps) {
  const { t } = useTranslation()

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onDismiss} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-amber-100 p-2 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                {t('backupSecrets.title')}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t('backupSecrets.description')}
              </p>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <ul className="mb-5 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          {includeWallet && <li>{t('backupSecrets.walletSecret')}</li>}
          {includeNostr && <li>{t('backupSecrets.nostrSecret')}</li>}
        </ul>

        {includeNostr && (
          <p className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100">
            {t('backupSecrets.identityDisclosure')}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {t('backupSecrets.later')}
          </button>
          <button
            onClick={onOpenSettings}
            className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            {t('backupSecrets.openSettings')}
          </button>
        </div>
      </div>
    </div>
  )
}
