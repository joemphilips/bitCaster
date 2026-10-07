import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  parseOrderLifecycleChanged,
  parseSettlementGroupStateChanged,
  SignalROrderLifecycleConnection,
} from '../src/orderHubConnection.ts'

const require = createRequire(import.meta.url)

test('order lifecycle callbacks require an owned order identity', () => {
  const identity = {
    orderId: '11111111-1111-4111-8111-111111111111',
    marketId: 'condition-YES',
  }
  const lifecycle = {
    ...identity,
    status: 'resting',
    remainingAmountSubunits: 1_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 1_000,
    activeSettlementGroup: null,
  }
  const settlement = {
    ...identity,
    settlementGroup: {
      groupId: '22222222-2222-4222-8222-222222222222',
      status: 'Prepared',
      revision: 1,
      coalescingDeadline: '2026-08-01T00:00:00.000Z',
      frozenAt: null,
    },
  }

  assert.deepEqual(parseOrderLifecycleChanged(lifecycle), identity)
  assert.deepEqual(parseSettlementGroupStateChanged(settlement), identity)
  assert.deepEqual(
    parseSettlementGroupStateChanged({
      ...settlement,
      settlementGroup: { ...settlement.settlementGroup, status: 'RejectedBeforeSubmission' },
    }),
    identity,
  )
  assert.throws(() => parseOrderLifecycleChanged({ ...lifecycle, tradeId: 'obsolete' }))
})

test('order lifecycle connection rejoins tracked orders after reconnect', async () => {
  const signalR = require('@microsoft/signalr') as Record<string, unknown>
  const originalBuilder = Object.getOwnPropertyDescriptor(signalR, 'HubConnectionBuilder')
  assert.ok(originalBuilder)

  const fake = new FakeHubConnection()
  const hubUrls: string[] = []
  Object.defineProperty(signalR, 'HubConnectionBuilder', {
    configurable: true,
    value: class {
      withUrl(url: string): this {
        hubUrls.push(url)
        return this
      }

      withAutomaticReconnect(): this {
        return this
      }

      build(): FakeHubConnection {
        return fake
      }
    },
  })

  let reconnects = 0
  const errors: string[] = []
  const receipts: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
  const callbackOrders: string[] = []
  try {
    const connection = new SignalROrderLifecycleConnection({
      engineBaseUrl: 'https://engine.example',
      nostrSecretKeyHex: '1'.repeat(64),
      observeOrderTimeline: (observation) => {
        receipts.push(observation)
        throw new Error('observer unavailable')
      },
      onSettlementGroupStateChanged: (delta) => {
        callbackOrders.push(delta.orderId)
      },
      onReconnected: () => {
        reconnects += 1
      },
      onError: (error) => errors.push(error.message),
    })
    await connection.trackOrder('condition-YES', 'order-1')
    await connection.trackOrder('condition-NO', 'order-2')
    await connection.start()
    assert.deepEqual(hubUrls, ['https://engine.example/hubs/order'])
    assert.equal(
      hubUrls.some((url) => url.includes('/hubs/trade')),
      false,
    )
    assert.deepEqual(fake.invocations, [
      ['JoinOrder', 'condition-YES', 'order-1'],
      ['JoinOrder', 'condition-NO', 'order-2'],
    ])
    const notify = fake.handlers.get('SettlementGroupStateChanged')!
    for (const orderId of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]) {
      notify({
        orderId,
        marketId: 'condition-YES',
        settlementGroup: {
          groupId: '33333333-3333-4333-8333-333333333333',
          status: 'Confirmed',
          revision: 2,
          coalescingDeadline: '2026-08-01T00:00:00.000Z',
          frozenAt: '2026-08-01T00:00:01.000Z',
        },
      })
    }
    await waitFor(() => callbackOrders.length === 2)
    assert.deepEqual(
      receipts.map(({ orderId }) => orderId),
      callbackOrders,
    )
    assert.equal(
      receipts.every(
        ({ groupId, groupRevision, operationId }) =>
          groupId === '33333333-3333-4333-8333-333333333333' &&
          groupRevision === 2 &&
          operationId === null,
      ),
      true,
    )

    fake.failingOrderId = 'order-1'
    await fake.reconnected?.()
    await waitFor(() => reconnects === 1)
    assert.deepEqual(fake.invocations.at(-1), ['JoinOrder', 'condition-NO', 'order-2'])

    await fake.closed?.(new Error('automatic reconnect exhausted'))
    await waitFor(() => reconnects === 2)
    assert.equal(fake.startCalls, 2)
    assert.deepEqual(fake.invocations.at(-1), ['JoinOrder', 'condition-NO', 'order-2'])
    assert.deepEqual(errors, [
      'join failed for order-1',
      'automatic reconnect exhausted',
      'join failed for order-1',
    ])
    notify({ orderId: 'malformed' })
    await waitFor(() => errors.length === 4)
    assert.equal(receipts.length, 2)
    assert.equal(callbackOrders.length, 2)

    await connection.stop()
    await fake.closed?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fake.startCalls, 2)
  } finally {
    Object.defineProperty(signalR, 'HubConnectionBuilder', originalBuilder)
  }
})

class FakeHubConnection {
  readonly handlers = new Map<string, (value: unknown) => void>()
  readonly invocations: unknown[][] = []
  startCalls = 0
  failingOrderId: string | null = null
  reconnected: (() => void) | undefined
  closed: ((error?: Error) => void) | undefined

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async stop(): Promise<void> {}

  on(name: string, callback: (value: unknown) => void): void {
    this.handlers.set(name, callback)
  }

  onreconnected(callback: () => void): void {
    this.reconnected = callback
  }

  onclose(callback: (error?: Error) => void): void {
    this.closed = callback
  }

  async invoke(methodName: string, ...args: unknown[]): Promise<void> {
    this.invocations.push([methodName, ...args])
    if (methodName === 'JoinOrder' && args[1] === this.failingOrderId) {
      throw new Error(`join failed for ${String(args[1])}`)
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
