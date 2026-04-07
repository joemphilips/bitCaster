import { MarketCreationWizard } from '@/components/market-creation'
import { useMarketCreationState } from '@/hooks/useMarketCreationState'

export function MarketCreationPage() {
  const state = useMarketCreationState()

  return (
    <MarketCreationWizard
      draft={state.draft}
      oracleAnnouncements={state.oracleAnnouncements}
      categoryTags={state.categoryTags}
      isNostrConfigured={state.isNostrConfigured}
      isSubmitting={state.isSubmitting}
      submitError={state.submitError}
      onOracleChoiceSelect={state.onOracleChoiceSelect}
      onAnnouncementSelect={state.onAnnouncementSelect}
      onExit={state.onExit}
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
    />
  )
}
