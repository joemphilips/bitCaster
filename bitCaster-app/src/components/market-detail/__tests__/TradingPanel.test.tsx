import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TradingPanel } from '../TradingPanel'
import type { LimitOrderPreview, TradePreview, YesNoMarketDetail } from '@/types/market-detail'

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
  it('uses a share input while keeping market base-asset labels for payouts', () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      quoteSats: 1_500,
      mintFee: 0,
      potentialPayout: 5_000,
      creatorFee: 1,
      engineScoreFeeSats: 0,
      totalCost: 1_501,
    }

    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={50}
        tradePreview={tradePreview}
        tradeSide="buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('Shares')).toBeInTheDocument()
    expect(screen.getByText('1 share = $1.00')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Buy YES for 50 shares' }),
    ).toBeInTheDocument()
    expect(screen.getByText('0 sats')).toBeInTheDocument()
  })

  it('pins 50 shares at price 30 for D=100 as 1,500 sats cost and 5,000 sats payout', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSats: 1_500,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 5_000,
      totalCost: 1_500,
    }

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: 'sat', baseUnit: 'sats', divisibility: 100 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={50}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('30 (30%)')).toBeInTheDocument()
    expect(screen.getByText('Shares you receive if order fills')).toBeInTheDocument()
    expect(screen.getByText('Market Creator fee (1%)')).toBeInTheDocument()
    expect(screen.getAllByText('0 sats')).toHaveLength(3)
    expect(screen.getByTestId('limit-total-cost')).toHaveTextContent('1,500 sats')
    expect(screen.getByTestId('limit-payout-if-win')).toHaveTextContent('5,000 sats')
  })

  it('shows fee tooltips on each fee row', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSats: 1_500,
      creatorFee: 15,
      mintFee: 2,
      engineScoreFeeSats: 0,
      potentialPayout: 5_000,
      totalCost: 1_517,
    }

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: 'sat', baseUnit: 'sats', divisibility: 100 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={50}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(
      screen.getByTitle('Paid to the market creator as a reward for creating this market'),
    ).toBeInTheDocument()
    expect(
      screen.getByTitle('Charged by the Cashu mint for processing the transaction'),
    ).toBeInTheDocument()
    expect(
      screen.getByTitle('Charged by the matching engine for order execution'),
    ).toBeInTheDocument()
  })

  it('keeps the share input as an integer of at least one when editing', () => {
    const onAmountChange = vi.fn()

    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        onAmountChange={onAmountChange}
        onTradeConfirm={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('trade-amount-input'), {
      target: { value: '50.8' },
    })

    expect(onAmountChange).toHaveBeenCalledWith(50)
  })

  it('respects finer price ticks for D=1000 and D=10000', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 301,
      amount: 1,
      sharesIfFilled: 1,
      quoteSats: 301,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 1_000,
      totalCost: 301,
    }

    const { rerender } = render(
      <TradingPanel
        market={makeMarket({ divisibility: 1_000 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={301}
        limitOrderPreview={preview}
      />,
    )

    expect(screen.getByText('301 (30.1%)')).toBeInTheDocument()

    rerender(
      <TradingPanel
        market={makeMarket({ divisibility: 10_000 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={3_015}
        limitOrderPreview={{
          ...preview,
          limitPrice: 3_015,
          quoteSats: 3_015,
          potentialPayout: 10_000,
          totalCost: 3_015,
        }}
      />,
    )

    expect(screen.getByText('3,015 (30.15%)')).toBeInTheDocument()
  })
})
