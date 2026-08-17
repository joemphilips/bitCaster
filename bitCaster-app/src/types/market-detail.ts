// =============================================================================
// Market Detail Types
// =============================================================================

// Import shared types from market discovery
import type { CurrentOdds, Outcome, CategoryTag, ProductMarketDivisibility } from "./market";
import type { MarketState } from "@/hooks/useMarketState";

// =============================================================================
// Resolution Types
// =============================================================================

export type ResolutionStatus = "open" | "pending_resolution" | "resolved" | "disputed";

export type ResolutionSource = "oracle" | "manual" | "community" | "smart_contract";

export interface ResolutionDetails {
  criteria: string;
  source: ResolutionSource;
  sourceDescription?: string;
  resolutionDate: string;
  status: ResolutionStatus;
  finalOutcome?: string; // Only set when resolved
  disputeDeadline?: string; // For disputed markets
}

// =============================================================================
// Creator Types
// =============================================================================

export interface MarketCreator {
  id: string;
  name: string;
  avatarUrl?: string;
  reputationScore?: number;
  totalMarketsCreated: number;
  feePercent: number;
}

export interface MarketMintInfo {
  collateral: string;
  keysetCount: number;
}

// =============================================================================
// Order Book Types
// =============================================================================

export interface Order {
  price: number; // 0-100 representing percentage
  amount: number; // in sats
  total: number; // cumulative amount at this price level
}

export interface OrderBook {
  bids: Order[]; // Buy orders, sorted by price descending
  asks: Order[]; // Sell orders, sorted by price ascending
  spread: number; // Difference between best bid and best ask
  depthLimit?: number; // Server-advertised max visible price levels per side
}

// =============================================================================
// Price History Types
// =============================================================================

export interface PricePoint {
  timestamp: string;
  price: number; // 0-100
  volume?: number;
  source?: "fill";
}

export interface PriceHistory {
  data: PricePoint[];
  timeframe: ChartTimeframe;
}

export type ChartTimeframe = "1h" | "24h" | "7d" | "30d" | "all";

// =============================================================================
// Activity Types
// =============================================================================

export interface Trade {
  id: string;
  userId: string;
  userDisplayName: string; // Anonymized or partial name
  side: "yes" | "no";
  outcomeId?: string; // For categorical markets
  amount: number; // in sats
  price: number; // 0-100
  timestamp: string;
}

export interface Comment {
  id: string;
  userId: string;
  userDisplayName: string;
  userAvatarUrl?: string;
  content: string;
  timestamp: string;
  likeCount: number;
  isLiked: boolean;
}

// =============================================================================
// Related Market Types
// =============================================================================

export interface RelatedMarket {
  id: string;
  title: string;
  imageUrl?: string;
  currentOdds?: CurrentOdds;
  volume: number;
  baseAsset: "sat";
  closingDate: string;
}

// =============================================================================
// Market Detail Data Types (extends discovery types)
// =============================================================================

interface BaseMarketDetail {
  id: string;
  title: string;
  imageUrl?: string;
  categoryTags: CategoryTag[];
  volume: number;
  liquidity: number;
  liquiditySubunits: number;
  ammBotBudgetSubunits: number;
  volumeLifetimeSubunits: number;
  closingDate: string | null;
  createdDate: string;
  activeSince: string;
  baseAsset: "sat";
  divisibility: ProductMarketDivisibility;
  baseUnit: string; // e.g. "sats", "USD"
  mint?: MarketMintInfo;
  creator: MarketCreator;
  outcomes?: Outcome[];
  /**
   * Engine-side lifecycle state per ADR-009 Amendment 2026-05-04. The detail
   * page reads this — NOT mintd's `attestation.status` — to decide Open /
   * Closed. `null` / `undefined` is the pre-fetch state (the catalogue
   * request is still in flight); the renderer treats it as Open so the
   * trade pane does not flash hidden during initial load.
   */
  state?: MarketState | null;
  resolution: ResolutionDetails;
  priceHistory: PriceHistory;
  orderBook: OrderBook;
  outcomeOrderBooks?: Record<string, OrderBook>;
  recentTrades: Trade[];
  comments: Comment[];
  relatedMarkets: RelatedMarket[];
}

export interface YesNoMarketDetail extends BaseMarketDetail {
  type: "yesno";
  currentOdds: CurrentOdds;
  outcomeOrderBooks?: Record<string, OrderBook>;
}

export interface CategoricalMarketDetail extends BaseMarketDetail {
  type: "categorical";
  outcomes: Outcome[];
  // Price history and order book per outcome
  outcomePriceHistories: Record<string, PriceHistory>;
  outcomeOrderBooks: Record<string, OrderBook>;
}

// Numeric market detail (NUT-CTF-numeric: HI/LO token pair with proportional payout)
export interface NumericMarketDetail extends BaseMarketDetail {
  type: "numeric";
  loBound: number; // Lower bound of the outcome range
  hiBound: number; // Upper bound of the outcome range
  precision: number; // Decimal places for display
  unit: string; // Display unit (e.g. "USD", "BTC")
  currentPrice: number; // Implied price: loBound + (hiPrice / 100) * (hiBound - loBound)
  attestedValue?: number; // Set when resolved — the oracle-attested value
}

export type MarketDetail = YesNoMarketDetail | CategoricalMarketDetail | NumericMarketDetail;

// =============================================================================
// Trade Side & Order Type
// =============================================================================

export type TradeSide = "Buy" | "Sell";
export type OrderType = "market" | "limit";

export interface LimitOrderPreview {
  limitPrice: number; // price numerator 1..divisibility-1
  amount: number; // display shares
  sharesIfFilled?: number;
  quoteSubunits: number; // whole shares × price, the pre-fee quote
  creatorFee: number;
  mintFee: number; // read from the CTF keyset input_fee_ppk (0 in the first release)
  engineScoreFeeSats: number | null; // sat-denominated Score fee; null means auth-gated until confirmation
  potentialPayout: number; // display shares × market divisibility
  // Display-only spend estimate used for the balance check. NEVER sent as the
  // wire amountSubunits (which is `amount * divisibility`). Reactive:
  //   limitPrice * amount + creatorFee + mintFee
  totalCost: number;
}

// =============================================================================
// Trade State Types
// =============================================================================

export interface TradeSelection {
  side: "yes" | "no" | "hi" | "lo";
  outcomeId?: string; // For categorical
  tradeSide?: TradeSide;
  orderType?: OrderType;
  limitPrice?: number;
}

export interface TradePreview {
  amount: number;
  predictedOdds: number; // Odds after trade
  priceImpact: number; // Change in odds
  averageExecutionPrice?: number;
  executableShares?: number;
  hasExecutableLiquidity?: boolean;
  quoteSubunits: number;
  mintFee: number;
  potentialPayout: number;
  creatorFee: number;
  engineScoreFeeSats: number | null;
  totalCost: number;
}

// =============================================================================
// Component Props
// =============================================================================

export interface MarketDetailProps {
  /** The market data to display */
  market: MarketDetail;

  /** Current chart timeframe selection */
  chartTimeframe: ChartTimeframe;

  /** Currently selected trade (null if none) */
  tradeSelection: TradeSelection | null;

  /** Trade amount entered by user, in display shares (1 share = market divisibility face units) */
  tradeAmount: number;

  /** Preview of trade outcome (null if no valid selection) */
  tradePreview: TradePreview | null;

  /** Called when user changes chart timeframe */
  onTimeframeChange?: (timeframe: ChartTimeframe) => void;

  /** Called when user selects an outcome to trade */
  onTradeSelect?: (selection: TradeSelection) => void;

  /** Called when user clears trade selection */
  onTradeClear?: () => void;

  /** Called when user changes trade amount */
  onAmountChange?: (amount: number) => void;

  /** Called when user confirms trade */
  onTradeConfirm?: (comment?: string) => void;

  /** Status text from the latest order-submit attempt. */
  tradeSubmitStatus?: {
    kind: "info" | "success" | "error";
    message: string;
  } | null;

  /** Explicitly dismiss the latest order-submit status. */
  onTradeSubmitStatusDismiss?: () => void;

  /** UX-only wallet feasibility gate for local wallet backing checks. */
  tradeFeasibility?: {
    canBack: boolean;
    reason?: "funds" | "outcome-tokens";
    message?: string;
  } | null;

  /** True while an order submit is in flight. Disables duplicate confirms. */
  isTradeSubmitting?: boolean;

  /** Called when user shares the market */
  onShare?: () => void;

  /** Called when user posts a comment */
  onCommentPost?: (content: string) => void;

  /** Called when user likes a comment */
  onCommentLike?: (commentId: string) => void;

  /** Called when user scrolls to load more trades */
  onLoadMoreTrades?: () => void;

  /** Called when user scrolls to load more comments */
  onLoadMoreComments?: () => void;

  /** Called when user clicks on a related market */
  onRelatedMarketClick?: (marketId: string) => void;

  /** Current buy/sell trade side */
  tradeSide: TradeSide;

  /** Called when user toggles between buy and sell */
  onTradeSideChange?: (side: TradeSide) => void;

  /** Current order type (market or limit) */
  orderType: OrderType;

  /** Called when user toggles between market and limit order */
  onOrderTypeChange?: (type: OrderType) => void;

  /** Preview for limit orders (null if not applicable) */
  limitOrderPreview?: LimitOrderPreview | null;

  /** Current limit price (in market's base unit) */
  limitPrice?: number;

  /** Called when user changes limit price */
  onLimitPriceChange?: (price: number) => void;

  /** Number of shares the user currently holds (for sell percentage calculation) */
  userHoldings?: number;

  /** Whether the user has a wallet configured (gates trade confirmation) */
  walletReady?: boolean;

  /** Called when the trade UI needs wallet/Nostr setup before continuing. */
  onWalletRequired?: (comment?: string) => void;

  /** Called when the trade UI should open the wallet top-up flow. */
  onTopUpRequired?: () => void;
}
