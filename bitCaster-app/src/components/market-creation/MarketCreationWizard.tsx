import { useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MarketCreationWizardProps } from '@/types/market-creation'
import { StepIndicator } from './StepIndicator'
import { OracleCheck } from './OracleCheck'
import { GetStarted } from './GetStarted'
import { BasicInfo } from './BasicInfo'
import { OutcomesStep } from './OutcomesStep'
import { InitialLiquidity } from './InitialLiquidity'
import { ReviewAndCreate } from './ReviewAndCreate'
import { ResumeBanner } from './ResumeBanner'
import { DepositStep } from './DepositStep'

export function MarketCreationWizard(props: MarketCreationWizardProps) {
  const { t } = useTranslation()
  const {
    draft,
    hasSavedDraft,
    oracleAnnouncements,
    categoryTags,
    signerMode,
    isSubmitting,
    submitError,
    onOracleChoiceSelect,
    onAnnouncementSelect,
    onExit,
    onClose,
    clearDraft,
    onNext,
    onBack,
    onOutcomeTypeSelect,
    onTitleChange,
    onCategoryTagsChange,
    onClosingDateChange,
    onThumbnailUpload,
    onAddOutcome,
    onRemoveOutcome,
    onOutcomeLabelChange,
    onOutcomeProbabilityChange,
    onNormalizeProbabilities,
    onLoBoundChange,
    onHiBoundChange,
    onPrecisionChange,
    onUnitChange,
    onLiquiditySatsChange,
    onDescriptionChange,
    onCreateMarket,
    createdMarketConditionId,
    createdMarketLiquiditySats,
  } = props

  const { currentStep } = draft

  const [bannerDismissed, setBannerDismissed] = useState(false)
  const showResumeBanner = hasSavedDraft && !bannerDismissed

  const handleStartOver = () => {
    clearDraft()
    setBannerDismissed(true)
  }

  const header = (
    <>
      <button
        onClick={onClose}
        aria-label={t('marketCreation.closeMarketCreation')}
        className="fixed top-4 right-4 z-20 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 backdrop-blur-sm transition-colors"
      >
        <X className="w-5 h-5" strokeWidth={1.75} />
      </button>
      {showResumeBanner && (
        <ResumeBanner
          lastModified={draft.lastModified}
          onDismiss={() => setBannerDismissed(true)}
          onStartOver={handleStartOver}
        />
      )}
    </>
  )

  // Deposit step takes priority once the market is created. `clearDraft()`
  // in `onCreateMarket` resets the draft store (currentStep becomes 1)
  // before `setCreatedMarketConditionId` re-renders us, which without this
  // override would bounce the user back to OracleCheck even though the
  // market is already registered on the mint and engine. The matching test
  // is `MarketCreateWithDepositE2ETests.DepositStep_LightningHappyPath`.
  if (createdMarketConditionId) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
        {header}
        <div className="flex-1 flex items-start justify-center px-4 py-8">
          <DepositStep
            conditionId={createdMarketConditionId}
            defaultAmountSats={createdMarketLiquiditySats ?? 0}
          />
        </div>
      </div>
    )
  }

  // Step 1: Oracle Check — full-screen standalone
  if (currentStep === 1) {
    return (
      <>
        {header}
        <OracleCheck
          choice={draft.stepOracleCheck?.choice ?? null}
          selectedAnnouncementId={draft.stepOracleCheck?.selectedAnnouncementId ?? null}
          announcements={oracleAnnouncements}
          signerMode={signerMode}
          onChoiceSelect={onOracleChoiceSelect}
          onAnnouncementSelect={onAnnouncementSelect}
          onContinue={onNext}
          onExit={onExit}
        />
      </>
    )
  }

  // Steps 2-6: Wizard with step indicator
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {header}
      <div className="w-full max-w-2xl mx-auto px-4 pt-8 pb-4">
        <div className="h-10 mb-4">
          {currentStep > 2 && (
            <button
              onClick={() => onBack?.()}
              className="flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
              {t('common.back')}
            </button>
          )}
        </div>

        <StepIndicator currentStep={currentStep} />
      </div>

      <div className="flex-1 flex items-start justify-center px-4 py-8">
        {currentStep === 2 && (
          <GetStarted
            outcomeType={draft.stepGetStarted?.outcomeType ?? null}
            onOutcomeTypeSelect={onOutcomeTypeSelect}
            onNext={onNext}
          />
        )}

        {currentStep === 3 && draft.stepBasicInfo && (
          <BasicInfo
            data={draft.stepBasicInfo}
            categoryTags={categoryTags}
            onTitleChange={onTitleChange}
            onCategoryTagsChange={onCategoryTagsChange}
            onClosingDateChange={onClosingDateChange}
            onThumbnailUpload={onThumbnailUpload}
            onNext={onNext}
          />
        )}

        {currentStep === 4 && draft.stepOutcomes && (
          <OutcomesStep
            outcomeType={draft.stepOutcomes.outcomeType}
            outcomes={draft.stepOutcomes.outcomes}
            loBound={draft.stepOutcomes.loBound}
            hiBound={draft.stepOutcomes.hiBound}
            precision={draft.stepOutcomes.precision}
            unit={draft.stepOutcomes.unit}
            onAddOutcome={onAddOutcome}
            onRemoveOutcome={onRemoveOutcome}
            onOutcomeLabelChange={onOutcomeLabelChange}
            onOutcomeProbabilityChange={onOutcomeProbabilityChange}
            onNormalizeProbabilities={onNormalizeProbabilities}
            onLoBoundChange={onLoBoundChange}
            onHiBoundChange={onHiBoundChange}
            onPrecisionChange={onPrecisionChange}
            onUnitChange={onUnitChange}
            onNext={onNext}
          />
        )}

        {currentStep === 5 && draft.stepInitialLiquidity && (
          <InitialLiquidity
            liquiditySats={draft.stepInitialLiquidity.liquiditySats}
            onLiquiditySatsChange={onLiquiditySatsChange}
            onNext={onNext}
          />
        )}

        {currentStep === 6 && !createdMarketConditionId && (
          <ReviewAndCreate
            description={draft.stepReviewAndCreate?.description ?? ''}
            basicInfo={draft.stepBasicInfo}
            outcomes={draft.stepOutcomes}
            liquidity={draft.stepInitialLiquidity}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onDescriptionChange={onDescriptionChange}
            onCreateMarket={onCreateMarket}
          />
        )}

      </div>
    </div>
  )
}
