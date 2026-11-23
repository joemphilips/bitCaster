/** The first retry of an automatic condition retirement scan. */
export const CONDITION_RETIREMENT_RETRY_INITIAL_MS = 30_000
/** Each later retry doubles the wait, up to this bound. */
export const CONDITION_RETIREMENT_RETRY_MAX_MS = 5 * 60_000

interface RetryTimer {
  unref?(): void
}

export interface ConditionRetirementRetry {
  /** Run the scan again after the current wait. A waiting retry is kept. */
  schedule(): void
  /** A scan found nothing to retry: cancel a waiting retry and restart at 30 seconds. */
  reset(): void
  /** The daemon stops: no retry runs again. */
  stop(): void
}

/**
 * One retry timer for the automatic retirement scan. It retries a pending
 * retirement and a closed condition whose attestation is not readable yet,
 * until the scan has nothing to retry or the daemon stops.
 */
export function createConditionRetirementRetry(input: {
  readonly run: () => void
  readonly setTimer?: (callback: () => void, delayMs: number) => RetryTimer
  readonly clearTimer?: (timer: RetryTimer) => void
}): ConditionRetirementRetry {
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  let delayMs = CONDITION_RETIREMENT_RETRY_INITIAL_MS
  let timer: RetryTimer | undefined
  let stopped = false
  const clear = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
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
    reset: () => {
      clear()
      delayMs = CONDITION_RETIREMENT_RETRY_INITIAL_MS
    },
    stop: () => {
      stopped = true
      clear()
    },
  }
}
