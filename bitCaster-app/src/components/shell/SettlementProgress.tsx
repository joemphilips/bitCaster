import { useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { AlertCircle, X } from "lucide-react";
import type { CtfRangeOrderPreparationPageCursor } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { pageActiveCtfRangePreparations } from "@/stores/ctf-range-order-db";
import { readBrowserCtfRangeOrderRefusalOperations } from "@/stores/ctf-range-order-messages";
import {
  dismissOrderFailureNotice,
  orderFailureNoticeKey,
  orderFailureReasonTextKey,
  useOrderFailureNotices,
  type OrderFailureNotice,
} from "@/stores/orderFailureNotices";
import { useWalletStore } from "@/stores/wallet";
import {
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import { assertNever } from "@/lib/enumDiscipline";
import { marketLabel, useMarketTitles } from "@/hooks/useMarketTitles";
import { isLocalCtfRangeOrderRefusal } from "@/lib/ctfRangeOrderLifecycle";
import {
  settlementEntryDisplay,
  useSettlementProgress,
  type SettlementEntryDisplay,
  type SettlementProgressEntry,
  type SettlementProgressScope,
} from "@/hooks/useSettlementProgress";

const NO_ENTRIES: readonly SettlementProgressEntry[] = [];
const NO_OPERATIONS: readonly string[] = [];

export function SettlementProgress({ canReadStatus }: { canReadStatus: boolean }) {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  const walletId = useMemo(() => browserWalletIdFromMnemonic(mnemonic), [mnemonic]);
  const signerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision,
    getNostrSignerRevision,
    getNostrSignerRevision,
  );
  return scopeId === null || walletId === null ? null : (
    <>
      <TradeFailures scopeId={scopeId} />
      <ProgressPages
        key={`${scopeId}:${signerRevision}:${canReadStatus}`}
        scope={{ scopeId, walletId, signerRevision }}
        canReadStatus={canReadStatus}
      />
    </>
  );
}

/**
 * A final order failure stays after wallet recovery ends the journal
 * operation, until the user dismisses it.
 */
function TradeFailures({ scopeId }: { scopeId: string }) {
  const { t } = useTranslation();
  const stored = useOrderFailureNotices((state) => state.notices);
  const notices = useMemo(() => visibleFailures(stored, scopeId), [stored, scopeId]);
  const titles = useMarketTitles();
  if (notices.length === 0) return null;
  return (
    <section
      className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
      aria-label={t("settlementProgress.failedTitle")}
    >
      <h2 className="flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("settlementProgress.failedTitle")}
      </h2>
      <ul className="mt-2 space-y-2">
        {notices.map((notice) => (
          <li key={notice.operationId} className="flex items-start gap-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {t("settlementProgress.failedOrder", {
                  market: marketLabel(notice.marketId, titles),
                })}
              </p>
              <p>{t(orderFailureReasonTextKey(notice.reason))}</p>
            </div>
            <button
              type="button"
              className="rounded p-1 hover:bg-rose-100 dark:hover:bg-rose-900/50"
              aria-label={t("settlementProgress.dismissFailure")}
              onClick={() => void dismissOrderFailureNotice(notice.scopeId, notice.operationId)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function visibleFailures(
  notices: Readonly<Record<string, OrderFailureNotice>>,
  scopeId: string,
): OrderFailureNotice[] {
  return Object.values(notices)
    .filter((notice) => notice.scopeId === scopeId && !notice.dismissed)
    .sort(
      (left, right) =>
        left.recordedAtMs - right.recordedAtMs || left.operationId.localeCompare(right.operationId),
    );
}

function ProgressPages({
  scope,
  canReadStatus,
}: {
  scope: SettlementProgressScope;
  canReadStatus: boolean;
}) {
  const { t } = useTranslation();
  const { scopeId } = scope;
  const [after, setAfter] = useState<CtfRangeOrderPreparationPageCursor>();
  const generation = JSON.stringify(after ?? null);
  const page = useLiveQuery(async () => {
    try {
      const result = await pageActiveCtfRangePreparations({
        scopeId,
        limit: 8,
        ...(after ? { after } : {}),
      });
      return {
        generation,
        unavailable: false,
        nextCursor: result.nextCursor,
        entries: result.preparations.map((record) => ({
          operationId: record.rangeOperationId,
          marketId: record.orderRouteId,
          lifecycleState: record.lifecycleState,
          orderId: record.capability?.orderId ?? null,
        })),
        refused: await refusedOperations(
          scopeId,
          result.preparations
            .filter((record) => isLocalCtfRangeOrderRefusal(record.lifecycleState))
            .map((record) => record.rangeOperationId),
        ),
      };
    } catch {
      return {
        generation,
        unavailable: true,
        nextCursor: null,
        entries: [],
        refused: NO_OPERATIONS,
      };
    }
  }, [scopeId, after]);
  const current = page?.generation === generation ? page : null;
  const visibleEntries = current?.entries ?? NO_ENTRIES;
  // Stable identities prevent journal-only revision changes from restarting reads.
  const key = JSON.stringify(visibleEntries);
  const entries = useMemo(() => visibleEntries, [key]);
  const progress = useSettlementProgress(entries, canReadStatus, scope);
  // A failed order shows under its failure heading, also after its dismissal.
  const failures = useOrderFailureNotices((state) => state.notices);
  const { observations } = progress;
  const refused = current?.refused ?? NO_OPERATIONS;
  const inProgress = useMemo(
    () =>
      entries.flatMap((entry) => {
        if (failures[orderFailureNoticeKey(scopeId, entry.operationId)] !== undefined) return [];
        const message = progressMessage(
          settlementEntryDisplay(
            entry.lifecycleState,
            observations[entry.operationId],
            canReadStatus,
          ),
          refused.includes(entry.operationId),
        );
        return message === null ? [] : [{ entry, message }];
      }),
    [entries, failures, scopeId, observations, canReadStatus, refused],
  );
  // Keep the section while a later page exists, also when this page holds
  // only failed or refused orders.
  if (
    current === null ||
    (!current.unavailable &&
      inProgress.length === 0 &&
      progress.completed.length === 0 &&
      current.nextCursor === null &&
      after === undefined)
  )
    return null;
  return (
    <section
      className="mb-4 rounded-lg border border-slate-300 p-3 dark:border-slate-700"
      aria-label={t("settlementProgress.title")}
    >
      <h2 className="font-medium">{t("settlementProgress.title")}</h2>
      {current.unavailable && (
        <p className="text-sm">{t("settlementProgress.journalUnavailable")}</p>
      )}
      <ProgressItems items={inProgress} canReadStatus={canReadStatus} {...progress} />
      <div className="mt-2 flex gap-3 text-sm">
        {after && (
          <button type="button" className="underline" onClick={() => setAfter(undefined)}>
            {t("settlementProgress.first")}
          </button>
        )}
        {current.nextCursor && (
          <button type="button" className="underline" onClick={() => setAfter(current.nextCursor!)}>
            {t("common.next")}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The progress text of an entry, or null when another place shows it: a final
 * failure under its failure heading, and a refused request in its wallet alert.
 */
function progressMessage(display: SettlementEntryDisplay, refusedByAlert: boolean): string | null {
  switch (display.kind) {
    case "failed":
      return null;
    case "refusal":
      return refusedByAlert ? null : display.message;
    case "progress":
      return display.message;
    default:
      return assertNever(display);
  }
}

/** A failed alert read shows the neutral text; the alert itself still shows the refusal. */
async function refusedOperations(
  scopeId: string,
  operationIds: readonly string[],
): Promise<readonly string[]> {
  if (operationIds.length === 0) return NO_OPERATIONS;
  try {
    return [...(await readBrowserCtfRangeOrderRefusalOperations(scopeId, operationIds))].sort();
  } catch {
    return NO_OPERATIONS;
  }
}

function ProgressItems({
  items,
  canReadStatus,
  observations,
  completed,
  loading,
  refresh,
}: {
  items: readonly { entry: SettlementProgressEntry; message: string }[];
  canReadStatus: boolean;
} & ReturnType<typeof useSettlementProgress>) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="mt-2 space-y-2">
        {items.map(({ entry, message }) => {
          const observation = observations[entry.operationId];
          return (
            <li key={entry.operationId} className="text-sm">
              <p className="break-all font-mono text-xs">
                {t("walletRecovery.operation", { operationId: entry.operationId })}
              </p>
              <p>{t(`settlementProgress.${message}`)}</p>
              {observation?.group && observation.unavailable && (
                <p>{t("settlementProgress.stale")}</p>
              )}
            </li>
          );
        })}
        {completed.map((entry) => (
          <li key={entry.operationId} className="text-sm">
            <p className="break-all font-mono text-xs">
              {t("walletRecovery.operation", { operationId: entry.operationId })}
            </p>
            <p className="text-emerald-700 dark:text-emerald-300">
              {t("settlementProgress.complete")}
            </p>
          </li>
        ))}
      </ul>
      {items.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">{t("settlementProgress.fees")}</p>
      )}
      {canReadStatus && items.length > 0 && (
        <button
          type="button"
          className="mt-2 text-sm underline disabled:opacity-50"
          disabled={loading}
          onClick={refresh}
        >
          {t("settlementProgress.refresh")}
        </button>
      )}
    </>
  );
}
