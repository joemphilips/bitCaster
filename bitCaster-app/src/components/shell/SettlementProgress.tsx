import { useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import type {
  CtfRangeOrderPreparationLifecycle,
  CtfRangeOrderPreparationPageCursor,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { pageActiveCtfRangePreparations } from "@/stores/ctf-range-order-db";
import { useWalletStore } from "@/stores/wallet";
import {
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import {
  useSettlementProgress,
  type SettlementProgressEntry,
  type SettlementProgressScope,
} from "@/hooks/useSettlementProgress";

const NO_ENTRIES: readonly SettlementProgressEntry[] = [];

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
    <ProgressPages
      key={`${scopeId}:${signerRevision}:${canReadStatus}`}
      scope={{ scopeId, walletId, signerRevision }}
      canReadStatus={canReadStatus}
    />
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
      };
    } catch {
      return { generation, unavailable: true, nextCursor: null, entries: [] };
    }
  }, [scopeId, after]);
  const current = page?.generation === generation ? page : null;
  const visibleEntries = current?.entries ?? NO_ENTRIES;
  // Stable identities prevent journal-only revision changes from restarting reads.
  const key = JSON.stringify(visibleEntries);
  const entries = useMemo(() => visibleEntries, [key]);
  const progress = useSettlementProgress(entries, canReadStatus, scope);
  if (
    current === null ||
    (!current.unavailable &&
      entries.length === 0 &&
      progress.completed.length === 0 &&
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
      <ProgressItems entries={entries} canReadStatus={canReadStatus} {...progress} />
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

function ProgressItems({
  entries,
  canReadStatus,
  observations,
  completed,
  loading,
  refresh,
}: {
  entries: readonly SettlementProgressEntry[];
  canReadStatus: boolean;
} & ReturnType<typeof useSettlementProgress>) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="mt-2 space-y-2">
        {entries.map((entry) => {
          const observation = observations[entry.operationId];
          const localMessage = localLifecycleMessage(entry.lifecycleState);
          const message =
            localMessage ??
            (!canReadStatus
              ? "authenticationRequired"
              : observation?.group
                ? observation.group.status
                : observation?.unavailable
                  ? "unavailable"
                  : "orderSubmitted");
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
      {entries.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">{t("settlementProgress.fees")}</p>
      )}
      {canReadStatus && entries.length > 0 && (
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

function localLifecycleMessage(lifecycleState: CtfRangeOrderPreparationLifecycle): string | null {
  switch (lifecycleState) {
    case "prepared":
      return "prepared";
    case "capability-requested":
      return "capabilityRequested";
    case "capability-bound":
      return "capabilityBound";
    case "submission-rejected":
      return "submissionRejected";
    case "order-submitted":
      return null;
    case "terminal":
      return "terminal";
    default:
      return assertNever(lifecycleState);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CTF range preparation lifecycle: ${value}`);
}
