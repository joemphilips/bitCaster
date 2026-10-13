import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDisplayResyncRepair,
  decodeMarketResyncRequired,
  decodeOrderResyncRequired,
} from '../src/displayResync.ts'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const condition = 'd'.repeat(64)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class ManualSleeps {
  calls: { milliseconds: number; release: () => void; signal: AbortSignal }[] = []
  private nextWaiter: (() => void) | null = null
  private consumed = 0
  readonly scheduler = {
    random: () => 1,
    sleep: (milliseconds: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        this.calls.push({
          milliseconds,
          signal,
          release: () => {
            signal.removeEventListener('abort', abort)
            resolve()
          },
        })
        this.nextWaiter?.()
        this.nextWaiter = null
      }),
  }
  async next() {
    if (this.consumed === this.calls.length)
      await new Promise<void>((resolve) => {
        this.nextWaiter = resolve
      })
    return this.calls[this.consumed++]!
  }
}

test('decodes exact market and current-user repair scopes', () => {
  assert.deepEqual(decodeMarketResyncRequired({ token: A, conditionId: condition }), {
    token: A,
    conditionId: condition,
  })
  assert.deepEqual(decodeMarketResyncRequired({ token: A, conditionId: null }), {
    token: A,
    conditionId: null,
  })
  assert.deepEqual(decodeOrderResyncRequired({ token: A }), { token: A })
})

test('rejects malformed tokens, scopes, extra fields and missing own fields', () => {
  for (const token of [
    null,
    1,
    '',
    A.toUpperCase(),
    `${A}\n`,
    A.slice(1),
    `${A}a`,
    'x'.repeat(32),
  ]) {
    assert.throws(() => decodeOrderResyncRequired({ token }), TypeError)
    assert.throws(() => decodeMarketResyncRequired({ token, conditionId: condition }), TypeError)
  }
  for (const conditionId of [
    undefined,
    0,
    '',
    condition.toUpperCase(),
    `${condition}\n`,
    condition.slice(1),
  ]) {
    assert.throws(() => decodeMarketResyncRequired({ token: A, conditionId }), TypeError)
  }
  for (const value of [
    null,
    [],
    A,
    { token: A, userId: 'private' },
    { token: A, [Symbol('extra')]: true },
    Object.create({ token: A }),
  ]) {
    assert.throws(() => decodeOrderResyncRequired(value), TypeError)
  }
  assert.throws(() => decodeMarketResyncRequired({ token: A }), TypeError)
  assert.throws(
    () => decodeMarketResyncRequired({ token: A, conditionId: condition, extra: true }),
    TypeError,
  )
})

test(
  'coalesces active and latest dirty tokens without overlapping repairs or healthy polling',
  { timeout: 2000 },
  async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    let active = 0
    let peak = 0
    const repair = createDisplayResyncRepair({
      repair: async () => {
        calls++
        peak = Math.max(peak, ++active)
        try {
          if (calls === 1) {
            entered.resolve()
            await release.promise
          }
        } finally {
          active--
        }
      },
    })
    try {
      repair.request(A)
      await entered.promise
      repair.request(A)
      repair.request(B)
      repair.request(C)
      repair.request(A) // A duplicate active token must not erase newer C.
      assert.equal(calls, 1)
      assert.equal(repair.pending, true)
      release.resolve()
      await repair.whenIdle()
      assert.equal(calls, 2)
      assert.equal(peak, 1)
      assert.equal(repair.pending, false)
      repair.request(C)
      await repair.whenIdle()
      assert.equal(calls, 2)
    } finally {
      release.resolve()
      await repair.dispose()
    }
  },
)

test(
  'retains explicit failed repairs through capped backoff and stops after success',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    let succeed = false
    let calls = 0
    const repair = createDisplayResyncRepair({
      scheduler: sleeps.scheduler,
      repair: async () => {
        calls++
        if (!succeed) throw new Error('snapshot unavailable')
      },
    })
    try {
      repair.request(A)
      const observed = []
      for (let retry = 0; retry < 8; retry++) {
        const pending = await sleeps.next()
        observed.push(pending.milliseconds)
        assert.equal(repair.pending, true)
        if (retry === 7) succeed = true
        pending.release()
      }
      await repair.whenIdle()
      assert.deepEqual(observed, [250, 500, 1000, 2000, 4000, 8000, 10000, 10000])
      assert.equal(calls, 9)
      assert.equal(repair.pending, false)
      assert.equal(sleeps.calls.length, 8)
    } finally {
      await repair.dispose()
    }
  },
)

test(
  'new token during failed repair replaces pending target and diagnostics cannot discard it',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    let calls = 0
    const repair = createDisplayResyncRepair({
      scheduler: sleeps.scheduler,
      onError: () => {
        throw new Error('diagnostic failure')
      },
      repair: async () => {
        if (++calls === 1) throw new Error('failed read')
      },
    })
    try {
      repair.request(A)
      const delay = await sleeps.next()
      repair.request(B)
      repair.request(C)
      repair.request(A)
      delay.release()
      await repair.whenIdle()
      assert.equal(calls, 2)
      repair.request(C)
      await repair.whenIdle()
      assert.equal(calls, 2)
    } finally {
      await repair.dispose()
    }
  },
)

test(
  'disposal aborts but drains the actual non-cooperative repair before resolving',
  { timeout: 2000 },
  async () => {
    const entered = deferred()
    const release = deferred()
    let signal: AbortSignal | undefined
    let calls = 0
    let disposed = false
    const repair = createDisplayResyncRepair({
      repair: async (current) => {
        calls++
        signal = current
        entered.resolve()
        await release.promise
      },
    })
    repair.request(A)
    await entered.promise
    const disposal = repair.dispose().then(() => {
      disposed = true
    })
    try {
      assert.equal(signal?.aborted, true)
      assert.equal(disposed, false)
      repair.request(B)
      assert.equal(calls, 1)
    } finally {
      release.resolve()
      await disposal
    }
    await repair.whenIdle()
    assert.equal(repair.pending, false)
    assert.equal(calls, 1)
  },
)

test(
  'disposal cancels an owned retry delay and never starts its next repair',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    let calls = 0
    const repair = createDisplayResyncRepair({
      scheduler: sleeps.scheduler,
      repair: async () => {
        calls++
        throw new Error('unavailable')
      },
    })
    repair.request(A)
    const delay = await sleeps.next()
    await repair.dispose()
    assert.equal(delay.signal.aborted, true)
    assert.equal(calls, 1)
    assert.equal(repair.pending, false)
    await repair.whenIdle()
  },
)

test(
  'initial jitter is bounded, owned and coalesces signals before one repair',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    let calls = 0
    const repair = createDisplayResyncRepair({
      initialJitterMs: 400,
      scheduler: sleeps.scheduler,
      repair: async () => {
        calls++
      },
    })
    try {
      repair.request(A)
      const initial = await sleeps.next()
      assert.equal(initial.milliseconds, 400)
      assert.equal(calls, 0)
      repair.request(B)
      repair.request(A)
      initial.release()
      await repair.whenIdle()
      assert.equal(calls, 1)
      repair.request(B)
      await repair.whenIdle()
      assert.equal(calls, 1)
      assert.equal(sleeps.calls.length, 1)
    } finally {
      await repair.dispose()
    }
    for (const initialJitterMs of [-1, 1001, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createDisplayResyncRepair({ initialJitterMs, repair: async () => {} }),
        TypeError,
      )
    }
  },
)

test('disposal cancels initial jitter before any repair starts', { timeout: 2000 }, async () => {
  const sleeps = new ManualSleeps()
  let calls = 0
  const repair = createDisplayResyncRepair({
    initialJitterMs: 1000,
    scheduler: sleeps.scheduler,
    repair: async () => {
      calls++
    },
  })
  repair.request(A)
  const initial = await sleeps.next()
  await repair.dispose()
  assert.equal(initial.signal.aborted, true)
  assert.equal(calls, 0)
  assert.equal(repair.pending, false)
})

test(
  'local invalidation bypasses and interrupts only initial control jitter',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    let calls = 0
    const repair = createDisplayResyncRepair({
      initialJitterMs: 250,
      scheduler: sleeps.scheduler,
      repair: async () => {
        calls++
      },
    })
    try {
      repair.invalidate()
      await repair.whenIdle()
      assert.equal(calls, 1)
      assert.equal(sleeps.calls.length, 0)
      repair.request(A)
      const jitter = await sleeps.next()
      repair.invalidate()
      await repair.whenIdle()
      assert.equal(jitter.signal.aborted, true)
      assert.equal(calls, 2)
      repair.invalidate()
      repair.request(B)
      await repair.whenIdle()
      assert.equal(calls, 3)
      assert.equal(sleeps.calls.length, 1)
    } finally {
      await repair.dispose()
    }
  },
)

test(
  'local and control demands retain failed backoff and latest demand through a held read',
  { timeout: 2000 },
  async () => {
    const sleeps = new ManualSleeps()
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const repair = createDisplayResyncRepair({
      initialJitterMs: 250,
      scheduler: sleeps.scheduler,
      repair: async () => {
        calls++
        if (calls === 1) throw new Error('503')
        if (calls === 2) {
          entered.resolve()
          await release.promise
        }
      },
    })
    try {
      repair.invalidate()
      const backoff = await sleeps.next()
      for (let i = 0; i < 20; i++) {
        repair.invalidate()
        repair.request(A)
      }
      assert.equal(backoff.signal.aborted, false)
      assert.equal(calls, 1)
      backoff.release()
      await entered.promise
      repair.request(B)
      repair.invalidate()
      release.resolve()
      await repair.whenIdle()
      assert.equal(calls, 3)
      assert.equal(sleeps.calls.length, 1)
      assert.equal(repair.pending, false)
    } finally {
      release.resolve()
      await repair.dispose()
    }
  },
)

test(
  'reports acceptance so ignored completed controls do not invalidate another active demand',
  { timeout: 2000 },
  async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const repair = createDisplayResyncRepair({
      repair: async () => {
        if (++calls === 2) {
          entered.resolve()
          await release.promise
        }
      },
    })
    try {
      assert.equal(repair.request(A), true)
      await repair.whenIdle()
      assert.equal(repair.request(B), true)
      await entered.promise
      assert.equal(repair.request(A), false)
      assert.equal(repair.request(B), false)
      release.resolve()
      await repair.whenIdle()
      assert.equal(calls, 2)
      assert.equal(repair.pending, false)
    } finally {
      release.resolve()
      await repair.dispose()
    }
  },
)
