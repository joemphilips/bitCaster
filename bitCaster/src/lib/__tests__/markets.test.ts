import { describe, it, expect } from 'vitest'
import { mapConditionToMarket, filterMarkets } from '../markets'
import type { ConditionInfo } from '../markets'
import type { FilterState } from '@/types/market'

const yesNoCondition: ConditionInfo = {
  condition_id: 'abc123',
  description: 'Will BTC hit 100K?',
  threshold: 1,
  announcements: ['ann1'],
  partitions: [
    {
      partition: ['YES', 'NO'],
      collateral: 'sats',
      parent_collection_id: '',
      keysets: {},
    },
  ],
  attestation: { status: 'pending', winning_outcome: null, attested_at: null },
}

const categoricalCondition: ConditionInfo = {
  condition_id: 'def456',
  description: 'Who wins the election?',
  threshold: 1,
  announcements: ['ann2'],
  partitions: [
    {
      partition: ['Alice', 'Bob', 'Charlie'],
      collateral: 'sats',
      parent_collection_id: '',
      keysets: {},
    },
  ],
  attestation: { status: 'pending', winning_outcome: null, attested_at: null },
}

describe('mapConditionToMarket', () => {
  it('maps a 2-partition YES/NO condition to yesno market', () => {
    const market = mapConditionToMarket(yesNoCondition)

    expect(market.id).toBe('abc123')
    expect(market.title).toBe('Will BTC hit 100K?')
    expect(market.type).toBe('yesno')
    if (market.type === 'yesno') {
      expect(market.currentOdds).toEqual({ yes: 50, no: 50 })
    }
  })

  it('maps a >2 partition condition to categorical market', () => {
    const market = mapConditionToMarket(categoricalCondition)

    expect(market.id).toBe('def456')
    expect(market.title).toBe('Who wins the election?')
    expect(market.type).toBe('categorical')
    if (market.type === 'categorical') {
      expect(market.outcomes).toHaveLength(3)
      expect(market.outcomes[0].label).toBe('Alice')
    }
  })

  it('provides defaults for missing fields', () => {
    const market = mapConditionToMarket(yesNoCondition)

    expect(market.volume).toBe(0)
    expect(market.liquidity).toBe(0)
    expect(market.traderCount).toBe(0)
    expect(market.categoryTags).toEqual([])
    expect(market.metaTags).toEqual([])
    expect(market.imageUrl).toBe('')
  })
})

describe('filterMarkets', () => {
  const markets = [
    mapConditionToMarket(yesNoCondition),
    mapConditionToMarket(categoricalCondition),
  ]

  const baseFilter: FilterState = {
    searchQuery: '',
    selectedTag: null,
    marketTypes: [],
    volumeRange: {},
  }

  it('returns all markets with empty filter', () => {
    const result = filterMarkets(markets, baseFilter)
    expect(result).toHaveLength(2)
  })

  it('filters by search query', () => {
    const result = filterMarkets(markets, { ...baseFilter, searchQuery: 'btc' })
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Will BTC hit 100K?')
  })

  it('filters by market type', () => {
    const result = filterMarkets(markets, { ...baseFilter, marketTypes: ['categorical'] })
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('categorical')
  })
})
