import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarketDetail } from '../MarketDetail'
import type { MarketDetail as MarketDetailType, TradePreview } from '@/types/market-detail'

vi.mock('../MarketHeader', () => ({ MarketHeader: () => <div /> }))
vi.mock('../TradingPanel', () => ({ TradingPanel: () => <div /> }))
vi.mock('../PriceChart', () => ({ PriceChart: () => <div /> }))
vi.mock('../OrderBookSection', () => ({ OrderBookSection: () => <div /> }))
vi.mock('../ResolutionInfo', () => ({ ResolutionInfo: () => <div /> }))
vi.mock('../RelatedMarkets', () => ({ RelatedMarkets: () => <div /> }))
vi.mock('../CommentSection', () => ({ CommentSection: () => <div /> }))

function makeMarket(): MarketDetailType {
  return {
    id: 'condition-1',
    title: 'Will it happen?',
    type: 'yesno',
    imageUrl: '',
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySats: 0,
    volumeLifetimeSats: 0,
    closingDate: '2030-01-01T00:00:00Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    state: 'open',
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
  }
}

describe('MarketDetail', () => {
  it('disables the mobile sticky confirm for market orders without executable liquidity', () => {
    const noLiquidityPreview: TradePreview = {
      amount: 1,
      predictedOdds: 0,
      priceImpact: 0,
      executableShares: 0,
      hasExecutableLiquidity: false,
      quoteSats: 0,
      mintFee: 0,
      potentialPayout: 0,
      creatorFee: 0,
      engineScoreFeeSats: 0,
      totalCost: 0,
    }

    render(
      <MarketDetail
        market={makeMarket()}
        chartTimeframe="7d"
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={noLiquidityPreview}
        tradeSide="buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    )

    expect(screen.getByText('No liquidity')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })
})
