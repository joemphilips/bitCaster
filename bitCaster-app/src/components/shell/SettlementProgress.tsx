import { useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import type { CtfRangeOrderPreparationPageCursor } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { pageActiveCtfRangePreparations } from "@/stores/ctf-range-order-db";
import { useWalletStore } from "@/stores/wallet";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import { useSettlementProgress, type SettlementProgressEntry } from "@/hooks/useSettlementProgress";

export function SettlementProgress({ canReadStatus }: { canReadStatus: boolean }) {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  const signerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision, getNostrSignerRevision, getNostrSignerRevision,
  );
  return scopeId === null ? null : (
    <ProgressPages key={`${scopeId}:${signerRevision}:${canReadStatus}`} scopeId={scopeId} canReadStatus={canReadStatus} />
  );
}

function ProgressPages({ scopeId, canReadStatus }: { scopeId: string; canReadStatus: boolean }) {
  const { t } = useTranslation();
  const [after, setAfter] = useState<CtfRangeOrderPreparationPageCursor>();
  const generation = JSON.stringify(after ?? null);
  const page = useLiveQuery(async () => {
    try {
      const result = await pageActiveCtfRangePreparations({ scopeId, limit: 8, ...(after ? { after } : {}) });
      return {
        generation, unavailable: false,
        nextCursor: result.nextCursor,
        entries: result.preparations.map((record) => ({
          operationId: record.rangeOperationId, marketId: record.orderRouteId,
          orderId: record.capability?.orderId ?? null,
        })),
      };
    } catch {
      return { generation, unavailable: true, nextCursor: null, entries: [] };
    }
  }, [scopeId, after]);
  if (!page || page.generation !== generation || (!page.unavailable && page.entries.length === 0 && after === undefined)) return null;
  return (
    <section className="mb-4 rounded-lg border border-slate-300 p-3 dark:border-slate-700" aria-label={t("settlementProgress.title")}>
      <h2 className="font-medium">{t("settlementProgress.title")}</h2>
      {page.unavailable && <p className="text-sm">{t("settlementProgress.journalUnavailable")}</p>}
      <ProgressItems key={JSON.stringify(after ?? null)} entries={page.entries} canReadStatus={canReadStatus} />
      <div className="mt-2 flex gap-3 text-sm">
        {after && <button type="button" className="underline" onClick={() => setAfter(undefined)}>{t("settlementProgress.first")}</button>}
        {page.nextCursor && <button type="button" className="underline" onClick={() => setAfter(page.nextCursor!)}>{t("common.next")}</button>}
      </div>
    </section>
  );
}

function ProgressItems({ entries, canReadStatus }: { entries: readonly SettlementProgressEntry[]; canReadStatus: boolean }) {
  const { t } = useTranslation();
  // Stable identities prevent journal-only revision changes from restarting reads.
  const key = JSON.stringify(entries);
  const stableEntries = useMemo(() => entries, [key]);
  const { observations, loading, refresh } = useSettlementProgress(stableEntries, canReadStatus);
  return (
    <>
      <ul className="mt-2 space-y-2">
        {entries.map((entry) => {
          const observation = observations[entry.operationId];
          const message = entry.orderId === null ? "localPreparation"
            : !canReadStatus ? "authenticationRequired"
            : observation?.group ? observation.group.status
            : observation?.unavailable ? "unavailable" : "checking";
          return (
            <li key={entry.operationId} className="text-sm">
              <p className="break-all font-mono text-xs">{t("walletRecovery.operation", { operationId: entry.operationId })}</p>
              <p>{t(`settlementProgress.${message}`)}</p>
              {observation?.group && observation.unavailable && <p>{t("settlementProgress.stale")}</p>}
            </li>
          );
        })}
      </ul>
      {entries.length > 0 && <p className="mt-2 text-xs text-slate-500">{t("settlementProgress.fees")}</p>}
      {canReadStatus && <button type="button" className="mt-2 text-sm underline disabled:opacity-50" disabled={loading} onClick={refresh}>
        {t("settlementProgress.refresh")}
      </button>}
    </>
  );
}
