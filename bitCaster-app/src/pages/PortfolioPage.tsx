import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { Portfolio } from "@/components/portfolio";
import { DepositWithdrawOverlay } from "@/components/deposit-withdraw/DepositWithdrawOverlay";
import { usePortfolioState } from "./usePortfolioState";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import {
  getConditionCtfProofs,
  getOutcomeProofs,
  removeProofs,
} from "@/stores/proof-db";
import { settleCtfPosition } from "@/lib/cashu";
import { isWinningCollection } from "@/lib/positionWinner";
import type { PLTimeSelector } from "@/types/portfolio";
import type { DepositWithdrawMode } from "@/types/deposit-withdraw";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";

export function toPortfolioMarketDetailId(marketId: string): string {
  const separator = marketId.indexOf("-");
  return separator > 0 ? marketId.slice(0, separator) : marketId;
}

export function PortfolioPage() {
  const navigate = useNavigate();
  const state = usePortfolioState();
  const [overlayMode, setOverlayMode] = useState<DepositWithdrawMode | null>(
    null,
  );
  const [claimingPositionId, setClaimingPositionId] = useState<string | null>(
    null,
  );
  const addActivity = useActivityLogStore((s) => s.addActivity);

  const handleGetStarted = useCallback(() => {
    navigate("/setup", { state: { from: "/portfolio" } });
  }, [navigate]);

  const handleAvatarUpload = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      state.saveProfile({ ...state.profile, avatarUrl: url });
    },
    [state],
  );

  const handleTimeRangeChange = useCallback(
    (range: PLTimeSelector) => {
      state.setSelectedTimeRange(range);
    },
    [state],
  );

  const handleDeposit = useCallback(() => {
    setOverlayMode("deposit");
  }, []);

  const handleWithdraw = useCallback(() => {
    setOverlayMode("withdraw");
  }, []);

  const handleSellPosition = useCallback(
    (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId);
      if (position) {
        navigate(`/markets/${toPortfolioMarketDetailId(position.marketId)}`);
      }
    },
    [navigate, state.positions],
  );

  const handleViewPosition = useCallback(
    (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId);
      if (position) {
        navigate(`/markets/${toPortfolioMarketDetailId(position.marketId)}`);
      }
    },
    [navigate, state.positions],
  );

  const handleViewMarket = useCallback(
    (marketId: string) => {
      navigate(`/markets/${toPortfolioMarketDetailId(marketId)}`);
    },
    [navigate],
  );

  const handleClaimPayout = useCallback(
    async (positionId: string) => {
      if (claimingPositionId) return;
      const position = state.positions.find((p) => p.id === positionId);
      if (
        !position ||
        position.status !== "closed" ||
        position.currentValueSats <= 0
      ) {
        return;
      }

      setClaimingPositionId(positionId);
      try {
        const conditionId = toPortfolioMarketDetailId(position.marketId);
        const outcomeCollection = position.outcomeLabel ?? position.outcomeId;
        // Gather ALL of the condition's CTF proofs (every keyset leg),
        // independent of how each leg was labelled when persisted. A composite
        // "A|B" position spans multiple keysets and `settleCtfPosition` buckets
        // them by keyset id, redeeming the winning leg and removing the losing
        // one — so the claim resolves the whole position, leaving no leftover
        // composite-tagged proof to keep the row alive or look like a winner.
        const proofs = await getConditionCtfProofs(
          position.mintUrl,
          conditionId,
        );
        if (proofs.length === 0)
          throw new Error("Position has no redeemable proofs");
        const regularProofs = await settleCtfPosition({
          conditionId,
          amountSats: proofs.reduce(
            (sum, proof) => sum + amountToNumber(proof.amount),
            0,
          ),
          proofs,
          mintUrl: position.mintUrl,
          outcomeCollection,
        });
        addActivity({
          type: "payout_claimed",
          amountSats: regularProofs.reduce(
            (sum, proof) => sum + amountToNumber(proof.amount),
            0,
          ),
          status: "completed",
          marketId: position.marketId,
          marketTitle: position.marketTitle,
        });
      } catch (error) {
        console.error("[portfolio] failed to claim payout", error);
        window.alert(
          error instanceof Error ? error.message : "Failed to claim payout",
        );
      } finally {
        setClaimingPositionId(null);
      }
    },
    [addActivity, claimingPositionId, state.positions],
  );

  const handleRemovePosition = useCallback(
    async (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId);
      // Gate on the SAME single source-of-truth as the "Lost" badge and the
      // Remove button (P22 F2/F3). These are bearer proofs: destroying a
      // mislabelled winner is permanent loss, so we never remove a position the
      // derivation considers a winner — even if a stale callback fired.
      if (!position || !position.isLoser || position.isWinner) return;
      try {
        const conditionId = toPortfolioMarketDetailId(position.marketId);
        const outcomeCollection = position.outcomeLabel ?? position.outcomeId;
        // Delete only this lost position's proofs (its outcome-collection
        // leg(s)), not the whole condition — a condition can hold several
        // positions. No mint redeem: a losing leg has nothing to claim.
        const proofs = outcomeCollection
          ? await getOutcomeProofs(
              position.mintUrl,
              conditionId,
              outcomeCollection,
              { includeReserved: true },
            )
          : [];
        // F2 defense-in-depth (P22 Link F): destroying a proof on a WINNING
        // keyset is permanent value loss. Even though `isLoser` already gates
        // this handler, never delete a proof whose own keyset outcome-collection
        // contains the attested final outcome — if the row classification were
        // ever off, this filter still refuses to touch redeemable proofs.
        const safeToDelete = proofs.filter((proof) => {
          const candidate = proof as typeof proof & {
            outcome_collection?: string;
          };
          const proofCollection =
            candidate.outcomeCollection ?? candidate.outcome_collection;
          return !(
            proofCollection &&
            isWinningCollection(proofCollection, position.finalOutcome)
          );
        });
        if (safeToDelete.length > 0) {
          await removeProofs(safeToDelete.map((proof) => proof.secret));
        }
      } catch (error) {
        console.error("[portfolio] failed to remove lost position", error);
      }
    },
    [state.positions],
  );

  const handlePositionsTabChange = useCallback(
    (tab: "active" | "closed") => {
      state.setPositionsTab(tab);
    },
    [state],
  );

  const handleOpenSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  const handleConnectNostr = useCallback(() => {
    navigate("/settings?category=nostr");
  }, [navigate]);

  // Anon state: no signer configured and no cached profile. Matches the
  // empty app-bar "Anon" + empty avatar the user sees in this state.
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nostrProfile = useSettingsStore((s) => s.nostrProfile);
  const showConnectNostrCta =
    nostrSignerMode === "none" && nostrProfile == null;

  return (
    <>
      <Portfolio
        walletState={state.walletState}
        baseCurrency={state.baseCurrency}
        selectedTimeRange={state.selectedTimeRange}
        profile={state.profile}
        plChartData={state.plChartData}
        stats={state.stats}
        positions={state.positions}
        funds={state.funds}
        activity={state.activity}
        createdMarkets={state.createdMarkets}
        positionsTab={state.positionsTab}
        onGetStarted={handleGetStarted}
        onAvatarUpload={handleAvatarUpload}
        onTimeRangeChange={handleTimeRangeChange}
        onDeposit={handleDeposit}
        onWithdraw={handleWithdraw}
        onSellPosition={handleSellPosition}
        onViewPosition={handleViewPosition}
        onViewMarket={handleViewMarket}
        onClaimPayout={handleClaimPayout}
        onRemovePosition={handleRemovePosition}
        onPositionsTabChange={handlePositionsTabChange}
        onOpenSettings={handleOpenSettings}
        showConnectNostrCta={showConnectNostrCta}
        onConnectNostr={handleConnectNostr}
      />
      {overlayMode && (
        <DepositWithdrawOverlay
          mode={overlayMode}
          onClose={() => setOverlayMode(null)}
        />
      )}
    </>
  );
}
