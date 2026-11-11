import { useState } from "react";
import { useTranslation } from "react-i18next";
import { retryBrowserSeedPositionRestore } from "@/lib/browserSeedPositionRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import type { WalletRecoveryDisplay } from "@/lib/walletRecoveryDisplay";

/** The Settings section that holds the seed restore ("Replace wallet"). */
const SEED_RESTORE_SETTINGS_HREF = "/settings?category=cashu";

/**
 * The resume time of a wait: the time alone on the same day, else the date
 * and the time.
 */
export function formatWalletRecoveryResumeTime(
  retryAtMs: number,
  nowMs: number,
  locale: string,
): string {
  const at = new Date(retryAtMs);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * The one status row of the automatic wallet recovery (issue #161). It is
 * always mounted, so a test can wait for `data-state`. It shows nothing when
 * the recovery is complete, or when the visitor has no wallet.
 */
export function WalletRecoveryStatusRow({
  display,
  className = "",
}: {
  display: WalletRecoveryDisplay;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const attributes = {
    "data-testid": "wallet-recovery-status",
    "data-state": display.state,
    ...(display.state === "unavailable" ? { "data-reason": display.reason } : {}),
  };

  switch (display.state) {
    case "complete":
      return <div {...attributes} hidden />;
    case "checking":
      return (
        <div {...attributes} className={className}>
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 motion-reduce:animate-none"
            />
            {t("wallet.recovery.checking")}
          </p>
        </div>
      );
    case "pending":
      return (
        <div {...attributes} className={className}>
          <p
            role="status"
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            {display.text === "resumesAt" && display.retryAtMs !== null
              ? t("wallet.recovery.resumesAt", {
                  time: formatWalletRecoveryResumeTime(
                    display.retryAtMs,
                    Date.now(),
                    i18n.language,
                  ),
                })
              : t(
                  display.text === "waitingForMint"
                    ? "wallet.recovery.waitingForMint"
                    : "wallet.recovery.restoring",
                )}
          </p>
        </div>
      );
    case "unavailable":
      break;
    default:
      throw new Error(
        `unknown wallet recovery display: ${JSON.stringify((display as { state: unknown }).state)}`,
      );
  }

  if (display.action === "none") return <div {...attributes} hidden />;
  const scopeId = display.scopeId;
  const retry = async () => {
    if (scopeId === null) return;
    setRetrying(true);
    try {
      // Retry resets the backoff, then wakes the coordinator. It does not start a restore.
      await retryBrowserSeedPositionRestore(scopeId);
      publishBrowserCtfRangeRecoveryWake({ scopeId });
    } finally {
      setRetrying(false);
    }
  };
  const actionClass = "shrink-0 font-medium underline disabled:opacity-50";
  const message =
    display.action === "retry"
      ? t("wallet.recovery.failed")
      : display.action === "reload-or-restore"
        ? t("wallet.recovery.profileUnavailable")
        : t("wallet.recovery.readFailed");
  return (
    <div {...attributes} className={className}>
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      >
        <span>{message}</span>
        <span className="flex shrink-0 items-center gap-3">
          {display.action === "retry" ? (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying || scopeId === null}
              className={actionClass}
            >
              {t("common.retry")}
            </button>
          ) : (
            <button type="button" onClick={() => window.location.reload()} className={actionClass}>
              {t("wallet.recovery.reload")}
            </button>
          )}
          {display.action === "reload-or-restore" && (
            <a href={SEED_RESTORE_SETTINGS_HREF} className={actionClass}>
              {t("wallet.recovery.restoreFromSeed")}
            </a>
          )}
        </span>
      </div>
    </div>
  );
}
