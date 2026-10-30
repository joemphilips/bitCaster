import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  EngineClientError,
  isOrderBookRefreshingError,
} from '../src/engineClient.ts'

const problem = {
  type: '/errors/order-quotes-refreshing',
  status: 503,
  code: 'order-quotes-refreshing',
}
const refreshing = () => new Response(JSON.stringify(problem), { status: 503 })
const snapshot = { bids: [], asks: [], spread: 0 }
const available = () => Response.json(snapshot)

test('depth refresh classification requires the exact status, type and code', () => {
  assert.equal(
    isOrderBookRefreshingError(new EngineClientError(503, JSON.stringify(problem))),
    true,
  )
  for (const value of [
    null,
    [],
    {},
    { ...problem, status: 500 },
    { ...problem, type: '/errors/other' },
    { ...problem, code: 'other' },
  ]) {
    assert.equal(
      isOrderBookRefreshingError(new EngineClientError(503, JSON.stringify(value))),
      false,
    )
  }
  assert.equal(
    isOrderBookRefreshingError(new EngineClientError(500, JSON.stringify(problem))),
    false,
  )
  assert.equal(isOrderBookRefreshingError(new Error('order-quotes-refreshing')), false)
})

test('default depth reads make one attempt', async () => {
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls++
      return refreshing()
    },
  })
  await assert.rejects(client.getOrderBook('market'), isOrderBookRefreshingError)
  assert.equal(calls, 1)
})

test('a single depth read without retries still ends after ten seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requestSignal: AbortSignal | undefined
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    },
  })
  const read = client.getOrderBook('market', undefined, { retryRefreshing: false })
  await setImmediate()
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(9_999)
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(
    read,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
})

test('opt-in depth read recovers after a lost notification at the two-second cadence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => (++calls === 1 ? refreshing() : available()),
  })
  const result = client.getOrderBook('market', undefined, { retryRefreshing: true })
  await setImmediate()
  assert.equal(calls, 1)
  t.mock.timers.tick(1999)
  await setImmediate()
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(await result, snapshot)
  assert.equal(calls, 2)
})

test('opt-in depth read stops after five attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls++
      return refreshing()
    },
  })
  const result = assert.rejects(
    client.getOrderBook('market', undefined, { retryRefreshing: true }),
    isOrderBookRefreshingError,
  )
  for (let attempt = 1; attempt < 5; attempt++) {
    await setImmediate()
    assert.equal(calls, attempt)
    t.mock.timers.tick(2000)
  }
  await result
  t.mock.timers.tick(100_000)
  assert.equal(calls, 5)
})

test('cancelling a refresh wait prevents the next request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls++
      return refreshing()
    },
  })
  const result = assert.rejects(
    client.getOrderBook('market', controller.signal, { retryRefreshing: true }),
    { name: 'AbortError' },
  )
  await setImmediate()
  controller.abort()
  await result
  t.mock.timers.tick(100_000)
  assert.equal(calls, 1)
})

test('each opt-in request has a ten-second deadline without overlapping requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      calls++
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      )
    },
  })
  const result = assert.rejects(
    client.getOrderBook('market', undefined, { retryRefreshing: true }),
    { name: 'AbortError' },
  )
  await setImmediate()
  t.mock.timers.tick(9999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  await result
  assert.equal(calls, 1)
})

test('non-refresh failures stop immediately and fresh empty depth remains available', async () => {
  for (const response of [
    new Response('{}', { status: 503 }),
    new Response(JSON.stringify(problem), { status: 500 }),
    available(),
  ]) {
    let calls = 0
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async () => {
        calls++
        return response
      },
    })
    if (response.ok)
      assert.deepEqual(
        await client.getOrderBook('market', undefined, { retryRefreshing: true }),
        snapshot,
      )
    else
      await assert.rejects(
        client.getOrderBook('market', undefined, { retryRefreshing: true }),
        EngineClientError,
      )
    assert.equal(calls, 1)
  }
})
