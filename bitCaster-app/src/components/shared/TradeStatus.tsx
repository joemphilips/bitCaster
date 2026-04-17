/**
 * TradeStatus — shows the current lifecycle state of an atomic swap trade.
 *
 * Each state maps to a human-readable message and a visual indicator:
 *
 *   matched   → "Preparing swap..."           (spinner)
 *   settling  → "Exchanging proofs…"          (spinner + step indicator)
 *   confirmed → "Swap complete!"              (check mark, green)
 *   retrying  → "Connection lost, retrying…" (spinner, amber)
 *   failed    → "Swap failed. Tokens will be refunded after locktime." (red)
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TradeLifecycleState } from '@/stores/tradeStore'

// ---------------------------------------------------------------------------
// Icons (inline SVG to avoid an extra dependency)
// ---------------------------------------------------------------------------

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className ?? ''}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Settling step indicator
// ---------------------------------------------------------------------------

function SettlingStepIndicator({ currentStep }: { currentStep?: number }) {
  const { t } = useTranslation()
  const step = currentStep ?? 0
  const settlingSteps = [
    t('trade.settlingStep0'),
    t('trade.settlingStep1'),
    t('trade.settlingStep2'),
  ]
  return (
    <ol className="flex gap-2 mt-2 text-xs text-slate-500 dark:text-slate-400">
      {settlingSteps.map((label, i) => (
        <li
          key={label}
          className={`flex items-center gap-1 ${
            i <= step
              ? 'text-blue-600 dark:text-blue-400 font-medium'
              : ''
          }`}
        >
          <span
            className={`w-4 h-4 rounded-full border text-[10px] flex items-center justify-center shrink-0 ${
              i < step
                ? 'border-blue-600 bg-blue-600 dark:border-blue-400 dark:bg-blue-400 text-white'
                : i === step
                ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400'
                : 'border-slate-300 dark:border-slate-600'
            }`}
          >
            {i < step ? '✓' : i + 1}
          </span>
          {label}
          {i < settlingSteps.length - 1 && (
            <span className="mx-1 text-slate-300 dark:text-slate-600">›</span>
          )}
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TradeStatusProps {
  state: TradeLifecycleState
  /** Optional 0-based step index while in 'settling' state. */
  settlingStep?: number
  /** Optional trade ID for display. */
  tradeId?: string
  className?: string
}

const STATE_META: Record<
  TradeLifecycleState,
  { icon: React.ReactNode; labelKey: string; colour: string }
> = {
  matched: {
    icon: <SpinnerIcon className="w-5 h-5" />,
    labelKey: 'trade.preparing',
    colour: 'text-blue-600 dark:text-blue-400',
  },
  settling: {
    icon: <SpinnerIcon className="w-5 h-5" />,
    labelKey: 'trade.exchanging',
    colour: 'text-blue-600 dark:text-blue-400',
  },
  confirmed: {
    icon: <CheckIcon className="w-5 h-5" />,
    labelKey: 'trade.complete',
    colour: 'text-emerald-600 dark:text-emerald-400',
  },
  retrying: {
    icon: <SpinnerIcon className="w-5 h-5" />,
    labelKey: 'trade.retrying',
    colour: 'text-amber-600 dark:text-amber-400',
  },
  failed: {
    icon: <AlertIcon className="w-5 h-5" />,
    labelKey: 'trade.failed',
    colour: 'text-red-600 dark:text-red-400',
  },
}

export function TradeStatus({
  state,
  settlingStep,
  tradeId,
  className = '',
}: TradeStatusProps) {
  const { t } = useTranslation()
  const { icon, labelKey, colour } = STATE_META[state]

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 ${className}`}
    >
      {tradeId && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2 font-mono truncate">
          {t('trade.tradeId', { id: tradeId })}
        </p>
      )}

      <div className={`flex items-center gap-2 font-medium ${colour}`}>
        {icon}
        <span>{t(labelKey)}</span>
      </div>

      {state === 'settling' && (
        <SettlingStepIndicator currentStep={settlingStep} />
      )}
    </div>
  )
}
