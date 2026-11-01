import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { OraclePublicationState } from "@bitcaster/client-sdk/oraclePublication";
import { localBrowserOracleBackupStatuses } from "@/lib/browserOracleBackupAccess";
import { assertNever } from "@/lib/enumDiscipline";
import { resolveNsecIdentity } from "@/lib/identityOps";
import { subscribeToNostrSignerRevision } from "@/lib/nostrSignerRevision";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

type OwnerRow = Awaited<ReturnType<typeof localBrowserOracleBackupStatuses>>["rows"][number];
type ReadyRow = Extract<OwnerRow, { available: true }>;
export type CreatorOraclePublication = (request: {
  conditionId: string;
  title: string;
  outcomes: string[];
  relayUrls: string[];
}) => void;
const button =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 disabled:opacity-50";
export const ORACLE_PUBLICATION_STATE_LABELS: Record<OraclePublicationState, string> = {
  publishing: "creator.resolutionPublishing",
  published: "creator.resolutionPublished",
  failed: "creator.resolutionFailed",
};

/**
 * Backup and resolution delivery run automatically. Show a message only when the user must act:
 * restore or sign with the oracle key, or keep local data that no relay has stored yet.
 */
function oracleOwnerNotice(row: ReadyRow, keyReady: boolean): string | null {
  const status = row.status;
  if (!status.importComplete) return "oracleBackup.importIncomplete";
  if (!row.chosenOutcome && row.readiness !== "ready")
    return row.readiness === "needs-restore"
      ? "oracleBackup.needsRestore"
      : "oracleBackup.authorityUnavailable";
  const unsignedChoice = row.chosenOutcome !== null && !row.signed;
  if ((status.preparationPending || unsignedChoice) && !keyReady) return "oracleBackup.keyRequired";
  if (row.chosenOutcome !== null) {
    // The initial backup was prepared before the choice. It holds the nonce but not the saved
    // outcome, so a restore from it could sign another outcome. Only the terminal backup counts.
    switch (row.publicationState) {
      case "publishing":
        return null;
      case "published":
      case "failed":
      case null: {
        const acknowledged = status.terminal.prepared
          ? status.terminal.replacementAcknowledgedRelays
          : 0;
        return acknowledged === 0 ? "oracleBackup.notOnRelay" : null;
      }
      default:
        return assertNever(row.publicationState);
    }
  }
  return status.initial.prepared && status.initial.acknowledgedRelays === 0
    ? "oracleBackup.notOnRelay"
    : null;
}

const MarketStatuses = createContext<{
  rows: OwnerRow[];
  failed: boolean;
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
  const signerMode = useSettingsStore((state) => state.nostrSignerMode);
  const signerKey = useSettingsStore((state) => state.nsecSecret);
  const signerPublicKey = useMemo(
    () => (signerMode === "nsec" ? (resolveNsecIdentity(signerKey)?.publicKey ?? null) : null),
    [signerMode, signerKey],
  );
  const [error, setError] = useState(false);
  useEffect(() => {
    if (page.failed) setError(true);
  }, [page.failed]);
  const ready = row?.available ? row : null;
  const chosen = ready?.chosenOutcome;
  const notice =
    ready && oracleOwnerNotice(ready, signerPublicKey === ready.status.binding.oraclePubkey);
  const publish = () => {
    if (!ready || publicationBusy) return;
    onPublish({
      conditionId,
      title,
      outcomes: [...ready.outcomes],
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
          {chosen && ready.publicationState && (
            <p role="status">
              {t("oracleBackup.savedOutcome", { outcome: chosen })}
              {" · "}
              {t(ORACLE_PUBLICATION_STATE_LABELS[ready.publicationState])}
            </p>
          )}
          {notice && <p>{t(notice)}</p>}
          {!chosen && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                data-testid="creator-oracle-publish"
                disabled={
                  publicationBusy ||
                  !ready.status.importComplete ||
                  ready.readiness !== "ready" ||
                  !ready.outcomes.length
                }
                onClick={publish}
              >
                {t("creator.closeMarket")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
