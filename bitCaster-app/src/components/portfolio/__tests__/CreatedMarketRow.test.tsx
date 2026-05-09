import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
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

  it('shows a working close-market control for active self-oracle markets', async () => {
    const onPublishOracleAttestation = vi.fn()
    render(
      <CreatedMarketRow
        market={fixture({
          oracle: {
            type: 'self',
            eventId: 'event-1',
            outcomes: ['YES', 'NO'],
          },
        })}
        onPublishOracleAttestation={onPublishOracleAttestation}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /close market/i }))

    expect(onPublishOracleAttestation).toHaveBeenCalledWith('m1', 'YES')
  })

  it('keeps close-market visible but disabled when local oracle metadata is missing', () => {
    render(
      <CreatedMarketRow
        market={fixture()}
        onPublishOracleAttestation={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: /close market/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      expect.stringContaining('self-oracle metadata'),
    )
  })
})
