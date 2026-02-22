import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { MarketCard } from '../MarketCard'
import type { YesNoMarket, CategoricalMarket } from '@/types/market'

const yesNoMarket: YesNoMarket = {
  id: 'mkt-1',
  title: 'Will BTC reach 100K?',
  type: 'yesno',
  imageUrl: '',
  categoryTags: ['crypto'],
  metaTags: ['trending'],
  currentOdds: { yes: 65.0, no: 35.0 },
  volume: 100000,
  liquidity: 50000,
  traderCount: 200,
  closingDate: '2026-12-31T00:00:00Z',
  createdDate: '2026-01-01T00:00:00Z',
  approvedDate: '2026-01-01T00:00:00Z',
  creatorFeePercent: 2,
  likeCount: 10,
  isLiked: false,
  baseMarket: 'sats',
}

const categoricalMarket: CategoricalMarket = {
  id: 'mkt-2',
  title: 'Who wins the championship?',
  type: 'categorical',
  imageUrl: '',
  categoryTags: ['sports'],
  metaTags: [],
  outcomes: [
    { id: 'a', label: 'Team A', odds: 40 },
    { id: 'b', label: 'Team B', odds: 35 },
    { id: 'c', label: 'Team C', odds: 25 },
  ],
  volume: 50000,
  liquidity: 20000,
  traderCount: 100,
  closingDate: '2026-06-30T00:00:00Z',
  createdDate: '2026-01-01T00:00:00Z',
  approvedDate: '2026-01-01T00:00:00Z',
  creatorFeePercent: 1.5,
  likeCount: 5,
  isLiked: false,
  baseMarket: 'sats',
}

describe('MarketCard', () => {
  it('renders yes/no market with odds and Buy buttons', () => {
    render(<MarketCard market={yesNoMarket} />)

    expect(screen.getByText('Will BTC reach 100K?')).toBeInTheDocument()
    expect(screen.getByText('65.0%')).toBeInTheDocument()
    expect(screen.getByText('Buy YES')).toBeInTheDocument()
    expect(screen.getByText('Buy NO')).toBeInTheDocument()
  })

  it('renders categorical market with outcome list', () => {
    render(<MarketCard market={categoricalMarket} />)

    expect(screen.getByText('Who wins the championship?')).toBeInTheDocument()
    expect(screen.getByText('Team A')).toBeInTheDocument()
    expect(screen.getByText('Team B')).toBeInTheDocument()
    expect(screen.getByText('Team C')).toBeInTheDocument()
  })

  it('opens trading overlay when Buy YES is clicked', async () => {
    const user = userEvent.setup()

    render(<MarketCard market={yesNoMarket} />)

    await user.click(screen.getByText('Buy YES'))

    // Trading overlay should show amount input and BUY button
    expect(screen.getByRole('spinbutton')).toBeInTheDocument()
    expect(screen.getByText(/^BUY/)).toBeInTheDocument()
  })

  it('calls onBuyYes with marketId and amount on confirm', async () => {
    const user = userEvent.setup()
    const onBuyYes = vi.fn()

    render(<MarketCard market={yesNoMarket} onBuyYes={onBuyYes} />)

    await user.click(screen.getByText('Buy YES'))
    await user.click(screen.getByText(/^BUY/))

    expect(onBuyYes).toHaveBeenCalledWith('mkt-1', 1000)
  })

  it('calls onViewMarket when card body is clicked', async () => {
    const user = userEvent.setup()
    const onViewMarket = vi.fn()

    render(<MarketCard market={yesNoMarket} onViewMarket={onViewMarket} />)

    // Click on the title (non-button area)
    await user.click(screen.getByText('Will BTC reach 100K?'))

    expect(onViewMarket).toHaveBeenCalledWith('mkt-1')
  })
})
