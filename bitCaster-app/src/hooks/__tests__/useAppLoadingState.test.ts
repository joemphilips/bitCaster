import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetMarkets } = vi.hoisted(() => ({
  mockGetMarkets: vi.fn(),
}))

vi.mock('@/lib/markets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/markets')>('@/lib/markets')
  return {
    ...actual,
    getMarkets: (...args: unknown[]) => mockGetMarkets(...args),
  }
})

import {
  useAppLoadingState,
  __resetAppLoadingStateForTests,
} from '../useAppLoadingState'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'

function emptyResult() {
  return {
    markets: [],
    nextCursor: null,
    lastSuccessfulRefreshAt: '2026-05-02T09:58:00Z',
  }
}

beforeEach(async () => {
  __resetAppLoadingStateForTests()
  mockGetMarkets.mockReset()
  // Force a fresh rehydrate so `persist.hasHydrated()` is deterministically
  // true regardless of test ordering — Zustand's persist middleware would
  // otherwise leave the flag in whatever state the previous test left it.
  await Promise.all([
    useWalletStore.persist.rehydrate(),
    useSettingsStore.persist.rehydrate(),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAppLoadingState', () => {
  it('starts in pending state and resolves to ready once markets fetch + stores hydrate (T5.4.e)', async () => {
    mockGetMarkets.mockResolvedValue(emptyResult())

    const { result } = renderHook(() => useAppLoadingState())

    expect(result.current).toBe('pending')
    await waitFor(() => expect(result.current).toBe('ready'))
  })

  it('flips to error when getMarkets rejects (security-reviewer threat-model)', async () => {
    mockGetMarkets.mockRejectedValue(new Error('engine unreachable'))

    const { result } = renderHook(() => useAppLoadingState())

    await waitFor(() => expect(result.current).toBe('error'))
  })

  it('flips to error after the configured timeout when no signals resolve', async () => {
    vi.useFakeTimers()
    // Pending forever — neither resolve nor reject. The timeout fallback
    // is the only path to a terminal state in this scenario, which is the
    // exact failure mode the 5s cap exists to defend against.
    mockGetMarkets.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useAppLoadingState({ timeoutMs: 50 }))

    expect(result.current).toBe('pending')
    await act(async () => {
      vi.advanceTimersByTime(60)
    })
    expect(result.current).toBe('error')
  })

  it('does not re-show pending after the first ready transition (T5.4.d)', async () => {
    mockGetMarkets.mockResolvedValue(emptyResult())

    const first = renderHook(() => useAppLoadingState())
    await waitFor(() => expect(first.result.current).toBe('ready'))
    first.unmount()

    // A second mount in the same tab is the analogue of an internal route
    // change. The latch must hold so the splash never reappears.
    mockGetMarkets.mockReturnValue(new Promise(() => {}))
    const second = renderHook(() => useAppLoadingState())
    expect(second.result.current).toBe('ready')
  })

  it('clears the timeout on unmount so a late tick cannot flip a torn-down hook to error', async () => {
    vi.useFakeTimers()
    mockGetMarkets.mockReturnValue(new Promise(() => {}))

    const { result, unmount } = renderHook(() =>
      useAppLoadingState({ timeoutMs: 50 }),
    )
    expect(result.current).toBe('pending')

    unmount()
    // Advance past the timeout — if the cleanup did not clear it, the test
    // would warn about state updates on an unmounted component.
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
  })
})
