import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Market } from '@/types/market'
import { useBookmarkStore } from '@/stores/bookmarks'

const { mockFetchMarkets } = vi.hoisted(() => ({
  mockFetchMarkets: vi.fn(),
}))

vi.mock('@/lib/markets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/markets')>('@/lib/markets')
  return {
    ...actual,
    fetchMarkets: (...args: unknown[]) => mockFetchMarkets(...args),
  }
})

import { useLikedMarkets } from '../useLikedMarkets'

function makeMarket(id: string, title = `Market ${id}`): Market {
  const now = new Date().toISOString()
  return {
    id,
    title,
    type: 'yesno',
    imageUrl: '',
    categoryTags: [],
    metaTags: [],
    currentOdds: { yes: 50, no: 50 },
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    creatorFeePercent: 0,
    baseMarket: 'sats',
  } as Market
}

beforeEach(() => {
  mockFetchMarkets.mockReset()
  useBookmarkStore.setState({ markets: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLikedMarkets', () => {
  it('returns the intersection of bookmark IDs and the market catalogue', async () => {
    mockFetchMarkets.mockResolvedValue([
      makeMarket('a'),
      makeMarket('b'),
      makeMarket('c'),
    ])
    useBookmarkStore.setState({ markets: ['b', 'c'] })

    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.markets.map((m) => m.id)).toEqual(['b', 'c'])
  })

  it('drops bookmark IDs with no matching mint condition', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a')])
    useBookmarkStore.setState({ markets: ['a', 'gone'] })

    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.markets.map((m) => m.id)).toEqual(['a'])
  })

  it('deduplicates bookmark IDs (T5.1.d)', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a')])
    // Inject a duplicate via setState even though `toggle` would not — the
    // hook must defend against arbitrary store snapshots so a stale Nostr
    // sync that landed two of the same e-tag does not render twice.
    useBookmarkStore.setState({ markets: ['a', 'a'] })

    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.markets).toHaveLength(1)
  })

  it('returns the empty list when the bookmark store is empty', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a')])
    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.markets).toEqual([])
  })

  it('surfaces fetch failures via error and clears markets', async () => {
    mockFetchMarkets.mockRejectedValue(new Error('boom'))
    useBookmarkStore.setState({ markets: ['a'] })
    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Failed to load markets')
    expect(result.current.markets).toEqual([])
  })

  it('reacts to bookmark toggles after the initial fetch', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a'), makeMarket('b')])
    const { result } = renderHook(() => useLikedMarkets())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.markets).toEqual([])
    act(() => {
      useBookmarkStore.getState().toggle('b')
    })
    expect(result.current.markets.map((m) => m.id)).toEqual(['b'])
  })
})
