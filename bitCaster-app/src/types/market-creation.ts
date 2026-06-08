// =============================================================================
// Get Started Types (Step 1)
// =============================================================================

export type OutcomeType = 'yesno' | 'categorical' | 'numeric'

export interface WizardStepGetStarted {
  outcomeType: OutcomeType | null
}

// =============================================================================
// Basic Info Types (Step 2)
// =============================================================================

export interface WizardStepBasicInfo {
  imageFile: string | null
  title: string
  categoryTags: string[]
  closingDate: string
}

// =============================================================================
// Outcomes Types (Step 3)
// =============================================================================

export interface WizardOutcome {
  id: string
  label: string
  description: string
  imageUrl?: string
  probability?: number // 0-100
}

export interface WizardStepOutcomes {
  outcomeType: OutcomeType
  outcomes: WizardOutcome[] | null  // null for numeric
  loBound?: number
  hiBound?: number
  precision?: number
  unit?: string
}

// =============================================================================
// Initial Liquidity Types (Step 4)
// =============================================================================

export interface WizardStepInitialLiquidity {
  liquiditySats: number
}

// =============================================================================
// Review & Create Types (Step 5)
// =============================================================================

export interface WizardStepReviewAndCreate {
  description: string
}

// =============================================================================
// Top-level Wizard Draft
// =============================================================================

export type WizardStep = 1 | 2 | 3 | 4 | 5

export interface WizardDraft {
  currentStep: WizardStep
  lastModified: string
  stepGetStarted: WizardStepGetStarted | null
  stepBasicInfo: WizardStepBasicInfo | null
  stepOutcomes: WizardStepOutcomes | null
  stepInitialLiquidity: WizardStepInitialLiquidity | null
  stepReviewAndCreate: WizardStepReviewAndCreate | null
}

// =============================================================================
// Component Props
// =============================================================================

export interface MarketCreationWizardProps {
  /** Current wizard draft state */
  draft: WizardDraft

  /** Available category tags for basic info */
  categoryTags: string[]

  /** Whether market creation is in progress */
  isSubmitting: boolean

  /** Error message from submission */
  submitError: string | null

  registrationFeePrompt: { feeSats: number; balanceSats: number } | null
  registrationFeeTopUp: { feeSats: number; balanceSats: number } | null
  registrationFeeTopUpStage: 'closed' | 'modal' | 'overlay'

  /**
   * Set after `createMarket` succeeds — the wizard renders the DepositStep
   * when this is non-null. The user funds the market's CPMM bot then
   * navigates to the market detail page from there. Held in component
   * state (not the localStorage draft) so reload doesn't replay
   * registration against a market that already exists.
   */
  createdMarketConditionId: string | null

  /**
   * Snapshot of `draft.stepInitialLiquidity.liquiditySats` at the moment
   * `createMarket` succeeded. Read by the deposit step as the default
   * `amountSats` so the user does not have to retype the value they picked
   * in step 5. Held separately because `clearDraft` (called on the same
   * tick) wipes the draft before DepositStep mounts.
   */
  createdMarketLiquiditySats: number | null

  /** True when the wizard is being re-entered with a previously-saved draft. */
  hasSavedDraft: boolean

  /** Close the wizard without discarding the draft. */
  onClose: () => void

  /** Discard the in-progress draft and reset the wizard to step 1. */
  clearDraft: () => void

  // -------------------------------------------------------------------------
  // Navigation Callbacks
  // -------------------------------------------------------------------------

  /** Called when user advances to next step */
  onNext?: () => void

  /** Called when user goes back to previous step */
  onBack?: () => void

  /** Called when user changes outcome type in Get Started */
  onOutcomeTypeSelect?: (type: OutcomeType) => void

  // -------------------------------------------------------------------------
  // Basic Info Callbacks (Step 3)
  // -------------------------------------------------------------------------

  /** Called when user updates title */
  onTitleChange?: (title: string) => void

  /** Called when user updates category tags */
  onCategoryTagsChange?: (tags: string[]) => void

  /** Called when user updates closing date */
  onClosingDateChange?: (date: string) => void

  /** Called when user uploads a thumbnail */
  onThumbnailUpload?: (file: File) => void

  // -------------------------------------------------------------------------
  // Outcomes Callbacks (Step 4)
  // -------------------------------------------------------------------------

  /** Called when user adds an outcome */
  onAddOutcome?: () => void

  /** Called when user removes an outcome */
  onRemoveOutcome?: (outcomeId: string) => void

  /** Called when user updates an outcome label */
  onOutcomeLabelChange?: (outcomeId: string, label: string) => void

  /** Called when user updates an outcome probability */
  onOutcomeProbabilityChange?: (outcomeId: string, probability: number) => void

  /** Called when user normalizes probabilities to sum to 100 */
  onNormalizeProbabilities?: () => void

  /** Called when user updates numeric low bound */
  onLoBoundChange?: (value: number) => void

  /** Called when user updates numeric high bound */
  onHiBoundChange?: (value: number) => void

  /** Called when user updates numeric precision */
  onPrecisionChange?: (value: number) => void

  /** Called when user updates numeric unit */
  onUnitChange?: (value: string) => void

  // -------------------------------------------------------------------------
  // Initial Liquidity Callbacks (Step 5)
  // -------------------------------------------------------------------------

  /** Called when user updates liquidity amount */
  onLiquiditySatsChange?: (sats: number) => void

  // -------------------------------------------------------------------------
  // Review Callbacks (Step 5)
  // -------------------------------------------------------------------------

  /** Called when user updates the description */
  onDescriptionChange?: (description: string) => void

  /** Called when user clicks Create Market */
  onCreateMarket?: () => void

  onConfirmRegistrationFee: () => void
  onCancelRegistrationFee: () => void
  onStartRegistrationFeeTopUp: () => void
  onCancelRegistrationFeeTopUp: () => void
  onRegistrationFeeTopUpSuccess: () => void
}
