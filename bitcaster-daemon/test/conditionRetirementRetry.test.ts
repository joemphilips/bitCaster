import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConditionRetirementRetry } from '../src/conditionRetirementRetry.ts'

/** A fake timer: the test fires each scheduled callback itself. */
function fakeTimers() {
  const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  return {
    scheduled,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cleared: false, unref() {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer: (timer: unknown) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    fireLast: () => {
      const timer = scheduled.at(-1)!
      assert.equal(timer.cleared, false)
      timer.callback()
    },
  }
}

test('the retirement retry waits 30 seconds, doubles each time, and stops at 5 minutes', () => {
  const timers = fakeTimers()
  let runs = 0
  const retry = createConditionRetirementRetry({
    run: () => {
      runs += 1
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  for (let attempt = 0; attempt < 7; attempt += 1) {
    retry.schedule()
    // A second request while a retry waits does not add a timer.
    retry.schedule()
    timers.fireLast()
  }
  assert.equal(runs, 7)
  assert.deepEqual(
    timers.scheduled.map((timer) => timer.delayMs),
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000],
  )

  // A clean scan resets the delay and cancels a waiting retry.
  retry.schedule()
  retry.reset()
  assert.equal(timers.scheduled.at(-1)!.cleared, true)
  retry.schedule()
  assert.equal(timers.scheduled.at(-1)!.delayMs, 30_000)

  // A stopped retry never runs again.
  retry.stop()
  assert.equal(timers.scheduled.at(-1)!.cleared, true)
  retry.schedule()
  assert.equal(timers.scheduled.length, 9)
  assert.equal(runs, 7)
})
