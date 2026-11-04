export interface CtfRangeRecoveryPass {
  readonly pending: ReadonlyArray<{ readonly retryAtMs?: number }>
  readonly deferredCount?: number
}

export interface CtfRangeRecoveryLoop {
  accept(result: CtfRangeRecoveryPass): void
  trigger(): void
  stop(): void
}

interface TimerHandle {
  unref?(): void
}

/** The first retry delay of pending work without an exact retry time. */
export const CTF_RANGE_RECOVERY_RETRY_BASE_MS = 15_000
/** Retries double up to this delay, so a stuck operation cannot load the mint. */
export const CTF_RANGE_RECOVERY_RETRY_MAX_MS = 15 * 60_000

export function createCtfRangeRecoveryLoop<Result extends CtfRangeRecoveryPass>(input: {
  readonly recover: () => Promise<Result>
  readonly onResult: (result: Result) => void
  readonly onError: (error: Error) => void
  readonly retryDelayMs?: number
  readonly now?: () => number
  readonly random?: () => number
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle
  readonly cancel?: (timer: TimerHandle) => void
}): CtfRangeRecoveryLoop {
  const retryDelayMs = input.retryDelayMs ?? CTF_RANGE_RECOVERY_RETRY_BASE_MS
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('CTF range recovery retry delay is invalid')
  }
  const now = input.now ?? Date.now
  const random = input.random ?? Math.random
  // Consecutive passes that left pending work without an exact retry time.
  let backoffAttempt = 0
  const backoffDelayMs = () => {
    backoffAttempt += 1
    const delay = Math.min(
      CTF_RANGE_RECOVERY_RETRY_MAX_MS,
      Math.max(retryDelayMs, retryDelayMs * 2 ** Math.min(backoffAttempt - 1, 32)),
    )
    const jitter = Math.min(1, Math.max(0, random()))
    return Math.floor(delay * (0.5 + 0.5 * jitter))
  }
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = input.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  let timer: TimerHandle | undefined
  let running = false
  let requested = false
  let stopped = false

  const clearScheduled = () => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const schedulePending = (result: CtfRangeRecoveryPass) => {
    clearScheduled()
    if (stopped) return
    if ((result.deferredCount ?? 0) > 0) {
      timer = schedule(() => {
        timer = undefined
        trigger()
      }, 0)
      timer.unref?.()
      return
    }
    if (result.pending.length === 0) {
      backoffAttempt = 0
      return
    }
    const fallback = result.pending.some(({ retryAtMs }) => retryAtMs === undefined)
      ? now() + backoffDelayMs()
      : Number.MAX_SAFE_INTEGER
    const retryAt = result.pending.reduce(
      (earliest, pending) =>
        pending.retryAtMs === undefined
          ? Math.min(earliest, fallback)
          : Math.min(earliest, pending.retryAtMs),
      Number.MAX_SAFE_INTEGER,
    )
    const delayMs = Math.max(0, Math.min(retryAt - now(), 2_147_483_647))
    timer = schedule(() => {
      timer = undefined
      trigger()
    }, delayMs)
    timer.unref?.()
  }
  const run = async () => {
    if (running || stopped) return
    running = true
    try {
      do {
        requested = false
        try {
          const result = await input.recover()
          input.onResult(result)
          schedulePending(result)
        } catch (error) {
          input.onError(error instanceof Error ? error : new Error(String(error)))
          schedulePending({ pending: [{}] })
        }
      } while (requested && !stopped)
    } finally {
      running = false
      if (requested && !stopped) void run()
    }
  }
  const trigger = () => {
    if (stopped) return
    clearScheduled()
    requested = true
    void run()
  }

  return {
    accept: schedulePending,
    trigger,
    stop: () => {
      stopped = true
      clearScheduled()
    },
  }
}
