import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMarketDetailWithBooks } from '@/pages/MarketDetailPage'
import { fetchMarketDetail, fetchOrderBook } from '@/lib/markets'
import type { MarketDetail, OrderBook } from '@/types/market-detail'

vi.mock('@/lib/markets', () => ({
  fetchMarketDetail: vi.fn(),
  fetchOrderBook: vi.fn(),
  submitOrder: vi.fn(),
}))

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 }

function book(price: number): OrderBook {
  return {
    bids: [{ price, amount: 100, total: 100 }],
    asks: [],
    spread: 0,
  }
}

function categoricalMarket(): MarketDetail {
  return {
    id: 'condition-1',
    title: 'Winner',
    type: 'categorical',
    imageUrl: '',
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySats: 0,
    volumeLifetimeSats: 0,
    closingDate: '2026-12-31T00:00:00Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    baseUnit: 'sats',
    creator: {
      id: 'creator',
      name: 'creator',
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    outcomes: [
      { id: 'outcome-0', label: 'Alice', odds: 33.33 },
      { id: 'outcome-1', label: 'Bob', odds: 33.33 },
      { id: 'outcome-2', label: 'Carol', odds: 33.33 },
    ],
    resolution: {
      criteria: 'Winner',
      source: 'oracle',
      resolutionDate: '2026-12-31T00:00:00Z',
      status: 'open',
    },
    priceHistory: { data: [], timeframe: '7d' },
    orderBook: emptyBook,
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    outcomePriceHistories: {},
    outcomeOrderBooks: {},
  }
}

describe('fetchMarketDetailWithBooks', () => {
  beforeEach(() => {
    vi.mocked(fetchMarketDetail).mockReset()
    vi.mocked(fetchOrderBook).mockReset()
  })

  it('fetches singleton and complement outcome-set books for categorical markets', async () => {
    vi.mocked(fetchMarketDetail).mockResolvedValue(categoricalMarket())
    vi.mocked(fetchOrderBook).mockImplementation(async (marketId) =>
      book(marketId.length),
    )

    const detail = await fetchMarketDetailWithBooks('condition-1')

    expect(fetchOrderBook).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetchOrderBook).mock.calls.map(([marketId]) => marketId)).toEqual([
      'condition-1-Alice',
      'condition-1-Bob',
      'condition-1-Carol',
    ])
    expect(detail.outcomeOrderBooks).toHaveProperty('Alice')
    expect(detail.outcomeOrderBooks).not.toHaveProperty('Bob|Carol')
  })
})
