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
  liquiditySubunits: number
  volumeLifetimeSubunits: number
  closingDate: string
  createdDate: string
  activeSince: string
  baseAsset?: 'sat' | 'usd' | 'jpy'
  divisibility?: number
  creatorFeePercent: number
  baseMarket: string              // Default: "sats"
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

// Union type for all market types
export type Market = YesNoMarket | CategoricalMarket

// =============================================================================
// Filter Types
// =============================================================================

export type MarketType = 'yesno' | 'categorical'

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

  /**
   * Whether more pages are available. When `false` (or omitted) the
   * "Loading more" sentinel at the bottom of the list is hidden so it doesn't
   * stay visible forever on the last page.
   */
  hasMore?: boolean

  /** Called when user scrolls to bottom and more markets should be loaded */
  onLoadMore?: () => void

  /** Called when user clicks on a secondary market from expanded list */
  onViewSecondaryMarket?: (baseMarketId: string, secondaryMarketId: string) => void
}
