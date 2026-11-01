import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Position, PortfolioProps } from "@/types/portfolio";
import { portfolioPositionAnchorId } from "@/lib/portfolioRoute";
import { PositionRow } from "./PositionRow";
import { ClaimCelebrationRow } from "./ClaimCelebrationRow";

interface PositionsListProps {
  positions: Position[];
  positionsTab: "active" | "closed";
  onPositionsTabChange?: (tab: "active" | "closed") => void;
  onSellPosition?: (positionId: string) => void;
  onClaimPayout?: (positionId: string) => void;
  onDiscardLostPosition?: (positionId: string) => void;
  onViewPosition?: (positionId: string) => void;
  positionAction?: PortfolioProps["positionAction"];
  claimCelebrations?: PortfolioProps["claimCelebrations"];
  removalConfirmationPositionId?: string;
  onConfirmDiscardLostPosition?: (positionId: string) => void;
  onCancelDiscardLostPosition?: () => void;
  /** Scroll to and focus this position once for each request key. */
  positionsRequest?: PortfolioProps["positionsRequest"];
}

export function PositionsList({
  positions,
  positionsTab,
  onPositionsTabChange,
  onSellPosition,
  onClaimPayout,
  onDiscardLostPosition,
  onViewPosition,
  positionAction,
  claimCelebrations = [],
  removalConfirmationPositionId,
  onConfirmDiscardLostPosition,
  onCancelDiscardLostPosition,
  positionsRequest,
}: PositionsListProps) {
  const { t } = useTranslation();
  const filtered = positions.filter((p) => p.status === positionsTab);
  // One row for each market ID owns the anchor. The same collection can be
  // held at more than one mint, and a DOM ID must be unique.
  const anchoredMarketIds = new Set<string>();
  const targetMarketId = positionsRequest?.positionMarketId ?? null;
  const targetRendered =
    targetMarketId !== null && filtered.some(({ marketId }) => marketId === targetMarketId);
  const handledRequestKey = useRef<string | null>(null);
  useEffect(() => {
    const requestKey = positionsRequest?.key;
    if (!targetRendered || targetMarketId === null || requestKey === undefined) return;
    if (handledRequestKey.current === requestKey) return;
    const row = document.getElementById(portfolioPositionAnchorId(targetMarketId));
    if (row === null) return;
    handledRequestKey.current = requestKey;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
  }, [positionsRequest?.key, targetMarketId, targetRendered]);

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-3" role="tablist">
        {(["active", "closed"] as const).map((tab) => {
          const count = positions.filter((p) => p.status === tab).length;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={positionsTab === tab}
              onClick={() => onPositionsTabChange?.(tab)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                positionsTab === tab
                  ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                  : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
              }`}
            >
              {t(`common.${tab}`)} ({count})
            </button>
          );
        })}
      </div>

      {/* Position List */}
      {claimCelebrations.map((celebration) => (
        <ClaimCelebrationRow key={celebration.id} celebration={celebration} />
      ))}
      {filtered.length === 0 && claimCelebrations.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          {positionsTab === "active"
            ? t("portfolio.noActivePositions")
            : t("portfolio.noClosedPositions")}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((position) => {
            const ownsAnchor = !anchoredMarketIds.has(position.marketId);
            anchoredMarketIds.add(position.marketId);
            return (
              <PositionRow
                key={position.id}
                position={position}
                anchorId={ownsAnchor ? portfolioPositionAnchorId(position.marketId) : undefined}
                onSell={onSellPosition}
                onClaim={onClaimPayout}
                onDiscard={onDiscardLostPosition}
                onView={onViewPosition}
                action={
                  positionAction?.positionId === position.id ? positionAction.kind : undefined
                }
                actionsDisabled={positionAction !== undefined}
                confirmingRemoval={removalConfirmationPositionId === position.id}
                onConfirmDiscard={onConfirmDiscardLostPosition}
                onCancelDiscard={onCancelDiscardLostPosition}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
