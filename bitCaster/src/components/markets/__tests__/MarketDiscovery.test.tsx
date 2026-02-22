import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MarketDiscovery } from '../MarketDiscovery'
import { getSampleMetaTags, getSampleCategoryTags, getSampleMarkets } from '@/lib/sample-markets'

describe('MarketDiscovery', () => {
  it('renders TagBar and market grid with markets', () => {
    const markets = getSampleMarkets().slice(0, 2)

    render(
      <MarketDiscovery
        metaTags={getSampleMetaTags()}
        categoryTags={getSampleCategoryTags()}
        markets={markets}
        selectedTag={null}
      />
    )

    // TagBar rendered
    expect(screen.getByText('Trending')).toBeInTheDocument()
    expect(screen.getByText('Sports')).toBeInTheDocument()

    // Market cards rendered
    expect(screen.getByText('Will Bitcoin reach $100,000 before end of Q2 2026?')).toBeInTheDocument()
  })

  it('shows empty state when markets array is empty', () => {
    render(
      <MarketDiscovery
        metaTags={getSampleMetaTags()}
        categoryTags={getSampleCategoryTags()}
        markets={[]}
        selectedTag={null}
      />
    )

    expect(screen.getByText('No markets found')).toBeInTheDocument()
  })
})
