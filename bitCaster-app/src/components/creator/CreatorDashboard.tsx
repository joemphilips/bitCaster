import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Plus, TrendingUp, CheckCircle2, BarChart3, Coins, AlertCircle } from "lucide-react";
import { formatBtc } from "@/lib/format";
import { formatMarketSubunits } from "@bitcaster/client-sdk/marketUnits";
import { publishBrowserOracleOutcome } from "@/lib/oracleAttestation";
import { ORACLE_EXPLANATION_UTF8_BYTES_MAX } from "@bitcaster/client-sdk/oracleResolutionExplanation";
import { NativeDialog } from "@/components/shared/NativeDialog";
import { useCreatorDashboardState } from "@/hooks/useCreatorDashboardState";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import { MyMarkets } from "@/components/portfolio/MyMarkets";
import { PrimaryGradientButton } from "@/components/shared/PrimaryGradientButton";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostrSignerRevision";
import { CreatorOracleRecovery, type OracleRecoveryPublish } from "./CreatorOracleRecovery";
import { AnalyticsComingSoon } from "./AnalyticsComingSoon";
import type { CreatorEngineDataStatus } from "@/types/portfolio";

const ENGINE_VOLUME_SUBLABELS: Record<CreatorEngineDataStatus, string> = {
  current: "creator.statTotalVolumeSub",
  stale: "creator.engineDataStale",
  unavailable: "creator.engineDataUnavailable",
};

type ActiveTab = "overview" | "analytics";

interface StatCardProps {
  label: string;
  value: string | number;
  subValue: string;
  icon: React.ReactNode;
}

function StatCard({ label, value, subValue, icon }: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <span className="text-slate-400 dark:text-slate-500">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{value}</div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{subValue}</div>
    </div>
  );
}

/**
 * Creator Dashboard at `/creator`.
 *
 * Three sections:
 *  - Overview — stats grid + list of markets the user has created (reuses the
 *    portfolio `MyMarkets` / `CreatedMarketRow` components so the look-and-
 *    feel is consistent with the bottom-of-portfolio section).
 *  - Analytics — placeholder until we have a real volume chart.
 *  - "Create Market" button — routes to the existing wizard at `/creator/new`.
 */
export function CreatorDashboard() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [resolvingMarketId, setResolvingMarketId] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolutionSuccess, setResolutionSuccess] = useState<string | null>(null);
  const { stats, markets, isLoading, error, pubkey, refresh, engineDataStatus } =
    useCreatorDashboardState();
  const generation = useRef(0);
  const signerMode = useSettingsStore((s) => s.nostrSignerMode);
  const signerKey = useSettingsStore((s) => s.nsecSecret);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      setResolutionDialog(null);
      setResolutionError(null);
      setResolutionSuccess(null);
      setResolvingMarketId(null);
    };
    clear();
    const unsubscribe = subscribeToNostrSignerRevision(clear);
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
      unsubscribeSettings();
      unsubscribe();
    };
  }, [signerMode, signerKey, pubkey]);
  const relays = useSettingsStore((s) => s.relays);
  const [resolutionDialog, setResolutionDialog] = useState<{
    marketId: string;
    outcome: string;
    recovery?: boolean;
    chosen?: boolean;
    republish?: boolean;
    relayUrls?: string[];
  } | null>(null);
  const [explanation, setExplanation] = useState("");
  const handleCreateMarket = () => navigate("/creator/new");
  const handleViewMarket = (marketId: string) => navigate(`/markets/${marketId}`);
  const handlePublishOracleAttestation = (marketId: string, outcome: string) => {
    const market = markets.find((m) => m.id === marketId);
    if (!market?.oracle || !market.oracle.outcomes.includes(outcome)) return;
    generation.current++;
    setResolutionError(null);
    setResolutionSuccess(null);
    setExplanation(market.oracle.explanationDraft ?? "");
    setResolutionDialog({
      marketId,
      outcome: market.oracle.chosenOutcome ?? market.oracle.attestedOutcome ?? outcome,
    });
  };
  const handleRecoveryPublication: OracleRecoveryPublish = (
    marketId,
    outcome,
    republish,
    relayUrls,
    chosen,
  ) => {
    generation.current++;
    setResolutionError(null);
    setResolutionSuccess(null);
    const state = useCreatorMarketsStore.getState();
    const imported = state.importedOracles.find((row) => row.binding.conditionId === marketId);
    const created = state.markets.find((row) => row.conditionId === marketId);
    setExplanation(imported?.explanationDraft ?? created?.oracle?.explanationDraft ?? "");
    setResolutionDialog({ marketId, outcome, recovery: true, chosen, republish, relayUrls });
  };
  const dismissResolution = () => {
    generation.current++;
    setResolutionDialog(null);
    setResolutionError(null);
  };
  const confirmResolution = async () => {
    if (!resolutionDialog) return;
    const { marketId, outcome, recovery, chosen, republish, relayUrls } = resolutionDialog;
    const captured = generation.current;
    const revision = getNostrSignerRevision();
    const isCurrent = () =>
      captured === generation.current && revision === getNostrSignerRevision();
    const requireCurrent = () => {
      if (!isCurrent()) throw new Error("The oracle publication action has expired.");
    };
    setResolvingMarketId(marketId);
    try {
      requireCurrent();
      if (!chosen)
        await useCreatorMarketsStore.getState().saveOracleExplanationDraft(marketId, explanation);
      if (!isCurrent()) return;
      const result = recovery
        ? await publishBrowserOracleOutcome(
            marketId,
            outcome,
            chosen ? undefined : explanation,
            relayUrls ?? [],
            useCreatorMarketsStore,
            undefined,
            {
              engineDelivery: "synchronize",
              republishAttestation: republish ?? false,
              requireCurrent,
            },
          )
        : await publishBrowserOracleOutcome(
            marketId,
            outcome,
            explanation,
            effectiveRelayUrls(relays),
            useCreatorMarketsStore,
            undefined,
            { engineDelivery: "synchronize", requireCurrent },
          );
      if (!isCurrent()) return;
      setResolutionSuccess(
        t(
          result.failures.length
            ? "creator.oracleDeliveryIncomplete"
            : "creator.oracleDeliveryComplete",
          { outcome },
        ),
      );
      setResolutionDialog(null);
      refresh();
    } catch {
      if (isCurrent()) setResolutionError(t("creator.oracleRecoveryRequired"));
    } finally {
      if (isCurrent()) setResolvingMarketId(null);
    }
  };
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-3xl">
              {t("creator.title")}
            </h1>
            <p className="mt-1 text-slate-500 dark:text-slate-400">{t("creator.subtitle")}</p>
          </div>

          <PrimaryGradientButton onClick={handleCreateMarket} icon={Plus}>
            {t("creator.createMarket")}
          </PrimaryGradientButton>
        </div>

        {/* Tab navigation */}
        <div className="mb-6 flex items-center gap-1 rounded-xl bg-slate-100 p-1.5 dark:bg-slate-800">
          {(["overview", "analytics"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all sm:flex-none ${
                activeTab === tab
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              {tab === "overview" ? t("creator.tabOverview") : t("creator.tabAnalytics")}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Wallet prompt — creator state lives on the client, so without a
               wallet we have nothing to scope this dashboard to. */}
            {!pubkey && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {t("creator.walletPrompt")}
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label={t("creator.statActiveMarkets")}
                value={stats.activeMarketsCount}
                subValue={t("creator.statActiveMarketsSub")}
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <StatCard
                label={t("creator.statResolved")}
                value={stats.resolvedMarketsCount}
                subValue={t("creator.statResolvedSub")}
                icon={<CheckCircle2 className="h-5 w-5" />}
              />
              <StatCard
                label={t("creator.statTotalVolume")}
                value={
                  engineDataStatus === "unavailable"
                    ? "—"
                    : formatMarketSubunits(stats.totalVolumeSubunits, "sat")
                }
                subValue={t(ENGINE_VOLUME_SUBLABELS[engineDataStatus])}
                icon={<BarChart3 className="h-5 w-5" />}
              />
              <StatCard
                label={t("creator.statFeesEarned")}
                value={formatBtc(stats.totalFeesEarnedSats)}
                subValue={t("creator.statFeesEarnedSub")}
                icon={<Coins className="h-5 w-5" />}
              />
            </div>

            {/* Error banner — markets still render from the client store, so
               this is informational only. */}
            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">{t("creator.engineDataUnavailable")}</p>
                  <p className="mt-0.5 text-xs opacity-80">{error}</p>
                </div>
              </div>
            )}

            {resolutionError && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">{t("creator.attestationErrorTitle")}</p>
                  <p className="mt-0.5 select-text text-xs opacity-80">{resolutionError}</p>
                  <button
                    onClick={() => setResolutionError(null)}
                    aria-label={t("oracleBackup.dismiss")}
                  >
                    {t("oracleBackup.dismiss")}
                  </button>
                </div>
              </div>
            )}

            {resolutionSuccess && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                {resolutionSuccess}
              </div>
            )}

            {/* Market list */}
            <div>
              {markets.length === 0 ? (
                <EmptyState isLoading={isLoading} onCreate={handleCreateMarket} />
              ) : (
                <MyMarkets
                  markets={markets}
                  onViewMarket={handleViewMarket}
                  onPublishOracleAttestation={handlePublishOracleAttestation}
                  publishingOracleAttestationMarketId={resolvingMarketId}
                />
              )}
            </div>
            <CreatorOracleRecovery
              onPublish={handleRecoveryPublication}
              publicationBusy={resolvingMarketId !== null}
            />
          </div>
        )}

        {activeTab === "analytics" && <AnalyticsComingSoon />}
        {resolutionDialog && (
          <NativeDialog
            ariaLabel={t("creator.resolveDialogTitle")}
            canDismiss={resolvingMarketId === null}
            onDismiss={dismissResolution}
          >
            {(dismiss) => (
              <div className="mx-auto mt-16 w-[calc(100%-2rem)] max-w-lg rounded-2xl bg-white p-6 text-slate-900 shadow-xl dark:bg-slate-900 dark:text-slate-100">
                <h2 className="text-xl font-semibold">{t("creator.resolveDialogTitle")}</h2>
                <p className="mt-3">
                  {t("creator.resolveImmutableChoice", {
                    outcome: resolutionDialog.outcome,
                  })}
                </p>
                {resolutionError && (
                  <p role="alert" className="mt-3 text-sm text-rose-600">
                    {resolutionError}
                  </p>
                )}
                <label className="mt-4 block" htmlFor="oracle-explanation">
                  {t("creator.explanationOptional")}
                </label>
                <textarea
                  id="oracle-explanation"
                  value={explanation}
                  disabled={
                    !!resolutionDialog.chosen ||
                    !!markets.find((m) => m.id === resolutionDialog.marketId)?.oracle
                      ?.chosenOutcome ||
                    !!markets.find((m) => m.id === resolutionDialog.marketId)?.oracle
                      ?.attestedOutcome ||
                    resolvingMarketId !== null
                  }
                  onChange={(event) => setExplanation(event.target.value)}
                  className="mt-2 min-h-28 w-full rounded-lg border border-slate-300 p-3 dark:border-slate-700 dark:bg-slate-800"
                />
                <p className="mt-2 text-sm text-slate-500">
                  {t("creator.explanationLimit", {
                    limit: ORACLE_EXPLANATION_UTF8_BYTES_MAX,
                  })}
                </p>
                <div className="mt-6 flex justify-end gap-3">
                  <button type="button" disabled={resolvingMarketId !== null} onClick={dismiss}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="creator-oracle-confirm"
                    onClick={() => void confirmResolution()}
                    disabled={
                      resolvingMarketId !== null ||
                      new TextEncoder().encode(explanation).length >
                        ORACLE_EXPLANATION_UTF8_BYTES_MAX
                    }
                    className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                  >
                    {t(resolvingMarketId ? "creator.closingMarket" : "creator.confirmResolution")}
                  </button>
                </div>
              </div>
            )}
          </NativeDialog>
        )}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  isLoading: boolean;
  onCreate: () => void;
}

function EmptyState({ isLoading, onCreate }: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-12 text-center dark:border-slate-700 dark:bg-slate-900/50">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
        <Plus className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-bold text-slate-900 dark:text-white">
        {isLoading ? t("creator.emptyLoading") : t("creator.emptyTitle")}
      </h3>
      <p className="mt-2 text-slate-500 dark:text-slate-400">{t("creator.emptyDesc")}</p>
      <button
        onClick={onCreate}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 font-bold text-white shadow-md transition-all hover:bg-blue-700 hover:shadow-lg"
      >
        <Plus className="h-5 w-5" />
        {t("creator.createMarket")}
      </button>
    </div>
  );
}
