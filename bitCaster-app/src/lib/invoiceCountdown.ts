/**
 * Tiny helper for rendering "expires in Xm Ys" against a bolt11 quote.
 *
 * Bolt11 quotes carry a unix-seconds `expiry`. The wait-for-mint-quote path
 * tears itself down at expiry; this hook only drives the visible countdown.
 *
 * Returns ms remaining (clamped at 0). Re-renders once per second while the
 * deadline is in the future; pauses once it hits zero.
 */
import { useEffect, useState } from 'react'

export function useInvoiceCountdown(expiresAtSec: number | undefined): number {
  const computeRemaining = () => {
    if (!expiresAtSec || !Number.isFinite(expiresAtSec)) return 0
    return Math.max(0, expiresAtSec * 1000 - Date.now())
  }
  const [remainingMs, setRemainingMs] = useState(computeRemaining)

  useEffect(() => {
    setRemainingMs(computeRemaining())
    if (!expiresAtSec) return
    const id = setInterval(() => {
      const next = computeRemaining()
      setRemainingMs(next)
      if (next <= 0) clearInterval(id)
    }, 1_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAtSec])

  return remainingMs
}

/** "4m 32s" / "0m 9s" / "0m 0s". Stable width so the countdown doesn't jiggle. */
export function formatRemaining(remainingMs: number): string {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}m ${seconds}s`
}
