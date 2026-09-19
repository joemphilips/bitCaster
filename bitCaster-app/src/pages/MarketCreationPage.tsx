import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarketCreationWizard } from "@/components/market-creation";
import { WalletSetupModal } from "@/components/shared/WalletSetupModal";
import { useMarketCreationState } from "@/hooks/useMarketCreationState";
import { useWalletStore } from "@/stores/wallet";

export function MarketCreationPage() {
  const { t } = useTranslation();
  const state = useMarketCreationState();
  const walletMnemonic = useWalletStore((wallet) => wallet.mnemonic);
  const [showWalletSetup, setShowWalletSetup] = useState(false);
  const [walletSetupCreating, setWalletSetupCreating] = useState(false);
  const [walletSetupError, setWalletSetupError] = useState<string | null>(null);
  const hasWallet = walletMnemonic.trim().length > 0;

  const handleRequireWallet = useCallback(() => {
    setWalletSetupError(null);
    setShowWalletSetup(true);
  }, []);

  const handleCreateMarket = useCallback(() => {
    if (!hasWallet) {
      handleRequireWallet();
      return;
    }
    void state.onCreateMarket?.();
  }, [handleRequireWallet, hasWallet, state.onCreateMarket]);

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

  return (
    <>
      <MarketCreationWizard
        draft={state.draft}
        hasSavedDraft={state.hasSavedDraft}
        categoryTags={state.categoryTags}
        isSubmitting={state.isSubmitting}
        submitError={state.submitError}
        registrationFeePrompt={state.registrationFeePrompt}
        registrationFeeTopUp={state.registrationFeeTopUp}
        registrationFeeTopUpStage={state.registrationFeeTopUpStage}
        onClose={state.onClose}
        clearDraft={state.clearDraft}
        onNext={state.onNext}
        onBack={state.onBack}
        onOutcomeTypeSelect={state.onOutcomeTypeSelect}
        onTitleChange={state.onTitleChange}
        onCategoryTagsChange={state.onCategoryTagsChange}
        onClosingDateChange={state.onClosingDateChange}
        onThumbnailUpload={state.onThumbnailUpload}
        onAddOutcome={state.onAddOutcome}
        onRemoveOutcome={state.onRemoveOutcome}
        onOutcomeLabelChange={state.onOutcomeLabelChange}
        onLoBoundChange={state.onLoBoundChange}
        onHiBoundChange={state.onHiBoundChange}
        onPrecisionChange={state.onPrecisionChange}
        onUnitChange={state.onUnitChange}
        onDescriptionChange={state.onDescriptionChange}
        onCreateMarket={handleCreateMarket}
        onRequireWallet={handleRequireWallet}
        onConfirmRegistrationFee={state.onConfirmRegistrationFee}
        onCancelRegistrationFee={state.onCancelRegistrationFee}
        onStartRegistrationFeeTopUp={state.onStartRegistrationFeeTopUp}
        onCancelRegistrationFeeTopUp={state.onCancelRegistrationFeeTopUp}
        onRegistrationFeeTopUpSuccess={state.onRegistrationFeeTopUpSuccess}
        createdMarketConditionId={state.createdMarketConditionId}
        createdMarketOutcomeCount={state.createdMarketOutcomeCount}
        createdMarketBaseAsset={state.createdMarketBaseAsset}
        createdMarketDivisibility={state.createdMarketDivisibility}
      />
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
