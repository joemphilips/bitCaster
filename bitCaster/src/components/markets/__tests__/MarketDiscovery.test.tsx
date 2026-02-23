import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MarketDiscovery } from '../MarketDiscovery'
import type { Market, MetaTag, CategoryTag } from '@/types/market'

const testMetaTags: MetaTag[] = [
  { id: 'trending', label: 'Trending', description: 'High activity' },
]

const testCategoryTags: CategoryTag[] = [
  { id: 'sports', label: 'Sports', marketCount: 10 },
]

const testMarkets: Market[] = [
  {
    id: 'test-001',
    title: 'Will Bitcoin reach $100K?',
    type: 'yesno',
    imageUrl: '',
    categoryTags: ['crypto'],
    metaTags: ['trending'],
    currentOdds: { yes: 60, no: 40 },
    volume: 1000,
    liquidity: 500,
    traderCount: 10,
    closingDate: '2026-12-31T23:59:59Z',
    createdDate: '2026-01-01T00:00:00Z',
    approvedDate: '2026-01-01T00:00:00Z',
    creatorFeePercent: 2,
    likeCount: 0,
    isLiked: false,
    baseMarket: 'sats',
  },
  {
    id: 'test-002',
    title: 'NBA Championship Winner',
    type: 'categorical',
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
    approvedDate: '2026-01-01T00:00:00Z',
    creatorFeePercent: 1.5,
    likeCount: 0,
    isLiked: false,
    baseMarket: 'sats',
  },
]

describe('MarketDiscovery', () => {
  it('renders TagBar and market grid with markets', () => {
    render(
      <MarketDiscovery
        metaTags={testMetaTags}
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTag={null}
      />
    )

    // TagBar rendered
    expect(screen.getByText('Trending')).toBeInTheDocument()
    expect(screen.getByText('Sports')).toBeInTheDocument()

    // Market cards rendered
    expect(screen.getByText('Will Bitcoin reach $100K?')).toBeInTheDocument()
  })

  it('shows empty state when markets array is empty', () => {
    render(
      <MarketDiscovery
        metaTags={testMetaTags}
        categoryTags={testCategoryTags}
        markets={[]}
        selectedTag={null}
      />
    )

    expect(screen.getByText('No markets found')).toBeInTheDocument()
  })
})
