export interface CtfRangeRecoveryPass {
  readonly pending: ReadonlyArray<{ readonly retryAtMs?: number }>
}

export interface CtfRangeRecoveryLoop {
  accept(result: CtfRangeRecoveryPass): void
  trigger(): void
  stop(): void
}

interface TimerHandle {
  unref?(): void
}

export function createCtfRangeRecoveryLoop<Result extends CtfRangeRecoveryPass>(input: {
  readonly recover: () => Promise<Result>
  readonly onResult: (result: Result) => void
  readonly onError: (error: Error) => void
  readonly retryDelayMs?: number
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle
  readonly cancel?: (timer: TimerHandle) => void
}): CtfRangeRecoveryLoop {
  const retryDelayMs = input.retryDelayMs ?? 30_000
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('CTF range recovery retry delay is invalid')
  }
  const now = input.now ?? Date.now
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
    if (stopped || result.pending.length === 0) return
    const fallback = now() + retryDelayMs
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
