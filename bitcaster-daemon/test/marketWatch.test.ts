import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BitcasterEngineClient } from '../../bitcaster-client-sdk/src/engineClient.ts'
import { createMarketWatch } from '../src/marketWatch.ts'

const BINARY = 'ab'.repeat(32)
const CATEGORY = 'cd'.repeat(32)
const outcomes = new Map([
  [BINARY, ['YES', 'NO']],
  [CATEGORY, ['Red', 'Green', 'Blue']],
])
type Input = Parameters<typeof createMarketWatch>[0]

class FakeHub {
  readonly owners = new Map<object, readonly string[]>()
  readonly joined: string[][] = []
  released = 0
  connected = true
  setup: Promise<void> = Promise.resolve()
  startup: Promise<void> = Promise.resolve()
  cleanup: Promise<void> = Promise.resolve()
  async setMarkets(owner: object, routes: readonly string[]) {
    this.owners.set(owner, routes)
    this.joined.push([...routes])
    await this.setup
  }
  start() {
    return this.startup
  }
  isConnected() {
    return this.connected
  }
  async releaseMarkets(owner: object) {
    this.owners.delete(owner)
    this.released++
    await this.cleanup
  }
}

function fixture() {
  const hub = new FakeHub()
  const controller = new AbortController()
  const calls: string[] = []
  let revision = 1
  const engine = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input, init) => {
      assert.equal(init?.signal, controller.signal)
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      if (url.pathname.endsWith('/registration')) {
        const conditionId = url.pathname.split('/').at(-2)!
        return Response.json({
          conditionId,
          outcomes: outcomes.get(conditionId),
          baseAsset: 'sat',
          divisibility: 1000,
        })
      }
      if (url.pathname.endsWith('/query')) {
        const conditionId = url.searchParams.get('ids')
        return Response.json({
          markets: [{ conditionId, fundingRevision: String(revision), state: 'open' }],
          nextCursor: null,
        })
      }
      const marketId = url.pathname.split('/').at(-2)!
      return Response.json({ marketId, bids: [{ price: 250, amount: revision }], asks: [] })
    },
  })
  const watch = createMarketWatch({ hub, engine })
  return {
    hub,
    controller,
    calls,
    engine,
    watch,
    advance: () => {
      revision++
    },
  }
}

test('initial binary and categorical snapshots use real SDK routes and every registered outcome', async () => {
  const f = fixture()
  const reader = f.watch.watch([BINARY, CATEGORY], f.controller.signal)
  assert.deepEqual((await reader.next()).value?.data, { state: 'connected' })
  assert.deepEqual(f.hub.joined, [
    [`${BINARY}-YES`, `${BINARY}-NO`, `${CATEGORY}-Red`, `${CATEGORY}-Green`, `${CATEGORY}-Blue`],
  ])
  for (const [conditionId, names] of outcomes) {
    const frame = (await reader.next()).value!
    assert.equal(frame.event, 'market.snapshot')
    const data = frame.data as {
      conditionId: string
      market: { fundingRevision: string }
      orderBooks: Array<{ marketId: string }>
    }
    assert.equal(data.conditionId, conditionId)
    assert.equal(data.market.fundingRevision, '1')
    assert.deepEqual(
      data.orderBooks.map((book) => book.marketId),
      names.map((name) => `${conditionId}-${name}`),
    )
  }
  assert.deepEqual(f.calls, [
    `/api/v1/markets/${BINARY}/registration`,
    `/api/v1/markets/${CATEGORY}/registration`,
    `/api/v1/markets/query?state=All&ids=${BINARY}&page_size=1`,
    `/api/v1/${BINARY}-YES/orderbook`,
    `/api/v1/${BINARY}-NO/orderbook`,
    `/api/v1/markets/query?state=All&ids=${CATEGORY}&page_size=1`,
    `/api/v1/${CATEGORY}-Red/orderbook`,
    `/api/v1/${CATEGORY}-Green/orderbook`,
    `/api/v1/${CATEGORY}-Blue/orderbook`,
  ])
  await reader.return()
  assert.equal(f.hub.owners.size, 0)
  assert.equal(f.hub.released, 1)
})

test('a paused consumer coalesces repeated changes and ignores unrelated conditions', async () => {
  const f = fixture()
  const reader = f.watch.watch([BINARY], f.controller.signal)
  await reader.next()
  await reader.next()
  const before = f.calls.length
  f.advance()
  for (let i = 0; i < 10000; i++) {
    f.watch.invalidate(BINARY)
    f.watch.invalidate(CATEGORY)
  }
  assert.equal(f.calls.length, before)
  const frame = (await reader.next()).value!
  assert.equal((frame.data as { market: { fundingRevision: string } }).market.fundingRevision, '2')
  assert.equal(f.calls.length, before + 3)
  const idle = reader.next()
  await tick()
  assert.equal(f.calls.length, before + 3)
  f.controller.abort()
  await assert.rejects(idle, /aborted/)
  assert.equal(f.hub.released, 1)
})

for (const stage of [
  'registration',
  'subscription',
  'startup',
  'market',
  'orderbook',
  'idle',
] as const) {
  test(`cancellation during ${stage} releases its owner and does not wait for network completion`, async () => {
    const f = fixture()
    const entered = deferred()
    const blocked = deferred()
    const original: Input['engine'] = f.engine
    const engine: Input['engine'] = {
      getMarketRegistration: async (...args) => {
        if (stage === 'registration') {
          entered.resolve()
          await blocked.promise
        }
        return original.getMarketRegistration(...args)
      },
      getMarket: async (...args) => {
        if (stage === 'market') {
          entered.resolve()
          await blocked.promise
        }
        return original.getMarket(...args)
      },
      getOrderBook: async (...args) => {
        if (stage === 'orderbook') {
          entered.resolve()
          await blocked.promise
        }
        return original.getOrderBook(...args)
      },
    }
    if (stage === 'subscription') f.hub.setup = blocked.promise
    if (stage === 'startup') f.hub.startup = blocked.promise
    const watch = createMarketWatch({ hub: f.hub, engine })
    const reader = watch.watch([BINARY], f.controller.signal)
    let pending = reader.next()
    if (stage === 'market' || stage === 'orderbook' || stage === 'idle') {
      await pending
      pending = reader.next()
      if (stage === 'idle') {
        await pending
        pending = reader.next()
      }
    }
    const rejected = assert.rejects(pending, /aborted/)
    if (stage === 'registration' || stage === 'market' || stage === 'orderbook')
      await entered.promise
    else await tick()
    // A real hub can wait for an in-flight JoinMarket while it releases this owner.
    f.hub.cleanup = blocked.promise
    f.controller.abort()
    await rejected
    assert.equal(f.hub.owners.size, 0)
    assert.equal(f.hub.released, 1)
    blocked.resolve()
    await tick()
    assert.equal(f.hub.released, 1)
  })
}

test('a reconnect refreshes all selected markets and emits no reads while disconnected', async () => {
  const f = fixture()
  const reader = f.watch.watch([BINARY, CATEGORY], f.controller.signal)
  await reader.next()
  await reader.next()
  await reader.next()
  f.watch.disconnected()
  assert.deepEqual((await reader.next()).value?.data, { state: 'reconnecting' })
  const before = f.calls.length
  const pending = reader.next()
  f.watch.invalidate(BINARY)
  await tick()
  assert.equal(f.calls.length, before)
  f.advance()
  f.watch.reconnected()
  assert.deepEqual((await pending).value?.data, { state: 'connected' })
  for (const conditionId of [BINARY, CATEGORY]) {
    const frame = (await reader.next()).value!
    assert.equal((frame.data as { conditionId: string }).conditionId, conditionId)
    assert.equal(
      (frame.data as { market: { fundingRevision: string } }).market.fundingRevision,
      '2',
    )
  }
  await reader.return()
})

for (const disconnectObserved of [true, false]) {
  test(`a read spanning reconnect is discarded (disconnect observed: ${disconnectObserved})`, async () => {
    const f = fixture()
    const entered = deferred()
    const blocked = deferred()
    let reads = 0
    const engine: Input['engine'] = {
      getMarketRegistration: f.engine.getMarketRegistration.bind(f.engine),
      getOrderBook: f.engine.getOrderBook.bind(f.engine),
      getMarket: async (...args) => {
        const result = await f.engine.getMarket(...args)
        if (++reads === 1) {
          entered.resolve()
          await blocked.promise
        }
        return result
      },
    }
    const watch = createMarketWatch({ hub: f.hub, engine })
    const reader = watch.watch([BINARY], f.controller.signal)
    await reader.next()
    const reading = reader.next()
    await entered.promise
    if (disconnectObserved) watch.disconnected()
    f.advance()
    watch.reconnected()
    blocked.resolve()
    assert.equal((await reading).value?.event, 'market.connection')
    const frame = (await reader.next()).value!
    assert.equal(frame.event, 'market.snapshot')
    assert.equal(
      (frame.data as { market: { fundingRevision: string } }).market.fundingRevision,
      '2',
    )
    assert.equal(reads, 2)
    await reader.return()
  })
}

for (const stage of ['registration', 'subscription', 'startup', 'market', 'orderbook'] as const) {
  test(`a ${stage} failure closes the watch and releases membership`, async () => {
    const f = fixture()
    const fail = async () => {
      throw new Error('fixture failure')
    }
    const engine: Input['engine'] = {
      getMarketRegistration:
        stage === 'registration' ? fail : f.engine.getMarketRegistration.bind(f.engine),
      getMarket: stage === 'market' ? fail : f.engine.getMarket.bind(f.engine),
      getOrderBook: stage === 'orderbook' ? fail : f.engine.getOrderBook.bind(f.engine),
    }
    if (stage === 'subscription') f.hub.setMarkets = fail
    if (stage === 'startup') f.hub.start = fail
    const reader = createMarketWatch({ hub: f.hub, engine }).watch([BINARY], f.controller.signal)
    if (stage === 'market' || stage === 'orderbook') await reader.next()
    await assert.rejects(reader.next(), /fixture failure/)
    assert.equal(f.hub.owners.size, 0)
    assert.equal(f.hub.released, 1)
    assert.equal((await reader.next()).done, true)
  })
}

test('selection and unavailable registration fail before subscriptions or reads', async () => {
  const f = fixture()
  for (const ids of [
    [],
    [BINARY, BINARY],
    ['bad-id'],
    Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(64, '0')),
  ]) {
    await assert.rejects(
      f.watch.watch(ids, f.controller.signal).next(),
      /invalid market watch selection/,
    )
  }
  for (const registration of [
    null,
    { conditionId: CATEGORY, outcomes: ['YES', 'NO'] },
    { conditionId: BINARY, outcomes: ['YES', 'YES'] },
    { conditionId: BINARY, outcomes: ['bad-name', 'NO'] },
  ]) {
    const watch = createMarketWatch({
      hub: f.hub,
      engine: {
        getMarket: f.engine.getMarket.bind(f.engine),
        getOrderBook: f.engine.getOrderBook.bind(f.engine),
        getMarketRegistration: async () =>
          registration as Awaited<ReturnType<Input['engine']['getMarketRegistration']>>,
      },
    })
    await assert.rejects(
      watch.watch([BINARY], f.controller.signal).next(),
      /registration is unavailable/,
    )
  }
  assert.equal(f.hub.joined.length, 0)
  assert.equal(f.calls.length, 0)
})

test('independent consumers retain their own selections after one unsubscribes', async () => {
  const f = fixture()
  const first = f.watch.watch([BINARY], f.controller.signal)
  const second = f.watch.watch([BINARY, CATEGORY], f.controller.signal)
  await first.next()
  await second.next()
  await first.return()
  assert.equal(f.hub.owners.size, 1)
  await second.next()
  await second.next()
  f.advance()
  f.watch.invalidate(CATEGORY)
  const frame = (await second.next()).value!
  assert.equal((frame.data as { conditionId: string }).conditionId, CATEGORY)
  await second.return()
  assert.equal(f.hub.owners.size, 0)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
