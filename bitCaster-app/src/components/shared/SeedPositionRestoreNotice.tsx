import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WalletRecoveryStatus } from "@bitcaster/client-sdk/walletRecoveryStatus";
import { retryBrowserSeedPositionRestore } from "@/lib/browserSeedPositionRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";

export type SeedPositionRestoreNoticeState = "none" | "restoring" | "failed";

/**
 * How the restore notice shows a wallet recovery status. A recovery that is
 * checking or pending shows the restoring notice. A failed recovery or a
 * failed status read shows the error with Retry. Without an active wallet
 * profile, the page shows its own wallet setup, so the notice shows nothing.
 */
export function seedPositionRestoreNoticeState(
  status: WalletRecoveryStatus,
): SeedPositionRestoreNoticeState {
  switch (status.kind) {
    case "completed":
      return "none";
    case "checking":
    case "pending":
      return "restoring";
    case "unavailable":
      return status.reason === "profile-unavailable" ? "none" : "failed";
    default:
      throw new Error(
        `unknown wallet recovery status: ${JSON.stringify((status as { kind: unknown }).kind)}`,
      );
  }
}

/**
 * Shows the automatic wallet recovery while it runs, and a retry after a
 * failure. The parent passes the status that also hides its empty states, so
 * both use one read.
 */
export function SeedPositionRestoreNotice({
  className = "",
  status,
}: {
  className?: string;
  status: WalletRecoveryStatus;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const state = seedPositionRestoreNoticeState(status);
  const scopeId = status.tag?.activation.scopeId ?? null;
  if (state === "none" || scopeId === null) return null;
  if (state === "restoring") {
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
      await retryBrowserSeedPositionRestore(scopeId);
      publishBrowserCtfRangeRecoveryWake({ scopeId });
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
