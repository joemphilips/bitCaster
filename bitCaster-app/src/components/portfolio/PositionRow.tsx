import type { KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Position } from "@/types/portfolio";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { InlineAmount } from "@/components/shared/InlineAmount";
import { OutcomeLabel } from "@/components/shared/OutcomeLabel";

interface PositionRowProps {
  position: Position;
  onSell?: (positionId: string) => void;
  onClaim?: (positionId: string) => void;
  onDiscard?: (positionId: string) => void;
  onView?: (positionId: string) => void;
}

const activeSideColors: Record<Position["side"], string> = {
  yes: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
  no: "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300",
  Outcome: "bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300",
};

function fallbackPositionLabel(position: Position, sideLabel: string): string {
  const explicit = position.outcomeLabel?.trim();
  if (explicit) return explicit;
  const outcomeId = position.outcomeId?.trim();
  if (outcomeId) {
    return outcomeId
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" or ");
  }
  return position.side === "Outcome" ? "Position" : sideLabel;
}

export function PositionRow({ position, onSell, onClaim, onDiscard, onView }: PositionRowProps) {
  const { t } = useTranslation();
  // Single source-of-truth (P22 F1/F2/F3): the "Won"/"Lost" badge, the Claim
  // button, and the destructive "Remove" gate all read these flags, derived
  // once in usePortfolioState. They can never disagree, so the Remove button
  // can never be offered on a position the badge calls "Won".
  const { isWinner, isLoser, isPending } = position;
  const baseAsset = normalizeMarketBaseAsset(position.baseAsset);
  const canClaim = position.canClaimPayout ?? (position.status === "closed" && isWinner);
  const canDiscard =
    position.canDiscard ?? (position.status === "closed" && isLoser && !isWinner && !isPending);
  const sideLabel = position.side.toUpperCase();
  const positionLabel = fallbackPositionLabel(position, sideLabel);
  const hasOutcomeLabel = Boolean(position.outcomeLabel?.trim());
  const categoricalOutcomeLabel = (
    <OutcomeLabel
      outcome={{ label: positionLabel, color: position.outcomeColor }}
      className="text-xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700"
      labelClassName="text-slate-700 dark:text-slate-300"
      swatchClassName="h-2.5 w-2.5"
    />
  );
  const handleView = () => onView?.(position.id);
  const handleViewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleView();
  };

  const handleDiscard = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onDiscard?.(position.id);
  };

  return (
    <div
      role={onView ? "button" : undefined}
      tabIndex={onView ? 0 : undefined}
      onClick={handleView}
      onKeyDown={onView ? handleViewKeyDown : undefined}
      className="w-full flex flex-col gap-3 p-3 rounded-lg transition-colors text-left sm:flex-row sm:items-center hover:bg-slate-50 dark:hover:bg-slate-700/50"
    >
      <div className="flex min-w-0 items-start gap-3 sm:contents">
        {/* Market Image */}
        <div className="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 overflow-hidden shrink-0">
          <img
            src={position.marketImageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>

        {/* Market Info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 dark:text-white break-words sm:truncate">
            {position.marketTitle}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-0.5">
            {isWinner ? (
              <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                {t("portfolio.won")} ☺
              </span>
            ) : isLoser ? (
              <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                {t("portfolio.lost")} 😭
              </span>
            ) : isPending ? (
              <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                {t("portfolio.awaitingResolution")}
              </span>
            ) : position.side === "Outcome" ? (
              categoricalOutcomeLabel
            ) : (
              <span
                className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                  position.status === "active"
                    ? activeSideColors[position.side]
                    : activeSideColors.Outcome
                }`}
              >
                {positionLabel}
              </span>
            )}
            {hasOutcomeLabel &&
              (isWinner || isLoser || isPending) &&
              (position.side === "Outcome" ? (
                categoricalOutcomeLabel
              ) : (
                <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                  {positionLabel}
                </span>
              ))}
            {position.shares !== undefined && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {position.shares.toLocaleString()} shares
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Position value */}
      {position.claimRecoveryPending && (
        <p
          role="status"
          className="w-full text-xs text-amber-700 dark:text-amber-300 max-w-xs sm:w-auto"
        >
          {t("portfolio.claimPending")}
        </p>
      )}
      {position.removalPending && (
        <p
          role="status"
          className="w-full text-xs text-amber-700 dark:text-amber-300 max-w-xs sm:w-auto"
        >
          {t("portfolio.removePending")}
        </p>
      )}
      <div className="flex w-full items-center justify-between gap-3 sm:contents">
        <div className="shrink-0 text-left sm:text-right">
          {position.valueKnown === false ? (
            <div className="max-w-48 text-slate-500 dark:text-slate-400">
              <div className="text-sm font-medium">{t("portfolio.unvalued")}</div>
              <p className="text-xs">{t("portfolio.unvaluedReason")}</p>
            </div>
          ) : (
            <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
              <InlineAmount amountSubunits={position.currentValueSats} baseAsset={baseAsset} />
            </div>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:contents">
          {/* Action Button */}
          {position.canSell !== false && position.status === "active" && onSell && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSell(position.id);
              }}
              aria-label={t("portfolio.sellAria", { title: position.marketTitle })}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              {t("common.sell")}
            </button>
          )}
          {canClaim && onClaim && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClaim(position.id);
              }}
              aria-label={t("portfolio.claimAria", { title: position.marketTitle })}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition-colors"
            >
              {t("common.claim")}
            </button>
          )}
          {canDiscard && onDiscard && (
            <button
              onClick={handleDiscard}
              aria-label={t("portfolio.discardLostPosition", {
                title: position.marketTitle,
              })}
              title={t("portfolio.discardLostPosition", {
                title: position.marketTitle,
              })}
              className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
