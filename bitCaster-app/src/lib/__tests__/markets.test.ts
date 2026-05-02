import { describe, it, expect } from 'vitest'
import {
  mapConditionToMarket,
  filterMarkets,
  getTagValue,
  getTagValues,
  extractCategoryTagIds,
  getMarketThumbnail,
  isMarketClosed,
} from '../markets'
import type { ConditionInfo } from '../markets'
import type { FilterState } from '@/types/market'

const yesNoCondition: ConditionInfo = {
  condition_id: 'abc123',
  tags: [['description', 'Will BTC hit 100K?'], ['n', 'BTC']],
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
  tags: [['description', 'Who wins the election?']],
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
    expect(market.metaTags).toEqual(['BTC'])
    expect(market.imageUrl).toBe('')
  })

  it('falls back to "Untitled Market" when description tag is missing', () => {
    const c: ConditionInfo = {
      ...yesNoCondition,
      tags: [['n', 'ETH']],
    }
    const market = mapConditionToMarket(c)
    expect(market.title).toBe('Untitled Market')
  })

  it('handles empty tags array gracefully', () => {
    const c: ConditionInfo = {
      ...yesNoCondition,
      tags: [],
    }
    const market = mapConditionToMarket(c)
    expect(market.title).toBe('Untitled Market')
    expect(market.categoryTags).toEqual([])
    expect(market.metaTags).toEqual([])
  })

  it('extracts category tags from non-standard tag keys', () => {
    const c: ConditionInfo = {
      ...yesNoCondition,
      tags: [['description', 'Test'], ['category', 'crypto']],
    }
    const market = mapConditionToMarket(c)
    expect(market.categoryTags).toContain('crypto')
  })
})

describe('tag helpers', () => {
  it('getTagValue returns first value for key', () => {
    const tags = [['description', 'hello'], ['n', 'BTC']]
    expect(getTagValue(tags, 'description')).toBe('hello')
    expect(getTagValue(tags, 'n')).toBe('BTC')
    expect(getTagValue(tags, 'missing')).toBeUndefined()
  })

  it('getTagValues returns all values after key', () => {
    const tags = [['n', 'BTC', 'ETH']]
    expect(getTagValues(tags, 'n')).toEqual(['BTC', 'ETH'])
    expect(getTagValues(tags, 'missing')).toEqual([])
  })

  it('extractCategoryTagIds excludes known keys', () => {
    const tags = [['description', 'x'], ['n', 'BTC'], ['category', 'crypto'], ['sport', 'NBA']]
    expect(extractCategoryTagIds(tags)).toEqual(['crypto', 'NBA'])
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

describe('isMarketClosed (P4.1 close-state mapping)', () => {
  it('returns false for a pending oracle attestation', () => {
    expect(isMarketClosed({ status: 'pending' })).toBe(false)
  })

  it('returns true for an attested oracle outcome', () => {
    expect(isMarketClosed({ status: 'attested' })).toBe(true)
  })

  it('returns true for an expired announcement (deadline passed without attestation)', () => {
    expect(isMarketClosed({ status: 'expired' })).toBe(true)
  })

  it('returns true for an oracle CET-violation report', () => {
    expect(isMarketClosed({ status: 'violation' })).toBe(true)
  })
})

describe('getMarketThumbnail (T4.3.c)', () => {
  it('returns the engine thumbnail URL when imageUrl resolved', () => {
    const url = getMarketThumbnail({ id: 'cond1', imageUrl: '/api/v1/cond1/thumbnail' })
    expect(url).toBe('/api/v1/cond1/thumbnail')
  })

  it('returns null when imageUrl is empty string (no broken url() in CSS)', () => {
    expect(getMarketThumbnail({ id: 'cond1', imageUrl: '' })).toBeNull()
  })

  it('returns null when imageUrl is whitespace-only', () => {
    expect(getMarketThumbnail({ id: 'cond1', imageUrl: '   ' })).toBeNull()
  })

  it('returns null when imageUrl is omitted entirely', () => {
    expect(getMarketThumbnail({ id: 'cond1' })).toBeNull()
  })
})
