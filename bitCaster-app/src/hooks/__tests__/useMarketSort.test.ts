import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { sortMarkets, useMarketSort, DEFAULT_MARKET_SORT } from '../useMarketSort'
import type { Market } from '@/types/market'

function fixture(id: string, volume: number, createdDate: string): Market {
  return {
    id,
    title: id,
    type: 'yesno',
    imageUrl: '',
    categoryTags: [],
    metaTags: [],
    currentOdds: { yes: 50, no: 50 },
    volume,
    liquidity: 0,
    traderCount: 0,
    closingDate: '2030-01-01T00:00:00Z',
    createdDate,
    activeSince: '2025-01-01T00:00:00Z',
    creatorFeePercent: 0,
    baseMarket: 'sats',
  }
}

const a = fixture('a', 1_000, '2026-01-01T00:00:00Z')
const b = fixture('b', 5_000, '2026-04-01T00:00:00Z')
const c = fixture('c', 100, '2026-05-01T00:00:00Z')

describe('sortMarkets', () => {
  it("sorts by createdAt desc when sort='new' (T4.2.b)", () => {
    expect(sortMarkets([a, b, c], 'new').map(m => m.id)).toEqual(['c', 'b', 'a'])
  })

  it("sorts by total volume desc when sort='popular' (T4.2.c)", () => {
    expect(sortMarkets([a, b, c], 'popular').map(m => m.id)).toEqual(['b', 'a', 'c'])
  })

  it("sorts by total volume desc when sort='trending'", () => {
    expect(sortMarkets([a, b, c], 'trending').map(m => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [a, b, c]
    sortMarkets(input, 'new')
    expect(input.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('useMarketSort (T4.2.e — exactly one selection at a time)', () => {
  it('defaults to trending', () => {
    const { result } = renderHook(() => useMarketSort([a, b, c]))
    expect(result.current.sort).toBe(DEFAULT_MARKET_SORT)
    expect(result.current.sort).toBe('trending')
  })

  it('switches mutually-exclusively between dimensions', () => {
    const { result } = renderHook(() => useMarketSort([a, b, c]))
    act(() => result.current.setSort('new'))
    expect(result.current.sort).toBe('new')
    expect(result.current.sorted.map(m => m.id)).toEqual(['c', 'b', 'a'])
    act(() => result.current.setSort('popular'))
    expect(result.current.sort).toBe('popular')
    expect(result.current.sorted.map(m => m.id)).toEqual(['b', 'a', 'c'])
  })
})
