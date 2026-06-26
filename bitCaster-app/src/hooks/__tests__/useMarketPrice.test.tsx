import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradeExecuted } from '@/lib/marketHub'
import type { MarketDetail, OrderBook } from '@/types/market-detail'

const { tradeHandlers } = vi.hoisted(() => ({
  tradeHandlers: new Map<string, (trade: TradeExecuted) => void>(),
}))

vi.mock('@/lib/marketHub', () => ({
  onTradeExecuted: (marketId: string, handler: (trade: TradeExecuted) => void) => {
    tradeHandlers.set(marketId, handler)
    return () => tradeHandlers.delete(marketId)
  },
}))

import { useMarketPrice } from '../useMarketPrice'

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 }

function makeMarket(overrides: Partial<MarketDetail> = {}): MarketDetail {
  return {
    id: 'condition-1',
    type: 'yesno',
    title: 'Will this test pass?',
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: null,
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    baseAsset: 'sat',
    divisibility: 100,
    baseUnit: 'sats',
    creator: {
      id: 'creator',
      name: 'Creator',
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: 'test',
      source: 'oracle',
      resolutionDate: '2026-01-02T00:00:00Z',
      status: 'open',
    },
    currentOdds: { yes: 50, no: 50 },
    priceHistory: { timeframe: '7d', data: [] },
    orderBook: emptyBook,
    outcomeOrderBooks: {},
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    ...overrides,
  } as MarketDetail
}

beforeEach(() => {
  vi.clearAllMocks()
  tradeHandlers.clear()
})

describe('useMarketPrice', () => {
  it('falls back to the midpoint default when no trades exist', () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 0, no: 100 } }),
        marketId: 'condition-1-Yes',
        outcomeSetId: 'Yes',
        orderBook: emptyBook,
      }),
    )

    expect(result.current.currentPrice).toBe(50)
    expect(result.current.defaultOrderPrice).toBe(50)
  })

  it('updates current price from the latest trade event', () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket(),
        marketId: 'condition-1-Yes',
        outcomeSetId: 'Yes',
        orderBook: emptyBook,
      }),
    )

    act(() => {
      tradeHandlers.get('condition-1-Yes')?.({
        executionPrice: 63,
        amountSubunits: 10,
        side: 'buy',
        timestamp: '2026-01-01T00:01:00Z',
      })
    })

    expect(result.current.currentPrice).toBe(63)
    expect(result.current.defaultOrderPrice).toBe(63)
  })

  it('uses the spread midpoint as the order entry default when both sides exist', () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 60, no: 40 } }),
        marketId: 'condition-1-Yes',
        outcomeSetId: 'Yes',
        orderBook: {
          bids: [{ price: 40, amount: 1, total: 1 }],
          asks: [{ price: 70, amount: 1, total: 1 }],
          spread: 30,
        },
      }),
    )

    expect(result.current.currentPrice).toBe(60)
    expect(result.current.defaultOrderPrice).toBe(55)
  })

  it('uses current price as the order entry default when there is no spread', () => {
    const { result } = renderHook(() =>
      useMarketPrice({
        market: makeMarket({ currentOdds: { yes: 65, no: 35 } }),
        marketId: 'condition-1-Yes',
        outcomeSetId: 'Yes',
        orderBook: {
          bids: [{ price: 40, amount: 1, total: 1 }],
          asks: [],
          spread: 0,
        },
      }),
    )

    expect(result.current.defaultOrderPrice).toBe(65)
  })

  it("does not override the user's manual price edit in a page-style consumer", () => {
    const bookWithoutSpread = {
      bids: [{ price: 40, amount: 1, total: 1 }],
      asks: [],
      spread: 0,
    }
    const bookWithSpread = {
      bids: [{ price: 40, amount: 1, total: 1 }],
      asks: [{ price: 70, amount: 1, total: 1 }],
      spread: 30,
    }
    let manuallyEdited = false
    let limitPrice = 0

    const { result, rerender } = renderHook(
      ({ orderBook }: { orderBook: OrderBook }) => {
        const marketPrice = useMarketPrice({
          market: makeMarket({ currentOdds: { yes: 60, no: 40 } }),
          marketId: 'condition-1-Yes',
          outcomeSetId: 'Yes',
          orderBook,
        })
        if (!manuallyEdited) limitPrice = marketPrice.defaultOrderPrice
        return marketPrice
      },
      { initialProps: { orderBook: bookWithoutSpread } },
    )

    expect(limitPrice).toBe(60)
    manuallyEdited = true
    limitPrice = 42

    rerender({ orderBook: bookWithSpread })

    expect(result.current.defaultOrderPrice).toBe(55)
    expect(limitPrice).toBe(42)
  })
})
