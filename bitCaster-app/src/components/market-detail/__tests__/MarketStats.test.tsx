import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarketStats } from '../MarketStats'
import type { YesNoMarketDetail } from '@/types/market-detail'

function makeMarket(overrides: Partial<YesNoMarketDetail> = {}): YesNoMarketDetail {
  return {
    id: 'market-1',
    title: 'Will it happen?',
    type: 'yesno',
    imageUrl: '',
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: '2030-01-01T00:00:00Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-02T00:00:00Z',
    baseAsset: 'sat',
    divisibility: 1_000,
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
    ...overrides,
  }
}

describe('MarketStats bot budget', () => {
  it('shows non-zero funded USD bot budget in dollars', () => {
    render(
      <MarketStats
        market={makeMarket({
          baseAsset: 'usd',
          baseUnit: 'USD',
          divisibility: 1_000,
          ammBotBudgetSubunits: 1_234,
        })}
      />,
    )

    const budget = screen.getByTestId('market-bot-budget')
    expect(within(budget).getByText('$12.34')).toBeInTheDocument()
    expect(budget).not.toHaveTextContent('0 sats')
  })

  it('shows zero for unfunded markets', () => {
    render(<MarketStats market={makeMarket({ ammBotBudgetSubunits: 0 })} />)

    expect(screen.getByTestId('market-bot-budget')).toHaveTextContent('0 sats')
  })
})
