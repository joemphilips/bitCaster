import { MarketCreationWizard } from '@/components/market-creation'
import { useMarketCreationState } from '@/hooks/useMarketCreationState'

export function MarketCreationPage() {
  const state = useMarketCreationState()

  return (
    <MarketCreationWizard
      draft={state.draft}
      hasSavedDraft={state.hasSavedDraft}
      oracleAnnouncements={state.oracleAnnouncements}
      categoryTags={state.categoryTags}
      signerMode={state.signerMode}
      isSubmitting={state.isSubmitting}
      submitError={state.submitError}
      registrationFeePrompt={state.registrationFeePrompt}
      registrationFeeTopUp={state.registrationFeeTopUp}
      registrationFeeTopUpStage={state.registrationFeeTopUpStage}
      onOracleChoiceSelect={state.onOracleChoiceSelect}
      onAnnouncementSelect={state.onAnnouncementSelect}
      onExit={state.onExit}
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
      onOutcomeProbabilityChange={state.onOutcomeProbabilityChange}
      onNormalizeProbabilities={state.onNormalizeProbabilities}
      onLoBoundChange={state.onLoBoundChange}
      onHiBoundChange={state.onHiBoundChange}
      onPrecisionChange={state.onPrecisionChange}
      onUnitChange={state.onUnitChange}
      onLiquiditySatsChange={state.onLiquiditySatsChange}
      onDescriptionChange={state.onDescriptionChange}
      onCreateMarket={state.onCreateMarket}
      onConfirmRegistrationFee={state.onConfirmRegistrationFee}
      onCancelRegistrationFee={state.onCancelRegistrationFee}
      onStartRegistrationFeeTopUp={state.onStartRegistrationFeeTopUp}
      onCancelRegistrationFeeTopUp={state.onCancelRegistrationFeeTopUp}
      onRegistrationFeeTopUpSuccess={state.onRegistrationFeeTopUpSuccess}
      createdMarketConditionId={state.createdMarketConditionId}
      createdMarketLiquiditySats={state.createdMarketLiquiditySats}
    />
  )
}
