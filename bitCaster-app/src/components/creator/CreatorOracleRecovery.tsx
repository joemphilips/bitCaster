import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OracleBackupScanCursor } from "@bitcaster/client-sdk/oracleBackupAccess";
import {
  listBrowserOracleBackups,
  localBrowserOracleBackupStatuses,
  restoreBrowserOracleBackup,
  type BrowserOracleBackupList,
} from "@/lib/browserOracleBackupAccess";
import { deliverBrowserOracleBackup } from "@/lib/browserOracleBackupDelivery";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostrSignerRevision";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

type LocalPage = Awaited<ReturnType<typeof localBrowserOracleBackupStatuses>>;
type LocalRows = LocalPage["rows"];
type ReadyRow = Extract<LocalRows[number], { available: true }>;
const SHOW_OUTCOME_SELECTION: Record<ReadyRow["kind"], boolean> = {
  created: false,
  imported: true,
};
export type OracleRecoveryPublish = (
  conditionId: string,
  outcome: string,
  republish: boolean,
  relayUrls: string[],
  chosen: boolean,
) => void;
const READINESS_MESSAGES: Record<ReadyRow["readiness"], string | null> = {
  ready: "oracleBackup.authorityReady",
  "needs-restore": "oracleBackup.needsRestore",
  unavailable: "oracleBackup.authorityUnavailable",
};
const button =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 disabled:opacity-50";
const input =
  "w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-600";

function OracleBackupOwner({
  row,
  busy,
  act,
  onPublish,
}: {
  row: ReadyRow;
  busy: boolean;
  act: (action: (requireCurrent: () => void) => Promise<unknown>) => Promise<void>;
  onPublish: OracleRecoveryPublish;
}) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState("");
  const status = row.status;
  const chosen = row.chosenOutcome;
  const readinessMessage = READINESS_MESSAGES[row.readiness];
  const publish = (republish = false) => {
    const selected = chosen ?? outcome;
    if (selected)
      onPublish(row.conditionId, selected, republish, [...status.destinations.relayUrls], !!chosen);
  };
  return (
    <article
      data-testid={
        row.kind === "imported" ? "creator-imported-oracle" : "creator-created-oracle-backup"
      }
      data-condition-id={row.conditionId}
      className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700"
    >
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
      {readinessMessage && <p className="text-sm">{t(readinessMessage)}</p>}
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
        disabled={
          busy ||
          ((!status.importComplete || row.readiness !== "ready") &&
            !status.initial.prepared &&
            !status.terminal.prepared)
        }
        onClick={() =>
          void act((requireCurrent) =>
            deliverBrowserOracleBackup(row.conditionId, { requireCurrent }).then((result) => {
              if (result.failures.length) throw new Error("Private backup remains pending.");
            }),
          )
        }
      >
        {t("oracleBackup.retryBackup")}
      </button>
      {chosen ? (
        <div className="flex flex-wrap gap-2">
          <button
            data-testid="creator-oracle-retry"
            className={button}
            disabled={busy}
            onClick={() => void publish()}
          >
            {t("oracleBackup.retryResolution")}
          </button>
          <button
            data-testid="creator-oracle-republish"
            className={button}
            disabled={busy}
            onClick={() => void publish(true)}
          >
            {t("oracleBackup.republishResolution")}
          </button>
        </div>
      ) : SHOW_OUTCOME_SELECTION[row.kind] ? (
        <div className="space-y-2">
          <p className="text-sm">{t("oracleBackup.immutableOutcome")}</p>
          <label className="block space-y-1 text-sm">
            <span>{t("oracleBackup.chooseOutcome")}</span>
            <select
              data-testid="creator-oracle-outcome"
              className={input}
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              disabled={busy || !status.importComplete || row.readiness !== "ready"}
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
            data-testid="creator-oracle-publish"
            disabled={busy || !outcome || !status.importComplete || row.readiness !== "ready"}
            onClick={() => void publish()}
          >
            {t("oracleBackup.publishOutcome")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function OracleRecordPagination({
  page,
  nextOffset,
  busy,
  onChange,
}: {
  page: number;
  nextOffset: number | null;
  busy: boolean;
  onChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      {page > 0 && (
        <button className={button} disabled={busy} onClick={() => onChange(page - 1)}>
          {t("oracleBackup.previous")}
        </button>
      )}
      {nextOffset !== null && (
        <button className={button} disabled={busy} onClick={() => onChange(nextOffset / 20)}>
          {t("oracleBackup.next")}
        </button>
      )}
    </div>
  );
}

export function CreatorOracleRecovery({
  onPublish,
  publicationBusy = false,
}: {
  onPublish: OracleRecoveryPublish;
  publicationBusy?: boolean;
}) {
  const { t } = useTranslation();
  const markets = useCreatorMarketsStore((state) => state.markets);
  const imported = useCreatorMarketsStore((state) => state.importedOracles);
  const signerKey = useSettingsStore((state) => state.nsecSecret);
  const pubkey = useSettingsStore((state) => state.nostrProfile?.pubkey);
  const signerMode = useSettingsStore((state) => state.nostrSignerMode);
  const [signerRevision, setSignerRevision] = useState(getNostrSignerRevision);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const currentIdentity = useRef({ signerMode, signerKey, pubkey });
  if (
    currentIdentity.current.signerMode !== signerMode ||
    currentIdentity.current.signerKey !== signerKey ||
    currentIdentity.current.pubkey !== pubkey
  ) {
    currentIdentity.current = { signerMode, signerKey, pubkey };
    generation.current++;
  }
  useEffect(() => {
    const unsubscribe = subscribeToNostrSignerRevision(() => {
      generation.current++;
      busyRef.current = false;
      setSignerRevision((epoch) => epoch + 1);
    });
    const unsubscribeSettings = useSettingsStore.subscribe((current, previous) => {
      if (
        current.nostrSignerMode !== previous.nostrSignerMode ||
        current.nsecSecret !== previous.nsecSecret ||
        current.nostrProfile?.pubkey !== previous.nostrProfile?.pubkey
      ) {
        generation.current++;
        busyRef.current = false;
        setSignerRevision((epoch) => epoch + 1);
      }
    });
    return () => {
      generation.current++;
      unsubscribeSettings();
      unsubscribe();
    };
  }, []);
  const [locals, setLocals] = useState<LocalRows>([]);
  const [createdRows, setCreatedRows] = useState<LocalRows>([]);
  const [createdPage, setCreatedPage] = useState(0);
  const [nextCreatedOffset, setNextCreatedOffset] = useState<number | null>(null);
  const [nextLocalOffset, setNextLocalOffset] = useState<number | null>(null);
  const [localPage, setLocalPage] = useState(0);
  const [remote, setRemote] = useState<BrowserOracleBackupList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventId, setEventId] = useState("");
  const [sourceRelay, setSourceRelay] = useState("");

  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
    setError(null);
    setRemote(null);
    setLocals([]);
    setCreatedRows([]);
  }, [signerMode, signerKey, pubkey, signerRevision]);

  const refreshLocal = useCallback(
    async (isActive: () => boolean = () => true) => {
      const captured = generation.current;
      const requireCurrent = () => {
        if (captured !== generation.current || !isActive())
          throw new Error("The oracle recovery refresh has expired.");
      };
      requireCurrent();
      const [page, created] = await Promise.all([
        localBrowserOracleBackupStatuses({
          localOffset: localPage * 20,
          kind: "imported",
          requireCurrent,
        }),
        localBrowserOracleBackupStatuses({
          localOffset: createdPage * 20,
          kind: "created",
          requireCurrent,
        }),
      ]);
      if (captured !== generation.current || !isActive()) return;
      setLocals(page.rows);
      setNextLocalOffset(page.nextOffset);
      setCreatedRows(created.rows);
      setNextCreatedOffset(created.nextOffset);
    },
    [localPage, createdPage],
  );
  useEffect(() => {
    let current = true;
    const captured = generation.current;
    void refreshLocal(() => current).catch(() => {
      if (current && captured === generation.current) setError(t("oracleBackup.failed"));
    });
    return () => {
      current = false;
    };
  }, [markets, imported, t, refreshLocal, signerMode, signerKey, pubkey, signerRevision]);

  const act = async (action: (requireCurrent: () => void) => Promise<unknown>) => {
    if (busyRef.current || publicationBusy) return;
    const captured = generation.current;
    const revision = getNostrSignerRevision();
    const isCurrent = () =>
      captured === generation.current && revision === getNostrSignerRevision();
    const requireCurrent = () => {
      if (!isCurrent()) throw new Error("The oracle recovery action has expired.");
    };
    busyRef.current = true;
    setBusy(true);
    try {
      requireCurrent();
      await action(requireCurrent);
      if (isCurrent()) setError(null);
    } catch (failure) {
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      try {
        await refreshLocal();
      } catch {
        if (isCurrent()) setError(t("oracleBackup.failed"));
      }
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const changePage = (setPage: (page: number) => void, page: number) => {
    if (busyRef.current || publicationBusy) return;
    generation.current++;
    setPage(page);
  };
  const scan = (cursor?: OracleBackupScanCursor | null) =>
    act(async (requireCurrent) => {
      const captured = generation.current;
      const result = await listBrowserOracleBackups(cursor, { requireCurrent });
      if (captured === generation.current) setRemote(result);
    });

  return (
    <section
      data-testid="creator-oracle-recovery"
      aria-labelledby="oracle-backup-heading"
      className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-700"
    >
      <h3 id="oracle-backup-heading" className="font-semibold">
        {t("oracleBackup.creatorHeading")}
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
            onClick={() => {
              generation.current++;
              busyRef.current = false;
              setError(null);
              setBusy(false);
            }}
            aria-label={t("oracleBackup.dismiss")}
          >
            {t("oracleBackup.dismiss")}
          </button>
        </div>
      )}
      <details
        data-testid="creator-oracle-advanced"
        className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"
      >
        <summary
          data-testid="creator-oracle-advanced-summary"
          className="cursor-pointer font-medium"
        >
          {t("oracleBackup.advanced")}
        </summary>
        <div className="mt-4 space-y-4">
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
                        void act((requireCurrent) =>
                          restoreBrowserOracleBackup(row.backupEventId, row.sourceRelay, {
                            requireCurrent,
                          }),
                        )
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
                id="oracle-backup-event-id"
                className={input}
                value={eventId}
                onChange={(event) => setEventId(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("oracleBackup.sourceRelay")}</span>
              <input
                id="oracle-backup-source-relay"
                className={input}
                value={sourceRelay}
                onChange={(event) => setSourceRelay(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              className={button}
              data-testid="creator-oracle-restore"
              disabled={busy || signerMode !== "nsec" || !eventId.trim() || !sourceRelay.trim()}
              onClick={() =>
                void act((requireCurrent) =>
                  restoreBrowserOracleBackup(eventId.trim(), sourceRelay.trim(), {
                    requireCurrent,
                  }),
                )
              }
            >
              {t("oracleBackup.restoreExact")}
            </button>
          </fieldset>
        </div>
      </details>
      {!!createdRows.length && (
        <h4 className="font-medium">{t("oracleBackup.createdBackupHeading")}</h4>
      )}
      {createdRows.map((row) =>
        row.available ? (
          <OracleBackupOwner
            key={row.conditionId}
            row={row}
            busy={busy || publicationBusy}
            act={act}
            onPublish={onPublish}
          />
        ) : (
          <p key={row.conditionId} className="break-all text-sm">
            {row.conditionId}: {t("oracleBackup.unavailable")}
          </p>
        ),
      )}
      <OracleRecordPagination
        page={createdPage}
        nextOffset={nextCreatedOffset}
        busy={busy || publicationBusy}
        onChange={(page) => changePage(setCreatedPage, page)}
      />
      <h4 className="font-medium">{t("oracleBackup.localHeading")}</h4>
      {locals.map((row) =>
        row.available ? (
          <OracleBackupOwner
            key={row.conditionId}
            row={row}
            busy={busy || publicationBusy}
            act={act}
            onPublish={onPublish}
          />
        ) : (
          <p key={row.conditionId} className="break-all text-sm">
            {row.conditionId}: {t("oracleBackup.unavailable")}
          </p>
        ),
      )}
      {!locals.length && <p className="text-sm">{t("oracleBackup.noLocal")}</p>}
      <OracleRecordPagination
        page={localPage}
        nextOffset={nextLocalOffset}
        busy={busy || publicationBusy}
        onChange={(page) => changePage(setLocalPage, page)}
      />
    </section>
  );
}
