import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EncryptedWalletBackupDriverState } from "@/hooks/useEncryptedWalletBackupDriver";

export function EncryptedWalletBackupRecoveryStatus({
  recoveryStatus,
  retryRecovery,
}: EncryptedWalletBackupDriverState) {
  const { t } = useTranslation();
  if (recoveryStatus.kind !== "recovering") return null;

  const reason = recoveryStatus.reason;
  return (
    <section
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      role="status"
      aria-live="polite"
      aria-label={t("walletBackupRecovery.title")}
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("walletBackupRecovery.title")}</p>
        <p>{t("walletBackupRecovery.description")}</p>
        {reason !== null && <p className="mt-1">{t(`walletBackupRecovery.reasons.${reason}`)}</p>}
      </div>
      <button
        type="button"
        className="shrink-0 rounded px-2 py-1 font-medium underline hover:bg-amber-100 dark:hover:bg-amber-900/50"
        onClick={retryRecovery}
      >
        {t("walletBackupRecovery.retry")}
      </button>
    </section>
  );
}
