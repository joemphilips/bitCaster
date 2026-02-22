// =============================================================================
// Dashboard Stats Types
// =============================================================================

export interface DashboardStats {
  activeMarketsCount: number
  resolvedMarketsCount: number
  pendingMarketsCount: number
  rejectedMarketsCount: number
  cancelledMarketsCount: number
  totalVolumeSats: number
  totalFeesEarnedSats: number
  totalFeesClaimedSats: number
  totalFeesUnclaimedSats: number
}

// =============================================================================
// Market Outcome Types
// =============================================================================

export interface MarketOutcome {
  id: string
  label: string
  odds: number
  description?: string
  imageUrl?: string
  isWinner?: boolean // Set when market is resolved
}

export interface CurrentOdds {
  yes: number
  no: number
}

// =============================================================================
// Creator Market Types
// =============================================================================

export type MarketStatus = 'pending' | 'approved' | 'rejected' | 'resolved' | 'cancelled'
export type MarketType = 'yesno' | 'categorical'

interface BaseCreatorMarket {
  id: string
  title: string
  description: string
  imageUrl: string
  categoryTags: string[]
  status: MarketStatus
  volume: number
  liquidity: number
  traderCount: number
  createdDate: string
  closingDate: string
  creatorFeePercent: number
  feesEarnedSats: number
  feesClaimedSats: number
  answerUrls: string[]
  // Optional status-specific dates
  approvedDate?: string
  rejectedDate?: string
  rejectionReason?: string
  resolvedDate?: string
  winningOutcomeId?: string
  cancelledDate?: string
  cancellationReason?: string
  refundedSats?: number
}

export interface YesNoCreatorMarket extends BaseCreatorMarket {
  type: 'yesno'
  currentOdds: CurrentOdds
}

export interface CategoricalCreatorMarket extends BaseCreatorMarket {
  type: 'categorical'
  outcomes: MarketOutcome[]
}

export type CreatorMarket = YesNoCreatorMarket | CategoricalCreatorMarket

// =============================================================================
// Volume Chart Types
// =============================================================================

export interface DailyVolumeDataPoint {
  date: string
  volumeSats: number
  feesSats: number
}

export interface WeeklyVolumeDataPoint {
  weekStart: string
  volumeSats: number
  feesSats: number
}

export interface MonthlyVolumeDataPoint {
  month: string
  volumeSats: number
  feesSats: number
}

export interface VolumeChartData {
  daily: DailyVolumeDataPoint[]
  weekly: WeeklyVolumeDataPoint[]
  monthly: MonthlyVolumeDataPoint[]
}

export interface MarketVolumeData {
  marketId: string
  marketTitle: string
  daily: { date: string; volumeSats: number }[]
}

export type TimeScale = 'daily' | 'weekly' | 'monthly'
export type ChartMode = 'aggregate' | 'per-market'

// =============================================================================
// Wizard Types
// =============================================================================

export type OutcomeType = 'yesno' | 'categorical' | 'numeric'

export interface WizardOutcome {
  id: string
  label: string
  description: string
  imageUrl?: string
  probability?: number // 0-100, optional, for preview only
}

export interface WizardStep1Data {
  imageFile: string | null
  title: string
  categoryTags: string[]
  closingDate: string
  answerUrls: string[]
}

export interface WizardStep2Data {
  outcomeType: OutcomeType
  outcomes: WizardOutcome[] | null // null for yesno, array for categorical/numeric
}

export interface WizardStep3Data {
  liquiditySats: number
  buyFeePercent: number
  sellFeePercent: number
  winFeePercent: number
}

export interface WizardStep4Data {
  // Review step - computed from previous steps
  estimatedInitialCost: number
  worstCaseLoss: number
  confirmed: boolean
}

export interface WizardStep5Data {
  description: string // Rich text (HTML or markdown)
  aiGenerated: boolean
}

export interface WizardDraft {
  currentStep: 1 | 2 | 3 | 4 | 5
  lastModified: string
  step1: WizardStep1Data | null
  step2: WizardStep2Data | null
  step3: WizardStep3Data | null
  step4: WizardStep4Data | null
  step5: WizardStep5Data | null
}

// =============================================================================
// Category Tag Types
// =============================================================================

export interface CategoryTag {
  id: string
  label: string
}

// =============================================================================
// Pagination Types
// =============================================================================

export interface PaginationState {
  currentPage: number
  pageSize: number
  totalItems: number
  totalPages: number
}

// =============================================================================
// Tab Types
// =============================================================================

export type ActiveTab = 'overview' | 'analytics'

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationError {
  field: string
  message: string
}

// =============================================================================
// Component Props
// =============================================================================

export interface MarketCreationProps {
  /** Dashboard statistics for the creator */
  dashboardStats: DashboardStats

  /** List of markets created by the user */
  creatorMarkets: CreatorMarket[]

  /** Aggregated volume chart data across all markets */
  volumeChartData: VolumeChartData

  /** Per-market volume data for detailed analytics */
  volumeByMarket: MarketVolumeData[]

  /** Current wizard draft state (null if no draft) */
  wizardDraft: WizardDraft | null

  /** Available category tags for market creation */
  categoryTags: CategoryTag[]

  /** Pagination state for market list */
  pagination: PaginationState

  /** Currently active tab */
  activeTab: ActiveTab

  /** Current time scale for analytics charts */
  analyticsTimeScale: TimeScale

  /** Current chart mode (aggregate vs per-market) */
  analyticsChartMode: ChartMode

  /** Validation errors from last submission attempt */
  validationErrors?: ValidationError[]

  // -------------------------------------------------------------------------
  // Navigation Callbacks
  // -------------------------------------------------------------------------

  /** Called when user clicks to view market details (navigates to market detail page) */
  onViewDetails?: (marketId: string) => void

  /** Called when user switches between Overview and Analytics tabs */
  onTabChange?: (tab: ActiveTab) => void

  // -------------------------------------------------------------------------
  // Market Management Callbacks
  // -------------------------------------------------------------------------

  /** Called when user submits a new market (triggers MarketCreated event) */
  onCreateMarket?: (wizardData: WizardDraft) => void

  /** Called when user cancels a pending or active market (triggers MarketCancelled event) */
  onCancelMarket?: (marketId: string) => void

  /** Called when user claims fees from a resolved market (triggers CreatorFeeClaimed event) */
  onClaimFees?: (marketId: string) => void

  // -------------------------------------------------------------------------
  // Wizard Callbacks
  // -------------------------------------------------------------------------

  /** Called when user saves wizard draft progress */
  onSaveDraft?: (draft: WizardDraft) => void

  /** Called when user discards the current wizard draft */
  onDiscardDraft?: () => void

  /** Called when wizard step changes */
  onWizardStepChange?: (step: 1 | 2 | 3 | 4 | 5) => void

  /** Called when user uploads a market thumbnail */
  onThumbnailUpload?: (file: File) => void

  /** Called when user uploads an outcome thumbnail */
  onOutcomeThumbnailUpload?: (outcomeId: string, file: File) => void

  /** Called when user requests AI-generated description */
  onGenerateDescription?: (context: {
    title: string
    categoryTags: string[]
    outcomeType: OutcomeType
  }) => void

  // -------------------------------------------------------------------------
  // Analytics Callbacks
  // -------------------------------------------------------------------------

  /** Called when user changes the time scale for volume charts */
  onTimeScaleChange?: (scale: TimeScale) => void

  /** Called when user toggles between aggregate and per-market view */
  onChartModeChange?: (mode: ChartMode) => void

  /** Called when user selects a specific market in per-market view */
  onSelectMarketForChart?: (marketId: string) => void

  // -------------------------------------------------------------------------
  // Pagination Callbacks
  // -------------------------------------------------------------------------

  /** Called when user navigates to a different page */
  onPageChange?: (page: number) => void

  /** Called when user changes page size */
  onPageSizeChange?: (pageSize: number) => void
}
