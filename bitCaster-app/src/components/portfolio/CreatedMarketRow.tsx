import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreatedMarket, CreatedMarketStatus } from "@/types/portfolio";
import { formatBtc } from "@/lib/format";
import { CheckCircle2, Eye } from "lucide-react";

const STATUS_STYLES: Record<CreatedMarketStatus, string> = {
  active:
    "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
  resolved: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
  refunded:
    "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
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
  const canClaimFees =
    market.status === "resolved" && market.creatorFeesEarned > 0;
  const canPublishOracleAttestation =
    market.status === "active" &&
    market.oracle?.type === "self" &&
    !market.oracle.attestationHex &&
    market.oracle.outcomes.length > 0 &&
    !!onPublishOracleAttestation;
  const [selectedOutcome, setSelectedOutcome] = useState(
    market.oracle?.outcomes[0] ?? "",
  );

  return (
    <div className="rounded-lg p-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/50">
      <div className="flex items-center gap-3">
        {/* Market Image */}
        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">
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
        </div>

        {/* Market Info */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
            {market.title}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[market.status]}`}
            >
              {t(`marketStatus.${market.status}`)}
            </span>
            {market.volume > 0 && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {t("portfolio.volLabel", { value: formatBtc(market.volume) })}
              </span>
            )}
            {market.oracle?.attestedOutcome && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t("creator.attestedOutcome", {
                  outcome: market.oracle.attestedOutcome,
                })}
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
              {formatBtc(market.creatorFeesEarned)}
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
            onClick={() => onClaimFees(market.id)}
            className="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-800/40"
          >
            {t("portfolio.claimFees")}
          </button>
        )}

        {canPublishOracleAttestation && (
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={selectedOutcome}
              onChange={(e) => setSelectedOutcome(e.target.value)}
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
                  : t("creator.closeMarket")
              }
              onClick={() =>
                onPublishOracleAttestation?.(market.id, selectedOutcome)
              }
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span className="hidden sm:inline">
                {isPublishingOracleAttestation
                  ? t("creator.closingMarket")
                  : t("creator.closeMarket")}
              </span>
            </button>
          </div>
        )}

        {onView && (
          <button
            type="button"
            onClick={() => onView(market.id)}
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
