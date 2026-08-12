// =============================================================================
// Wallet & Currency Types
// =============================================================================

export type WalletState = "none" | "ready";
export type BaseCurrency = "BTC" | "USD" | "JPY";

// =============================================================================
// P/L Chart Types
// =============================================================================

export type PLTimeSelector = "1D" | "1W" | "1M" | "ALL";

export interface PLChartDataPoint {
  timestamp: string;
  cumulativePL: number;
}

export interface PLChartData {
  "1D": PLChartDataPoint[];
  "1W": PLChartDataPoint[];
  "1M": PLChartDataPoint[];
  ALL: PLChartDataPoint[];
}

// =============================================================================
// User Profile Types
// =============================================================================

export interface UserProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  registeredDate: string;
}

// =============================================================================
// Portfolio Stats Types
// =============================================================================

export interface PortfolioStats {
  positionsValueSats: number;
  totalValueSats: number;
  positionsValueKnown?: boolean;
  totalValueKnown?: boolean;
  positionsValueByUnit?: Array<{ unit: "sat"; amount: number }>;
  totalValueByUnit?: Array<{ unit: "sat"; amount: number }>;
  biggestWinSats: number;
  predictionsCount: number;
}

export interface PortfolioMonitoringState {
  stale: boolean;
  incomplete: boolean;
  building: boolean;
  unvaluedAssetCount: number;
  hasPendingOutgoing: boolean;
  pendingOutgoingValueMsat: number | null;
  error: "unavailable" | null;
  assetPageError: "unavailable" | null;
  hasMoreAssets: boolean;
  loadingMoreAssets: boolean;
}

// =============================================================================
// Position Types
// =============================================================================

export type PositionStatus = "active" | "closed";
export type PositionSide = "yes" | "no" | "Outcome";

export interface Position {
  id: string;
  marketId: string;
  marketTitle: string;
  marketImageUrl: string;
  side: PositionSide;
  outcomeId?: string;
  outcomeLabel?: string;
  canClaimPayout?: boolean;
  canDiscard?: boolean;
  /** False for server monitoring rows. Local proofs authorize all wallet actions. */
  canSell?: boolean;
  /** Complete canonical monitor identity when local custody can prove it. */
  monitoringAssetIdentity?: string;
  baseAsset: "sat";
  divisibility: import("./market").ProductMarketDivisibility;
  /** Exact share count when the client knows the market divisibility. */
  shares?: number;
  avgBuyPrice: number;
  currentPrice: number;
  currentValueSats: number;
  /** False when the display-only monitor cannot value this asset. */
  valueKnown?: boolean;
  profitLossSats: number;
  profitLossPercent: number;
  status: PositionStatus;
  /**
   * Single source-of-truth winner flag for a closed position (P22 Link F),
   * derived once in usePortfolioState via deriveWinner. A position is a winner
   * iff it holds >= 1 proof on a winning keyset (the attested outcome is a
   * member of the keyset's collection). The "Won" badge, Claim button,
   * value/P&L, and the destructive "Remove" guard all read this same field so
   * they can never disagree. Always false while active.
   */
  isWinner: boolean;
  /**
   * Closed, attested, and not a winner. Always false while active or pending.
   * Gates "Remove" — only an attested loser may have its proofs destroyed.
   */
  isLoser: boolean;
  /**
   * Closed but NOT YET ATTESTED (no final outcome — closed by deadline, or
   * before the oracle attests). Win/loss is UNDECIDED (P22 Link F): the row
   * shows an "awaiting resolution" indicator and offers NEITHER Claim NOR
   * Remove, so not-yet-decided proofs can never be destroyed. Its value is the
   * full held amount, not zero. Always false while active.
   */
  isPending: boolean;
  /**
   * The market's attested final outcome (P22 Link F). Carried so the
   * destructive "Remove" handler can apply a defense-in-depth filter: it must
   * never delete a proof on a winning keyset, even if classification were off.
   */
  finalOutcome?: string | null;
  closedDate?: string;
  acquiredDate: string;
  mintUrl: string;
}

// =============================================================================
// Fund Types (base ecash assets)
// =============================================================================

export interface Fund {
  id: string;
  unit: "sats";
  amount: number;
  mintUrl: string;
  /** Complete canonical monitor identity for display-row stability. */
  monitoringAssetIdentity?: string;
}

// =============================================================================
// Activity Types (replaces OrderHistoryItem)
// =============================================================================

export type ActivityType =
  | "deposit"
  | "withdrawal"
  | "Buy"
  | "Sell"
  | "payout_claimed"
  | "creator_fee_claimed";
export type ActivityStatus = "pending" | "completed" | "Failed";

export interface ActivityItem {
  id: string;
  type: ActivityType;
  amountSats: number;
  baseAsset: "sat";
  date: string;
  status: ActivityStatus;
  txId: string | null;
  lightningInvoice: string | null;
  failureReason?: string;
  marketId?: string;
  marketTitle?: string;
  positionId?: string;
}

// =============================================================================
// Created Market Types
// =============================================================================

export type CreatedMarketStatus = "active" | "resolved" | "refunded";

export interface CreatedMarket {
  id: string;
  title: string;
  imageUrl: string;
  status: CreatedMarketStatus;
  createdDate: string;
  baseAsset: "sat";
  divisibility: import("./market").ProductMarketDivisibility;
  resolvedDate?: string;
  refundedDate?: string;
  volume: number;
  creatorFeesEarned: number;
  creatorFeePercent: number;
  oracle?: {
    type: "self";
    eventId: string;
    announcementEventId?: string;
    outcomes: string[];
    /**
     * TLV-hex of the kormir DLC oracle announcement. Mirrored client-side so a
     * fresh browser profile can re-import the committed-nonce material before
     * re-signing the attestation (P22 B1b).
     */
    announcementHex?: string;
    attestationHex?: string;
    attestedOutcome?: string;
    attestedAt?: string;
  };
}

// =============================================================================
// Component Props
// =============================================================================

export interface PortfolioProps {
  /** Wallet state — determines whether to show portfolio or onboarding CTA */
  walletState: WalletState;

  /** User's preferred base currency for display */
  baseCurrency: BaseCurrency;

  /** Currently selected P/L time range */
  selectedTimeRange: PLTimeSelector;

  /** User profile information */
  profile: UserProfile;

  /** P/L chart data for each time range */
  plChartData: PLChartData;

  /** Portfolio statistics */
  stats: PortfolioStats;

  /** User's positions in markets */
  positions: Position[];

  /** Activity feed (deposits, withdrawals, trades, payouts, fees) */
  activity: ActivityItem[];

  /** Base ecash fund balances */
  funds: Fund[];

  /** Markets created by the user */
  createdMarkets: CreatedMarket[];

  /** Currently selected positions sub-tab */
  positionsTab: "active" | "closed";

  /** Called when user clicks "Get Started" (no-wallet state). */
  onGetStarted?: () => void;

  /** Called when user uploads a new avatar image */
  onAvatarUpload?: (file: File) => void;

  /** Called when user selects a P/L time range */
  onTimeRangeChange?: (range: PLTimeSelector) => void;

  /** Called when user clicks Deposit */
  onDeposit?: () => void;

  /** Called when user clicks Withdraw */
  onWithdraw?: () => void;

  /** Called when user clicks Sell on a position */
  onSellPosition?: (positionId: string) => void;

  /** Called when user clicks to view position details */
  onViewPosition?: (positionId: string) => void;

  /** Called when user clicks to view a market they created */
  onViewMarket?: (marketId: string) => void;

  /** Called when user clicks to view activity item details */
  onViewActivity?: (activityId: string) => void;

  /** Called when user switches positions sub-tab */
  onPositionsTabChange?: (tab: "active" | "closed") => void;

  /** Called when user clicks to claim creator fees from a resolved market */
  onClaimCreatorFees?: (marketId: string) => void;

  /** Called when user claims payout from a winning position */
  onClaimPayout?: (positionId: string) => void;

  /** Called when user removes a losing closed CTF position from local wallet state */
  onDiscardLostPosition?: (positionId: string) => void;

  /** Called when user clicks to view a fund */
  onViewFund?: (fundId: string) => void;

  /** Called when user opens Settings */
  onOpenSettings?: () => void;

  /** Display-only status from the authenticated portfolio monitor. */
  monitoring?: PortfolioMonitoringState;

  /** Called when the user dismisses a monitoring error. */
  onDismissMonitoringError?: () => void;

  /** Called when the user requests the next asset-monitoring page. */
  onLoadMoreAssets?: () => void;

  /** Called when the user retries a failed asset-monitoring page. */
  onRetryLoadMoreAssets?: () => void;

  /** Called when the user dismisses an asset-monitoring page error. */
  onDismissAssetPageError?: () => void;

  /**
   * Show the "Connect Nostr" CTA just beneath ProfileCard. Set by the
   * page when the user has no configured Nostr signer and no cached
   * profile (Anon state) — P5 item 4.
   */
  showConnectNostrCta?: boolean;

  /** Called when user clicks "Connect Nostr" (navigates to Nostr settings) */
  onConnectNostr?: () => void;
}
