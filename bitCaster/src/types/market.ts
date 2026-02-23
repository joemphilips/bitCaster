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
  imageUrl: string
  categoryTags: string[]
  metaTags: string[]
  volume: number
  liquidity: number
  traderCount: number
  closingDate: string
  createdDate: string
  activeSince: string
  creatorFeePercent: number
  likeCount: number
  isLiked: boolean
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
  selectedTag: string | null // Single selected tag (meta or category)
  marketTypes: MarketType[]
  volumeRange: VolumeRange
  closingInDays?: number
}

// =============================================================================
// Component Props
// =============================================================================

export interface MarketDiscoveryProps {
  /** List of meta tags (Trending, Popular, New) */
  metaTags: MetaTag[]

  /** List of category tags for filtering */
  categoryTags: CategoryTag[]

  /** List of markets to display */
  markets: Market[]

  /** Currently selected tag ID (single-select) */
  selectedTag: string | null

  /** Search query */
  searchQuery?: string

  /** Called when user searches for markets */
  onSearch?: (query: string) => void

  /** Called when user selects a tag (single-select - only one active at a time) */
  onTagSelect?: (tagId: string) => void

  /** Called when user changes market type filter */
  onMarketTypeChange?: (types: MarketType[]) => void

  /** Called when user changes volume range filter */
  onVolumeRangeChange?: (range: VolumeRange) => void

  /** Called when user changes closing date filter */
  onClosingDateChange?: (days?: number) => void

  /** Called when user navigates to market detail page */
  onViewMarket?: (marketId: string) => void

  /** Called when user scrolls to bottom and more markets should be loaded */
  onLoadMore?: () => void

  /** Called when user clicks on a secondary market from expanded list */
  onViewSecondaryMarket?: (baseMarketId: string, secondaryMarketId: string) => void
}
