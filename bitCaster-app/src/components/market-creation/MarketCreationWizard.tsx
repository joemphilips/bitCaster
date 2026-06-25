import { useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, X } from 'lucide-react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import type { MarketCreationWizardProps } from '@/types/market-creation'
import { createGeneratedNostrIdentity } from '@/lib/identityOps'
import { useSettingsStore } from '@/stores/settings'
import { StepIndicator } from './StepIndicator'
import { GetStarted } from './GetStarted'
import { BasicInfo } from './BasicInfo'
import { OutcomesStep } from './OutcomesStep'
import { ReviewAndCreate } from './ReviewAndCreate'
import { ResumeBanner } from './ResumeBanner'
import { DepositStep } from './DepositStep'
import { RegistrationFeeConfirmationModal } from './RegistrationFeeConfirmationModal'
import { InsufficientBalanceModal } from '@/components/shared/InsufficientBalanceModal'
import { TopUpOverlay } from '@/components/market-detail/TopUpOverlay'
import { formatMarketSubunits } from '@bitcaster/client-sdk/marketUnits'

export function MarketCreationWizard(props: MarketCreationWizardProps) {
  const { t } = useTranslation()
  const hasNsecOracleKey = useSettingsStore(
    (s) => s.nostrSignerMode === 'nsec' && !!s.nsecSecret,
  )
  const {
    draft,
    hasSavedDraft,
    categoryTags,
    isSubmitting,
    submitError,
    registrationFeePrompt,
    registrationFeeTopUp,
    registrationFeeTopUpStage,
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
    onBaseAssetChange,
    onDescriptionChange,
    onCreateMarket,
    onConfirmRegistrationFee,
    onCancelRegistrationFee,
    onStartRegistrationFeeTopUp,
    onCancelRegistrationFeeTopUp,
    onRegistrationFeeTopUpSuccess,
    createdMarketConditionId,
    createdMarketOutcomeCount,
    createdMarketBaseAsset,
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
  const registrationFeeDeficit = registrationFeeTopUp
    ? Math.max(registrationFeeTopUp.feeSubunits - registrationFeeTopUp.balanceSubunits, 0)
    : 0
  const formatRegistrationFeeAmount = registrationFeeTopUp
    ? (amount: number) => formatMarketSubunits(amount, registrationFeeTopUp.baseAsset)
    : undefined
  const feeOverlays = (
    <>
      {registrationFeePrompt && (
        <RegistrationFeeConfirmationModal
          feeSubunits={registrationFeePrompt.feeSubunits}
          balanceSubunits={registrationFeePrompt.balanceSubunits}
          baseAsset={registrationFeePrompt.baseAsset}
          onCancel={onCancelRegistrationFee}
          onConfirm={onConfirmRegistrationFee}
        />
      )}
      {registrationFeeTopUpStage === 'modal' && registrationFeeTopUp && (
        <InsufficientBalanceModal
          balance={registrationFeeTopUp.balanceSubunits}
          required={registrationFeeTopUp.feeSubunits}
          title={t('marketCreation.registrationFeeTopUpTitle')}
          requiredDescription={t('marketCreation.registrationFeeTopUpRequiredDescription')}
          formatAmount={formatRegistrationFeeAmount}
          onCancel={onCancelRegistrationFeeTopUp}
          onTopUp={onStartRegistrationFeeTopUp}
        />
      )}
      {registrationFeeTopUpStage === 'overlay' && registrationFeeTopUp && (
        <TopUpOverlay
          deficit={registrationFeeDeficit}
          baseAsset={registrationFeeTopUp.baseAsset}
          minimumDescription={t('marketCreation.registrationFeeTopUpMinimumDescription', {
            amount: formatMarketSubunits(registrationFeeDeficit, registrationFeeTopUp.baseAsset),
          })}
          minimumErrorDescription={t('marketCreation.registrationFeeTopUpMinimumError', {
            amount: formatMarketSubunits(registrationFeeDeficit, registrationFeeTopUp.baseAsset),
          })}
          onSuccess={onRegistrationFeeTopUpSuccess}
          onCancel={onCancelRegistrationFeeTopUp}
        />
      )}
    </>
  )

  // Deposit step takes priority once the market is created. `clearDraft()`
  // in `onCreateMarket` resets the draft store (currentStep becomes 1)
  // before `setCreatedMarketConditionId` re-renders us, which without this
  // override would bounce the user back to the first wizard step even though
  // the market is already registered on the mint and engine. The matching test
  // is `MarketCreateWithDepositE2ETests.DepositStep_LightningHappyPath`.
  if (createdMarketConditionId) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
        {header}
        <div className="flex-1 flex items-start justify-center px-4 py-8">
          <DepositStep
            conditionId={createdMarketConditionId}
            defaultAmountSats={0}
            outcomeCount={createdMarketOutcomeCount ?? 2}
            baseAsset={createdMarketBaseAsset ?? 'sat'}
          />
        </div>
        {feeOverlays}
      </div>
    )
  }

  if (!hasNsecOracleKey) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
        {header}
        <div className="flex-1 flex items-start justify-center px-4 py-8">
          <NostrKeyRequired />
        </div>
        {feeOverlays}
      </div>
    )
  }

  // Steps 1-5: Wizard with step indicator. The old oracle-announcement
  // chooser is intentionally gone: creator markets always use the creator's
  // own nsec-backed oracle identity.
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {header}
      <div className="w-full max-w-2xl mx-auto px-4 pt-8 pb-4">
        <div className="h-10 mb-4">
          {currentStep > 1 && (
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
        {currentStep === 1 && (
          <GetStarted
            outcomeType={draft.stepGetStarted?.outcomeType ?? null}
            onOutcomeTypeSelect={onOutcomeTypeSelect}
            onNext={onNext}
          />
        )}

        {currentStep === 2 && draft.stepBasicInfo && (
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

        {currentStep === 3 && draft.stepOutcomes && (
          <OutcomesStep
            outcomeType={draft.stepOutcomes.outcomeType}
            outcomes={draft.stepOutcomes.outcomes}
            loBound={draft.stepOutcomes.loBound}
            hiBound={draft.stepOutcomes.hiBound}
            precision={draft.stepOutcomes.precision}
            unit={draft.stepOutcomes.unit}
            baseAsset={draft.stepOutcomes.baseAsset}
            onAddOutcome={onAddOutcome}
            onRemoveOutcome={onRemoveOutcome}
            onOutcomeLabelChange={onOutcomeLabelChange}
            onOutcomeProbabilityChange={onOutcomeProbabilityChange}
            onNormalizeProbabilities={onNormalizeProbabilities}
            onLoBoundChange={onLoBoundChange}
            onHiBoundChange={onHiBoundChange}
            onPrecisionChange={onPrecisionChange}
            onUnitChange={onUnitChange}
            onBaseAssetChange={onBaseAssetChange}
            onNext={onNext}
          />
        )}

        {currentStep === 4 && !createdMarketConditionId && (
          <ReviewAndCreate
            description={draft.stepReviewAndCreate?.description ?? ''}
            basicInfo={draft.stepBasicInfo}
            outcomes={draft.stepOutcomes}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onDescriptionChange={onDescriptionChange}
            onCreateMarket={onCreateMarket}
          />
        )}

      </div>
      {feeOverlays}
    </div>
  )
}

function NostrKeyRequired() {
  const { t } = useTranslation()
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (isCreating) return
    setIsCreating(true)
    setError(null)
    const result = await createGeneratedNostrIdentity()
    if (!result.ok) {
      setError(result.error ?? t('marketCreation.nostrKeyCreateFailed'))
    }
    setIsCreating(false)
  }

  return (
    <div className="w-full max-w-xl">
      <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 text-blue-400">
        <KeyRound className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t('marketCreation.mustRegisterNostrKey')}
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        {t('marketCreation.nsecRequired')}
      </p>
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 mb-6">
        <p className="text-sm text-blue-100">
          {t('marketCreation.preferExistingNostrKey')}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Link
          to="/settings?category=nostr"
          className="w-full rounded-full bg-blue-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-colors hover:bg-blue-700"
        >
          {t('marketCreation.registerOwnNostrKey')}
        </Link>
        <button
          type="button"
          onClick={handleCreate}
          disabled={isCreating}
          className="w-full rounded-full border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
        >
          {isCreating ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('marketCreation.creatingNostrKey')}
            </span>
          ) : (
            t('marketCreation.createNostrKey')
          )}
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
    </div>
  )
}
