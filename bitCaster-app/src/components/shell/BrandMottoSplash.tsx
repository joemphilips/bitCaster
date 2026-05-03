import { useTranslation } from 'react-i18next'
import { useAppLoadingState, type AppLoadingState } from '@/hooks/useAppLoadingState'

interface BrandMottoSplashProps {
  /** Test seam — bypass the hook with an explicit state. */
  forcedState?: AppLoadingState
  /** Test seam — shorten the timeout in jsdom. */
  timeoutMs?: number
}

/**
 * Full-screen brand-motto splash shown on cold boot until the app's
 * critical signals (wallet/settings rehydration + markets catalogue) all
 * resolve. On the next render after `useAppLoadingState` returns 'ready'
 * the splash unmounts and the same motto image continues to live as the
 * 0.02-opacity fixed background in `AppShell` — the "fade to background"
 * step the user requested in the P6 review.
 *
 * Error state surfaces an explicit message rather than spinning forever
 * (security-reviewer threat-model concern in P6 plan 00-overview.md): a
 * silently-hung boot must not be indistinguishable from a healthy boot.
 */
export function BrandMottoSplash({ forcedState, timeoutMs }: BrandMottoSplashProps = {}) {
  const { t } = useTranslation()
  const detected = useAppLoadingState(timeoutMs ? { timeoutMs } : undefined)
  const state = forcedState ?? detected

  if (state === 'ready') return null

  // 'pending' keeps the original blocking, full-bleed behaviour — we
  // don't want the user clicking through a partially-loaded app.
  if (state === 'pending') {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="brand-motto-splash"
        data-loading-state="pending"
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white dark:bg-slate-950 transition-opacity duration-500"
      >
        <img
          src="/brand_motto.png"
          alt=""
          className="max-w-[80vw] max-h-[60vh] object-contain"
        />
        <p
          className="mt-6 text-sm text-slate-500 dark:text-slate-400 animate-pulse"
          data-testid="brand-motto-splash-pending"
        >
          {t('app.loading')}
        </p>
      </div>
    )
  }

  // 'error' renders a toast-style banner pinned to the top of the
  // viewport. Two reasons it's NOT a centered full-screen overlay:
  //
  //   1. The boot signals failed but the underlying app (setup wizard,
  //      markets page, etc.) still owns its own per-page error UX, and
  //      blocking the centre of the screen prevents the user from
  //      reaching it. Playwright also reports
  //      "<div data-testid=brand-motto-splash-*> subtree intercepts
  //      pointer events" on every click when the splash overlaps
  //      centred content.
  //   2. A toast at `top-4` and `max-w-md` only covers the header
  //      strip, not the page body — the rest of the viewport stays
  //      interactive even though the toast itself is clickable
  //      (Retry must work).
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="brand-motto-splash"
      data-loading-state="error"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[min(92vw,28rem)]"
    >
      <div
        className="rounded-xl border border-red-200 bg-white/95 px-6 py-4 text-center shadow-lg dark:border-red-900/60 dark:bg-slate-950/95"
        data-testid="brand-motto-splash-error"
      >
        <p className="text-sm font-medium text-red-500 dark:text-red-400">
          {t('app.loadFailedTitle')}
        </p>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {t('app.loadFailedHint')}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          data-testid="brand-motto-splash-retry"
          className="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
        >
          {t('app.loadFailedRetry')}
        </button>
      </div>
    </div>
  )
}
