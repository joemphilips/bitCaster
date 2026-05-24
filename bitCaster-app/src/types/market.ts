// =============================================================================
// Tag Types
// =============================================================================

export interface MetaTag {
  id: string
  label: string
  description: string
}

export interface CategoryTag {
  id: string
  label: string
  marketCount: number
}

// Combined tag type for single-select behavior
export type Tag = MetaTag | CategoryTag

// =============================================================================
// Market Data Types
// =============================================================================

export interface CurrentOdds {
  yes: number
  no: number
}

export interface Outcome {
  id: string
  label: string
  odds: number
}

// Composite odds for Yes/No + Yes/No 2D markets
export interface YesNoCompositeOdds {
  yesYes: number
  yesNo: number
  noYes: number
  noNo: number
}

// Composite odds for Categorical + Yes/No 2D markets
export interface CategoricalYesNoCompositeOdds {
  [outcomeId: string]: { yes: number; no: number }
}

// Base market properties shared by all market types
interface BaseMarket {
  id: string
  title: string
  state: 'open' | 'closed'
  imageUrl: string
  categoryTags: string[]
  metaTags: string[]
  volume: number
  liquidity: number
  liquiditySats: number
  traderCount: number
  volumeLifetimeSats: number
  closingDate: string
  createdDate: string
  activeSince: string
  creatorFeePercent: number
  baseMarket: string              // Default: "sats", or market ID for 2D markets
  secondaryMarkets?: string[]     // IDs of markets using this as base
}

// Yes/No market type
export interface YesNoMarket extends BaseMarket {
  type: 'yesno'
  currentOdds: CurrentOdds
}

// Categorical market type
export interface CategoricalMarket extends BaseMarket {
  type: 'categorical'
  outcomes: Outcome[]
}

// Two-dimensional market type (composite market referencing another market)
export interface TwoDimensionalMarket extends BaseMarket {
  type: 'twodimensional'
  baseMarketId: string                          // ID of the market this is based on
  baseMarketTitle: string                       // Title of the base market for display
  baseMarketType: 'yesno' | 'categorical'       // Type of the base market
  secondaryType: 'yesno' | 'categorical'        // Type of this secondary market's outcomes
  secondaryQuestion: string                     // The secondary question (displayed with base)

  // For Yes/No + Yes/No combinations
  compositeOdds?: YesNoCompositeOdds

  // For Categorical + Yes/No combinations
  categoricalCompositeOdds?: CategoricalYesNoCompositeOdds
  baseOutcomes?: Outcome[]                      // Outcomes from base market (for categorical)

  // For Categorical secondary
  secondaryOutcomes?: Outcome[]                 // Outcomes if secondary is categorical
}

// Union type for all market types
export type Market = YesNoMarket | CategoricalMarket | TwoDimensionalMarket

// =============================================================================
// Filter Types
// =============================================================================

export type MarketType = 'yesno' | 'categorical' | 'twodimensional'

export interface VolumeRange {
  min?: number
  max?: number
}

export interface FilterState {
  searchQuery: string
  /**
   * Selected category tags. Empty array means "no tag filter" (all markets);
   * multiple tags OR-filter (the engine's `?tag=` query parameter is
   * repeatable — see ADR-009 / §`/markets`). Per P7 §`/markets` the user
   * needs to combine multiple categories to find the markets they care about.
   */
  selectedTags: string[]
  marketTypes: MarketType[]
  volumeRange: VolumeRange
  closingInDays?: number
  includeClosed?: boolean
}

// =============================================================================
// Component Props
// =============================================================================

export interface MarketDiscoveryProps {
  /** List of category tags for filtering */
  categoryTags: CategoryTag[]

  /** List of markets to display */
  markets: Market[]

  /**
   * Currently selected tag IDs (multi-select, OR semantics). Empty array =
   * "no tag filter". The engine's `/api/v1/markets/query` accepts repeated
   * `tag=` query parameters and ORs them; the page assembles the request
   * from this set.
   */
  selectedTags: string[]

  /** Search query */
  searchQuery?: string

  /**
   * Active sort dimension. Per ADR-009 the markets list is always sorted
   * by exactly one of Trending / Popular / New; the page owner is the
   * source of truth and the engine `?sort=` query parameter receives the
   * value verbatim (post-Phase 2 wiring).
   */
  sort: import('@/hooks/useMarketSort').MarketSort

  /** Called when user picks a different sort dimension. */
  onSortChange: (next: import('@/hooks/useMarketSort').MarketSort) => void

  /** Called when user searches for markets */
  onSearch?: (query: string) => void

  /**
   * Called when user clicks a tag chip. The page-level handler toggles the
   * tag in/out of the selected set (multi-select).
   */
  onTagSelect?: (tagId: string) => void

  /** Called when user clears all selected tags (the chip-row "Clear" affordance). */
  onClearTags?: () => void

  /** Called when user changes market type filter */
  onMarketTypeChange?: (types: MarketType[]) => void

  /** Called when user changes volume range filter */
  onVolumeRangeChange?: (range: VolumeRange) => void

  /** Called when user changes closing date filter */
  onClosingDateChange?: (days?: number) => void
  onIncludeClosedChange?: (includeClosed: boolean) => void

  /** Called when user navigates to market detail page */
  onViewMarket?: (marketId: string) => void

  /** Called when user scrolls to bottom and more markets should be loaded */
  onLoadMore?: () => void

  /** Called when user clicks on a secondary market from expanded list */
  onViewSecondaryMarket?: (baseMarketId: string, secondaryMarketId: string) => void
}
