import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { MarketDiscovery } from '../MarketDiscovery'
import type { Market, CategoryTag } from '@/types/market'

const testCategoryTags: CategoryTag[] = [
  { id: 'sports', label: 'Sports', marketCount: 10 },
]

const testMarkets: Market[] = [
  {
    id: 'test-001',
    title: 'Will Bitcoin reach $100K?',
    type: 'yesno',
    state: 'open',
    imageUrl: '',
    categoryTags: ['crypto'],
    metaTags: ['trending'],
    currentOdds: { yes: 60, no: 40 },
    volume: 1000,
    liquidity: 500,
    traderCount: 10,
    closingDate: '2026-12-31T23:59:59Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    creatorFeePercent: 2,
    baseMarket: 'sats',
  },
  {
    id: 'test-002',
    title: 'NBA Championship Winner',
    type: 'categorical',
    state: 'open',
    imageUrl: '',
    categoryTags: ['sports'],
    metaTags: [],
    outcomes: [
      { id: 'lakers', label: 'Lakers', odds: 50 },
      { id: 'celtics', label: 'Celtics', odds: 50 },
    ],
    volume: 500,
    liquidity: 200,
    traderCount: 5,
    closingDate: '2026-06-30T23:59:59Z',
    createdDate: '2026-01-01T00:00:00Z',
    activeSince: '2026-01-01T00:00:00Z',
    creatorFeePercent: 1.5,
    baseMarket: 'sats',
  },
]

describe('MarketDiscovery', () => {
  it('renders SortBar (Row 1), TagBar (Row 2), and market grid', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />
    )

    // Row 1 — sort buttons live in their own bar
    expect(screen.getByTestId('market-sort-trending')).toBeInTheDocument()
    expect(screen.getByTestId('market-sort-popular')).toBeInTheDocument()
    expect(screen.getByTestId('market-sort-new')).toBeInTheDocument()

    // Row 2 — category tags
    expect(screen.getByText('Sports')).toBeInTheDocument()

    // Cards rendered
    expect(screen.getByText('Will Bitcoin reach $100K?')).toBeInTheDocument()
  })

  it('shows empty state when markets array is empty', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={[]}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />
    )

    expect(screen.getByText('No markets found')).toBeInTheDocument()
  })

  it('renders sort pills and category chips on a single discovery row (Issue 5.1)', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />
    )

    const row = screen.getByTestId('market-discovery-bar')
    const trendingPill = screen.getByTestId('market-sort-trending')
    const sportsChip = screen.getByText('Sports').closest('button')!

    // Both must live inside the same flex row — proven by walking up
    // from each leaf and asserting they share the discovery-bar parent.
    expect(row).toContainElement(trendingPill)
    expect(row).toContainElement(sportsChip)
  })

  it('stacks discovery controls on mobile and keeps tags in their own scroll lane', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('market-discovery-bar')).toHaveClass('flex-col')
    expect(screen.getByTestId('market-discovery-bar')).toHaveClass('md:flex-row')
    expect(screen.getByTestId('market-tag-bar')).toHaveClass('min-w-0')
    expect(screen.getByTestId('market-tag-scroller')).toHaveClass('overflow-x-auto')
  })

  it('forwards SortBar interactions to onSortChange (T4.2.a)', async () => {
    const user = userEvent.setup()
    const onSortChange = vi.fn()
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={onSortChange}
      />
    )

    await user.click(screen.getByTestId('market-sort-new'))
    expect(onSortChange).toHaveBeenCalledWith('new')
  })

  it('forwards the include-closed filter toggle', async () => {
    const user = userEvent.setup()
    const onIncludeClosedChange = vi.fn()
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        onIncludeClosedChange={onIncludeClosedChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /filters/i }))
    await user.click(screen.getByLabelText('Include closed'))

    expect(onIncludeClosedChange).toHaveBeenCalledWith(true)
  })
})
