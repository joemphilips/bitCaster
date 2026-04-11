import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatedMarket } from '@/types/portfolio'
import type { DashboardStats } from '@/types/market-management'

const {
  mockUseCreatorDashboardState,
  mockNavigate,
} = vi.hoisted(() => ({
  mockUseCreatorDashboardState: vi.fn(),
  mockNavigate: vi.fn(),
}))

vi.mock('@/hooks/useCreatorDashboardState', () => ({
  useCreatorDashboardState: () => mockUseCreatorDashboardState(),
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

import { CreatorDashboard } from '../CreatorDashboard'

function emptyStats(): DashboardStats {
  return {
    activeMarketsCount: 0,
    resolvedMarketsCount: 0,
    refundedMarketsCount: 0,
    totalVolumeSats: 0,
    totalFeesEarnedSats: 0,
    totalFeesClaimedSats: 0,
    totalFeesUnclaimedSats: 0,
  }
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <CreatorDashboard />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockNavigate.mockReset()
  mockUseCreatorDashboardState.mockReset()
})

describe('CreatorDashboard', () => {
  it('renders the empty state when no markets are stored', () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    expect(
      screen.getByRole('heading', { name: /create your first market/i }),
    ).toBeInTheDocument()
    // Both the header CTA and the empty-state CTA are rendered.
    expect(screen.getAllByRole('button', { name: /create market/i }).length).toBeGreaterThanOrEqual(
      2,
    )
  })

  it('prompts to configure a wallet when no pubkey is available', () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: null,
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    expect(screen.getByText(/set up a wallet/i)).toBeInTheDocument()
  })

  it('renders created markets and aggregate stats', () => {
    const markets: CreatedMarket[] = [
      {
        id: 'a'.repeat(64),
        title: 'Will BTC hit $150k?',
        imageUrl: '',
        status: 'active',
        createdDate: '2026-04-10T00:00:00.000Z',
        volume: 100_000,
        creatorFeesEarned: 0,
        creatorFeePercent: 0.02,
      },
    ]
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1, totalVolumeSats: 100_000 },
      markets,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    expect(screen.getByText('Will BTC hit $150k?')).toBeInTheDocument()
    expect(screen.getByText(/my markets/i)).toBeInTheDocument()
    // Active markets stat card shows "1"
    expect(screen.getByText('Active Markets')).toBeInTheDocument()
  })

  it('navigates to /creator/new when the create CTA is clicked', async () => {
    const user = userEvent.setup()
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    // Click the first "Create Market" button (header CTA).
    const buttons = screen.getAllByRole('button', { name: /create market/i })
    await user.click(buttons[0])
    expect(mockNavigate).toHaveBeenCalledWith('/creator/new')
  })

  it('switches to the analytics tab and shows the coming-soon placeholder', async () => {
    const user = userEvent.setup()
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    await user.click(screen.getByRole('button', { name: /analytics/i }))
    expect(screen.getByRole('heading', { name: /analytics coming soon/i })).toBeInTheDocument()
  })

  it('surfaces the backend error banner when fetch fails', () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: 'engine unreachable',
      refresh: vi.fn(),
    })

    renderDashboard()

    expect(screen.getByText(/couldn't load live volume data/i)).toBeInTheDocument()
    expect(screen.getByText(/engine unreachable/i)).toBeInTheDocument()
  })
})
