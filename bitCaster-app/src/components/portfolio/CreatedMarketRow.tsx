import { useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  CreatedMarket,
  CreatedMarketStatus,
  CreatorEngineDataStatus,
} from "@/types/portfolio";
import { formatMarketSubunits, normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { InlineAmount } from "@/components/shared/InlineAmount";
import { CheckCircle2, Eye } from "lucide-react";

const STATUS_STYLES: Record<CreatedMarketStatus, string> = {
  active: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
  resolved: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
  refunded: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
  unknown: "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300",
};

const CLOSED_THUMBNAIL: Record<CreatedMarketStatus, boolean> = {
  active: false,
  resolved: true,
  refunded: true,
  unknown: false,
};
const ENGINE_DATA_LABELS: Record<CreatorEngineDataStatus, string | null> = {
  current: null,
  stale: "creator.engineDataStale",
  unavailable: "creator.engineDataUnavailable",
};

interface CreatedMarketRowProps {
  market: CreatedMarket;
  onView?: (marketId: string) => void;
  onClaimFees?: (marketId: string) => void;
  onPublishOracleAttestation?: (marketId: string, outcome: string) => void;
  isPublishingOracleAttestation?: boolean;
}

export function CreatedMarketRow({
  market,
  onView,
  onClaimFees,
  onPublishOracleAttestation,
  isPublishingOracleAttestation = false,
}: CreatedMarketRowProps) {
  const { t } = useTranslation();
  const baseAsset = normalizeMarketBaseAsset(market.baseAsset);
  const engineDataLabel = market.engineDataStatus
    ? ENGINE_DATA_LABELS[market.engineDataStatus]
    : null;
  const canClaimFees = market.status === "resolved" && market.creatorFeesEarned > 0;
  const canPublishOracleAttestation =
    (market.status === "active" ||
      market.status === "resolved" ||
      !!market.oracle?.chosenOutcome ||
      !!market.oracle?.attestationHex) &&
    market.oracle?.type === "self" &&
    (!market.oracle.engineEvidence ||
      !market.oracle.relayPublished ||
      (!!market.oracle.explanationDraft?.trim() && !market.oracle.explanationEventJson) ||
      (!!market.oracle.explanationEventJson && !market.oracle.explanationRelayPublished)) &&
    market.oracle.outcomes.length > 0 &&
    !!onPublishOracleAttestation;
  const [selectedOutcome, setSelectedOutcome] = useState(market.oracle?.outcomes[0] ?? "");
  const immutableOutcome = market.oracle?.chosenOutcome ?? market.oracle?.attestedOutcome;

  const handleRowClick = () => {
    onView?.(market.id);
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onView) return;
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onView(market.id);
  };

  const stopRowNavigation = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      data-created-market-id={market.id}
      onClick={onView ? handleRowClick : undefined}
      onKeyDown={handleRowKeyDown}
      tabIndex={onView ? 0 : undefined}
      className={`rounded-lg p-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/50 ${
        onView ? "cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        {/* Market Image */}
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">
          {market.imageUrl && (
            <img
              src={market.imageUrl}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          {CLOSED_THUMBNAIL[market.status] && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/65 text-[9px] font-semibold uppercase tracking-wide text-white">
              {t("common.closed")}
            </div>
          )}
        </div>

        {/* Market Info */}
        <div className="min-w-0 flex-1 basis-40 sm:basis-0">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
            {market.title}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[market.status]}`}
            >
              {t(`marketStatus.${market.status}`)}
            </span>
            {market.volume > 0 && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {t("portfolio.volLabel", {
                  value: formatMarketSubunits(market.volume, baseAsset),
                })}
              </span>
            )}
            {engineDataLabel && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t(engineDataLabel)}
              </span>
            )}
            {market.oracle?.attestedOutcome && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t("creator.attestedOutcome", {
                  outcome: market.oracle.attestedOutcome,
                })}
              </span>
            )}
            {market.oracle?.chosenOutcome && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t(
                  market.oracle.engineEvidence
                    ? "creator.engineConfirmed"
                    : "creator.enginePending",
                )}
                {" · "}
                {t(
                  market.oracle.relayPublished ? "creator.relayConfirmed" : "creator.relayPending",
                )}
              </span>
            )}
            {market.oracle?.explanationDraft?.trim() &&
              !market.oracle.explanationRelayPublished && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t("creator.explanationPending")}
                </span>
              )}
          </div>
        </div>

        {/* Fees & Action */}
        {/* The percentage row is hidden while the engine accrues no fees
            (creatorFeePercent === 0); showing "0% fee" was the P7 §`/creator`
            regression. A non-zero value still renders so a future engine-side
            fee model surfaces without further UI work. */}
        <div className="shrink-0 text-right">
          {market.creatorFeesEarned > 0 && (
            <div className="font-mono text-sm text-amber-600 dark:text-amber-400">
              <InlineAmount amountSubunits={market.creatorFeesEarned} baseAsset={baseAsset} />
            </div>
          )}
          {market.creatorFeePercent > 0 && (
            <div className="text-xs text-slate-400 dark:text-slate-500">
              {market.creatorFeePercent}% fee
            </div>
          )}
        </div>

        {canClaimFees && onClaimFees && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClaimFees(market.id);
            }}
            className="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-800/40"
          >
            {t("portfolio.claimFees")}
          </button>
        )}

        {canPublishOracleAttestation && (
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={immutableOutcome ?? selectedOutcome}
              disabled={!!immutableOutcome || isPublishingOracleAttestation}
              onChange={(e) => setSelectedOutcome(e.target.value)}
              onClick={stopRowNavigation}
              onKeyDown={stopRowNavigation}
              aria-label={t("creator.winningOutcomeLabel", {
                title: market.title,
              })}
              className="h-9 max-w-28 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              {market.oracle!.outcomes.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedOutcome || isPublishingOracleAttestation}
              aria-label={
                isPublishingOracleAttestation
                  ? t("creator.closingMarket")
                  : t(immutableOutcome ? "creator.retrySavedResolution" : "creator.closeMarket")
              }
              onClick={(event) => {
                event.stopPropagation();
                onPublishOracleAttestation?.(market.id, immutableOutcome ?? selectedOutcome);
              }}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span className="hidden sm:inline">
                {isPublishingOracleAttestation
                  ? t("creator.closingMarket")
                  : t(immutableOutcome ? "creator.retrySavedResolution" : "creator.closeMarket")}
              </span>
            </button>
          </div>
        )}

        {onView && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onView(market.id);
            }}
            aria-label={t("portfolio.viewMarket", { title: market.title })}
            className="shrink-0 rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white"
          >
            <Eye className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
