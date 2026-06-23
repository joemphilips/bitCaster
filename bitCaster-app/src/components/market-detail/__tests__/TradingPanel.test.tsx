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
    divisibility: 1_000,
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
  it('uses a share input and only shows market price plus expected cost', () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 30,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSats: 150,
      mintFee: 0,
      potentialPayout: 500,
      creatorFee: 1,
      engineScoreFeeSats: 0,
      totalCost: 150,
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
    expect(screen.getByText('1 share = $10.00')).toBeInTheDocument()
    expect(screen.getByText('Price per share')).toBeInTheDocument()
    expect(screen.getByTestId('trade-total-cost')).toHaveTextContent('$1.50')
    expect(
      screen.getByRole('button', { name: 'Buy YES for 50 shares' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Executable shares')).not.toBeInTheDocument()
    expect(screen.queryByText('Market Creator fee (1%)')).not.toBeInTheDocument()
    expect(screen.queryByText('Mint fee')).not.toBeInTheDocument()
    expect(screen.queryByText('Engine Score fee')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Gross settlement payout per filled share if this outcome wins'),
    ).not.toBeInTheDocument()
  })

  it('uses market preview totalCost for expected cost when fees are non-zero', () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 30,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSats: 150,
      mintFee: 100,
      potentialPayout: 500,
      creatorFee: 1,
      engineScoreFeeSats: 0,
      totalCost: 250,
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

    expect(screen.getByTestId('trade-total-cost')).toHaveTextContent('$2.50')
  })

  it('formats sat-denominated limit preview as price plus expected cost only', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSats: 1_500,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 500,
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

    expect(screen.getByText('Price per share')).toBeInTheDocument()
    expect(screen.getByText('30 (30.00%)')).toBeInTheDocument()
    expect(screen.getByText('Total expected cost')).toBeInTheDocument()
    expect(screen.getByTestId('limit-total-cost')).toHaveTextContent('1.5 sats')
    expect(screen.queryByText('Shares you receive if order fills')).not.toBeInTheDocument()
    expect(screen.queryByText('Market Creator fee (1%)')).not.toBeInTheDocument()
    expect(screen.queryByText('Mint fee')).not.toBeInTheDocument()
    expect(screen.queryByText('Engine Score fee')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Gross settlement payout per filled share if this outcome wins'),
    ).not.toBeInTheDocument()
  })

  it('formats P40 sat-market subunit totals as display sats', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 100,
      amount: 1,
      sharesIfFilled: 1,
      quoteSats: 100,
      creatorFee: 0,
      mintFee: 1,
      engineScoreFeeSats: 0,
      potentialPayout: 10_000,
      totalCost: 101,
    }

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: 'sat', baseUnit: 'sats', divisibility: 10_000 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={100}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('1 share = 10 sats')).toBeInTheDocument()
    expect(screen.getByText('100 (1.00%)')).toBeInTheDocument()
    expect(screen.getByTestId('limit-total-cost')).toHaveTextContent(/^0\.101 sats$/)
    expect(screen.getByTestId('limit-total-cost')).not.toHaveTextContent(/^101 sats$/)
  })

  it('uses market divisibility when displaying one-share face value', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 1,
      sharesIfFilled: 1,
      quoteSats: 30,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 100,
      totalCost: 30,
    }

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: 'sat', baseUnit: 'sats', divisibility: 100 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('1 share = 0.1 sats')).toBeInTheDocument()
  })

  it('does not show fee rows in the simplified limit preview', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSats: 1_500,
      creatorFee: 15,
      mintFee: 2,
      engineScoreFeeSats: 0,
      potentialPayout: 500,
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
      screen.queryByTitle('Paid to the market creator as a reward for creating this market'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTitle('Charged by the Cashu mint for processing the transaction'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTitle('Charged by the matching engine for order execution'),
    ).not.toBeInTheDocument()
  })

  it('uses limit preview totalCost for expected cost when fees are non-zero', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSats: 1_500,
      creatorFee: 500,
      mintFee: 250,
      engineScoreFeeSats: 0,
      potentialPayout: 500,
      totalCost: 2_250,
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

    expect(screen.getByTestId('limit-total-cost')).toHaveTextContent('2.25 sats')
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

  it('respects price ticks for D=100 and D=1000', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 1,
      sharesIfFilled: 1,
      quoteSats: 30,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 100,
      totalCost: 30,
    }

    const { rerender } = render(
      <TradingPanel
        market={makeMarket({ divisibility: 100 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
      />,
    )

    expect(screen.getByText('30 (30.00%)')).toBeInTheDocument()

    rerender(
      <TradingPanel
        market={makeMarket({ divisibility: 1_000 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={301}
        limitOrderPreview={{
          ...preview,
          limitPrice: 301,
          quoteSats: 301,
          potentialPayout: 1_000,
          totalCost: 301,
        }}
      />,
    )

    expect(screen.getByText('301 (30.10%)')).toBeInTheDocument()
  })
})
