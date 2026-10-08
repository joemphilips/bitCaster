import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Portfolio } from "@/components/portfolio";
import { DepositWithdrawOverlay } from "@/components/deposit-withdraw/DepositWithdrawOverlay";
import { WalletSetupModal } from "@/components/shared/WalletSetupModal";
import { NativeDialog } from "@/components/shared/NativeDialog";
import { usePortfolioState } from "./usePortfolioState";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import { useWalletStore } from "@/stores/wallet";
import { claimPortfolioPosition } from "@/lib/browserPortfolioClaim";
import {
  removePortfolioPosition,
  type BrowserPortfolioRemoveFailure,
} from "@/lib/browserPortfolioRemove";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  isActiveBrowserWalletId,
} from "@/lib/browserWalletProfile";
import type { BrowserCtfClaimFailureCategory } from "@/lib/browserCtfRedeemCoordinator";
import type { PLTimeSelector } from "@/types/portfolio";
import type { DepositWithdrawMode } from "@/types/deposit-withdraw";

export function toPortfolioMarketDetailId(marketId: string, outcomeId?: string | null): string {
  const suffix = outcomeId ? `-${outcomeId}` : "";
  if (suffix && marketId.endsWith(suffix)) {
    return marketId.slice(0, -suffix.length);
  }
  return marketId;
}

const CLAIM_FAILURE_TRANSLATION_KEYS = {
  "profile-ownership": "portfolio.claimFailureProfileOwnership",
  "counter-readiness": "portfolio.claimFailureCounterReadiness",
  "keyset-authority": "portfolio.claimFailureKeysetAuthority",
  "attestation-lookup": "portfolio.claimFailureAttestationLookup",
  "persisted-recovery": "portfolio.claimFailurePersistedRecovery",
  "mint-refusal": "portfolio.claimFailureMintRefusal",
  "unknown-mint-result": "portfolio.claimFailureUnknownMintResult",
  "local-commit": "portfolio.claimFailureLocalCommit",
} as const satisfies Record<BrowserCtfClaimFailureCategory, string>;

function isCurrentWallet(walletId: string): boolean {
  const mnemonic = useWalletStore.getState().mnemonic;
  return isActiveBrowserWalletId(walletId, mnemonic);
}

type PositionActionDialog = { scopeId: string | null; epoch: number; message: string };
type RemovalConfirmation = {
  epoch: number;
  scopeId: string | null;
  positionId: string;
  walletId: string;
  mintUrl: string;
  conditionId: string;
  outcomeCollection: string;
};
type PositionOperation = {
  token: symbol;
  epoch: number;
  scopeId: string | null;
  walletId: string;
  positionId: string;
  kind: "claim" | "remove";
};

export function PortfolioPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const state = usePortfolioState();
  const [overlayMode, setOverlayMode] = useState<DepositWithdrawMode | null>(null);
  const [positionAction, setPositionAction] = useState<PositionOperation | null>(null);
  const operation = useRef<PositionOperation | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const confirmation = useRef<RemovalConfirmation | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState<RemovalConfirmation | null>(null);
  const [showWalletSetup, setShowWalletSetup] = useState(false);
  const [walletSetupCreating, setWalletSetupCreating] = useState(false);
  const [walletSetupError, setWalletSetupError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<PositionActionDialog | null>(null);
  const activeScopeId = activeBrowserWalletScopeId();
  const visibleDialog =
    actionDialog?.scopeId === activeScopeId && actionDialog.epoch === epoch.current
      ? actionDialog
      : null;
  const visibleAction =
    positionAction?.scopeId === activeScopeId && positionAction.epoch === epoch.current
      ? positionAction
      : undefined;
  const visibleConfirmation =
    removalConfirmation?.scopeId === activeScopeId && removalConfirmation.epoch === epoch.current
      ? removalConfirmation
      : null;
  const addActivity = useActivityLogStore((s) => s.addActivity);

  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      epoch.current++;
      operation.current = null;
      confirmation.current = null;
      setPositionAction(null);
      setRemovalConfirmation(null);
      setActionDialog(null);
    };
    // A store subscription sees each transition, including batched A → B → A.
    const unsubscribe = useWalletStore.subscribe((current, previous) => {
      if (current.mnemonic !== previous.mnemonic) invalidate();
    });
    return () => {
      mounted.current = false;
      epoch.current++;
      operation.current = null;
      confirmation.current = null;
      unsubscribe();
    };
  }, []);

  const isCurrentOperation = useCallback(
    (captured: PositionOperation) =>
      mounted.current &&
      operation.current?.token === captured.token &&
      captured.epoch === epoch.current &&
      captured.scopeId === activeBrowserWalletScopeId() &&
      isCurrentWallet(captured.walletId),
    [],
  );
  const beginOperation = useCallback(
    (kind: PositionOperation["kind"], positionId: string, walletId: string) => {
      const captured: PositionOperation = {
        token: Symbol(kind),
        epoch: epoch.current,
        scopeId: activeBrowserWalletScopeId(),
        walletId,
        positionId,
        kind,
      };
      operation.current = captured;
      confirmation.current = null;
      setRemovalConfirmation(null);
      setActionDialog(null);
      setPositionAction(captured);
      return captured;
    },
    [],
  );
  const finishOperation = useCallback(
    (captured: PositionOperation) => {
      if (!isCurrentOperation(captured)) return;
      operation.current = null;
      setPositionAction(null);
    },
    [isCurrentOperation],
  );
  const showActionMessage = useCallback((message: string) => {
    setActionDialog({ message, scopeId: activeBrowserWalletScopeId(), epoch: epoch.current });
  }, []);

  const removeFailureMessage = useCallback(
    (failure: BrowserPortfolioRemoveFailure) =>
      [
        t("portfolio.removeFailed"),
        t("portfolio.removeAttemptReference", {
          reference: `${failure.stage}: ${failure.attemptRef}`,
        }),
        ...(failure.claimFailure
          ? [
              t(CLAIM_FAILURE_TRANSLATION_KEYS[failure.claimFailure.category]),
              t("portfolio.claimAttemptReference", { reference: failure.claimFailure.attemptRef }),
              ...(failure.claimFailure.operationRef
                ? [
                    t("portfolio.claimOperationReference", {
                      reference: failure.claimFailure.operationRef,
                    }),
                  ]
                : []),
            ]
          : []),
      ].join("\n"),
    [t],
  );

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
      if (operation.current) return;
      const position = state.positions.find((p) => p.id === positionId);
      if (
        !position ||
        position.status !== "closed" ||
        (!position.isWinner && !position.claimRecoveryPending) ||
        position.canClaimPayout !== true
      ) {
        return;
      }
      const walletId = browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic);
      if (walletId === null || !isCurrentWallet(walletId)) return;

      const captured = beginOperation("claim", positionId, walletId);
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
              walletId,
              type: "payout_claimed",
              baseAsset: position.baseAsset,
              amountSubunits: payoutAmount,
              status: "completed",
              marketId: position.marketId,
              marketTitle: position.marketTitle,
            });
          },
        });
        if (!isCurrentOperation(captured)) return;
        const warning =
          result.oracleEvidence?.status === "unverified"
            ? t("portfolio.unverifiedOracleOutcome")
            : null;
        if (result.kind === "pending") {
          showActionMessage([t("portfolio.claimPending"), warning].filter(Boolean).join("\n"));
        }
        if (result.kind === "error") {
          showActionMessage(
            [
              t("portfolio.claimFailed"),
              t(CLAIM_FAILURE_TRANSLATION_KEYS[result.error.category]),
              t("portfolio.claimAttemptReference", { reference: result.error.attemptRef }),
              ...(warning === null ? [] : [warning]),
              ...(result.error.operationRef
                ? [t("portfolio.claimOperationReference", { reference: result.error.operationRef })]
                : []),
            ].join("\n"),
          );
        }
        if ((result.kind === "completed" || result.kind === "stopped") && warning !== null) {
          showActionMessage(warning);
        }
      } catch {
        if (isCurrentOperation(captured)) showActionMessage(t("portfolio.claimFailed"));
      } finally {
        finishOperation(captured);
      }
    },
    [
      addActivity,
      beginOperation,
      finishOperation,
      isCurrentOperation,
      state.positions,
      t,
      showActionMessage,
    ],
  );

  const handleDiscardLostPosition = useCallback(
    async (positionId: string, confirmed?: RemovalConfirmation) => {
      if (operation.current) return;
      const position = state.positions.find((p) => p.id === positionId);
      if (!position || !position.isLoser || position.isWinner || position.isPending) return;
      const walletId = browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic);
      if (walletId === null || !isCurrentWallet(walletId)) return;
      const conditionId = toPortfolioMarketDetailId(position.marketId, position.outcomeId);
      const outcomeCollection = position.outcomeLabel ?? position.outcomeId;
      if (!outcomeCollection) return;
      if (confirmed === undefined) {
        const request: RemovalConfirmation = {
          epoch: epoch.current,
          scopeId: activeBrowserWalletScopeId(),
          positionId,
          walletId,
          mintUrl: position.mintUrl,
          conditionId,
          outcomeCollection,
        };
        confirmation.current = request;
        setRemovalConfirmation(request);
        return;
      }
      if (
        confirmation.current !== confirmed ||
        confirmed.epoch !== epoch.current ||
        confirmed.walletId !== walletId ||
        confirmed.scopeId !== activeBrowserWalletScopeId() ||
        confirmed.positionId !== position.id ||
        confirmed.mintUrl !== position.mintUrl ||
        confirmed.conditionId !== conditionId ||
        confirmed.outcomeCollection !== outcomeCollection
      ) {
        confirmation.current = null;
        setRemovalConfirmation(null);
        return;
      }
      const captured = beginOperation("remove", positionId, walletId);
      try {
        // The catalogue label cannot authorize deletion. The coordinator verifies mint evidence.
        const result = await removePortfolioPosition({
          mintUrl: position.mintUrl,
          conditionId,
          outcomeCollection,
          onCommittedLeg: ({ payoutAmount }) => {
            addActivity({
              walletId,
              type: "payout_claimed",
              baseAsset: position.baseAsset,
              amountSubunits: payoutAmount,
              status: "completed",
              marketId: position.marketId,
              marketTitle: position.marketTitle,
            });
          },
        });
        if (!isCurrentOperation(captured)) return;
        const warning =
          result.oracleEvidence?.status === "unverified"
            ? t("portfolio.unverifiedOracleOutcome")
            : null;
        const showRemoveMessage = (message: string) =>
          showActionMessage([message, warning].filter(Boolean).join("\n"));
        switch (result.kind) {
          case "completed":
            if (warning !== null) showActionMessage(warning);
            break;
          case "pending":
            showRemoveMessage(t("portfolio.removePending"));
            break;
          case "stopped":
            showRemoveMessage(t("portfolio.removePayout"));
            break;
          case "partial":
            showRemoveMessage(
              result.error ? removeFailureMessage(result.error) : t("portfolio.removePending"),
            );
            break;
          case "error":
            showRemoveMessage(removeFailureMessage(result.error));
            break;
        }
      } catch {
        if (isCurrentOperation(captured)) showActionMessage(t("portfolio.removeFailed"));
      } finally {
        finishOperation(captured);
      }
    },
    [
      addActivity,
      beginOperation,
      finishOperation,
      isCurrentOperation,
      state.positions,
      t,
      removeFailureMessage,
      showActionMessage,
    ],
  );

  const handlePositionsTabChange = useCallback(
    (tab: "active" | "closed") => {
      state.setPositionsTab(tab);
    },
    [state],
  );

  const handleConnectNostr = useCallback(() => {
    navigate("/settings?category=nostr");
  }, [navigate]);

  const nostrConnectionStatus = useSettingsStore((s) => s.signerConnectionStatus);
  const nostrProfileFetchStatus = useSettingsStore((s) => s.nostrProfileFetchStatus);
  const showConnectNostrCta = nostrConnectionStatus === "disconnected";

  return (
    <>
      <Portfolio
        walletState={state.walletState}
        baseCurrency={state.baseCurrency}
        selectedTimeRange={state.selectedTimeRange}
        profile={state.profile}
        profileFetchStatus={
          nostrConnectionStatus === "connected" ? nostrProfileFetchStatus : undefined
        }
        plChartData={state.plChartData}
        stats={state.stats}
        positions={state.positions}
        funds={state.funds}
        activity={state.activity}
        createdMarkets={state.createdMarkets}
        positionsTab={state.positionsTab}
        monitoring={state.monitoring}
        onGetStarted={handleGetStarted}
        onTimeRangeChange={handleTimeRangeChange}
        onDeposit={handleDeposit}
        onWithdraw={handleWithdraw}
        onSellPosition={handleSellPosition}
        onViewPosition={handleViewPosition}
        onViewMarket={handleViewMarket}
        onClaimPayout={handleClaimPayout}
        onDiscardLostPosition={handleDiscardLostPosition}
        onPositionsTabChange={handlePositionsTabChange}
        positionAction={visibleAction}
        removalConfirmationPositionId={visibleConfirmation?.positionId}
        onConfirmDiscardLostPosition={(id) => {
          const selected = confirmation.current;
          if (selected?.positionId === id) void handleDiscardLostPosition(id, selected);
        }}
        onCancelDiscardLostPosition={() => {
          confirmation.current = null;
          setRemovalConfirmation(null);
        }}
        onDismissMonitoringError={state.dismissMonitoringError}
        onLoadMoreAssets={state.loadMoreAssets}
        onRetryLoadMoreAssets={state.loadMoreAssets}
        onDismissAssetPageError={state.dismissAssetPageError}
        showConnectNostrCta={showConnectNostrCta}
        nostrConnectionPending={nostrConnectionStatus === "connecting"}
        onConnectNostr={handleConnectNostr}
      />
      {visibleAction?.kind === "claim" && (
        <p role="status" className="mx-auto max-w-6xl px-4 py-2 text-sm text-slate-400">
          {t("portfolio.claimInProgress")}
        </p>
      )}
      {visibleDialog && (
        <NativeDialog
          ariaLabel={t("portfolio.positionActionTitle")}
          onDismiss={() => setActionDialog(null)}
        >
          {(dismiss) => (
            <section className="mx-auto mt-24 max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-6 text-neutral-100 shadow-xl">
              <h2 className="mb-4 text-lg font-semibold">{t("portfolio.positionActionTitle")}</h2>
              <p className="select-text whitespace-pre-wrap break-words text-sm">
                {visibleDialog.message}
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  className="rounded-lg border border-neutral-600 px-4 py-2 text-sm"
                  onClick={dismiss}
                >
                  {t("common.close")}
                </button>
              </div>
            </section>
          )}
        </NativeDialog>
      )}
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
