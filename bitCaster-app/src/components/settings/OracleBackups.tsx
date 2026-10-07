import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OracleBackupScanCursor } from "@bitcaster/client-sdk/oracleBackupAccess";
import {
  listBrowserOracleBackups,
  localBrowserOracleBackupStatuses,
  restoreBrowserOracleBackup,
  type BrowserOracleBackupList,
} from "@/lib/browserOracleBackupAccess";
import { deliverBrowserOracleBackup } from "@/lib/browserOracleBackupDelivery";
import { publishBrowserOracleOutcome } from "@/lib/oracleAttestation";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

type LocalPage = Awaited<ReturnType<typeof localBrowserOracleBackupStatuses>>;
type LocalRows = LocalPage["rows"];
type ReadyRow = Extract<LocalRows[number], { available: true }>;
const button =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 disabled:opacity-50";
const input =
  "w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-600";

function OracleBackupOwner({
  row,
  busy,
  act,
}: {
  row: ReadyRow;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState("");
  const status = row.status;
  const chosen = row.chosenOutcome;
  const publish = async (republish = false) => {
    const selected = chosen ?? outcome;
    if (!selected) return;
    await act(async () => {
      const result = await publishBrowserOracleOutcome(
        row.conditionId,
        selected,
        undefined,
        [...status.destinations.relayUrls],
        useCreatorMarketsStore,
        undefined,
        { engineDelivery: "synchronize", republishAttestation: republish },
      );
      if (result.failures.length) throw new Error("Pending exact resolution delivery.");
    });
  };
  return (
    <article className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h4 className="break-words font-semibold">{row.title}</h4>
      <p className="break-all text-xs text-slate-500">{row.conditionId}</p>
      <p className="text-sm">{t("oracleBackup.owner_" + row.kind)}</p>
      <dl className="space-y-1 break-all text-xs">
        <div>
          <dt className="inline font-medium">{t("oracleBackup.mint")}: </dt>
          <dd className="inline">{status.destinations.mintUrl}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t("oracleBackup.engine")}: </dt>
          <dd className="inline">{status.destinations.engineUrl}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t("oracleBackup.relays")}: </dt>
          <dd className="inline">
            {status.destinations.relayUrls.join(", ") || t("oracleBackup.noRelays")}
          </dd>
        </div>
      </dl>
      <div role="status" className="space-y-1 text-sm">
        {!status.importComplete && <p>{t("oracleBackup.importIncomplete")}</p>}
        {status.preparationPending && <p>{t("oracleBackup.preparationPending")}</p>}
        {status.noRelays && <p>{t("oracleBackup.noRelays")}</p>}
        {status.initial.prepared && (
          <p>
            {t("oracleBackup.initialProgress", {
              count: status.initial.acknowledgedRelays,
              total: status.initial.totalRelays,
            })}
          </p>
        )}
        {status.terminal.prepared && (
          <p>
            {t("oracleBackup.terminalProgress", {
              count: status.terminal.replacementAcknowledgedRelays,
              total: status.initial.totalRelays,
            })}
          </p>
        )}
        {status.terminal.deletionRequired && (
          <p>
            {t("oracleBackup.deletionProgress", {
              count: status.terminal.deletionAcknowledgedRelays,
              total: status.initial.totalRelays,
            })}
          </p>
        )}
        {status.terminal.localCommitPending && <p>{t("oracleBackup.commitPending")}</p>}
        {chosen && <p>{t("oracleBackup.savedOutcome", { outcome: chosen })}</p>}
        {status.publication.relayPublished && <p>{t("oracleBackup.resolutionRelayConfirmed")}</p>}
        {chosen && !status.publication.engineSynchronized && (
          <p>{t("oracleBackup.enginePending")}</p>
        )}
      </div>
      <button
        className={button}
        disabled={busy || !status.importComplete}
        onClick={() =>
          void act(() =>
            deliverBrowserOracleBackup(row.conditionId).then((result) => {
              if (result.failures.length) throw new Error("Private backup remains pending.");
            }),
          )
        }
      >
        {t("oracleBackup.retryBackup")}
      </button>
      {chosen ? (
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy} onClick={() => void publish()}>
            {t("oracleBackup.retryResolution")}
          </button>
          <button className={button} disabled={busy} onClick={() => void publish(true)}>
            {t("oracleBackup.republishResolution")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">{t("oracleBackup.immutableOutcome")}</p>
          <label className="block space-y-1 text-sm">
            <span>{t("oracleBackup.chooseOutcome")}</span>
            <select
              className={input}
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              disabled={busy || !status.importComplete}
            >
              <option value="">{t("oracleBackup.chooseOutcome")}</option>
              {row.outcomes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={busy || !outcome || !status.importComplete}
            onClick={() => void publish()}
          >
            {t("oracleBackup.publishOutcome")}
          </button>
        </div>
      )}
    </article>
  );
}

export function OracleBackups() {
  const { t } = useTranslation();
  const markets = useCreatorMarketsStore((state) => state.markets);
  const imported = useCreatorMarketsStore((state) => state.importedOracles);
  const signerMode = useSettingsStore((state) => state.nostrSignerMode);
  const [locals, setLocals] = useState<LocalRows>([]);
  const [nextLocalOffset, setNextLocalOffset] = useState<number | null>(null);
  const [localPage, setLocalPage] = useState(0);
  const [remote, setRemote] = useState<BrowserOracleBackupList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventId, setEventId] = useState("");
  const [sourceRelay, setSourceRelay] = useState("");

  const refreshLocal = useCallback(async () => {
    const page = await localBrowserOracleBackupStatuses({ localOffset: localPage * 20 });
    setLocals(page.rows);
    setNextLocalOffset(page.nextOffset);
  }, [localPage]);
  useEffect(() => {
    let current = true;
    void localBrowserOracleBackupStatuses({ localOffset: localPage * 20 })
      .then((page) => {
        if (current) {
          setLocals(page.rows);
          setNextLocalOffset(page.nextOffset);
        }
      })
      .catch(() => {
        if (current) setError(t("oracleBackup.failed"));
      });
    return () => {
      current = false;
    };
  }, [markets, imported, t, localPage]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
    } catch (failure) {
      const reason =
        typeof failure === "object" && failure !== null && "reason" in failure
          ? failure.reason
          : null;
      setError(
        reason === "terminal-backup-source-not-admitted"
          ? t("oracleBackup.sourceRefused")
          : t("oracleBackup.failed"),
      );
    } finally {
      try {
        await refreshLocal();
      } catch {
        setError(t("oracleBackup.failed"));
      }
      setBusy(false);
    }
  };
  const scan = (cursor?: OracleBackupScanCursor | null) =>
    act(async () => {
      setRemote(await listBrowserOracleBackups(cursor));
    });

  return (
    <section
      aria-labelledby="oracle-backup-heading"
      className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-700"
    >
      <h3 id="oracle-backup-heading" className="font-semibold">
        {t("oracleBackup.heading")}
      </h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("oracleBackup.description")}</p>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("oracleBackup.staleRisk")}</p>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <p className="flex-1 select-text">{error}</p>
          <button
            className={button}
            onClick={() => setError(null)}
            aria-label={t("oracleBackup.dismiss")}
          >
            {t("oracleBackup.dismiss")}
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={busy || signerMode !== "nsec"}
          onClick={() => void scan()}
        >
          {t("oracleBackup.list")}
        </button>
        {remote?.cursor && (
          <button className={button} disabled={busy} onClick={() => void scan(remote.cursor)}>
            {t("oracleBackup.next")}
          </button>
        )}
      </div>
      {signerMode !== "nsec" && <p className="text-sm">{t("oracleBackup.keyRequired")}</p>}
      {remote && (
        <div className="space-y-3">
          <p role="status" className="text-sm">
            {t("oracleBackup.discoveryLimit")}
          </p>
          {remote.partialReasons.some((reason) => reason !== "relay-dependent-history") && (
            <p className="text-sm">{t("oracleBackup.incompleteDiscovery")}</p>
          )}
          {!remote.descriptors.length && <p className="text-sm">{t("oracleBackup.empty")}</p>}
          <div className="max-h-96 space-y-3 overflow-y-auto">
            {remote.descriptors.map((row) => (
              <article
                key={row.backupEventId}
                className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
              >
                <p className="break-all text-sm">{row.oracleEventId}</p>
                <p className="text-xs">
                  {t("oracleBackup.version_" + row.state)} ·{" "}
                  {new Date(row.createdAt * 1000).toLocaleString()}
                </p>
                <p className="break-all text-xs">{row.sourceRelay}</p>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(() => restoreBrowserOracleBackup(row.backupEventId, row.sourceRelay))
                  }
                >
                  {t("oracleBackup.restore")}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("oracleBackup.exactRestore")}</legend>
        <label className="block space-y-1 text-sm">
          <span>{t("oracleBackup.eventId")}</span>
          <input
            className={input}
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("oracleBackup.sourceRelay")}</span>
          <input
            className={input}
            value={sourceRelay}
            onChange={(event) => setSourceRelay(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className={button}
          disabled={busy || signerMode !== "nsec" || !eventId || !sourceRelay}
          onClick={() =>
            void act(() => restoreBrowserOracleBackup(eventId.trim(), sourceRelay.trim()))
          }
        >
          {t("oracleBackup.restoreExact")}
        </button>
      </fieldset>
      <h4 className="font-medium">{t("oracleBackup.localHeading")}</h4>
      {locals.map((row) =>
        row.available ? (
          <OracleBackupOwner key={row.conditionId} row={row} busy={busy} act={act} />
        ) : (
          <p key={row.conditionId} className="break-all text-sm">
            {row.conditionId}: {t("oracleBackup.unavailable")}
          </p>
        ),
      )}
      {!locals.length && <p className="text-sm">{t("oracleBackup.noLocal")}</p>}
      <div className="flex gap-2">
        {localPage > 0 && (
          <button className={button} onClick={() => setLocalPage((page) => page - 1)}>
            {t("oracleBackup.previous")}
          </button>
        )}
        {nextLocalOffset !== null && (
          <button className={button} onClick={() => setLocalPage(nextLocalOffset / 20)}>
            {t("oracleBackup.next")}
          </button>
        )}
      </div>
    </section>
  );
}
