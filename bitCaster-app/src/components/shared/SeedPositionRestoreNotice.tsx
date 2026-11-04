import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSeedPositionRestoreStatus,
  type SeedPositionRestoreStatus,
} from "@/hooks/useSeedPositionRestoreStatus";
import { retryBrowserSeedPositionRestore } from "@/lib/browserSeedPositionRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";

/**
 * Shows the automatic seed restore while it runs, and a retry after a
 * failure. A parent that hides empty states passes its own status, so both
 * use one read.
 */
export function SeedPositionRestoreNotice({
  className = "",
  status: parentStatus,
}: {
  className?: string;
  status?: SeedPositionRestoreStatus;
}) {
  const { t } = useTranslation();
  const ownStatus = useSeedPositionRestoreStatus();
  const status = parentStatus ?? ownStatus;
  const [retrying, setRetrying] = useState(false);
  if (status.kind === "idle") return null;
  if (status.kind === "restoring") {
    return (
      <p
        role="status"
        data-testid="seed-restore-status"
        className={`flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 ${className}`}
      >
        <span
          aria-hidden="true"
          className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500"
        />
        {t("portfolio.restoringPositions")}
      </p>
    );
  }
  const retry = async () => {
    setRetrying(true);
    try {
      await retryBrowserSeedPositionRestore(status.scopeId);
      publishBrowserCtfRangeRecoveryWake({ scopeId: status.scopeId });
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div
      role="alert"
      data-testid="seed-restore-error"
      className={`flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 ${className}`}
    >
      <span>{t("portfolio.restorePositionsFailed")}</span>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className="shrink-0 font-medium underline disabled:opacity-50"
      >
        {t("portfolio.restorePositionsRetry")}
      </button>
    </div>
  );
}
