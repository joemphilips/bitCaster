import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filterMarkets,
  getMarkets,
  getTagValue,
  getTagValues,
  extractCategoryTagIds,
  getMarketThumbnail,
  isMarketClosed,
  mapCatalogueEntryToMarket,
} from '../markets'
import type { MarketCatalogueEntry } from '../markets'
import type { FilterState, Market } from '@/types/market'

const yesNoEntry: MarketCatalogueEntry = {
  conditionId: 'abc123',
  outcomes: ['YES', 'NO'],
  title: 'Will BTC hit 100K?',
  thumbnailUrl: null,
  creatorPubkey: null,
  deadline: '2030-12-31T23:59:59Z',
  state: 'open',
  createdAt: '2026-01-01T00:00:00Z',
  volume24hSats: 12_000,
  volume30dSats: 340_000,
  lastTradedPrice: 0.62,
  categoryTags: ['crypto'],
  lastSuccessfulRefreshAt: '2026-05-02T09:58:00Z',
}

const categoricalEntry: MarketCatalogueEntry = {
  conditionId: 'def456',
  outcomes: ['Alice', 'Bob', 'Charlie'],
  title: 'Who wins the election?',
  thumbnailUrl: null,
  creatorPubkey: null,
  deadline: '2030-12-31T23:59:59Z',
  state: 'open',
  createdAt: '2026-02-01T00:00:00Z',
  volume24hSats: 0,
  volume30dSats: 0,
  lastTradedPrice: null,
  categoryTags: ['politics'],
  lastSuccessfulRefreshAt: '2026-05-02T09:58:00Z',
}

describe('mapCatalogueEntryToMarket', () => {
  it('maps a 2-outcome YES/NO entry to a yesno market', () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry)

    expect(market.id).toBe('abc123')
    expect(market.title).toBe('Will BTC hit 100K?')
    expect(market.type).toBe('yesno')
    if (market.type === 'yesno') {
      expect(market.currentOdds).toEqual({ yes: 50, no: 50 })
    }
  })

  it('maps a >2 outcome entry to a categorical market', () => {
    const market = mapCatalogueEntryToMarket(categoricalEntry)

    expect(market.id).toBe('def456')
    expect(market.type).toBe('categorical')
    if (market.type === 'categorical') {
      expect(market.outcomes).toHaveLength(3)
      expect(market.outcomes[0].label).toBe('Alice')
    }
  })

  it('uses the engine 24h volume so Trending sort renders the right magnitude', () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry)
    expect(market.volume).toBe(12_000)
  })

  it('falls back to "Untitled Market" when title is null', () => {
    const market = mapCatalogueEntryToMarket({ ...yesNoEntry, title: null })
    expect(market.title).toBe('Untitled Market')
  })

  it('preserves engine category tags', () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry)
    expect(market.categoryTags).toEqual(['crypto'])
  })

  it('uses createdAt as closingDate when deadline is null', () => {
    const market = mapCatalogueEntryToMarket({ ...yesNoEntry, deadline: null })
    expect(market.closingDate).toBe('2026-01-01T00:00:00Z')
  })
})

describe('tag helpers (mintd condition mapping — detail page only)', () => {
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

describe('filterMarkets (client-side stop-gap)', () => {
  const markets: Market[] = [
    mapCatalogueEntryToMarket(yesNoEntry),
    mapCatalogueEntryToMarket(categoricalEntry),
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

describe('getMarkets (engine catalogue proxy wiring)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  function makeResponse(): Response {
    const body = {
      markets: [yesNoEntry],
      nextCursor: null,
      lastSuccessfulRefreshAt: yesNoEntry.lastSuccessfulRefreshAt,
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn(() => Promise.resolve(makeResponse()))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function lastCallUrl(): string {
    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string]
    return url
  }

  it('hits /api/v1/markets/query (NOT the deprecated /v1/conditions mintd path)', async () => {
    await getMarkets()
    const url = lastCallUrl()
    expect(url).toMatch(/^\/api\/v1\/markets\/query/)
    expect(url).not.toMatch(/\/v1\/conditions/)
  })

  it('forwards the sort dimension as the engine `sort=` enum (Trending|Popular|New)', async () => {
    await getMarkets({ sort: 'new' })
    expect(lastCallUrl()).toContain('sort=New')
    await getMarkets({ sort: 'popular' })
    expect(lastCallUrl()).toContain('sort=Popular')
    await getMarkets({ sort: 'trending' })
    expect(lastCallUrl()).toContain('sort=Trending')
  })

  it('forwards repeatable tag filters as multiple ?tag= params (OR semantics)', async () => {
    await getMarkets({ tags: ['politics', 'tech'] })
    const url = lastCallUrl()
    expect(url).toContain('tag=politics')
    expect(url).toContain('tag=tech')
  })

  it('forwards bulk-fetch IDs as a single comma-joined ?ids= param', async () => {
    await getMarkets({ ids: ['abc', 'def', '123'] })
    expect(lastCallUrl()).toContain('ids=abc%2Cdef%2C123')
  })

  it('forwards the cursor and page_size for follow-up pages', async () => {
    await getMarkets({ cursor: 'opaque-hmac', pageSize: 50 })
    const url = lastCallUrl()
    expect(url).toContain('cursor=opaque-hmac')
    expect(url).toContain('page_size=50')
  })

  it('shapes the response into Market objects with engine-derived fields', async () => {
    const result = await getMarkets()
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0].id).toBe('abc123')
    expect(result.markets[0].volume).toBe(12_000)
    expect(result.nextCursor).toBeNull()
    expect(result.lastSuccessfulRefreshAt).toBe(yesNoEntry.lastSuccessfulRefreshAt)
  })

  it('throws on non-2xx so the page can render an error/retry affordance', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(getMarkets()).rejects.toThrow(/Failed to query markets: 500/)
  })
})

describe('legacy mintd-list path (markets list) is fully removed', () => {
  it('no longer exports a fetchMarkets() function', async () => {
    const mod = await import('../markets')
    expect(Object.prototype.hasOwnProperty.call(mod, 'fetchMarkets')).toBe(false)
  })

  it('no longer exports a mapConditionToMarket() function', async () => {
    const mod = await import('../markets')
    expect(Object.prototype.hasOwnProperty.call(mod, 'mapConditionToMarket')).toBe(false)
  })
})
