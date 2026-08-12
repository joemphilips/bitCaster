import { COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT } from './state.ts'

export interface StartupRecoveryResult {
  readonly recovered: readonly string[]
  readonly recoveredCount?: number
  readonly pending: ReadonlyArray<{ readonly operationId: string; readonly error: string }>
}

export interface CustodyRecoveryStatus {
  readonly nonRetirementPending: boolean
  readonly retryPending: boolean
  readonly retirementPending: boolean
}

export interface ManualCustodyRecoveryStatus {
  readonly nonRetirementPending: boolean
  readonly retryPending: boolean
  readonly retirementPending: boolean
}

export interface NonRetirementCustodyRecoveryPass {
  readonly pending: boolean
}

export function outgoingCashuRecoveryStatus(input: {
  readonly hasPending: boolean
  readonly hasMore: boolean
  readonly hasBlockingPending: boolean
}): { readonly blockingPending: boolean; readonly retryPending: boolean } {
  return {
    blockingPending: input.hasBlockingPending,
    retryPending: input.hasPending || input.hasMore,
  }
}

export interface NonRetirementCustodyRecoveryLoop {
  accept(result: NonRetirementCustodyRecoveryPass): void
  trigger(): void
  stop(): void
}

interface TimerHandle {
  unref?(): void
}

export function composeStartupCustodyRecovery(recoveries: readonly StartupRecoveryResult[]): {
  readonly recovered: string[]
  readonly recoveredCount: number
  readonly pending: Array<{ operationId: string; error: string }>
} {
  const recovered: string[] = []
  const pending: Array<{ operationId: string; error: string }> = []
  let recoveredCount = 0
  for (const recovery of recoveries) {
    recoveredCount += recovery.recoveredCount ?? recovery.recovered.length
    for (const operationId of recovery.recovered) {
      if (recovered.length < COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT) recovered.push(operationId)
    }
    pending.push(...recovery.pending)
  }
  return { recovered, recoveredCount, pending }
}

export function createCustodyReadinessTracker(initial: CustodyRecoveryStatus): {
  updateManualRecovery(status: ManualCustodyRecoveryStatus): void
  beginAutomaticNonRetirementScan(): number
  completeAutomaticNonRetirementScan(
    generation: number,
    nonRetirementPending: boolean,
    retryPending: boolean,
  ): boolean
  beginAutomaticRetirementScan(): number
  completeAutomaticRetirementScan(generation: number, retirementPending: boolean): boolean
  isNonRetirementPending(): boolean
  isRetryPending(): boolean
  isReady(): boolean
} {
  let nonRetirementPending = initial.nonRetirementPending
  let retryPending = initial.retryPending
  let retirementPending = initial.retirementPending
  let latestAutomaticNonRetirementScan = 0
  let latestAutomaticRetirementScan = 0
  return {
    updateManualRecovery: (status) => {
      latestAutomaticNonRetirementScan += 1
      nonRetirementPending = status.nonRetirementPending
      retryPending = status.retryPending
      if (status.retirementPending) retirementPending = true
    },
    beginAutomaticNonRetirementScan: () => {
      latestAutomaticNonRetirementScan += 1
      return latestAutomaticNonRetirementScan
    },
    completeAutomaticNonRetirementScan: (generation, pending, retry) => {
      if (generation !== latestAutomaticNonRetirementScan) return false
      nonRetirementPending = pending
      retryPending = retry
      return true
    },
    beginAutomaticRetirementScan: () => {
      latestAutomaticRetirementScan += 1
      return latestAutomaticRetirementScan
    },
    completeAutomaticRetirementScan: (generation, pending) => {
      if (generation !== latestAutomaticRetirementScan) return false
      retirementPending = pending
      return true
    },
    isNonRetirementPending: () => nonRetirementPending,
    isRetryPending: () => retryPending,
    isReady: () => !nonRetirementPending && !retirementPending,
  }
}

/** Retry bounded custody recovery only while durable work remains pending. */
export function createNonRetirementCustodyRecoveryLoop<
  Result extends NonRetirementCustodyRecoveryPass,
>(input: {
  readonly recover: () => Promise<Result>
  readonly onResult: (result: Result) => void
  readonly onError: (error: Error) => void
  readonly retryAfterError?: () => boolean
  readonly retryDelayMs?: number
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle
  readonly cancel?: (timer: TimerHandle) => void
}): NonRetirementCustodyRecoveryLoop {
  const retryDelayMs = input.retryDelayMs ?? 30_000
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('non-retirement custody recovery retry delay is invalid')
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
  const schedulePending = (pending: boolean) => {
    clearScheduled()
    if (!pending || stopped) return
    timer = schedule(() => {
      timer = undefined
      trigger()
    }, retryDelayMs)
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
          schedulePending(result.pending)
        } catch (error) {
          input.onError(error instanceof Error ? error : new Error(String(error)))
          schedulePending(input.retryAfterError?.() ?? true)
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
    accept: (result) => schedulePending(result.pending),
    trigger,
    stop: () => {
      stopped = true
      clearScheduled()
    },
  }
}
