import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Market } from '@/types/market'
import { useBookmarkStore } from '@/stores/bookmarks'

const { mockFetchMarkets } = vi.hoisted(() => ({
  mockFetchMarkets: vi.fn(),
}))

vi.mock('@/lib/markets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/markets')>('@/lib/markets')
  return {
    ...actual,
    fetchMarkets: (...args: unknown[]) => mockFetchMarkets(...args),
  }
})

import { LikedMarkets } from '../LikedMarkets'

function makeMarket(id: string, title = `Market ${id}`): Market {
  const now = new Date().toISOString()
  return {
    id,
    title,
    type: 'yesno',
    imageUrl: '',
    categoryTags: [],
    metaTags: [],
    currentOdds: { yes: 50, no: 50 },
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    creatorFeePercent: 0,
    baseMarket: 'sats',
  } as Market
}

beforeEach(() => {
  mockFetchMarkets.mockReset()
  useBookmarkStore.setState({ markets: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LikedMarkets (P5.1)', () => {
  it('renders the empty state when the user has no bookmarks', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a')])
    render(<LikedMarkets />)
    expect(await screen.findByTestId('liked-markets-empty')).toBeInTheDocument()
  })

  it('renders one card per bookmarked market with click-through', async () => {
    mockFetchMarkets.mockResolvedValue([makeMarket('a', 'Alpha'), makeMarket('b', 'Beta')])
    useBookmarkStore.setState({ markets: ['a', 'b'] })
    const user = userEvent.setup()
    const onViewMarket = vi.fn()
    render(<LikedMarkets onViewMarket={onViewMarket} />)

    await waitFor(() => {
      expect(screen.getByTestId('liked-markets-scroller')).toBeInTheDocument()
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()

    await user.click(screen.getByTestId('liked-market-card-a'))
    expect(onViewMarket).toHaveBeenCalledWith('a')
  })

  it('shows an error message when the catalogue fetch fails', async () => {
    mockFetchMarkets.mockRejectedValue(new Error('boom'))
    useBookmarkStore.setState({ markets: ['a'] })
    render(<LikedMarkets />)
    expect(await screen.findByTestId('liked-markets-error')).toBeInTheDocument()
  })
})
