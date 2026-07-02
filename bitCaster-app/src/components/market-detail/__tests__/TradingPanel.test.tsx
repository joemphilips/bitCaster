import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TradingPanel } from '../TradingPanel'
import type { LimitOrderPreview, TradePreview, YesNoMarketDetail } from '@/types/market-detail'
import { useState } from 'react'

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
    liquiditySubunits: 0,
    volumeLifetimeSubunits: 0,
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
  function StatefulLimitTradingPanel({
    initialLimitPrice = 40,
    initialTradeAmount = 2,
    onLimitPriceChange,
    onAmountChange,
  }: {
    initialLimitPrice?: number
    initialTradeAmount?: number
    onLimitPriceChange?: (price: number) => void
    onAmountChange?: (amount: number) => void
  }) {
    const [limitPrice, setLimitPrice] = useState(initialLimitPrice)
    const [tradeAmount, setTradeAmount] = useState(initialTradeAmount)

    return (
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={tradeAmount}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={limitPrice}
        onLimitPriceChange={(price) => {
          setLimitPrice(price)
          onLimitPriceChange?.(price)
        }}
        onAmountChange={(amount) => {
          setTradeAmount(amount)
          onAmountChange?.(amount)
        }}
      />
    )
  }

  it('uses a share input and only shows market price plus expected cost', () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 30,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSubunits: 150,
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

  it('turns buy submit into a top-up button when local funds are insufficient', () => {
    const onTopUpRequired = vi.fn()
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={vi.fn()}
        onTopUpRequired={onTopUpRequired}
        tradeFeasibility={{
          canBack: false,
          reason: 'funds',
        }}
      />,
    )

    const button = screen.getByTestId('trade-confirm')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('Top up wallet')
    expect(button).not.toHaveAttribute('title')
    expect(screen.getByTestId('trade-feasibility-status')).toHaveTextContent('Insufficient funds')
    expect(screen.queryByRole('button', { name: 'Top up wallet' })).toBe(button)
    expect(screen.queryByText(/VCS/i)).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(onTopUpRequired).toHaveBeenCalledTimes(1)
  })

  it('disables sell submit and shows outcome-token wording when local tokens are insufficient', () => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="sell"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={vi.fn()}
        tradeFeasibility={{
          canBack: false,
          reason: 'outcome-tokens',
        }}
      />,
    )

    const button = screen.getByTestId('trade-confirm')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Insufficient outcome tokens')
    expect(screen.getByTestId('trade-feasibility-status')).toHaveTextContent(
      'Insufficient outcome tokens',
    )
    expect(screen.queryByRole('button', { name: 'Top up wallet' })).not.toBeInTheDocument()
    expect(screen.queryByText(/VCS/i)).not.toBeInTheDocument()
  })

  it('keeps submit enabled when local backing is sufficient', () => {
    const onTradeConfirm = vi.fn()
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={onTradeConfirm}
        tradeFeasibility={{ canBack: true }}
      />,
    )

    const button = screen.getByTestId('trade-confirm')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onTradeConfirm).toHaveBeenCalledTimes(1)
  })

  it('uses market preview totalCost for expected cost when fees are non-zero', () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 30,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSubunits: 150,
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
      quoteSubunits: 1_500,
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
    expect(screen.getByText('0.03 sats (30.00%)')).toBeInTheDocument()
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
      quoteSubunits: 100,
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
    expect(screen.getByText('0.10 sats (1.00%)')).toBeInTheDocument()
    expect(screen.getByTestId('limit-total-cost')).toHaveTextContent(/^0\.101 sats$/)
    expect(screen.getByTestId('limit-total-cost')).not.toHaveTextContent(/^101 sats$/)
  })

  it('displays sat-market limit prices as sats, not raw msat subunits', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 8_500,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 8_500,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 10_000,
      totalCost: 8_500,
    }

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: 'sat', baseUnit: 'sats', divisibility: 10_000 })}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={8_500}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    )

    expect(screen.getByTestId('limit-price-input')).toHaveValue(8.5)
    expect(screen.getByText('8.50 sats (85.00%)')).toBeInTheDocument()
    expect(screen.queryByText('8500 sats')).not.toBeInTheDocument()
  })

  it('uses market divisibility when displaying one-share face value', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 30,
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
      quoteSubunits: 1_500,
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
      quoteSubunits: 1_500,
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

  it('keeps the share input as an integer of at least one on blur', async () => {
    const onAmountChange = vi.fn()
    const user = userEvent.setup()

    render(
      <StatefulLimitTradingPanel
        initialTradeAmount={1}
        onAmountChange={onAmountChange}
      />,
    )

    const amountInput = screen.getByTestId('trade-amount-input') as HTMLInputElement
    await user.clear(amountInput)
    await user.type(amountInput, '50.8')

    expect(amountInput).toHaveValue(50.8)

    fireEvent.blur(amountInput)

    expect(onAmountChange).toHaveBeenCalledWith(51)
    expect(amountInput).toHaveValue(51)
  })

  it('enables confirmation as soon as a valid share amount is typed', async () => {
    const user = userEvent.setup()

    render(<StatefulLimitTradingPanel initialTradeAmount={0} />)

    const confirm = screen.getByTestId('trade-confirm')
    expect(confirm).toBeDisabled()

    await user.type(screen.getByTestId('trade-amount-input'), '1')

    expect(confirm).toBeEnabled()
  })

  it('allows the limit price to be cleared and replaced before committing on blur', async () => {
    const onLimitPriceChange = vi.fn()
    const user = userEvent.setup()

    render(<StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />)

    const priceInput = screen.getByTestId('limit-price-input') as HTMLInputElement
    await user.clear(priceInput)

    expect(priceInput).toHaveValue(null)
    expect(onLimitPriceChange).not.toHaveBeenCalled()

    await user.type(priceInput, '0.75')
    expect(priceInput).toHaveValue(0.75)
    expect(onLimitPriceChange).not.toHaveBeenCalled()

    fireEvent.blur(priceInput)

    expect(onLimitPriceChange).toHaveBeenCalledWith(75)
    expect(priceInput).toHaveValue(0.75)
  })

  it('clamps the limit price to the market tick range on blur', async () => {
    const onLimitPriceChange = vi.fn()
    const user = userEvent.setup()

    render(<StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />)

    const priceInput = screen.getByTestId('limit-price-input') as HTMLInputElement
    await user.clear(priceInput)
    await user.type(priceInput, '5000')
    fireEvent.blur(priceInput)

    expect(onLimitPriceChange).toHaveBeenCalledWith(999)
    expect(priceInput).toHaveValue(9.99)
  })

  it('restores the previous valid limit price when the field is empty on blur', async () => {
    const onLimitPriceChange = vi.fn()
    const user = userEvent.setup()

    render(<StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />)

    const priceInput = screen.getByTestId('limit-price-input') as HTMLInputElement
    await user.clear(priceInput)

    expect(priceInput).toHaveValue(null)

    fireEvent.blur(priceInput)

    expect(onLimitPriceChange).not.toHaveBeenCalled()
    expect(priceInput).toHaveValue(0.4)
  })

  it('does not overwrite an in-progress limit price edit when live props refresh', async () => {
    const user = userEvent.setup()

    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={40}
      />,
    )

    const priceInput = screen.getByTestId('limit-price-input') as HTMLInputElement
    await user.click(priceInput)
    await user.clear(priceInput)
    await user.type(priceInput, '0.75')

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={60}
      />,
    )

    expect(priceInput).toHaveValue(0.75)
  })

  it('does not overwrite an in-progress share amount edit when live props refresh', async () => {
    const user = userEvent.setup()

    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={40}
      />,
    )

    const amountInput = screen.getByTestId('trade-amount-input') as HTMLInputElement
    await user.click(amountInput)
    await user.clear(amountInput)
    await user.type(amountInput, '123')

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: 'yes' }}
        tradeAmount={9}
        tradePreview={null}
        tradeSide="buy"
        orderType="limit"
        limitPrice={40}
      />,
    )

    expect(amountInput).toHaveValue(123)
  })

  it('allows the share amount to be cleared and restores zero on empty blur', async () => {
    const onAmountChange = vi.fn()
    const user = userEvent.setup()

    render(<StatefulLimitTradingPanel initialTradeAmount={2} onAmountChange={onAmountChange} />)

    const amountInput = screen.getByTestId('trade-amount-input') as HTMLInputElement
    await user.clear(amountInput)

    expect(amountInput).toHaveValue(null)
    expect(onAmountChange).toHaveBeenCalledWith(0)

    fireEvent.blur(amountInput)

    expect(onAmountChange).toHaveBeenCalledWith(0)
    expect(amountInput).toHaveValue(null)
  })

  it('respects price ticks for D=100 and D=1000', () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 30,
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

    expect(screen.getByText('$0.30 (30.00%)')).toBeInTheDocument()

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
          quoteSubunits: 301,
          potentialPayout: 1_000,
          totalCost: 301,
        }}
      />,
    )

    expect(screen.getByText('$3.01 (30.10%)')).toBeInTheDocument()
  })
})
