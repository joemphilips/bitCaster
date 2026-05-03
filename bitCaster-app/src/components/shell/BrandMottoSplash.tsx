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

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="brand-motto-splash"
      data-loading-state={state}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white dark:bg-slate-950 transition-opacity duration-500"
    >
      <img
        src="/brand_motto.png"
        alt=""
        className="max-w-[80vw] max-h-[60vh] object-contain"
      />

      {state === 'pending' && (
        <p
          className="mt-6 text-sm text-slate-500 dark:text-slate-400 animate-pulse"
          data-testid="brand-motto-splash-pending"
        >
          {t('app.loading')}
        </p>
      )}

      {state === 'error' && (
        <div
          className="mt-6 max-w-md text-center px-6"
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
            className="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
          >
            {t('app.loadFailedRetry')}
          </button>
        </div>
      )}
    </div>
  )
}
