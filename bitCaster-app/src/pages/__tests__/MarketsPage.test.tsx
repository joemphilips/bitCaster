import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketsPage } from '@/pages/MarketsPage'
import { getMarkets } from '@/lib/markets'

vi.mock('@/lib/markets', () => ({
  getMarkets: vi.fn(),
  filterMarkets: vi.fn((markets) => markets),
}))

const mockedGetMarkets = vi.mocked(getMarkets)

describe('MarketsPage', () => {
  beforeEach(() => {
    mockedGetMarkets.mockReset()
  })

  it('shows a create-market empty state when the catalogue response is valid but empty', async () => {
    mockedGetMarkets.mockResolvedValue({
      markets: [],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date('2026-07-02T00:00:00Z').toISOString(),
    })

    render(
      <MemoryRouter initialEntries={['/markets']}>
        <MarketsPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Loading markets...')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('No markets yet')).toBeInTheDocument()
    })

    expect(
      screen.getByText('Create one to get started.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(
        'Failed to load markets. Please check that the matching engine is running.',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /create market/i }),
    ).toBeInTheDocument()
  })

  it('keeps the engine-unavailable response in the error state', async () => {
    mockedGetMarkets.mockRejectedValue(new Error('HTTP 503'))

    render(
      <MemoryRouter initialEntries={['/markets']}>
        <MarketsPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          'Failed to load markets. Please check that the matching engine is running.',
        ),
      ).toBeInTheDocument()
    })

    expect(screen.queryByText('No markets yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
