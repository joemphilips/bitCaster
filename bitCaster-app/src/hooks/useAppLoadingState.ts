import { useEffect, useState } from 'react'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { getMarkets } from '@/lib/markets'

export type AppLoadingState = 'pending' | 'ready' | 'error'

/**
 * Maximum time the brand-motto splash may stay on screen before flipping
 * to the error state. Picks up the operator's instruction in
 * docs/plans/p6-staging-fixes/05-frontend-features.md (P5.4) and the
 * security-reviewer's threat-model concern in 00-overview.md: "if a
 * security-relevant error is thrown during boot... the splash hides it".
 *
 * Five seconds is long enough for a healthy local dev cycle and a typical
 * cold-cache mobile load on staging, short enough that a hung request
 * surfaces user-visibly rather than silently masking an outage.
 */
export const APP_LOADING_TIMEOUT_MS = 5000

/**
 * Once we have ever reached the 'ready' state in this browser tab we stay
 * there. The splash is for the *cold* boot only — internal route changes
 * do not re-trigger it (T5.4.d).
 */
let everReady = false

interface UseAppLoadingStateOptions {
  /**
   * Test seam: override the timeout when the splash needs to be exercised
   * in jsdom without a five-second wait.
   */
  timeoutMs?: number
}

/**
 * Track the boot-time signals required before we can dismiss the
 * brand-motto splash:
 *
 *  - **Wallet store hydrated.** Zustand's `persist` rehydrates async; the
 *    rest of the app reads the mint list / mnemonic on first render and
 *    will mis-render if we paint over the splash before that lands.
 *  - **Settings store hydrated.** Theme, base currency, signer mode —
 *    user-visible values that should not flicker on first paint.
 *  - **Markets catalogue resolved.** A successful `getMarkets()` call
 *    proves the matching engine (and, transitively, the mintd-mirror it
 *    serves from) is reachable. Failure flips us to the error state
 *    rather than spinning forever.
 *
 * Errors thrown during boot flip the state to 'error' so the splash UI
 * can surface a clear message instead of hiding a security-relevant
 * problem behind an infinite spinner. A hard timeout (5s default)
 * guarantees the spinner can never stay up indefinitely even when no
 * promise rejects (e.g. silent network black-hole).
 */
export function useAppLoadingState(
  { timeoutMs = APP_LOADING_TIMEOUT_MS }: UseAppLoadingStateOptions = {},
): AppLoadingState {
  // Skip everything if we already saw a ready transition in this session.
  // Using state for the initial value lets React re-render once on mount
  // for the very first user, then short-circuit forever after.
  const [state, setState] = useState<AppLoadingState>(() =>
    everReady ? 'ready' : 'pending',
  )

  useEffect(() => {
    if (everReady) return

    let cancelled = false
    let walletUnsub: (() => void) | null = null
    let settingsUnsub: (() => void) | null = null

    const flags = {
      walletHydrated: useWalletStore.persist.hasHydrated(),
      settingsHydrated: useSettingsStore.persist.hasHydrated(),
      marketsResolved: false,
    }

    const tryFinish = () => {
      if (cancelled) return
      if (
        flags.walletHydrated &&
        flags.settingsHydrated &&
        flags.marketsResolved
      ) {
        everReady = true
        setState('ready')
      }
    }

    const fail = () => {
      if (cancelled) return
      setState('error')
    }

    // Persist hydration — fire callbacks if not yet hydrated.
    if (!flags.walletHydrated) {
      walletUnsub = useWalletStore.persist.onFinishHydration(() => {
        flags.walletHydrated = true
        tryFinish()
      })
    }
    if (!flags.settingsHydrated) {
      settingsUnsub = useSettingsStore.persist.onFinishHydration(() => {
        flags.settingsHydrated = true
        tryFinish()
      })
    }

    // Markets catalogue. Treat any rejection as boot failure rather than
    // letting the splash hide it — the security-reviewer's "splash masks
    // an error" failure mode. Hits the engine's catalogue proxy
    // (`/api/v1/markets/query`) post Phase-2 wiring, not mintd directly.
    getMarkets()
      .then(() => {
        flags.marketsResolved = true
        tryFinish()
      })
      .catch(() => {
        fail()
      })

    // Hard timeout. If we have not flipped to ready by now something is
    // wedged; flip to error so the UI surfaces it.
    const timer = window.setTimeout(() => {
      if (!cancelled && !everReady) fail()
    }, timeoutMs)

    return () => {
      cancelled = true
      walletUnsub?.()
      settingsUnsub?.()
      window.clearTimeout(timer)
    }
  }, [timeoutMs])

  return state
}

/**
 * Test-only reset of the module-level "ever ready" latch. Avoids exposing
 * the latch to production callers — only the unit-test file imports this.
 */
export function __resetAppLoadingStateForTests(): void {
  everReady = false
}
