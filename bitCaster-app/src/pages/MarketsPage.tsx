import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { MarketDiscovery } from '@/components/markets'
import { getMarkets, filterMarkets } from '@/lib/markets'
import { DEFAULT_MARKET_SORT, type MarketSort } from '@/hooks/useMarketSort'
import type {
  Market,
  MarketType,
  VolumeRange,
  FilterState,
  CategoryTag,
} from '@/types/market'

export function MarketsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const searchQuery = searchParams.get('search')?.trim() ?? ''
  const [markets, setMarkets] = useState<Market[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Selected category tags. P7 §`/markets`: chip multi-select with OR
  // semantics. The engine's `/api/v1/markets/query?tag=…` accepts repeated
  // `tag=` parameters, so the page forwards the whole set verbatim.
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [filter, setFilter] = useState<FilterState>({
    searchQuery: '',
    selectedTags: [],
    marketTypes: [],
    volumeRange: {},
    includeClosed: false,
  })

  // Sort dimension is hoisted into the engine query (`?sort=`); the page now
  // owns only the active selection, not the client-side ordering.
  const [sort, setSort] = useState<MarketSort>(DEFAULT_MARKET_SORT)

  const loadMarkets = useCallback(() => {
    setLoading(true)
    setError(null)
    setNextCursor(null)
    const tags = selectedTags.length > 0 ? selectedTags : undefined
    getMarkets({
      sort,
      tags,
      search: searchQuery || undefined,
      state: filter.includeClosed ? 'All' : 'Open',
    })
      .then((result) => {
        setMarkets(result.markets)
        setNextCursor(result.nextCursor)
      })
      .catch(() => {
        setError(
          'Failed to load markets. Please check that the matching engine is running.',
        )
      })
      .finally(() => {
        setLoading(false)
      })
  }, [sort, selectedTags, searchQuery, filter.includeClosed])

  useEffect(() => {
    loadMarkets()
  }, [loadMarkets])

  const derivedCategoryTags = useMemo<CategoryTag[]>(() => {
    const counts = new Map<string, number>()
    for (const m of markets) {
      for (const tagId of m.categoryTags) {
        counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).map(([id, count]) => ({
      id,
      label: id,
      marketCount: count,
    }))
  }, [markets])

  // Market-type / volume / closing-date filters stay client-side. Search and
  // tag selection are pushed up to the API call, so we strip them from the
  // client filter to avoid double-applying.
  const filteredMarkets = useMemo(
    () =>
      filterMarkets(markets, { ...filter, searchQuery: '', selectedTags: [] }),
    [markets, filter],
  )

  const handleTagSelect = useCallback((tagId: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId],
    )
  }, [])

  const handleClearTags = useCallback(() => {
    setSelectedTags([])
  }, [])

  const handleMarketTypeChange = useCallback((types: MarketType[]) => {
    setFilter((prev) => ({ ...prev, marketTypes: types }))
  }, [])

  const handleVolumeRangeChange = useCallback((range: VolumeRange) => {
    setFilter((prev) => ({ ...prev, volumeRange: range }))
  }, [])

  const handleClosingDateChange = useCallback((days?: number) => {
    setFilter((prev) => ({ ...prev, closingInDays: days }))
  }, [])

  const handleIncludeClosedChange = useCallback((includeClosed: boolean) => {
    setFilter((prev) => ({ ...prev, includeClosed }))
  }, [])

  const handleViewMarket = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`)
    },
    [navigate],
  )

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const tags = selectedTags.length > 0 ? selectedTags : undefined
    getMarkets({
      sort,
      tags,
      search: searchQuery || undefined,
      state: filter.includeClosed ? 'All' : 'Open',
      cursor: nextCursor,
    })
      .then((result) => {
        setMarkets((prev) => [...prev, ...result.markets])
        setNextCursor(result.nextCursor)
      })
      .catch(() => {
        // Pagination failure is non-fatal — leave the existing list in place
        // and surface nothing rather than blow up the page.
      })
      .finally(() => {
        setLoadingMore(false)
      })
  }, [nextCursor, loadingMore, sort, selectedTags, searchQuery, filter.includeClosed])

  const handleViewSecondaryMarket = useCallback(
    (_baseMarketId: string, secondaryMarketId: string) => {
      navigate(`/markets/${secondaryMarketId}`)
    },
    [navigate],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-slate-400 animate-pulse">Loading markets...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="text-red-400">{error}</div>
        <button
          onClick={loadMarkets}
          className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <MarketDiscovery
      categoryTags={derivedCategoryTags}
      markets={filteredMarkets}
      selectedTags={selectedTags}
      sort={sort}
      searchQuery={searchQuery}
      onSortChange={setSort}
      onTagSelect={handleTagSelect}
      onClearTags={handleClearTags}
      onMarketTypeChange={handleMarketTypeChange}
      onVolumeRangeChange={handleVolumeRangeChange}
      onClosingDateChange={handleClosingDateChange}
      onIncludeClosedChange={handleIncludeClosedChange}
      onViewMarket={handleViewMarket}
      hasMore={nextCursor !== null}
      onLoadMore={handleLoadMore}
      onViewSecondaryMarket={handleViewSecondaryMarket}
    />
  )
}
