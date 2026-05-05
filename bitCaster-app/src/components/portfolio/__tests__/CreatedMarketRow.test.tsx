import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CreatedMarketRow } from '../CreatedMarketRow'
import type { CreatedMarket } from '@/types/portfolio'

function fixture(overrides: Partial<CreatedMarket> = {}): CreatedMarket {
  return {
    id: 'm1',
    title: 'Will BTC hit 100K?',
    imageUrl: 'https://example.test/thumb.png',
    status: 'active',
    volume: 0,
    creatorFeesEarned: 0,
    creatorFeePercent: 0,
    ...overrides,
  } as CreatedMarket
}

describe('CreatedMarketRow', () => {
  it('hides the fee row when creatorFeePercent is 0 (P7 §/creator regression)', () => {
    render(<CreatedMarketRow market={fixture({ creatorFeePercent: 0 })} />)
    // The pre-fix UI rendered "0% fee" or "0.02% fee" — both must be absent.
    expect(screen.queryByText(/% fee/i)).toBeNull()
  })

  it('renders the fee row when creatorFeePercent > 0 (future engine fee model)', () => {
    render(<CreatedMarketRow market={fixture({ creatorFeePercent: 1.5 })} />)
    expect(screen.getByText(/1\.5% fee/i)).toBeInTheDocument()
  })
})
