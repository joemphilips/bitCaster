import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBrowserRecoveryIndexStatus } from "@/hooks/useBrowserRecoveryIndex";

/**
 * The persistent error of the recovery index (ADR-051 "Upload" and "Merge").
 * The backup is always on, so other states show nothing. Trading continues.
 */
export function RecoveryIndexStatus() {
  const { t } = useTranslation();
  const status = useBrowserRecoveryIndexStatus();
  if (status?.kind !== "blocked") return null;
  return (
    <div
      role="alert"
      data-testid="recovery-index-blocked"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{t(`walletBackup.blocked.${status.reason}`)}</p>
    </div>
  );
}
