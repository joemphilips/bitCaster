// =============================================================================
// Wallet & Currency Types
// =============================================================================

export type WalletState = 'none' | 'ready'
export type BaseCurrency = 'BTC' | 'USD' | 'JPY'

// =============================================================================
// P/L Chart Types
// =============================================================================

export type PLTimeSelector = '1D' | '1W' | '1M' | 'ALL'

export interface PLChartDataPoint {
  timestamp: string
  cumulativePL: number
}

export interface PLChartData {
  '1D': PLChartDataPoint[]
  '1W': PLChartDataPoint[]
  '1M': PLChartDataPoint[]
  'ALL': PLChartDataPoint[]
}

// =============================================================================
// User Profile Types
// =============================================================================

export interface UserProfile {
  userId: string
  displayName: string
  avatarUrl: string | null
  registeredDate: string
  viewCount: number
}

// =============================================================================
// Portfolio Stats Types
// =============================================================================

export interface PortfolioStats {
  positionsValueSats: number
  biggestWinSats: number
  predictionsCount: number
}

// =============================================================================
// Position Types
// =============================================================================

export type PositionStatus = 'active' | 'closed'
export type PositionSide = 'yes' | 'no'

export interface Position {
  id: string
  marketId: string
  marketTitle: string
  marketImageUrl: string
  side: PositionSide
  outcomeId?: string
  outcomeLabel?: string
  shares: number
  avgBuyPrice: number
  currentPrice: number
  currentValueSats: number
  profitLossSats: number
  profitLossPercent: number
  status: PositionStatus
  closedDate?: string
  acquiredDate: string
}

// =============================================================================
// Activity Types (replaces OrderHistoryItem)
// =============================================================================

export type ActivityType = 'deposit' | 'withdrawal' | 'buy' | 'sell' | 'payout_claimed' | 'creator_fee_claimed'
export type ActivityStatus = 'pending' | 'completed' | 'failed'

export interface ActivityItem {
  id: string
  type: ActivityType
  amountSats: number
  date: string
  status: ActivityStatus
  txId: string | null
  lightningInvoice: string | null
  failureReason?: string
  marketId?: string
  marketTitle?: string
  positionId?: string
}

// =============================================================================
// Created Market Types
// =============================================================================

export type CreatedMarketStatus = 'pending' | 'approved' | 'rejected' | 'resolved' | 'cancelled'

export interface CreatedMarket {
  id: string
  title: string
  imageUrl: string
  status: CreatedMarketStatus
  createdDate: string
  approvedDate?: string
  rejectedDate?: string
  rejectionReason?: string
  resolvedDate?: string
  cancelledDate?: string
  volume: number
  creatorFeesEarned: number
  creatorFeePercent: number
}

// =============================================================================
// Component Props
// =============================================================================

export interface PortfolioProps {
  /** Wallet state — determines whether to show portfolio or onboarding CTA */
  walletState: WalletState

  /** User's preferred base currency for display */
  baseCurrency: BaseCurrency

  /** Currently selected P/L time range */
  selectedTimeRange: PLTimeSelector

  /** User profile information */
  profile: UserProfile

  /** P/L chart data for each time range */
  plChartData: PLChartData

  /** Portfolio statistics */
  stats: PortfolioStats

  /** User's positions in markets */
  positions: Position[]

  /** Activity feed (deposits, withdrawals, trades, payouts, fees) */
  activity: ActivityItem[]

  /** Markets created by the user */
  createdMarkets: CreatedMarket[]

  /** Currently selected positions sub-tab */
  positionsTab: 'active' | 'closed'

  /** Called when user clicks "Get Started" (no-wallet state) → navigates to wallet-setup */
  onGetStarted?: () => void

  /** Called when user uploads a new avatar image */
  onAvatarUpload?: (file: File) => void

  /** Called when user selects a P/L time range */
  onTimeRangeChange?: (range: PLTimeSelector) => void

  /** Called when user clicks Deposit */
  onDeposit?: () => void

  /** Called when user clicks Withdraw */
  onWithdraw?: () => void

  /** Called when user clicks Sell on a position */
  onSellPosition?: (positionId: string) => void

  /** Called when user clicks to view position details */
  onViewPosition?: (positionId: string) => void

  /** Called when user clicks to view a market they created */
  onViewMarket?: (marketId: string) => void

  /** Called when user clicks to view activity item details */
  onViewActivity?: (activityId: string) => void

  /** Called when user switches positions sub-tab */
  onPositionsTabChange?: (tab: 'active' | 'closed') => void

  /** Called when user clicks to claim creator fees from a resolved market */
  onClaimCreatorFees?: (marketId: string) => void

  /** Called when user claims payout from a winning position */
  onClaimPayout?: (positionId: string) => void

  /** Called when user opens Settings */
  onOpenSettings?: () => void
}
