import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND,
  RECOVERY_INDEX_CLI_RESULT_GAP_LIMIT,
  recoveryIndexCliGapCommand,
} from "@bitcaster/client-sdk/recoveryIndexRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import {
  dismissBrowserSeedRestoreResult,
  retryBrowserSeedPositionRestore,
} from "@/lib/browserSeedPositionRestore";

/** The result of the seed restore of the active wallet (ADR-039, "Restore order"). */
export interface SeedRestoreResultDisplay {
  readonly scopeId: string;
  /** No index, an unavailable index, a refused keyset, or a stop at the budget. */
  readonly partial: boolean;
  /** Retry can change the partial result. */
  readonly retryable: boolean;
}

/**
 * The restore result: one short line with the CLI command for a larger gap
 * (ADR-051), and for a partial result one pointer to the CLI broad recovery.
 * It stays until the user closes it. Retry continues the restore; it is not a
 * new restore start.
 */
export function SeedRestoreResult({ result }: { result: SeedRestoreResultDisplay | null }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (result === null) return null;
  const { scopeId } = result;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // The durable row did not change, so the result stays on screen.
    } finally {
      setBusy(false);
    }
  };
  const retry = () =>
    run(async () => {
      await retryBrowserSeedPositionRestore(scopeId);
      publishBrowserCtfRangeRecoveryWake({ scopeId });
    });
  const dismiss = () => run(() => dismissBrowserSeedRestoreResult(scopeId));
  const actionClass =
    "-my-2 shrink-0 py-2 font-medium underline disabled:opacity-50 md:my-0 md:py-0";
  return (
    <div
      data-testid="seed-restore-result"
      data-partial={result.partial ? "true" : "false"}
      className="flex items-start gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300"
    >
      <div className="min-w-0 flex-1 space-y-1 select-text">
        {result.partial && (
          <p>
            {t("wallet.restoreResult.partial", {
              command: RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND,
            })}
          </p>
        )}
        <p>
          {t("wallet.restoreResult.gapLimit", {
            command: recoveryIndexCliGapCommand(RECOVERY_INDEX_CLI_RESULT_GAP_LIMIT),
          })}
        </p>
      </div>
      {result.retryable && (
        <button type="button" onClick={() => void retry()} disabled={busy} className={actionClass}>
          {t("common.retry")}
        </button>
      )}
      <button
        type="button"
        onClick={() => void dismiss()}
        disabled={busy}
        aria-label={t("common.dismiss")}
        className="shrink-0 rounded p-1 hover:bg-slate-200 disabled:opacity-50 dark:hover:bg-slate-800"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
