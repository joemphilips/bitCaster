/** The first retry of an automatic condition retirement scan. */
export const CONDITION_RETIREMENT_RETRY_INITIAL_MS = 30_000
/** Each later retry doubles the wait, up to this bound. */
export const CONDITION_RETIREMENT_RETRY_MAX_MS = 5 * 60_000
/** The longest delay of one Node.js timer. A later maturity wakes the scan, which arms it again. */
const TIMER_DELAY_MAX_MS = 2_147_483_647

interface RetryTimer {
  unref?(): void
}

export interface ConditionRetirementRetry {
  /** Run the scan again after the current wait. A waiting retry is kept. */
  schedule(): void
  /**
   * Run the scan once at an announced event maturity. Before it, the oracle is
   * not due, so the scan does not read the relays. An earlier waiting wake is kept.
   */
  wakeAt(atMs: number): void
  /** A scan found nothing to retry: cancel a waiting retry and restart at 30 seconds. */
  reset(): void
  /** The daemon stops: no retry or wake runs again. */
  stop(): void
}

/**
 * The timers of the automatic retirement scan. The retry repeats a pending
 * retirement, and a condition whose attestation is due but not readable yet,
 * until the scan has nothing to retry or the daemon stops. The maturity wake
 * starts these reads when a held condition becomes due.
 */
export function createConditionRetirementRetry(input: {
  readonly run: () => void
  readonly setTimer?: (callback: () => void, delayMs: number) => RetryTimer
  readonly clearTimer?: (timer: RetryTimer) => void
  readonly now?: () => number
}): ConditionRetirementRetry {
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  const now = input.now ?? Date.now
  let delayMs = CONDITION_RETIREMENT_RETRY_INITIAL_MS
  let timer: RetryTimer | undefined
  let maturity: { readonly timer: RetryTimer; readonly atMs: number } | undefined
  let stopped = false
  const clear = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }
  const clearMaturity = () => {
    if (maturity === undefined) return
    clearTimer(maturity.timer)
    maturity = undefined
  }
  return {
    schedule: () => {
      if (stopped || timer !== undefined) return
      const waitMs = delayMs
      delayMs = Math.min(delayMs * 2, CONDITION_RETIREMENT_RETRY_MAX_MS)
      timer = setTimer(() => {
        timer = undefined
        input.run()
      }, waitMs)
      timer.unref?.()
    },
    wakeAt: (atMs) => {
      if (stopped || (maturity !== undefined && maturity.atMs <= atMs)) return
      clearMaturity()
      const wake = setTimer(
        () => {
          maturity = undefined
          input.run()
        },
        Math.min(Math.max(atMs - now(), 0), TIMER_DELAY_MAX_MS),
      )
      wake.unref?.()
      maturity = { timer: wake, atMs }
    },
    reset: () => {
      clear()
      delayMs = CONDITION_RETIREMENT_RETRY_INITIAL_MS
    },
    stop: () => {
      stopped = true
      clear()
      clearMaturity()
    },
  }
}
