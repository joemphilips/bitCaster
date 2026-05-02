import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TagBar } from './TagBar'
import { SortBar } from './SortBar'
import { FilterControls } from './FilterControls'
import { MarketCard } from './MarketCard'
import { useWalletStore } from '@/stores/wallet'
import type { MarketDiscoveryProps, MarketType, VolumeRange, Market } from '@/types/market'

export function MarketDiscovery({
  categoryTags,
  markets,
  selectedTag,
  sort,
  onSortChange,
  searchQuery: _searchQuery = '',
  onSearch: _onSearch,
  onTagSelect,
  onMarketTypeChange,
  onVolumeRangeChange,
  onClosingDateChange,
  onViewMarket,
  onLoadMore,
  onViewSecondaryMarket,
}: MarketDiscoveryProps) {
  const { t } = useTranslation()
  const walletReady = useWalletStore((s) => s.setupComplete)
  const observerTarget = useRef<HTMLDivElement>(null)
  const [filtersVisible, setFiltersVisible] = useState(false)
  const [selectedMarketTypes, setSelectedMarketTypes] = useState<MarketType[]>([])
  const [volumeRange, setVolumeRange] = useState<VolumeRange>({})
  const [closingInDays, setClosingInDays] = useState<number | undefined>(undefined)

  const marketMap = useMemo(() => {
    const map = new Map<string, Market>()
    markets.forEach((m) => map.set(m.id, m))
    return map
  }, [markets])

  const getSecondaryMarketInfos = (market: Market) => {
    if (!market.secondaryMarkets || market.secondaryMarkets.length === 0) {
      return undefined
    }
    return market.secondaryMarkets
      .map((id) => {
        const secondaryMarket = marketMap.get(id)
        if (!secondaryMarket) return null
        return {
          id: secondaryMarket.id,
          title: secondaryMarket.title,
        }
      })
      .filter((info): info is { id: string; title: string } => info !== null)
  }

  const activeFilterCount = [
    selectedMarketTypes.length > 0 ? 1 : 0,
    volumeRange.min !== undefined ? 1 : 0,
    closingInDays !== undefined ? 1 : 0,
  ].reduce((a, b) => a + b, 0)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore?.()
        }
      },
      { threshold: 0.1 }
    )

    const currentTarget = observerTarget.current
    if (currentTarget) {
      observer.observe(currentTarget)
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget)
      }
    }
  }, [onLoadMore])

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="sticky top-14 md:top-16 z-40 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto">
          {/* Row 1 — Sort buttons (always present, ADR-009 dimensions). */}
          <SortBar active={sort} onSortChange={onSortChange} />
          {/* Row 2 — Tag chips, multi-select category filter. */}
          <TagBar
            categoryTags={categoryTags}
            selectedTag={selectedTag}
            filtersVisible={filtersVisible}
            activeFilterCount={activeFilterCount}
            onTagSelect={onTagSelect}
            onToggleFilters={() => setFiltersVisible(!filtersVisible)}
          />
        </div>
      </div>

      <FilterControls
        isVisible={filtersVisible}
        selectedMarketTypes={selectedMarketTypes}
        volumeRange={volumeRange}
        closingInDays={closingInDays}
        onMarketTypeChange={(types) => {
          setSelectedMarketTypes(types)
          onMarketTypeChange?.(types)
        }}
        onVolumeRangeChange={(range) => {
          setVolumeRange(range)
          onVolumeRangeChange?.(range)
        }}
        onClosingDateChange={(days) => {
          setClosingInDays(days)
          onClosingDateChange?.(days)
        }}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {markets.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">🔍</div>
            <h3 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
              {t('market.noMarketsFound')}
            </h3>
            <p className="text-slate-500 dark:text-slate-400">
              {t('market.noMarketsFoundHint')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
            {markets.map((market) => (
              <MarketCard
                key={market.id}
                market={market}
                secondaryMarketInfos={getSecondaryMarketInfos(market)}
                onViewMarket={onViewMarket}
                onViewSecondaryMarket={onViewSecondaryMarket}
                walletReady={walletReady}
              />
            ))}
          </div>
        )}

        <div ref={observerTarget} className="h-20 flex items-center justify-center">
          {markets.length > 0 && (
            <div className="text-sm text-slate-500 dark:text-slate-400 animate-pulse">
              {t('market.loadingMore')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
