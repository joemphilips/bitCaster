import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { AlertCircle, X } from "lucide-react";
import type { CtfRangeOrderPreparationPageCursor } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { pageActiveCtfRangePreparations } from "@/stores/ctf-range-order-db";
import { readBrowserCtfRangeOrderRefusalOperations } from "@/stores/ctf-range-order-messages";
import {
  dismissOrderFailureNotice,
  isFinalFunds,
  offersRetry,
  orderFailureFundsReader,
  orderFailureNoticeKey,
  readOrderFailureFundsObservations,
  showsOrderFailure,
  useOrderFailureNotices,
  type OrderFailureNotice,
} from "@/stores/orderFailureNotices";
import { requestTradeRetry } from "@/stores/tradeRetryRequest";
import { fundsSentence, orderFailureReasonText, withFundsSentence } from "@/lib/orderFailureText";
import { ctfRangeOrderLock, type CtfRangeOrderLock } from "@/lib/ctfRangeOrderFunds";
import { useCtfRangeOrderLocks } from "@/hooks/useCtfRangeOrderLocks";
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
const NO_LOCKS: Readonly<Record<string, CtfRangeOrderLock>> = {};

export function SettlementProgress({
  canReadStatus,
  onNavigate,
}: {
  canReadStatus: boolean;
  /** Opens a page of the app, as the bell does. */
  onNavigate?: (href: string) => void;
}) {
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
      <TradeFailures scopeId={scopeId} onNavigate={onNavigate} />
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
 * operation, until the user dismisses it. While the refund is pending, the
 * journal names the locked funds, and Retry starts the same order again.
 */
function TradeFailures({
  scopeId,
  onNavigate,
}: {
  scopeId: string;
  onNavigate?: (href: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const stored = useOrderFailureNotices((state) => state.notices);
  const notices = useMemo(() => visibleFailures(stored, scopeId), [stored, scopeId]);
  const titles = useMarketTitles();
  useRefundObservation(stored, scopeId);
  const pendingOperations = useMemo(
    () =>
      notices.filter((notice) => !isFinalFunds(notice.funds)).map((notice) => notice.operationId),
    [notices],
  );
  const locks = useCtfRangeOrderLocks(scopeId, pendingOperations);
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
        {notices.map((notice) => {
          const market = marketLabel(notice.marketId, titles, notice.marketTitle);
          const reason = orderFailureReasonText(t, notice.reason);
          const pending = !isFinalFunds(notice.funds);
          const lock = locks?.[notice.operationId] ?? null;
          // Before the first journal read, a pending refund shows no funds
          // line, so the generic line does not change into the locked amount.
          const funds =
            pending && locks === undefined
              ? null
              : fundsSentence(t, notice.funds, { lock, locale: i18n.language });
          return (
            <li key={notice.operationId} className="flex items-start gap-1 text-sm">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">
                  {t("settlementProgress.orderOnMarket", { market })}
                </p>
                {reason !== null && <p>{reason}</p>}
                {funds !== null && <p>{funds}</p>}
                {pending && lock !== null && offersRetry(notice.reason) && (
                  <button
                    type="button"
                    className="-ml-2 inline-flex min-h-11 items-center rounded px-2 font-medium underline hover:bg-rose-100 dark:hover:bg-rose-900/50"
                    aria-label={t("settlementProgress.retryTrade", { market })}
                    onClick={() => {
                      requestTradeRetry(lock.retry);
                      onNavigate?.(`/markets/${lock.retry.conditionId}`);
                    }}
                  >
                    {t("settlementProgress.retry")}
                  </button>
                )}
              </div>
              <button
                type="button"
                className="-mr-2 -mt-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded hover:bg-rose-100 dark:hover:bg-rose-900/50"
                aria-label={t("settlementProgress.dismissFailure", { market })}
                onClick={() => void dismissOrderFailureNotice(notice.scopeId, notice.operationId)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Settle the funds of this wallet's notices when the refund, or another end,
 * changes the journal. The query reads the journal and the custody operation,
 * so a refund that commits both together updates it. It reads only the
 * database of this wallet; while another wallet's database is active, the
 * notices stay pending.
 */
function useRefundObservation(
  stored: Readonly<Record<string, OrderFailureNotice>>,
  scopeId: string,
) {
  const key = JSON.stringify(
    Object.values(stored)
      .filter((notice) => notice.scopeId === scopeId && !isFinalFunds(notice.funds))
      .map((notice) => notice.operationId)
      .sort(),
  );
  const observed = useLiveQuery(async () => {
    const read = orderFailureFundsReader(scopeId);
    return read === null
      ? {}
      : readOrderFailureFundsObservations(scopeId, JSON.parse(key) as string[], read);
  }, [scopeId, key]);
  useEffect(() => {
    if (observed !== undefined) useOrderFailureNotices.getState().settleFunds(observed);
  }, [observed]);
}

function visibleFailures(
  notices: Readonly<Record<string, OrderFailureNotice>>,
  scopeId: string,
): OrderFailureNotice[] {
  return Object.values(notices)
    .filter(
      (notice) => notice.scopeId === scopeId && !notice.dismissed && showsOrderFailure(notice),
    )
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
        // Only a stopped order shows its funds in this list.
        locks: Object.fromEntries(
          result.preparations.flatMap((record) => {
            const lock = isLocalCtfRangeOrderRefusal(record.lifecycleState)
              ? ctfRangeOrderLock(record)
              : null;
            return lock === null ? [] : [[record.rangeOperationId, lock] as const];
          }),
        ),
      };
    } catch {
      return {
        generation,
        unavailable: true,
        nextCursor: null,
        entries: [],
        refused: NO_OPERATIONS,
        locks: NO_LOCKS,
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
        const item = progressItem(
          settlementEntryDisplay(
            entry.lifecycleState,
            observations[entry.operationId],
            canReadStatus,
          ),
          refused.includes(entry.operationId),
        );
        return item === null ? [] : [{ entry, ...item }];
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
      <ProgressItems
        items={inProgress}
        canReadStatus={canReadStatus}
        locks={current.locks}
        {...progress}
      />
      {(after !== undefined || current.nextCursor !== null) && (
        <div className="mt-2 flex gap-3 text-sm">
          {after && (
            <button type="button" className="underline" onClick={() => setAfter(undefined)}>
              {t("settlementProgress.first")}
            </button>
          )}
          {current.nextCursor && (
            <button
              type="button"
              className="underline"
              onClick={() => setAfter(current.nextCursor!)}
            >
              {t("common.next")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The progress text of an entry, or null when another place shows it: a final
 * failure under its failure heading, and a refused request in its wallet alert.
 */
function progressItem(
  display: SettlementEntryDisplay,
  refusedByAlert: boolean,
): { message: string; final: boolean } | null {
  switch (display.kind) {
    case "failed":
      return null;
    case "refusal":
      return refusedByAlert ? null : { message: display.message, final: true };
    case "progress":
      return { message: display.message, final: display.final };
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
  locks,
  observations,
  completed,
  loading,
  refresh,
}: {
  items: readonly { entry: SettlementProgressEntry; message: string; final: boolean }[];
  canReadStatus: boolean;
  locks: Readonly<Record<string, CtfRangeOrderLock>>;
} & ReturnType<typeof useSettlementProgress>) {
  const { t, i18n } = useTranslation();
  const titles = useMarketTitles();
  // A final entry ended without a trade; only its refund is active.
  const active = items.some((item) => !item.final);
  return (
    <>
      <ul className="mt-2 space-y-2">
        {items.map(({ entry, message, final }) => {
          const observation = observations[entry.operationId];
          const text = t(`settlementProgress.${message}`);
          return (
            <li key={entry.operationId} className="text-sm">
              <p className="break-words text-xs font-medium">
                {t("settlementProgress.orderOnMarket", {
                  market: marketLabel(entry.marketId, titles),
                })}
              </p>
              <p>
                {final
                  ? withFundsSentence(t, text, "pending", {
                      lock: locks[entry.operationId] ?? null,
                      locale: i18n.language,
                    })
                  : text}
              </p>
              {observation?.group && observation.unavailable && (
                <p>{t("settlementProgress.stale")}</p>
              )}
            </li>
          );
        })}
        {completed.map((entry) => (
          <li key={entry.operationId} className="text-sm">
            <p className="break-words text-xs font-medium">
              {t("settlementProgress.orderOnMarket", {
                market: marketLabel(entry.marketId, titles),
              })}
            </p>
            <p className="text-emerald-700 dark:text-emerald-300">
              {t("settlementProgress.complete")}
            </p>
          </li>
        ))}
      </ul>
      {active && <p className="mt-2 text-xs text-slate-500">{t("settlementProgress.fees")}</p>}
      {canReadStatus && active && (
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
