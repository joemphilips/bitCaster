import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createCustodyReadinessTracker,
  createNonRetirementCustodyRecoveryLoop,
  outgoingCashuRecoveryStatus,
} from '../src/startupRecovery.ts'

interface ScheduledTimer {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
}

test('non-retirement recovery remains idle when no work is pending', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({ timers, recover: async () => ({ pending: false }) })

  loop.accept({ pending: false })

  assert.deepEqual(timers, [])
})

test('ordinary bearer pagination retries without blocking custody readiness', () => {
  const status = outgoingCashuRecoveryStatus({
    hasPending: true,
    hasMore: true,
    hasBlockingPending: false,
  })
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: status.blockingPending,
    retryPending: status.retryPending,
    retirementPending: false,
  })

  assert.equal(status.retryPending, true)
  assert.equal(readiness.isReady(), true)
})

test('non-retirement recovery schedules one bounded follow-up only while work remains', async () => {
  const timers: ScheduledTimer[] = []
  let calls = 0
  const loop = createLoop({
    timers,
    recover: async () => {
      calls += 1
      return { pending: false }
    },
  })

  loop.accept({ pending: true })
  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.delayMs, 30_000)

  timers[0]?.callback()
  await flushAsyncWork()

  assert.equal(calls, 1)
  assert.equal(timers.length, 1)
})

test('non-retirement recovery coalesces concurrent triggers into one follow-up pass', async () => {
  let releaseFirstPass: (() => void) | undefined
  let calls = 0
  const firstPass = new Promise<void>((resolve) => {
    releaseFirstPass = resolve
  })
  const loop = createLoop({
    recover: async () => {
      calls += 1
      if (calls === 1) await firstPass
      return { pending: false }
    },
  })

  loop.trigger()
  loop.trigger()
  loop.trigger()
  assert.equal(calls, 1)

  releaseFirstPass?.()
  await flushAsyncWork()

  assert.equal(calls, 2)
})

test('non-retirement recovery stop cancels a scheduled retry', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({ timers, recover: async () => ({ pending: true }) })

  loop.accept({ pending: true })
  loop.stop()

  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.cancelled, true)
})

test('an older automatic non-retirement result cannot clear manual pending custody', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: true,
    retryPending: true,
    retirementPending: false,
  })
  const olderGeneration = readiness.beginAutomaticNonRetirementScan()

  readiness.updateManualRecovery({
    nonRetirementPending: true,
    retryPending: true,
    retirementPending: false,
  })

  assert.equal(readiness.completeAutomaticNonRetirementScan(olderGeneration, false, false), false)
  assert.equal(readiness.isNonRetirementPending(), true)
  assert.equal(readiness.isReady(), false)
})

test('an older automatic result cannot stop a manual bearer-monitoring retry', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: false,
    retryPending: true,
    retirementPending: false,
  })
  const olderGeneration = readiness.beginAutomaticNonRetirementScan()

  readiness.updateManualRecovery({
    nonRetirementPending: false,
    retryPending: true,
    retirementPending: false,
  })

  assert.equal(readiness.completeAutomaticNonRetirementScan(olderGeneration, false, false), false)
  assert.equal(readiness.isRetryPending(), true)
  assert.equal(readiness.isReady(), true)
})

test('a stale recovery failure does not schedule when manual recovery cleared work', async () => {
  const timers: ScheduledTimer[] = []
  const errors: Error[] = []
  const loop = createNonRetirementCustodyRecoveryLoop({
    recover: async () => {
      throw new Error('mint unavailable')
    },
    onResult: () => undefined,
    onError: (error) => errors.push(error),
    retryAfterError: () => false,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: (timer) => {
      ;(timer as ScheduledTimer).cancelled = true
    },
  })

  loop.trigger()
  await flushAsyncWork()

  assert.equal(errors.length, 1)
  assert.deepEqual(timers, [])
})

function createLoop(input: {
  readonly timers?: ScheduledTimer[]
  readonly recover: () => Promise<{ pending: boolean }>
}) {
  const timers = input.timers ?? []
  return createNonRetirementCustodyRecoveryLoop({
    recover: input.recover,
    onResult: () => undefined,
    onError: (error) => {
      throw error
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: (timer) => {
      ;(timer as ScheduledTimer).cancelled = true
    },
  })
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
