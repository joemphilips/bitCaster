import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { parseMarketStatusChanged, SignalRMarketHubConnection } from '../src/marketHubConnection.ts'
import { createMarketWatch } from '../src/marketWatch.ts'

test('committed comment handler refreshes the real watch even when economic values stay unchanged', async () => {
  let watch: ReturnType<typeof createMarketWatch>
  let reads = 0
  await fixture(
    async (hub, connections) => {
      watch = createMarketWatch({
        hub,
        engine: {
          getMarketRegistration: async () =>
            ({ conditionId: CONDITION, outcomes: ['YES', 'NO'] }) as never,
          getMarket: async () => {
            reads++
            return { conditionId: CONDITION, state: 'open', fundingRevision: 'unchanged' } as never
          },
          getOrderBook: async (marketId) => ({ marketId, bids: [], asks: [] }) as never,
        },
      })
      const reader = watch.watch([CONDITION], new AbortController().signal)
      await reader.next()
      const initial = (await reader.next()).value
      assert.equal(reads, 1)
      const socket = connections[0]!
      assert.equal(typeof socket.handlers.get('MarketCommentsChanged'), 'function')
      for (let index = 0; index < 1_000; index++) {
        socket.emit('MarketCommentsChanged', {
          conditionId: CONDITION,
          eventOrder: 'opaque-source-position',
        })
        socket.emit('MarketCommentsChanged', {
          conditionId: 'cd'.repeat(32),
          eventOrder: 'unrelated',
        })
      }
      await tick()
      assert.equal(reads, 1)
      const refreshed = (await reader.next()).value
      assert.deepEqual(refreshed, initial)
      assert.equal(refreshed?.event, 'market.snapshot')
      assert.equal(reads, 2)
      await reader.return()
      socket.emit('MarketCommentsChanged', { conditionId: CONDITION, eventOrder: 'later' })
      await tick()
      assert.equal(reads, 2)
    },
    {},
    { onMarketInvalidated: async (conditionId) => watch.invalidate(conditionId) },
  )
})

test('MarketStatusChanged requires one exact closed-condition identity', () => {
  const conditionId = 'ab'.repeat(32)
  assert.deepEqual(
    parseMarketStatusChanged({
      conditionId: conditionId.toUpperCase(),
      state: 'closed',
      closedAt: '2026-08-02T00:00:00.000Z',
      finalOutcome: 'YES',
    }),
    {
      conditionId,
      state: 'closed',
      closedAt: '2026-08-02T00:00:00.000Z',
      finalOutcome: 'YES',
    },
  )
  assert.throws(
    () =>
      parseMarketStatusChanged({
        conditionId,
        state: 'closed',
        closedAt: null,
        finalOutcome: 'YES',
      }),
    /lifecycle fields/,
  )
})

const CONDITION = 'ab'.repeat(32)
const YES = `${CONDITION}-YES`
const NO = `${CONDITION}-NO`

test('market subscriptions share membership and release the last owner only', async () => {
  await fixture(async (hub, connections) => {
    const first = {},
      second = {}
    await hub.setMarkets(first, [YES])
    await hub.start()
    await hub.setMarkets(second, [YES, NO])
    await hub.setMarkets(second, [YES, NO])
    await hub.releaseMarkets(first)
    assert.deepEqual(connections[0]!.invocations, [
      ['JoinMarket', YES],
      ['JoinMarket', NO],
    ])
    await hub.releaseMarkets(second)
    assert.deepEqual(connections[0]!.invocations.slice(2), [
      ['LeaveMarket', YES],
      ['LeaveMarket', NO],
    ])
  })
})

test('stop cancels a starting connection and rejects its late completion', async () => {
  const start = deferred()
  await fixture(
    async (hub, connections) => {
      await hub.trackMarket(YES)
      const starting = hub.start()
      const refused = assert.rejects(starting, /cancelled/)
      await tick()
      await hub.stop()
      assert.equal(connections[0]!.stops, 1)
      start.resolve()
      await refused
      assert.deepEqual(connections[0]!.invocations, [])
    },
    { start: () => start.promise },
  )
})

test('release during an in-flight join leaves the group when that join finishes', async () => {
  const join = deferred()
  await fixture(
    async (hub, connections) => {
      const owner = {}
      await hub.setMarkets(owner, [YES])
      const starting = hub.start()
      await tick()
      const released = hub.releaseMarkets(owner)
      join.resolve()
      await Promise.all([starting, released])
      assert.deepEqual(connections[0]!.invocations, [
        ['JoinMarket', YES],
        ['LeaveMarket', YES],
      ])
    },
    { invoke: (method) => (method === 'JoinMarket' ? join.promise : Promise.resolve()) },
  )
})

test('reconnect restores only current memberships before requesting a fresh snapshot', async () => {
  let refreshed = 0,
    disconnected = 0
  await fixture(
    async (hub, connections) => {
      const owner = {}
      await hub.setMarkets(owner, [YES, NO])
      await hub.start()
      await hub.setMarkets(owner, [NO])
      connections[0]!.reconnecting?.()
      assert.equal(disconnected, 1)
      connections[0]!.reconnected?.()
      await tick()
      assert.equal(refreshed, 1)
      assert.deepEqual(connections[0]!.invocations, [
        ['JoinMarket', YES],
        ['JoinMarket', NO],
        ['LeaveMarket', YES],
        ['JoinMarket', NO],
      ])
    },
    {},
    {
      onDisconnected: () => {
        disconnected += 1
      },
      onReconnected: async () => {
        refreshed += 1
      },
    },
  )
})

test('a slow consumer coalesces repeated updates instead of retaining every payload', async () => {
  const consumer = deferred()
  const observed: string[] = []
  await fixture(
    async (hub, connections) => {
      await hub.trackMarket(YES)
      await hub.start()
      const socket = connections[0]!
      socket.emit('OrderBookUpdated', { marketId: YES })
      assert.deepEqual(observed, [CONDITION])
      for (let i = 0; i < 10000; i++) {
        socket.emit('ConfirmedTradeRecorded', { conditionId: CONDITION })
        socket.emit('MarketFundingUpdated', { conditionId: 'cd'.repeat(32) })
      }
      consumer.resolve()
      await tick()
      assert.deepEqual(observed, [CONDITION, CONDITION])
    },
    {},
    {
      onMarketInvalidated: async (id) => {
        observed.push(id)
        await consumer.promise
      },
    },
  )
})

test('every public market change invalidates the snapshot and released or old sockets do not', async () => {
  const observed: string[] = []
  const statuses: string[] = []
  await fixture(
    async (hub, connections) => {
      const owner = {}
      await hub.setMarkets(owner, [YES])
      await hub.start()
      for (const [event, payload] of [
        ['OrderBookUpdated', { marketId: YES }],
        ['OrderCancelled', { marketId: YES }],
        ['ConfirmedTradeRecorded', { conditionId: CONDITION }],
        ['MarketFundingUpdated', { conditionId: CONDITION }],
        [
          'MarketStatusChanged',
          { conditionId: CONDITION, state: 'closed', closedAt: '2026-10-02', finalOutcome: 'YES' },
        ],
      ] as const) {
        connections[0]!.emit(event, payload)
        await tick()
      }
      assert.equal(observed.length, 5)
      assert.deepEqual(statuses, ['closed'])
      await hub.releaseMarkets(owner)
      connections[0]!.emit('OrderCancelled', { marketId: YES })
      await tick()
      assert.equal(observed.length, 5)
      await hub.stop()
      await hub.setMarkets(owner, [YES])
      await hub.start()
      connections[0]!.emit('OrderCancelled', { marketId: YES })
      await tick()
      assert.equal(observed.length, 5)
      connections[1]!.emit('OrderCancelled', { marketId: YES })
      await tick()
      assert.equal(observed.length, 6)
    },
    {},
    {
      onMarketInvalidated: async (id) => {
        observed.push(id)
      },
      onMarketStatusChanged: async (status) => {
        statuses.push(status.state)
      },
    },
  )
})

test('managed holdings replace obsolete routes without removing a live watch', async () => {
  await fixture(async (hub, connections) => {
    const watch = {}
    await hub.trackMarket(YES)
    await hub.start()
    await hub.setMarkets(watch, [YES])
    await hub.setManagedMarkets([NO])
    assert.deepEqual(connections[0]!.invocations, [
      ['JoinMarket', YES],
      ['JoinMarket', NO],
    ])
    await hub.releaseMarkets(watch)
    assert.deepEqual(connections[0]!.invocations.at(-1), ['LeaveMarket', YES])
  })
})

test('a closed connection cannot prevent a new watch from starting or revive old callbacks', async () => {
  let invalidations = 0
  await fixture(
    async (hub, connections) => {
      await hub.trackMarket(YES)
      await Promise.all([hub.start(), hub.start()])
      assert.equal(connections.length, 1)
      connections[0]!.reconnecting?.()
      connections[0]!.emit('OrderBookUpdated', { marketId: YES })
      await tick()
      assert.equal(invalidations, 0)
      connections[0]!.closed?.()
      await hub.start()
      assert.equal(connections.length, 2)
      connections[0]!.reconnected?.()
      connections[0]!.emit('OrderBookUpdated', { marketId: YES })
      await tick()
      assert.equal(invalidations, 0)
      assert.deepEqual(connections[1]!.invocations, [['JoinMarket', YES]])
    },
    {},
    {
      onMarketInvalidated: async () => {
        invalidations += 1
      },
    },
  )
})

test('valuation memberships share one connection and release only the departing owner', async () => {
  await fixture(async (hub, connections) => {
    const first = {},
      second = {}
    await hub.setPortfolioValuationConditions(first, [CONDITION, 'BEEF'])
    await hub.start()
    await hub.setMarkets(second, [YES])
    await hub.setPortfolioValuationConditions(second, ['BEEF'])
    await hub.releasePortfolioValuationConditions(first)
    await hub.releasePortfolioValuationConditions(second)
    assert.equal(connections.length, 1)
    assert.deepEqual(connections[0]!.invocations, [
      ['SetPortfolioValuationSubscriptions', ['BEEF', CONDITION]],
      ['JoinMarket', YES],
      ['SetPortfolioValuationSubscriptions', ['BEEF']],
      ['SetPortfolioValuationSubscriptions', []],
    ])
  })
})

test('valuation overflow and invalid identities preserve the previously accepted owner set', async () => {
  await fixture(async (hub, connections) => {
    const first = {},
      second = {}
    const conditions = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(4, '0'))
    await hub.setPortfolioValuationConditions(first, conditions)
    await hub.start()
    for (const next of [['not-hex'], ['f'.repeat(129)], [...conditions, 'beef']])
      await assert.rejects(hub.setPortfolioValuationConditions(first, next))
    await assert.rejects(hub.setPortfolioValuationConditions(second, ['beef']))
    assert.equal(connections[0]!.invocations.length, 1)
    await hub.releasePortfolioValuationConditions(first)
    assert.deepEqual(connections[0]!.invocations.at(-1), ['SetPortfolioValuationSubscriptions', []])
  })
})

test('valuation-only events preserve exact condition identity and stop after release', async () => {
  const observed: string[] = []
  await fixture(
    async (hub, connections) => {
      const owner = {}
      await hub.setPortfolioValuationConditions(owner, ['BEEF'])
      await hub.start()
      for (const event of ['ConfirmedTradeRecorded', 'MarketStatusChanged']) {
        connections[0]!.emit(event, { conditionId: 'BEEF', state: 'closed' })
        await tick()
      }
      assert.deepEqual(observed, ['BEEF', 'BEEF'])
      connections[0]!.emit('ConfirmedTradeRecorded', { conditionId: 'beef' })
      await hub.releasePortfolioValuationConditions(owner)
      connections[0]!.emit('ConfirmedTradeRecorded', { conditionId: 'BEEF' })
      await tick()
      assert.deepEqual(observed, ['BEEF', 'BEEF'])
    },
    {},
    {
      onMarketInvalidated: async (id) => {
        observed.push(id)
      },
    },
  )
})

test('reconnect restores valuation membership before announcing a fresh snapshot', async () => {
  const replacement = deferred()
  let invocations = 0,
    refreshed = 0
  await fixture(
    async (hub, connections) => {
      await hub.setPortfolioValuationConditions({}, [CONDITION])
      await hub.start()
      connections[0]!.reconnecting?.()
      connections[0]!.reconnected?.()
      await tick()
      assert.equal(refreshed, 0)
      replacement.resolve()
      await tick()
      assert.equal(refreshed, 1)
      assert.deepEqual(connections[0]!.invocations, [
        ['SetPortfolioValuationSubscriptions', [CONDITION]],
        ['SetPortfolioValuationSubscriptions', [CONDITION]],
      ])
    },
    {
      invoke: async () => {
        if (++invocations === 2) await replacement.promise
      },
    },
    {
      onReconnected: async () => {
        refreshed++
      },
    },
  )
})

test('release during a pending valuation replacement sends the latest empty set', async () => {
  const replacement = deferred()
  await fixture(
    async (hub, connections) => {
      const owner = {}
      await hub.setPortfolioValuationConditions(owner, [CONDITION])
      const starting = hub.start()
      await tick()
      const released = hub.releasePortfolioValuationConditions(owner)
      replacement.resolve()
      await Promise.all([starting, released])
      assert.deepEqual(connections[0]!.invocations, [
        ['SetPortfolioValuationSubscriptions', [CONDITION]],
        ['SetPortfolioValuationSubscriptions', []],
      ])
    },
    { invoke: () => replacement.promise },
  )
})

interface FakeBehavior {
  start?: () => Promise<void>
  invoke?: (method: string) => Promise<void>
}

class FakeConnection {
  readonly handlers = new Map<string, (...args: unknown[]) => void>()
  readonly invocations: unknown[][] = []
  reconnected?: () => void
  reconnecting?: () => void
  closed?: () => void
  stops = 0
  readonly behavior: FakeBehavior
  constructor(behavior: FakeBehavior) {
    this.behavior = behavior
  }
  start() {
    return this.behavior.start?.() ?? Promise.resolve()
  }
  async stop() {
    this.stops += 1
  }
  on(event: string, callback: (...args: unknown[]) => void) {
    this.handlers.set(event, callback)
  }
  onreconnected(callback: () => void) {
    this.reconnected = callback
  }
  onreconnecting(callback: () => void) {
    this.reconnecting = callback
  }
  onclose(callback: () => void) {
    this.closed = callback
  }
  async invoke(method: string, ...args: unknown[]) {
    this.invocations.push([method, ...args])
    await this.behavior.invoke?.(method)
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload)
  }
}

async function fixture(
  run: (hub: SignalRMarketHubConnection, connections: FakeConnection[]) => Promise<void>,
  behavior: FakeBehavior = {},
  callbacks: Partial<ConstructorParameters<typeof SignalRMarketHubConnection>[0]> = {},
) {
  const signalR = createRequire(import.meta.url)('@microsoft/signalr') as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(signalR, 'HubConnectionBuilder')!
  const connections: FakeConnection[] = []
  Object.defineProperty(signalR, 'HubConnectionBuilder', {
    configurable: true,
    value: class {
      withUrl() {
        return this
      }
      withAutomaticReconnect() {
        return this
      }
      build() {
        const connection = new FakeConnection(behavior)
        connections.push(connection)
        return connection
      }
    },
  })
  const hub = new SignalRMarketHubConnection({
    engineBaseUrl: 'https://engine.example',
    nostrSecretKeyHex: '11'.repeat(32),
    ...callbacks,
  })
  try {
    await run(hub, connections)
  } finally {
    await hub.stop()
    Object.defineProperty(signalR, 'HubConnectionBuilder', descriptor)
  }
}

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
