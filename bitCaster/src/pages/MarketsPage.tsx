import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { MarketDiscovery } from '@/components/markets'
import { fetchMarkets, filterMarkets } from '@/lib/markets'
import type { Market, MarketType, VolumeRange, FilterState } from '@/types/market'

export function MarketsPage() {
  const navigate = useNavigate()
  const [markets, setMarkets] = useState<Market[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterState>({
    searchQuery: '',
    selectedTag: null,
    marketTypes: [],
    volumeRange: {},
  })

  const loadMarkets = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchMarkets()
      .then((result) => {
        setMarkets(result)
      })
      .catch(() => {
        setError('Failed to load markets. Please check that the mint is running.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    loadMarkets()
  }, [loadMarkets])

  const filteredMarkets = useMemo(
    () => filterMarkets(markets, { ...filter, selectedTag }),
    [markets, filter, selectedTag]
  )

  const handleTagSelect = useCallback((tagId: string) => {
    setSelectedTag((prev) => (prev === tagId ? null : tagId))
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

  const handleViewMarket = useCallback((marketId: string) => {
    navigate(`/markets/${marketId}`)
  }, [navigate])

  const handleLoadMore = useCallback(() => {
    // No-op for M2 — all data loaded at once
  }, [])

  const handleViewSecondaryMarket = useCallback(
    (_baseMarketId: string, secondaryMarketId: string) => {
      navigate(`/markets/${secondaryMarketId}`)
    },
    [navigate]
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
      metaTags={[]}
      categoryTags={[]}
      markets={filteredMarkets}
      selectedTag={selectedTag}
      onTagSelect={handleTagSelect}
      onMarketTypeChange={handleMarketTypeChange}
      onVolumeRangeChange={handleVolumeRangeChange}
      onClosingDateChange={handleClosingDateChange}
      onViewMarket={handleViewMarket}
      onLoadMore={handleLoadMore}
      onViewSecondaryMarket={handleViewSecondaryMarket}
    />
  )
}
