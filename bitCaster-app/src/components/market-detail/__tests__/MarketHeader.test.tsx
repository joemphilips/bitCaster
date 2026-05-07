import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'
import { MarketHeader } from '../MarketHeader'
import type { YesNoMarketDetail } from '@/types/market-detail'

const creatorPubkey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const creatorNpub = nip19.npubEncode(creatorPubkey)

interface NavigatorMutable {
  clipboard?: { writeText: (text: string) => Promise<void> }
}

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
  let originalClipboard: NavigatorMutable['clipboard']

  beforeEach(() => {
    originalClipboard = (navigator as unknown as NavigatorMutable).clipboard
  })

  afterEach(() => {
    if (originalClipboard === undefined) {
      delete (navigator as unknown as NavigatorMutable).clipboard
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
        writable: true,
      })
    }
  })

  it('renders mint metadata beside the creator card', () => {
    render(<MarketHeader market={makeMarket()} />)

    expect(screen.getByText('Mint')).toBeInTheDocument()
    expect(screen.getByText('SAT CTF - 2 keysets')).toBeInTheDocument()
  })

  it('renders a shortened oracle npub and copies the full npub', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
      writable: true,
    })
    render(<MarketHeader market={makeMarket()} />)

    expect(
      screen.getByText(`${creatorNpub.slice(0, 10)}...${creatorNpub.slice(-6)}`),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy oracle pubkey' }))

    expect(writeText).toHaveBeenCalledWith(creatorNpub)
  })

  it('does not render a copy button when the detail has no creator pubkey', () => {
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
      />,
    )

    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copy oracle pubkey' }),
    ).not.toBeInTheDocument()
  })
})
