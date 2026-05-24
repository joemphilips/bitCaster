import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatedMarket } from '@/types/portfolio'
import type { DashboardStats } from '@/types/market-management'

const {
  mockUseCreatorDashboardState,
  mockNavigate,
  mockSignEnumAttestation,
  mockSubmitOracleAttestation,
} = vi.hoisted(() => ({
  mockUseCreatorDashboardState: vi.fn(),
  mockNavigate: vi.fn(),
  mockSignEnumAttestation: vi.fn(),
  mockSubmitOracleAttestation: vi.fn(),
}))

vi.mock('@/hooks/useCreatorDashboardState', () => ({
  useCreatorDashboardState: () => mockUseCreatorDashboardState(),
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/oracleAttestation', () => ({
  signEnumOracleAttestationEvent: (...args: unknown[]) => mockSignEnumAttestation(...args),
}))

vi.mock('@/lib/markets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markets')>()
  return {
    ...actual,
    submitOracleAttestation: (...args: unknown[]) => mockSubmitOracleAttestation(...args),
  }
})

import { CreatorDashboard } from '../CreatorDashboard'
import { useCreatorMarketsStore } from '@/stores/creatorMarkets'
import { useSettingsStore } from '@/stores/settings'

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
  mockSignEnumAttestation.mockReset()
  mockSignEnumAttestation.mockReturnValue({
    id: 'event-id',
    pubkey: 'a'.repeat(64),
    createdAt: 1,
    kind: 89,
    content: 'attestation-hex',
    sig: 'b'.repeat(128),
  })
  mockSubmitOracleAttestation.mockReset()
  mockSubmitOracleAttestation.mockResolvedValue({ result: 'Closed' })
  vi.stubGlobal('confirm', vi.fn(() => true))
  useCreatorMarketsStore.setState({ markets: [] })
  useSettingsStore.setState({
    nostrSignerMode: 'none',
    nsecSecret: null,
    relays: [],
  })
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

  it('publishes a creator-owned oracle attestation from a created market row', async () => {
    const user = userEvent.setup()
    const markets: CreatedMarket[] = [
      {
        id: 'a'.repeat(64),
        title: 'Will BTC hit $150k?',
        imageUrl: '',
        status: 'active',
        createdDate: '2026-04-10T00:00:00.000Z',
        volume: 0,
        creatorFeesEarned: 0,
        creatorFeePercent: 0,
        oracle: {
          type: 'self',
          eventId: 'will_btc_hit_150k_abcd',
          outcomes: ['Yes', 'No'],
        },
      },
    ]
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      nsecSecret: 'nsec1test',
      relays: [{ url: 'wss://relay.example.test', connectionStatus: 'connected' }],
    })
    useCreatorMarketsStore.setState({
      markets: [{
        conditionId: 'a'.repeat(64),
        title: 'Will BTC hit $150k?',
        thumbnailUrl: null,
        createdAt: '2026-04-10T00:00:00.000Z',
        creatorFeePercent: 0,
        oracle: {
          type: 'self',
          eventId: 'will_btc_hit_150k_abcd',
          outcomes: ['Yes', 'No'],
        },
      }],
    })
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: 'a'.repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1 },
      markets,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderDashboard()

    await user.click(screen.getByRole('button', { name: /close market/i }))

    expect(mockSignEnumAttestation).toHaveBeenCalledWith(
      'nsec1test',
      'will_btc_hit_150k_abcd',
      'Yes',
    )
    expect(mockSubmitOracleAttestation).toHaveBeenCalledWith('a'.repeat(64), {
      id: 'event-id',
      pubkey: 'a'.repeat(64),
      createdAt: 1,
      kind: 89,
      content: 'attestation-hex',
      sig: 'b'.repeat(128),
    })
    expect(useCreatorMarketsStore.getState().markets[0].oracle).toMatchObject({
      attestationHex: 'attestation-hex',
      attestedOutcome: 'Yes',
    })
    expect(screen.getByText(/published oracle attestation/i)).toBeInTheDocument()
  })
})
