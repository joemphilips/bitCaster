import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarketHeader } from '../MarketHeader'
import type { YesNoMarketDetail } from '@/types/market-detail'

const creatorPubkey =
  'npub1creatorprofile000000000000000000000000000000000000abcd'

function makeMarket(
  overrides: Partial<YesNoMarketDetail> = {},
): YesNoMarketDetail {
  return {
    id: 'abc123',
    title: 'Will BTC hit 100K?',
    type: 'yesno',
    imageUrl: undefined,
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: '2030-12-31T23:59:59Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    baseUnit: 'sats',
    mint: {
      collateral: 'sat',
      keysetCount: 2,
    },
    creator: {
      id: creatorPubkey,
      name: `${creatorPubkey.slice(0, 8)}...${creatorPubkey.slice(-4)}`,
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: 'Will BTC hit 100K?',
      source: 'oracle',
      resolutionDate: '2030-12-31T23:59:59Z',
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

describe('MarketHeader', () => {
  it('renders mint metadata beside the creator card', () => {
    render(<MarketHeader market={makeMarket()} />)

    expect(screen.getByText('Mint')).toBeInTheDocument()
    expect(screen.getByText('SAT CTF - 2 keysets')).toBeInTheDocument()
  })

  it('passes the creator pubkey when the creator card is clicked', async () => {
    const user = userEvent.setup()
    const onCreatorClick = vi.fn()
    render(
      <MarketHeader market={makeMarket()} onCreatorClick={onCreatorClick} />,
    )

    const creatorButton = screen.getByText('npub1cre...abcd').closest('button')
    expect(creatorButton).not.toBeNull()
    await user.click(creatorButton!)

    expect(onCreatorClick).toHaveBeenCalledWith(creatorPubkey)
  })

  it('disables creator navigation when the detail has no creator pubkey', async () => {
    const user = userEvent.setup()
    const onCreatorClick = vi.fn()
    render(
      <MarketHeader
        market={makeMarket({
          creator: {
            id: 'unknown',
            name: 'Unknown',
            totalMarketsCreated: 0,
            feePercent: 0,
          },
        })}
        onCreatorClick={onCreatorClick}
      />,
    )

    const creatorButton = screen.getByText('Unknown').closest('button')
    expect(creatorButton).toBeDisabled()
    await user.click(creatorButton!)

    expect(onCreatorClick).not.toHaveBeenCalled()
  })
})
