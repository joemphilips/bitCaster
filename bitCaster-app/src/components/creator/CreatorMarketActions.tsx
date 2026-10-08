import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { localBrowserOracleBackupStatuses } from "@/lib/browserOracleBackupAccess";
import { deliverBrowserOracleBackup } from "@/lib/browserOracleBackupDelivery";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostrSignerRevision";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

type OwnerRow = Awaited<ReturnType<typeof localBrowserOracleBackupStatuses>>["rows"][number];
export type CreatorOraclePublication = (request: {
  conditionId: string;
  title: string;
  outcomes: string[];
  chosenOutcome: string | null;
  republish: boolean;
  relayUrls: string[];
}) => void;
const button =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 disabled:opacity-50";

const MarketStatuses = createContext<{
  rows: OwnerRow[];
  failed: boolean;
  refresh: () => void;
} | null>(null);

/** One bounded status read serves the visible market page. */
export function CreatorMarketActionsProvider({
  conditionIds,
  children,
}: {
  conditionIds: string[];
  children: ReactNode;
}) {
  const markets = useCreatorMarketsStore((state) => state.markets);
  const imported = useCreatorMarketsStore((state) => state.importedOracles);
  const signerMode = useSettingsStore((state) => state.nostrSignerMode);
  const signerKey = useSettingsStore((state) => state.nsecSecret);
  const pubkey = useSettingsStore((state) => state.nostrProfile?.pubkey);
  const pageKey = JSON.stringify(conditionIds);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    pageKey: string;
    rows: OwnerRow[];
    failed: boolean;
  } | null>(null);
  const generation = useRef(0);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      setResult(null);
      refresh();
    };
    const unsubscribeSigner = subscribeToNostrSignerRevision(clear);
    const unsubscribeSettings = useSettingsStore.subscribe((current, previous) => {
      if (
        current.nostrSignerMode !== previous.nostrSignerMode ||
        current.nsecSecret !== previous.nsecSecret ||
        current.nostrProfile?.pubkey !== previous.nostrProfile?.pubkey
      )
        clear();
    });
    return () => {
      generation.current++;
      unsubscribeSigner();
      unsubscribeSettings();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const captured = generation.current;
    const requireCurrent = () => {
      if (!active || captured !== generation.current)
        throw new Error("The market status read has expired.");
    };
    const ids: string[] = JSON.parse(pageKey);
    if (ids.length > 0)
      void localBrowserOracleBackupStatuses({ conditionIds: ids, requireCurrent })
        .then((page) => {
          requireCurrent();
          setResult({ pageKey, rows: page.rows, failed: false });
        })
        .catch(() => {
          if (active && captured === generation.current)
            setResult({ pageKey, rows: [], failed: true });
        });
    return () => {
      active = false;
    };
  }, [pageKey, markets, imported, signerMode, signerKey, pubkey, revision]);
  return (
    <MarketStatuses.Provider
      value={{
        rows: result?.pageKey === pageKey ? result.rows : [],
        failed: result?.pageKey === pageKey && result.failed,
        refresh,
      }}
    >
      {children}
    </MarketStatuses.Provider>
  );
}

/** Local authority and delivery actions belong to the ordinary market row. */
export function CreatorMarketActions({
  conditionId,
  title,
  onPublish,
  publicationBusy,
}: {
  conditionId: string;
  title: string;
  onPublish: CreatorOraclePublication;
  publicationBusy: boolean;
}) {
  const { t } = useTranslation();
  const page = useContext(MarketStatuses);
  if (!page) throw new Error("Market actions require a visible market page.");
  const row = page.rows.find((item) => item.conditionId === conditionId) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const action = useRef<symbol | null>(null);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      action.current = null;
      setBusy(false);
      setError(false);
    };
    const unsubscribeSigner = subscribeToNostrSignerRevision(clear);
    const unsubscribeSettings = useSettingsStore.subscribe((current, previous) => {
      if (
        current.nostrSignerMode !== previous.nostrSignerMode ||
        current.nsecSecret !== previous.nsecSecret ||
        current.nostrProfile?.pubkey !== previous.nostrProfile?.pubkey
      )
        clear();
    });
    return () => {
      generation.current++;
      action.current = null;
      unsubscribeSigner();
      unsubscribeSettings();
    };
  }, [conditionId]);
  useEffect(() => {
    if (page.failed) setError(true);
  }, [page.failed]);

  const retryBackup = async () => {
    if (action.current || publicationBusy) return;
    const operation = Symbol("backup-delivery");
    action.current = operation;
    const captured = generation.current;
    const signerRevision = getNostrSignerRevision();
    const isCurrent = () =>
      action.current === operation &&
      captured === generation.current &&
      signerRevision === getNostrSignerRevision();
    const requireCurrent = () => {
      if (!isCurrent()) throw new Error("The market delivery action has expired.");
    };
    setBusy(true);
    try {
      requireCurrent();
      const result = await deliverBrowserOracleBackup(conditionId, { requireCurrent });
      if (isCurrent()) setError(result.failures.length > 0);
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      if (isCurrent()) {
        action.current = null;
        setBusy(false);
        page.refresh();
      }
    }
  };
  const ready = row?.available ? row : null;
  const status = ready?.status;
  const chosen = ready?.chosenOutcome;
  const disabled = busy || publicationBusy;
  const pendingBackup =
    status &&
    (status.preparationPending ||
      status.terminal.localCommitPending ||
      (status.initial.prepared && status.initial.acknowledgedRelays < status.initial.totalRelays) ||
      (status.terminal.prepared &&
        status.terminal.replacementAcknowledgedRelays < status.initial.totalRelays) ||
      (status.terminal.deletionRequired &&
        status.terminal.deletionAcknowledgedRelays < status.initial.totalRelays));
  const publish = (republish: boolean) => {
    if (!ready || disabled) return;
    onPublish({
      conditionId,
      title,
      outcomes: [...ready.outcomes],
      chosenOutcome: chosen ?? null,
      republish,
      relayUrls: [...ready.status.destinations.relayUrls],
    });
  };
  return (
    <div className="mt-2 space-y-2 text-sm" onClick={(event) => event.stopPropagation()}>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-red-700 dark:text-red-300">
          <span className="select-text">{t("oracleBackup.failed")}</span>
          <button type="button" className={button} onClick={() => setError(false)}>
            {t("oracleBackup.dismiss")}
          </button>
        </div>
      )}
      {row && !row.available && <p>{t("oracleBackup.unavailable")}</p>}
      {ready && (
        <>
          {!status!.importComplete && <p>{t("oracleBackup.importIncomplete")}</p>}
          {status!.noRelays && <p>{t("oracleBackup.noRelays")}</p>}
          {!chosen && ready.readiness !== "ready" && (
            <p>
              {t(
                ready.readiness === "needs-restore"
                  ? "oracleBackup.needsRestore"
                  : "oracleBackup.authorityUnavailable",
              )}
            </p>
          )}
          {chosen && (
            <p>
              {t("oracleBackup.savedOutcome", { outcome: chosen })}
              {" · "}
              {t(
                status!.publication.engineSynchronized
                  ? "creator.engineConfirmed"
                  : "creator.enginePending",
              )}
              {" · "}
              {t(
                status!.publication.relayPublished
                  ? "creator.relayConfirmed"
                  : "creator.relayPending",
              )}
            </p>
          )}
          {pendingBackup && <p role="status">{t("oracleBackup.deliveryPending")}</p>}
          {!status!.noRelays &&
            !pendingBackup &&
            (status!.initial.prepared || status!.terminal.prepared) && (
              <p role="status">{t("oracleBackup.deliveryConfirmed")}</p>
            )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              data-testid={chosen ? "creator-oracle-retry" : "creator-oracle-publish"}
              disabled={
                disabled ||
                (!chosen &&
                  (!status!.importComplete ||
                    ready.readiness !== "ready" ||
                    !ready.outcomes.length))
              }
              onClick={() => publish(false)}
            >
              {t(chosen ? "creator.retrySavedResolution" : "creator.closeMarket")}
            </button>
            {chosen && (
              <button
                type="button"
                className={button}
                data-testid="creator-oracle-republish"
                disabled={disabled}
                onClick={() => publish(true)}
              >
                {t("oracleBackup.republishResolution")}
              </button>
            )}
            {pendingBackup && (
              <button
                type="button"
                className={button}
                disabled={
                  disabled ||
                  ((!status!.importComplete || ready.readiness !== "ready") &&
                    !status!.initial.prepared &&
                    !status!.terminal.prepared)
                }
                onClick={() => void retryBackup()}
              >
                {t("oracleBackup.retryBackup")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
