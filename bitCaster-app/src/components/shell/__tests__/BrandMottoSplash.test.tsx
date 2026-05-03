import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `BrandMottoSplash` calls `useAppLoadingState` unconditionally (Rules of
// Hooks), so even when `forcedState` overrides the rendered output we still
// want the underlying `fetchMarkets` effect to settle without polluting the
// jsdom run with unhandled-rejection or "act warning" noise.
const { mockFetchMarkets } = vi.hoisted(() => ({
  mockFetchMarkets: vi.fn(),
}))
vi.mock('@/lib/markets', async () => {
  const actual = await vi.importActual<typeof import('@/lib/markets')>('@/lib/markets')
  return {
    ...actual,
    fetchMarkets: (...args: unknown[]) => mockFetchMarkets(...args),
  }
})

import { BrandMottoSplash } from '../BrandMottoSplash'
import { __resetAppLoadingStateForTests } from '@/hooks/useAppLoadingState'

beforeEach(() => {
  __resetAppLoadingStateForTests()
  mockFetchMarkets.mockReset()
  // Default to a resolved fetch so the inner hook completes quickly.
  mockFetchMarkets.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Drain the inner `useAppLoadingState` effect that fires from
 * `BrandMottoSplash` regardless of `forcedState` (Rules of Hooks force the
 * unconditional call). Without this the resolved `fetchMarkets` promise
 * triggers a `setState` after the test body finishes and React logs an
 * "update not wrapped in act" warning. We don't care about the resulting
 * state — only that the effect has settled before the test exits.
 */
async function flushSplashEffects() {
  await act(async () => {
    await Promise.resolve()
  })
  await waitFor(() => expect(mockFetchMarkets).toHaveBeenCalled())
}

describe('BrandMottoSplash', () => {
  it('renders the brand-motto image and pending hint while pending', async () => {
    render(<BrandMottoSplash forcedState="pending" />)

    const splash = screen.getByTestId('brand-motto-splash')
    expect(splash).toBeInTheDocument()
    expect(splash.getAttribute('data-loading-state')).toBe('pending')

    const img = splash.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/brand_motto.png')

    expect(screen.getByTestId('brand-motto-splash-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('brand-motto-splash-error')).toBeNull()

    await flushSplashEffects()
  })

  it('renders an explicit error message + retry button on error (security-reviewer threat-model)', async () => {
    render(<BrandMottoSplash forcedState="error" />)

    const splash = screen.getByTestId('brand-motto-splash')
    expect(splash.getAttribute('data-loading-state')).toBe('error')

    const errorBlock = screen.getByTestId('brand-motto-splash-error')
    expect(errorBlock).toBeInTheDocument()
    // The pending spinner must NOT also render — the failure mode the
    // 5-second timeout exists to prevent is "splash hides the actual error".
    expect(screen.queryByTestId('brand-motto-splash-pending')).toBeNull()

    const retry = errorBlock.querySelector('button')
    expect(retry).toBeInTheDocument()
    expect(retry?.textContent?.length ?? 0).toBeGreaterThan(0)

    await flushSplashEffects()
  })

  it('unmounts entirely when ready so the splash never lingers over interactive UI', async () => {
    const { container } = render(<BrandMottoSplash forcedState="ready" />)
    expect(container.firstChild).toBeNull()
    await flushSplashEffects()
  })

  it('exposes role=status and aria-live=polite so screen readers announce boot progress', async () => {
    render(<BrandMottoSplash forcedState="pending" />)
    const splash = screen.getByTestId('brand-motto-splash')
    expect(splash.getAttribute('role')).toBe('status')
    expect(splash.getAttribute('aria-live')).toBe('polite')
    await flushSplashEffects()
  })
})
