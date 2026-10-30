import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runOrderQuoteRefreshRetry,
  OrderQuoteRefreshWaitStopped,
} from '../src/orderQuoteRefreshRetry.ts'
import { isOrderQuotesRefreshingError, EngineClientError } from '../src/engineClient.ts'

const refusal = new EngineClientError(
  503,
  JSON.stringify({
    type: '/errors/order-quotes-refreshing',
    status: 503,
    code: 'order-quotes-refreshing',
  }),
)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('only the complete exact preaccept problem permits retry', () => {
  assert.equal(isOrderQuotesRefreshingError(refusal), true)
  for (const detail of [
    '',
    '{}',
    JSON.stringify({ code: 'order-quotes-refreshing' }),
    JSON.stringify({
      type: '/errors/order-quotes-refreshing',
      status: 500,
      code: 'order-quotes-refreshing',
    }),
    JSON.stringify({
      type: '/errors/order-processing-unavailable',
      status: 503,
      code: 'order-quotes-refreshing',
    }),
  ])
    assert.equal(isOrderQuotesRefreshingError(new EngineClientError(503, detail)), false)
  assert.equal(isOrderQuotesRefreshingError(new Error('order-quotes-refreshing')), false)
})

test('waits one second after exact refusal and submits again once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred<void>()
  let calls = 0
  const result = runOrderQuoteRefreshRetry(
    async () => {
      if (++calls === 1) throw refusal
      return 'accepted'
    },
    isOrderQuotesRefreshingError,
    {
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
        onWaiting: () => waiting.resolve(),
      },
    },
  )
  await waiting.promise
  assert.equal(calls, 1)
  t.mock.timers.tick(999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(await result, 'accepted')
  assert.equal(calls, 2)
})

test('cancellation stops waiting without a second dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred<void>(),
    controller = new AbortController()
  let calls = 0
  const result = runOrderQuoteRefreshRetry(
    async () => {
      calls++
      throw refusal
    },
    isOrderQuotesRefreshingError,
    {
      signal: controller.signal,
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
        onWaiting: () => waiting.resolve(),
      },
    },
  )
  const assertion = assert.rejects(
    result,
    (e: unknown) => e instanceof OrderQuoteRefreshWaitStopped && e.reason === 'cancelled',
  )
  await waiting.promise
  controller.abort()
  await assertion
  t.mock.timers.tick(60000)
  assert.equal(calls, 1)
})

test('generic failure never enters the waiting policy', async () => {
  let calls = 0,
    waits = 0
  const error = new EngineClientError(503, 'unavailable')
  await assert.rejects(
    runOrderQuoteRefreshRetry(
      async () => {
        calls++
        throw error
      },
      isOrderQuotesRefreshingError,
      {
        quoteRefreshRetry: {
          authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
          onWaiting: () => waits++,
        },
      },
    ),
    (e) => e === error,
  )
  assert.equal(calls, 1)
  assert.equal(waits, 0)
})

// A whole second keeps the integer expiry and the remaining time exact.
const MOCKED_NOW_MS = 1_800_000_000_000

test('an expired authorization never dispatches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCKED_NOW_MS })
  let calls = 0
  await assert.rejects(
    runOrderQuoteRefreshRetry(
      async () => {
        calls++
        return 1
      },
      isOrderQuotesRefreshingError,
      {
        quoteRefreshRetry: { authorizationExpiresAtUnixSeconds: MOCKED_NOW_MS / 1000 },
      },
    ),
    (e) => e instanceof OrderQuoteRefreshWaitStopped && e.reason === 'expired',
  )
  assert.equal(calls, 0)
})

test('a short-lived authorization submits with an attempt limit at its expiry', async (t) => {
  // Five seconds of authorization lifetime is less than the 30-second
  // attempt limit. The order must still be sent, and the attempt must stop
  // at the authorization expiry.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCKED_NOW_MS })
  const entered = deferred<void>()
  let calls = 0
  let settled = false
  const result = runOrderQuoteRefreshRetry(
    async () => {
      calls++
      entered.resolve()
      return new Promise(() => {})
    },
    isOrderQuotesRefreshingError,
    {
      quoteRefreshRetry: { authorizationExpiresAtUnixSeconds: MOCKED_NOW_MS / 1000 + 5 },
    },
  )
  const assertion = assert.rejects(result, /timed out/).finally(() => {
    settled = true
  })
  await entered.promise
  assert.equal(calls, 1)
  t.mock.timers.tick(4_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assertion
  assert.equal(calls, 1)
})

test('a quote-refresh retry uses the time left after its delay', async (t) => {
  // Ten seconds of lifetime cannot hold a delay plus a 30-second attempt.
  // The retry still runs, and its attempt stops at the authorization expiry.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: MOCKED_NOW_MS })
  const waiting = deferred<void>()
  const second = deferred<void>()
  let calls = 0
  let settled = false
  const result = runOrderQuoteRefreshRetry(
    async () => {
      if (++calls === 1) throw refusal
      second.resolve()
      return new Promise(() => {})
    },
    isOrderQuotesRefreshingError,
    {
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: MOCKED_NOW_MS / 1000 + 10,
        onWaiting: () => waiting.resolve(),
      },
    },
  )
  const assertion = assert.rejects(result, /timed out/).finally(() => {
    settled = true
  })
  await waiting.promise
  t.mock.timers.tick(1_000)
  await second.promise
  assert.equal(calls, 2)
  t.mock.timers.tick(8_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assertion
  assert.equal(calls, 2)
})

test('attempt timeout exits after 30 seconds even when a transport ignores cancellation', async (t) => {
  // A hosted engine can take more than 10 seconds to accept an order. The
  // default attempt limit must not report that accepted order as uncertain.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = deferred<void>()
  let calls = 0
  let settled = false
  const result = runOrderQuoteRefreshRetry(
    async () => {
      calls++
      entered.resolve()
      return new Promise(() => {})
    },
    isOrderQuotesRefreshingError,
    {
      quoteRefreshRetry: { authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120 },
    },
  )
  const assertion = assert.rejects(result, /timed out/).finally(() => {
    settled = true
  })
  await entered.promise
  t.mock.timers.tick(29_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assertion
  assert.equal(calls, 1)
})

test('a caller can shorten but not extend the 30-second attempt limit', async () => {
  const { BitcasterEngineClient } = await import('../src/engineClient.ts')
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls++
      return new Response(null, { status: 500 })
    },
  })
  const request = {
    settlementCapability: { artifactId: 'initial', bindingDigest: 'digest' },
    comment: null,
  }
  await assert.rejects(
    client.submitOrder('market', request, { requestTimeoutMs: 30_001 }),
    /between 1 and 30000 milliseconds/,
  )
  await assert.rejects(
    runOrderQuoteRefreshRetry(async () => 1, isOrderQuotesRefreshingError, {
      requestTimeoutMs: 30_001,
      quoteRefreshRetry: { authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120 },
    }),
    /between 1 and 30000 milliseconds/,
  )
  assert.equal(calls, 0)
})

test('SDK freezes bytes including comment while refreshing authentication', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { BitcasterEngineClient } = await import('../src/engineClient.ts')
  const waiting = deferred<void>()
  const bodies: string[] = [],
    authBodies: string[] = []
  let auth = 0
  const terminal = new Error('second transport is ambiguous')
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: ({ bodyText }) => {
      authBodies.push(bodyText!)
      return `auth-${++auth}`
    },
    fetchImpl: async (_url, init) => {
      bodies.push(init!.body as string)
      if (bodies.length === 1)
        return new Response(refusal.detail, {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        })
      throw terminal
    },
  })
  const request = {
    settlementCapability: { artifactId: 'initial', bindingDigest: 'digest' },
    comment: {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      createdAt: 1234,
      kind: 1 as const,
      tags: [['r', 'https://app.example/markets/condition']],
      content: 'original signed content',
      sig: 'c'.repeat(128),
    },
  }
  const result = client.submitOrder('market', request, {
    quoteRefreshRetry: {
      authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
      onWaiting: () => waiting.resolve(),
    },
  })
  const assertion = assert.rejects(result, (e) => e === terminal)
  await waiting.promise
  request.settlementCapability.artifactId = 'changed'
  request.comment.createdAt = 9999
  request.comment.sig = 'mutated'
  request.comment.content = 'changed'
  t.mock.timers.tick(1000)
  await assertion
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
  assert.deepEqual(authBodies, bodies)
  assert.equal(auth, 2)
})

test('total wait budget does not reset after a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const waiting = deferred<void>()
  let calls = 0
  const result = runOrderQuoteRefreshRetry(
    async () => {
      calls++
      throw refusal
    },
    isOrderQuotesRefreshingError,
    {
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
        onWaiting: () => waiting.resolve(),
      },
    },
  )
  const assertion = assert.rejects(
    result,
    (e) => e instanceof OrderQuoteRefreshWaitStopped && e.reason === 'budget',
  )
  await waiting.promise
  // The delay ends when the 60-second budget from the first submission is
  // used. A reset budget would start a second attempt.
  now = 60_000
  t.mock.timers.tick(1000)
  await assertion
  assert.equal(calls, 1)
})

test('an explicit shorter timeout also bounds a single attempt without retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { BitcasterEngineClient } = await import('../src/engineClient.ts')
  const entered = deferred<void>()
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls++
      entered.resolve()
      return new Promise(() => {})
    },
  })
  const result = client.submitOrder(
    'market',
    { settlementCapability: { artifactId: 'initial', bindingDigest: 'digest' }, comment: null },
    { requestTimeoutMs: 500 },
  )
  const assertion = assert.rejects(result)
  await entered.promise
  t.mock.timers.tick(500)
  await assertion
  assert.equal(calls, 1)
})
