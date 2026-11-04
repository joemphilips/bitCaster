import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCtfRangeRecoveryLoop } from '../src/ctfRangeRecoveryLoop.ts'

interface ScheduledTimer {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
}

test('range recovery loop remains idle when no durable work is pending', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({
    timers,
    recover: async () => ({ pending: [] }),
  })

  loop.accept({ pending: [] })

  assert.deepEqual(timers, [])
})

test('range recovery loop schedules the earliest exact retry time', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({
    timers,
    now: () => 1_000,
    recover: async () => ({ pending: [] }),
  })

  loop.accept({
    pending: [{ retryAtMs: 9_000 }, { retryAtMs: 4_000 }],
  })

  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.delayMs, 3_000)
})

test('range recovery loop coalesces concurrent triggers into one follow-up pass', async () => {
  let releaseFirstPass: (() => void) | undefined
  let passes = 0
  const firstPass = new Promise<void>((resolve) => {
    releaseFirstPass = resolve
  })
  const loop = createLoop({
    recover: async () => {
      passes += 1
      if (passes === 1) await firstPass
      return { pending: [] }
    },
  })

  loop.trigger()
  loop.trigger()
  loop.trigger()
  assert.equal(passes, 1)

  releaseFirstPass?.()
  await flushAsyncWork()

  assert.equal(passes, 2)
})

test('range recovery loop backs off without an exact retry time and caps the delay', async () => {
  const timers: ScheduledTimer[] = []
  let pending: Array<{ retryAtMs?: number }> = [{}]
  const loop = createLoop({
    timers,
    random: () => 1,
    recover: async () => ({ pending }),
  })

  loop.accept({ pending: [{}] })
  const delays = [timers.at(-1)!.delayMs]
  for (let pass = 0; pass < 8; pass++) {
    timers.at(-1)!.callback()
    await flushAsyncWork()
    delays.push(timers.at(-1)!.delayMs)
  }

  assert.deepEqual(
    delays,
    [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000],
  )

  // A pass without pending work resets the delay.
  pending = []
  timers.at(-1)!.callback()
  await flushAsyncWork()
  loop.accept({ pending: [{}] })
  assert.equal(timers.at(-1)!.delayMs, 15_000)
})

test('range recovery loop keeps jitter between half and all of the delay', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({ timers, random: () => 0, recover: async () => ({ pending: [] }) })

  loop.accept({ pending: [{}] })

  assert.equal(timers[0]?.delayMs, 7_500)
})

test('range recovery loop stop cancels a scheduled retry', () => {
  const timers: ScheduledTimer[] = []
  const loop = createLoop({
    timers,
    recover: async () => ({ pending: [] }),
  })
  loop.accept({ pending: [{}] })

  loop.stop()

  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.cancelled, true)
})

function createLoop(input: {
  readonly timers?: ScheduledTimer[]
  readonly now?: () => number
  readonly random?: () => number
  readonly recover: () => Promise<{ pending: Array<{ retryAtMs?: number }> }>
}) {
  const timers = input.timers ?? []
  return createCtfRangeRecoveryLoop({
    recover: input.recover,
    ...(input.random === undefined ? {} : { random: input.random }),
    onResult: () => undefined,
    onError: (error) => {
      throw error
    },
    now: input.now ?? (() => 1_000),
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
