import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreatorMarketsStore } from '@/stores/creatorMarkets'
import { useSettingsStore } from '@/stores/settings'

const { mockFetchCreatorMarkets, mockResolveCreatorPubkey } = vi.hoisted(() => ({
  mockFetchCreatorMarkets: vi.fn(),
  mockResolveCreatorPubkey: vi.fn(),
}))

vi.mock('@/lib/markets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/markets')>('@/lib/markets')
  return {
    ...actual,
    fetchCreatorMarkets: (...args: unknown[]) => mockFetchCreatorMarkets(...args),
  }
})

vi.mock('@/lib/identityOps', () => ({
  resolveCreatorPubkey: (...args: unknown[]) => mockResolveCreatorPubkey(...args),
}))

import { useCreatorDashboardState } from '../useCreatorDashboardState'

const FAKE_PUBKEY = 'a'.repeat(64)
const CONDITION_A = 'c'.repeat(64)
const CONDITION_B = 'd'.repeat(64)

beforeEach(() => {
  mockFetchCreatorMarkets.mockReset()
  mockResolveCreatorPubkey.mockReset()
  useCreatorMarketsStore.setState({ markets: [] })
  useSettingsStore.setState({
    nostrSignerMode: 'none',
    nsecSecret: null,
    nostrProfile: null,
  })
  mockResolveCreatorPubkey.mockImplementation((input: { nostrSignerMode: string }) =>
    input.nostrSignerMode === 'none' ? null : FAKE_PUBKEY,
  )
})

describe('useCreatorDashboardState', () => {
  it('returns an empty state when no Nostr identity is configured', () => {
    mockFetchCreatorMarkets.mockResolvedValue({ pubkey: FAKE_PUBKEY, markets: [] })

    const { result } = renderHook(() => useCreatorDashboardState())

    expect(result.current.pubkey).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.markets).toEqual([])
    expect(result.current.stats.activeMarketsCount).toBe(0)
    expect(mockFetchCreatorMarkets).not.toHaveBeenCalled()
  })

  it('merges backend volume data with local store markets', async () => {
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      nsecSecret: '11'.repeat(32),
      nostrProfile: null,
    })
    useCreatorMarketsStore.setState({
      markets: [
        {
          conditionId: CONDITION_A,
          title: 'Market A',
          thumbnailUrl: null,
          createdAt: '2026-04-10T00:00:00.000Z',
          creatorFeePercent: 0.02,
        },
        {
          conditionId: CONDITION_B,
          title: 'Market B',
          thumbnailUrl: '/api/v1/foo/thumbnail',
          createdAt: '2026-04-09T00:00:00.000Z',
          creatorFeePercent: 0.03,
        },
      ],
    })

    mockFetchCreatorMarkets.mockResolvedValue({
      pubkey: FAKE_PUBKEY,
      // Only market A has backend volume — market B should default to 0.
      markets: [
        {
          conditionId: CONDITION_A,
          totalVolumeSubunits: 50_000,
          createdAt: '2026-04-10T00:00:00.000Z',
          state: 'open',
        },
      ],
    })

    const { result } = renderHook(() => useCreatorDashboardState())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.pubkey).toBe(FAKE_PUBKEY)
    expect(result.current.markets).toHaveLength(2)
    const [a, b] = result.current.markets
    expect(a.id).toBe(CONDITION_A)
    expect(a.volume).toBe(50_000)
    expect(a.status).toBe('active')
    expect(a.creatorFeePercent).toBe(0.02)
    expect(b.id).toBe(CONDITION_B)
    expect(b.volume).toBe(0)

    expect(result.current.stats.activeMarketsCount).toBe(2)
    expect(result.current.stats.totalVolumeSubunits).toBe(50_000)
    expect(result.current.stats.totalFeesEarnedSats).toBe(0)
  })

  it('maps engine closed state to a resolved creator-market row', async () => {
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      nsecSecret: '11'.repeat(32),
      nostrProfile: null,
    })
    useCreatorMarketsStore.setState({
      markets: [
        {
          conditionId: CONDITION_A,
          title: 'Market A',
          thumbnailUrl: null,
          createdAt: '2026-04-10T00:00:00.000Z',
          creatorFeePercent: 0,
          oracle: {
            type: 'self',
            eventId: 'event-1',
            outcomes: ['Yes', 'No'],
            attestedOutcome: 'Yes',
            attestationHex: 'abc123',
            attestedAt: '2026-05-09T00:00:00.000Z',
          },
        },
      ],
    })

    mockFetchCreatorMarkets.mockResolvedValue({
      pubkey: FAKE_PUBKEY,
      markets: [
        {
          conditionId: CONDITION_A,
          totalVolumeSubunits: 75_000,
          createdAt: '2026-04-10T00:00:00.000Z',
          state: 'closed',
        },
      ],
    })

    const { result } = renderHook(() => useCreatorDashboardState())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.markets[0].status).toBe('resolved')
    expect(result.current.stats.activeMarketsCount).toBe(0)
    expect(result.current.stats.resolvedMarketsCount).toBe(1)
  })

  it('falls back to zero volume on backend error and surfaces the error', async () => {
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      nsecSecret: '11'.repeat(32),
      nostrProfile: null,
    })
    useCreatorMarketsStore.setState({
      markets: [
        {
          conditionId: CONDITION_A,
          title: 'Market A',
          thumbnailUrl: null,
          createdAt: '2026-04-10T00:00:00.000Z',
          creatorFeePercent: 0.02,
        },
      ],
    })

    mockFetchCreatorMarkets.mockRejectedValue(new Error('engine unreachable'))

    const { result } = renderHook(() => useCreatorDashboardState())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.error).toBe('engine unreachable')
    expect(result.current.markets).toHaveLength(1)
    expect(result.current.markets[0].volume).toBe(0)
    expect(result.current.stats.totalVolumeSubunits).toBe(0)
  })

  it('fetches creator markets under the resolved signer pubkey', async () => {
    const signerPubkey = 'e'.repeat(64)
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      nsecSecret: '11'.repeat(32),
      nostrProfile: { pubkey: signerPubkey, displayName: '', avatar: '', nip05: '', nip05verified: false, bio: '' },
    })
    mockResolveCreatorPubkey.mockReturnValue(signerPubkey)
    mockFetchCreatorMarkets.mockResolvedValue({ pubkey: signerPubkey, markets: [] })

    const { result } = renderHook(() => useCreatorDashboardState())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(mockResolveCreatorPubkey).toHaveBeenCalledWith({
      nostrSignerMode: 'nsec',
      nsecSecret: '11'.repeat(32),
      nostrProfilePubkey: signerPubkey,
    })
    expect(mockFetchCreatorMarkets).toHaveBeenCalledWith(signerPubkey)
    expect(result.current.pubkey).toBe(signerPubkey)
  })
})
