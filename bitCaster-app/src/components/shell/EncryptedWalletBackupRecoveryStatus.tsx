import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EncryptedWalletBackupDriverState } from "@/hooks/useEncryptedWalletBackupDriver";
import { assertNever } from "@/lib/enumDiscipline";

export function EncryptedWalletBackupRecoveryStatus({
  recoveryStatus,
  retryRecovery,
}: EncryptedWalletBackupDriverState) {
  const { t } = useTranslation();
  const copy = statusCopy(recoveryStatus);
  if (copy === null) return null;
  return (
    <section
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      role="status"
      aria-live="polite"
      aria-label={t(copy.title)}
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t(copy.title)}</p>
        <p>{t(copy.description)}</p>
        {copy.detail !== null && <p className="mt-1">{t(copy.detail)}</p>}
      </div>
      {copy.retry !== null && (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 font-medium underline hover:bg-amber-100 dark:hover:bg-amber-900/50"
          onClick={retryRecovery}
        >
          {t(copy.retry)}
        </button>
      )}
    </section>
  );
}

function statusCopy(status: EncryptedWalletBackupDriverState["recoveryStatus"]) {
  switch (status.kind) {
    case "ready":
      return null;
    case "preparing":
      return {
        title: "walletBackupRecovery.preparingTitle",
        description: "walletBackupRecovery.preparingDescription",
        detail: `walletBackupRecovery.preparingReasons.${status.reason}`,
        retry: null,
      };
    case "failed":
      return {
        title: "walletBackupRecovery.failedTitle",
        description: "walletBackupRecovery.failedDescription",
        detail: null,
        retry: "walletBackupRecovery.retryStartup",
      };
    case "recovering":
      return {
        title: "walletBackupRecovery.title",
        description: "walletBackupRecovery.description",
        detail: status.reason === null ? null : `walletBackupRecovery.reasons.${status.reason}`,
        retry: "walletBackupRecovery.retry",
      };
    default:
      return assertNever(status);
  }
}
