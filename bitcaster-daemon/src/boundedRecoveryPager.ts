import type { StartupRecoveryResult } from './startupRecovery.ts'

const RECOVERY_SAMPLE_LIMIT = 100

export type NormalizedRecoveryOutcome =
  | { readonly kind: 'recovered'; readonly operationId: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'blocking'; readonly operationId: string; readonly error: string }

export interface BoundedRecoveryPage {
  readonly recovery: StartupRecoveryResult
  readonly hasMore: boolean
  readonly retryPending: boolean
  readonly blockingPending: boolean
}

/** Aggregate one bounded cursor cycle and preserve blocking facts across page restarts. */
export function createBoundedRecoveryPager<T>(
  recover: (cursor: string | null) => Promise<{
    readonly outcomes: readonly T[]
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }>,
  normalize: (outcome: T) => NormalizedRecoveryOutcome,
): {
  recoverPage(): Promise<BoundedRecoveryPage>
  restart(): void
} {
  let cursor: string | null = null
  let generation = 0
  let restartRequested = false
  let inFlight: Promise<BoundedRecoveryPage> | undefined
  let cycleActive = false
  let cycleRetryPending = false
  let cycleBlockingPending = false
  let cycleRecoveredCount = 0
  let cycleRecovered: string[] = []
  let cyclePending: Array<{ operationId: string; error: string }> = []
  let lastCompleteBlockingPending = false

  const clearCycle = () => {
    cycleActive = true
    cycleRetryPending = false
    cycleBlockingPending = false
    cycleRecoveredCount = 0
    cycleRecovered = []
    cyclePending = []
  }

  const currentRecovery = (): StartupRecoveryResult => ({
    recovered: [...cycleRecovered],
    recoveredCount: cycleRecoveredCount,
    pending: [...cyclePending],
  })

  const supersededResult = (): BoundedRecoveryPage => ({
    recovery: { recovered: [], recoveredCount: 0, pending: [] },
    hasMore: true,
    retryPending: true,
    blockingPending: cycleBlockingPending || lastCompleteBlockingPending,
  })

  const recordOutcome = (outcome: T) => {
    const normalized = normalize(outcome)
    switch (normalized.kind) {
      case 'recovered':
        cycleRecoveredCount += 1
        if (cycleRecovered.length < RECOVERY_SAMPLE_LIMIT) {
          cycleRecovered.push(normalized.operationId)
        }
        return
      case 'retry':
        cycleRetryPending = true
        return
      case 'blocking':
        cycleRetryPending = true
        cycleBlockingPending = true
        if (cyclePending.length < RECOVERY_SAMPLE_LIMIT) {
          cyclePending.push({ operationId: normalized.operationId, error: normalized.error })
        }
        return
      default:
        return assertNever(normalized)
    }
  }

  const isBlocking = (outcome: T) => normalize(outcome).kind === 'blocking'

  const performPage = async (scanGeneration: number): Promise<BoundedRecoveryPage> => {
    const pageCursor = cursor
    let page: Awaited<ReturnType<typeof recover>>
    try {
      page = await recover(pageCursor)
    } catch (error) {
      lastCompleteBlockingPending = true
      if (generation !== scanGeneration) {
        return supersededResult()
      }
      throw error
    }
    if (generation !== scanGeneration) {
      for (const outcome of page.outcomes) {
        if (isBlocking(outcome)) {
          cycleBlockingPending = true
          lastCompleteBlockingPending = true
        }
      }
      return supersededResult()
    }
    if (page.hasMore && page.nextCursor === null) {
      throw new Error('recovery cursor is invalid')
    }
    for (const outcome of page.outcomes) recordOutcome(outcome)

    if (page.hasMore) {
      cursor = page.nextCursor
      return {
        recovery: currentRecovery(),
        hasMore: true,
        retryPending: true,
        blockingPending: cycleBlockingPending || lastCompleteBlockingPending,
      }
    }

    cursor = null
    cycleActive = false
    lastCompleteBlockingPending = cycleBlockingPending
    const result = {
      recovery: currentRecovery(),
      hasMore: false,
      retryPending: cycleRetryPending,
      blockingPending: lastCompleteBlockingPending,
    }
    cycleRetryPending = false
    cycleBlockingPending = false
    cycleRecoveredCount = 0
    cycleRecovered = []
    cyclePending = []
    return result
  }

  return {
    recoverPage: async () => {
      if (inFlight !== undefined) return inFlight
      if (restartRequested) {
        cursor = null
        restartRequested = false
        cycleActive = false
      }
      if (!cycleActive) clearCycle()

      const scanGeneration = generation
      const current = performPage(scanGeneration)
      inFlight = current
      try {
        return await current
      } finally {
        if (inFlight === current) inFlight = undefined
      }
    },
    restart: () => {
      if (cycleBlockingPending) lastCompleteBlockingPending = true
      generation += 1
      restartRequested = true
    },
  }
}

function assertNever(value: never): never {
  throw new Error(`recovery outcome is unsupported: ${String(value)}`)
}
