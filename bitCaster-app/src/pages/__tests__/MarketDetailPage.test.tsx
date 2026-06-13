import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decideTradeCollateralGate,
  fetchMarketDetailWithBooks,
  resolvePreflightSplitBuyCollateralRequirement,
} from '@/pages/MarketDetailPage'
import { fetchMarketDetail, fetchOrderBook } from '@/lib/markets'
import type { MarketDetail, OrderBook } from '@/types/market-detail'

const mocks = vi.hoisted(() => ({
  resolveRootPreflightOutputAmountSats: vi.fn(),
}))

vi.mock('@/lib/markets', () => ({
  fetchMarketDetail: vi.fn(),
  fetchOrderBook: vi.fn(),
  submitOrder: vi.fn(),
}))

vi.mock('@/lib/ctfSplit', () => ({
  resolveRootPreflightOutputAmountSats:
    mocks.resolveRootPreflightOutputAmountSats,
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
    baseAsset: 'sat',
    divisibility: 100,
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
    mocks.resolveRootPreflightOutputAmountSats.mockReset()
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

describe('resolvePreflightSplitBuyCollateralRequirement', () => {
  beforeEach(() => {
    mocks.resolveRootPreflightOutputAmountSats.mockReset()
  })

  it('uses face-value root collateral for non-crossing preflight limit buys', async () => {
    mocks.resolveRootPreflightOutputAmountSats.mockResolvedValue(100)
    const market = categoricalMarket()
    market.outcomeOrderBooks = {
      Alice: { bids: [], asks: [], spread: 0 },
      'Bob|Carol': { bids: [{ price: 20, amount: 100, total: 100 }], asks: [], spread: 0 },
    }

    const required = await resolvePreflightSplitBuyCollateralRequirement({
      activeMintUrl: 'https://mint.example',
      preflightSplit: true,
      market,
      tradeSelection: { side: 'yes', outcomeId: 'outcome-0' },
      tradeAmount: 1,
      tradeSide: 'buy',
      orderType: 'limit',
      limitPrice: 40,
    })

    expect(required).toBe(100)
    expect(mocks.resolveRootPreflightOutputAmountSats).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example',
      baseAsset: 'sat',
      conditionId: 'condition-1',
      amountSats: 100,
      keepOutcomeSetId: 'Alice',
      lockOutcomeSetId: 'Bob|Carol',
    })
  })

  it('does not replace cost gating when the limit buy can cross immediately', async () => {
    const market = categoricalMarket()
    market.outcomeOrderBooks = {
      Alice: { bids: [], asks: [{ price: 40, amount: 100, total: 100 }], spread: 0 },
      'Bob|Carol': emptyBook,
    }

    const required = await resolvePreflightSplitBuyCollateralRequirement({
      activeMintUrl: 'https://mint.example',
      preflightSplit: true,
      market,
      tradeSelection: { side: 'yes', outcomeId: 'outcome-0' },
      tradeAmount: 1,
      tradeSide: 'buy',
      orderType: 'limit',
      limitPrice: 40,
    })

    expect(required).toBeNull()
    expect(mocks.resolveRootPreflightOutputAmountSats).not.toHaveBeenCalled()
  })
})

describe('decideTradeCollateralGate', () => {
  it('returns top-up when balance covers quoted cost but not preflight face collateral', () => {
    expect(
      decideTradeCollateralGate({
        balance: 50,
        tradeSide: 'buy',
        tradeFaceAmount: 100,
        requiredBuyCost: 40,
        preflightSplitRequirement: 100,
      }),
    ).toEqual({ kind: 'top-up', balance: 50, required: 100 })
  })

  it('proceeds when balance covers preflight face collateral', () => {
    expect(
      decideTradeCollateralGate({
        balance: 100,
        tradeSide: 'buy',
        tradeFaceAmount: 100,
        requiredBuyCost: 40,
        preflightSplitRequirement: 100,
      }),
    ).toEqual({ kind: 'proceed', balance: 100, required: 100 })
  })
})
