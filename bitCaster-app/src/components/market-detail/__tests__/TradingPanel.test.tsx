import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TradingPanel } from '../TradingPanel'
import type { TradePreview, YesNoMarketDetail } from '@/types/market-detail'

function makeMarket(
  overrides: Partial<YesNoMarketDetail> = {},
): YesNoMarketDetail {
  return {
    id: 'usd-market',
    title: 'Will it happen?',
    type: 'yesno',
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySats: 0,
    traderCount: 0,
    volumeLifetimeSats: 0,
    closingDate: '2030-01-01T00:00:00Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    baseAsset: 'usd',
    divisibility: 100,
    baseUnit: 'USD',
    creator: {
      id: 'creator',
      name: 'Creator',
      totalMarketsCreated: 0,
      feePercent: 1,
    },
    resolution: {
      criteria: 'Will it happen?',
      source: 'oracle',
      resolutionDate: '2030-01-01T00:00:00Z',
      status: 'open',
    },
    priceHistory: { data: [], timeframe: '7d' },
    orderBook: { bids: [], asks: [], spread: 0 },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    ...overrides,
  }
}

describe('TradingPanel', () => {
  it('uses market base-asset labels for USD trade amounts', () => {
    const tradePreview: TradePreview = {
      amount: 100,
      predictedOdds: 50,
      priceImpact: 0,
      potentialPayout: 200,
      creatorFee: 1,
      platformFee: 0,
      totalCost: 100,
    }

    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={100}
        tradePreview={tradePreview}
        tradeSide="buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('Amount (cents)')).toBeInTheDocument()
    expect(screen.getByText('1 share = $1.00')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Buy YES for $1.00' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument()
  })
})
