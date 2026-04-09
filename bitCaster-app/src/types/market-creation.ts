// =============================================================================
// Oracle Check Types (Step 1)
// =============================================================================

export type OracleCheckChoice = 'existing' | 'become-oracle'

export interface OracleAnnouncement {
  id: string
  eventId: string           // Nostr event hex id (kind 88)
  oraclePubkey: string
  description: string
  resolutionDate: string    // ISO 8601
  outcomes: string[]
}

export interface WizardStepOracleCheck {
  choice: OracleCheckChoice | null
  selectedAnnouncementId: string | null
}

// =============================================================================
// Get Started Types (Step 2)
// =============================================================================

export type OutcomeType = 'yesno' | 'categorical' | 'numeric'

export interface WizardStepGetStarted {
  outcomeType: OutcomeType | null
}

// =============================================================================
// Basic Info Types (Step 3)
// =============================================================================

export interface WizardStepBasicInfo {
  imageFile: string | null
  title: string
  categoryTags: string[]
  closingDate: string
}

// =============================================================================
// Outcomes Types (Step 4)
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
// Initial Liquidity Types (Step 5)
// =============================================================================

export interface WizardStepInitialLiquidity {
  liquiditySats: number
}

// =============================================================================
// Review & Create Types (Step 6)
// =============================================================================

export interface WizardStepReviewAndCreate {
  description: string
}

// =============================================================================
// Top-level Wizard Draft
// =============================================================================

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6

export interface WizardDraft {
  currentStep: WizardStep
  lastModified: string
  stepOracleCheck: WizardStepOracleCheck | null
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

  /** Available oracle announcements for step 1 */
  oracleAnnouncements: OracleAnnouncement[]

  /** Available category tags for basic info */
  categoryTags: string[]

  /**
   * Current Nostr signer mode from settings. Controls which oracle choices
   * are available in step 1:
   * - 'none' — no Nostr signer; cannot even browse announcements
   * - 'nip07' — can use existing announcements, cannot become oracle
   * - 'nsec' — full access, can become oracle
   */
  signerMode: import('./settings').NostrSignerMode

  /** Whether market creation is in progress */
  isSubmitting: boolean

  /** Error message from submission */
  submitError: string | null

  // -------------------------------------------------------------------------
  // Oracle Check Callbacks (Step 1)
  // -------------------------------------------------------------------------

  /** Called when user selects oracle check choice */
  onOracleChoiceSelect?: (choice: OracleCheckChoice) => void

  /** Called when user selects an oracle announcement */
  onAnnouncementSelect?: (announcementId: string) => void

  /** Called when user exits the wizard (e.g. "Go to Settings") */
  onExit?: () => void

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
  // Review Callbacks (Step 6)
  // -------------------------------------------------------------------------

  /** Called when user updates the description */
  onDescriptionChange?: (description: string) => void

  /** Called when user clicks Create Market */
  onCreateMarket?: () => void
}
