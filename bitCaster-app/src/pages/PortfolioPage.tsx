import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Portfolio } from "@/components/portfolio";
import { DepositWithdrawOverlay } from "@/components/deposit-withdraw/DepositWithdrawOverlay";
import { WalletSetupModal } from "@/components/shared/WalletSetupModal";
import { usePortfolioState } from "./usePortfolioState";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import { useWalletStore } from "@/stores/wallet";
import { claimPortfolioPosition } from "@/lib/browserPortfolioClaim";
import { removePortfolioPosition } from "@/lib/browserPortfolioRemove";
import type { PLTimeSelector } from "@/types/portfolio";
import type { DepositWithdrawMode } from "@/types/deposit-withdraw";

export function toPortfolioMarketDetailId(marketId: string, outcomeId?: string | null): string {
  const suffix = outcomeId ? `-${outcomeId}` : "";
  if (suffix && marketId.endsWith(suffix)) {
    return marketId.slice(0, -suffix.length);
  }
  return marketId;
}

export function PortfolioPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const state = usePortfolioState();
  const [overlayMode, setOverlayMode] = useState<DepositWithdrawMode | null>(null);
  const [claimingPositionId, setClaimingPositionId] = useState<string | null>(null);
  const [removingPositionId, setRemovingPositionId] = useState<string | null>(null);
  const [showWalletSetup, setShowWalletSetup] = useState(false);
  const [walletSetupCreating, setWalletSetupCreating] = useState(false);
  const [walletSetupError, setWalletSetupError] = useState<string | null>(null);
  const addActivity = useActivityLogStore((s) => s.addActivity);

  const handleGetStarted = useCallback(() => {
    setWalletSetupError(null);
    setShowWalletSetup(true);
  }, []);

  const handleCreateNewWallet = useCallback(async () => {
    setWalletSetupCreating(true);
    setWalletSetupError(null);
    try {
      await useWalletStore.getState().ensureImplicitWallet();
      setShowWalletSetup(false);
    } catch (error) {
      setWalletSetupError(error instanceof Error ? error.message : t("wallet.setupFailed"));
    } finally {
      setWalletSetupCreating(false);
    }
  }, [t]);

  const handleImportSeed = useCallback(
    async (words: string[]) => {
      setWalletSetupCreating(true);
      setWalletSetupError(null);
      try {
        const result = await useWalletStore.getState().recoverFromMnemonic(words);
        if (!result.valid) {
          setWalletSetupError(result.error ?? t("seed.invalidMnemonic"));
          return;
        }
        await useWalletStore.getState().ensureImplicitWallet();
        setShowWalletSetup(false);
      } catch (error) {
        setWalletSetupError(error instanceof Error ? error.message : t("wallet.setupFailed"));
      } finally {
        setWalletSetupCreating(false);
      }
    },
    [t],
  );

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
        navigate(`/markets/${toPortfolioMarketDetailId(position.marketId, position.outcomeId)}`);
      }
    },
    [navigate, state.positions],
  );

  const handleViewPosition = useCallback(
    (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId);
      if (position) {
        navigate(`/markets/${toPortfolioMarketDetailId(position.marketId, position.outcomeId)}`);
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
      if (claimingPositionId || removingPositionId) return;
      const position = state.positions.find((p) => p.id === positionId);
      if (
        !position ||
        position.status !== "closed" ||
        (!position.isWinner && !position.claimRecoveryPending) ||
        position.canClaimPayout !== true
      ) {
        return;
      }

      setClaimingPositionId(positionId);
      try {
        const conditionId = toPortfolioMarketDetailId(position.marketId, position.outcomeId);
        const outcomeCollection = position.outcomeLabel ?? position.outcomeId;
        if (!outcomeCollection) throw new Error("Position outcome is unavailable");
        const result = await claimPortfolioPosition({
          conditionId,
          mintUrl: position.mintUrl,
          outcomeCollection,
          onCommittedLeg: ({ payoutAmount }) => {
            addActivity({
              type: "payout_claimed",
              baseAsset: position.baseAsset,
              amountSats: payoutAmount,
              status: "completed",
              marketId: position.marketId,
              marketTitle: position.marketTitle,
            });
          },
        });
        if (result.kind === "pending") window.alert(t("portfolio.claimPending"));
        if (result.kind === "error") window.alert(t("portfolio.claimFailed"));
      } catch {
        window.alert(t("portfolio.claimFailed"));
      } finally {
        setClaimingPositionId(null);
      }
    },
    [addActivity, claimingPositionId, removingPositionId, state.positions, t],
  );

  const handleDiscardLostPosition = useCallback(
    async (positionId: string) => {
      if (removingPositionId || claimingPositionId) return;
      const position = state.positions.find((p) => p.id === positionId);
      if (!position || !position.isLoser || position.isWinner || position.isPending) return;
      if (!window.confirm(t("portfolio.discardLostPositionConfirm"))) return;
      setRemovingPositionId(positionId);
      try {
        const conditionId = toPortfolioMarketDetailId(position.marketId, position.outcomeId);
        const outcomeCollection = position.outcomeLabel ?? position.outcomeId;
        if (!outcomeCollection) throw new Error("Position outcome is unavailable");
        // The catalogue label cannot authorize deletion. The coordinator verifies mint evidence.
        const result = await removePortfolioPosition({
          mintUrl: position.mintUrl,
          conditionId,
          outcomeCollection,
          onCommittedLeg: ({ payoutAmount }) => {
            addActivity({
              type: "payout_claimed",
              baseAsset: position.baseAsset,
              amountSats: payoutAmount,
              status: "completed",
              marketId: position.marketId,
              marketTitle: position.marketTitle,
            });
          },
        });
        switch (result.kind) {
          case "completed":
            break;
          case "pending":
            window.alert(t("portfolio.removePending"));
            break;
          case "stopped":
            window.alert(t("portfolio.removePayout"));
            break;
          case "partial":
          case "error":
            window.alert(t("portfolio.removeFailed"));
            break;
        }
      } catch {
        window.alert(t("portfolio.removeFailed"));
      } finally {
        setRemovingPositionId(null);
      }
    },
    [addActivity, claimingPositionId, removingPositionId, state.positions, t],
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
  const showConnectNostrCta = nostrSignerMode === "none" && nostrProfile == null;

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
        monitoring={state.monitoring}
        onGetStarted={handleGetStarted}
        onAvatarUpload={handleAvatarUpload}
        onTimeRangeChange={handleTimeRangeChange}
        onDeposit={handleDeposit}
        onWithdraw={handleWithdraw}
        onSellPosition={handleSellPosition}
        onViewPosition={handleViewPosition}
        onViewMarket={handleViewMarket}
        onClaimPayout={handleClaimPayout}
        onDiscardLostPosition={handleDiscardLostPosition}
        onPositionsTabChange={handlePositionsTabChange}
        onOpenSettings={handleOpenSettings}
        onDismissMonitoringError={state.dismissMonitoringError}
        onLoadMoreAssets={state.loadMoreAssets}
        onRetryLoadMoreAssets={state.loadMoreAssets}
        onDismissAssetPageError={state.dismissAssetPageError}
        showConnectNostrCta={showConnectNostrCta}
        onConnectNostr={handleConnectNostr}
      />
      {overlayMode && (
        <DepositWithdrawOverlay mode={overlayMode} onClose={() => setOverlayMode(null)} />
      )}
      {showWalletSetup && (
        <WalletSetupModal
          isCreating={walletSetupCreating}
          error={walletSetupError}
          onClose={() => setShowWalletSetup(false)}
          onCreateNew={handleCreateNewWallet}
          onImportSeed={handleImportSeed}
        />
      )}
    </>
  );
}
