import { performance } from 'node:perf_hooks'

export type OrderTimelinePhase =
  | 'preparation'
  | 'score-admission'
  | 'capability-admission'
  | 'order-submit'
  | 'submitted-record'
  | 'result-verification'
  | 'result-verification-recheck'
  | 'engine-result-observation'
  | 'mint-observation'
  | 'recovery-verification-staging'
  | 'result-application'
  | 'result-acknowledgement'
  | 'result-reuse'
  | 'result-completion'
  | 'notification-receipt'
export type OrderTimelineOutcome = 'success' | 'failed' | 'reused' | 'unverified'
export type OrderTimelineApplicationPath =
  | 'engine'
  | 'mint-recovery'
  | 'persisted-engine-reuse'
  | 'persisted-mint-reuse'
export interface OrderTimelineIdentity {
  readonly applicationPath?: OrderTimelineApplicationPath
  readonly clientOrderId?: string
  readonly operationId?: string
  readonly orderId?: string
  readonly groupId?: string
  readonly groupRevision?: number
}
export interface OrderTimelineObservation {
  readonly applicationPath: OrderTimelineApplicationPath | null
  readonly phase: OrderTimelinePhase
  readonly outcome: OrderTimelineOutcome
  readonly startedUtc: string
  readonly endedUtc: string
  readonly elapsedMs: number
  readonly clientOrderId: string | null
  readonly operationId: string | null
  readonly orderId: string | null
  readonly groupId: string | null
  readonly groupRevision: number | null
}
export type OrderTimelineObserver = (observation: OrderTimelineObservation) => void | Promise<void>

/** Diagnostics cannot become protocol authority or change a caller's result. */
export function startOrderPhase(
  observer: OrderTimelineObserver | undefined,
  phase: OrderTimelinePhase,
  identity: OrderTimelineIdentity,
): (outcome: OrderTimelineOutcome, known?: OrderTimelineIdentity) => void {
  const started = performance.now()
  const startedUtc = new Date().toISOString()
  let finished = false
  return (outcome, known = identity) => {
    if (finished) return
    finished = true
    try {
      const delivery = observer?.({
        applicationPath: known.applicationPath ?? null,
        phase,
        outcome,
        startedUtc,
        endedUtc: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        clientOrderId: known.clientOrderId ?? null,
        operationId: known.operationId ?? null,
        orderId: known.orderId ?? null,
        groupId: known.groupId ?? null,
        groupRevision: known.groupRevision ?? null,
      })
      delivery?.catch(() => {})
    } catch {
      // A listener failure must not cause a retry or another custody mutation.
    }
  }
}

export async function measureOrderPhase<T>(
  observer: OrderTimelineObserver | undefined,
  phase: OrderTimelinePhase,
  identity: OrderTimelineIdentity,
  work: () => Promise<T>,
  success: OrderTimelineOutcome = 'success',
): Promise<T> {
  const finish = startOrderPhase(observer, phase, identity)
  try {
    const result = await work()
    finish(success)
    return result
  } catch (error) {
    finish('failed')
    throw error
  }
}

export function writeOrderTimeline(
  observation: OrderTimelineObservation,
  write: (line: string) => unknown,
): void {
  try {
    write(
      'order-timeline: ' +
        JSON.stringify({
          applicationPath: observation.applicationPath,
          phase: observation.phase,
          outcome: observation.outcome,
          startedUtc: observation.startedUtc,
          endedUtc: observation.endedUtc,
          elapsedMs: observation.elapsedMs,
          clientOrderId: observation.clientOrderId,
          operationId: observation.operationId,
          orderId: observation.orderId,
          groupId: observation.groupId,
          groupRevision: observation.groupRevision,
        }) +
        '\n',
    )
  } catch {
    // Logging is not an admission, recovery, or acknowledgement dependency.
  }
}

interface OrderTimelineStderr {
  on(event: 'error', listener: () => void): unknown
  write(line: string, callback: (error?: Error | null) => void): unknown
}

/** One process-owned listener; a broken private sink must not stop RPC work. */
export function createOrderTimelineStderrSink(stream: OrderTimelineStderr): OrderTimelineObserver {
  let unavailable = false
  try {
    stream.on('error', () => {
      unavailable = true
    })
  } catch {
    unavailable = true
  }
  return (observation) => {
    if (unavailable) return
    writeOrderTimeline(observation, (line) => {
      try {
        const accepted = stream.write(line, (error) => {
          if (error) unavailable = true
        })
        // A diagnostic must not queue more data or make RPC work wait for drain.
        if (accepted === false) unavailable = true
      } catch {
        unavailable = true
      }
    })
  }
}
