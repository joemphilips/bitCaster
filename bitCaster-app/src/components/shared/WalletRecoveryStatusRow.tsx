import { useState } from "react";
import { useTranslation } from "react-i18next";
import { retryBrowserSeedPositionRestore } from "@/lib/browserSeedPositionRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import type { WalletRecoveryDisplay } from "@/lib/walletRecoveryDisplay";

/** The Settings section that holds "Replace Wallet", which takes a seed phrase. */
const SEED_RESTORE_SETTINGS_HREF = "/settings?category=cashu";

/** Every visible state has one height, so the card below does not move. */
const ROW_CLASS = "flex min-h-10 items-center gap-2 rounded-xl px-3 py-2 text-sm";

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
    ? at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
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
  const statusText = (
    display: Extract<WalletRecoveryDisplay, { state: "checking" | "pending" }>,
  ) => {
    if (display.state === "checking") return t("wallet.recovery.checking");
    switch (display.text) {
      case "recovering":
        return t("wallet.recovery.recovering");
      case "waitingForMint":
        return t("wallet.recovery.waitingForMint");
      case "resumesAt":
        return t("wallet.recovery.resumesAt", {
          time: formatWalletRecoveryResumeTime(display.retryAtMs!, Date.now(), i18n.language),
        });
      default:
        throw new Error(`unknown wallet recovery wait: ${JSON.stringify(display.text)}`);
    }
  };
  const attributes = {
    "data-testid": "wallet-recovery-status",
    "data-state": display.state,
    ...(display.state === "unavailable" ? { "data-reason": display.reason } : {}),
  };

  switch (display.state) {
    case "complete":
      return <div {...attributes} hidden />;
    case "checking":
    case "pending": {
      // A scheduled wait does not work now, so it has no spinner.
      const working = display.state === "checking" || display.text !== "resumesAt";
      return (
        <div {...attributes} className={className}>
          <p
            role="status"
            className={`${ROW_CLASS} bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300`}
          >
            {working && (
              <span
                aria-hidden="true"
                className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 motion-reduce:animate-none"
              />
            )}
            {statusText(display)}
          </p>
        </div>
      );
    }
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
    } catch {
      // The reset did not happen. The status still shows the failure, so Retry stays.
    } finally {
      setRetrying(false);
    }
  };
  // The padding enlarges the touch target on mobile. The margin keeps the row height.
  const actionClass =
    "-my-2 shrink-0 py-2 font-medium underline disabled:opacity-50 md:my-0 md:py-0";
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
        className={`${ROW_CLASS} flex-wrap justify-between gap-x-3 gap-y-1 border border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300`}
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
              {t("wallet.replaceWallet")}
            </a>
          )}
        </span>
      </div>
    </div>
  );
}
