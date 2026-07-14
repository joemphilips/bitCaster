import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { createDaemonDurableTradeRecoveryRunner } from '../src/durableTradeRecovery.ts'
import {
  emptyDaemonState,
  readState,
  recordSwapMessage,
  type DaemonState,
} from '../src/state.ts'
import { writeStateWithDurableSessionKeys } from './durableSessionTestStore.ts'

test('daemon recovery owner queues a runtime event behind bootstrap recovery', async () => {
  const calls: string[] = []
  let releaseBootstrap: (() => void) | undefined
  let beginBootstrap: (() => void) | undefined
  const bootstrapStarted = new Promise<void>((resolve) => {
    beginBootstrap = resolve
  })
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve
  })
  const state = eventState()
  let coordinatorRuns = 0
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps() {
        calls.push('legacy')
        return { activeSwaps: 0 }
      },
    } as never,
    connection: {} as never,
    loadState: async () => state,
    recoverDurableSessions: async () => {
      coordinatorRuns += 1
      calls.push(`coordinator:${coordinatorRuns}`)
      if (coordinatorRuns === 1) {
        beginBootstrap!()
        await bootstrapGate
      }
      return { sessions: [], orphans: [] }
    },
  })

  runner.armBootstrap()
  const queuedEvent = runner.runTradeEvent(
    'trade-event',
    async () => {
      calls.push('event-persist')
      return 'persisted-event'
    },
    async (persisted) => {
      assert.equal(persisted, 'persisted-event')
      calls.push('event-executor')
    },
  )
  const bootstrap = runner.finishBootstrap()
  await bootstrapStarted
  assert.deepEqual(calls, ['coordinator:1'])

  releaseBootstrap!()
  await bootstrap
  await queuedEvent

  assert.deepEqual(calls, [
    'coordinator:1',
    'legacy',
    'event-persist',
    'coordinator:2',
    'legacy',
    'event-executor',
  ])
})

test('runtime recovery targets one trade without sweeping unrelated active work', async () => {
  const state = eventState()
  state.swaps['trade-event'] = {
    tradeId: 'trade-event',
    orderId: 'order-event',
    marketId: 'condition-event-YES',
    role: 'seller',
    messages: {},
    step: 'seller-opened',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
  state.swaps['trade-other'] = {
    tradeId: 'trade-other',
    orderId: 'order-other',
    marketId: 'condition-other-YES',
    role: 'seller',
    messages: {},
    step: 'seller-opened',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
  const recoveryTargets: Array<string | undefined> = []
  const executorTargets: string[][] = []
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps(selected: DaemonState) {
        executorTargets.push(Object.keys(selected.swaps))
        return { activeSwaps: Object.keys(selected.swaps).length }
      },
    } as never,
    connection: {} as never,
    loadState: async () => state,
    recoverDurableSessions: async ({ tradeId }) => {
      recoveryTargets.push(tradeId)
      return { sessions: [], orphans: [] }
    },
  })

  await runner.recoverTrade('trade-event')

  assert.deepEqual(recoveryTargets, ['trade-event'])
  assert.deepEqual(executorTargets, [['trade-event']])
})

test('daemon recovery retry is one-shot, coalesced, and does no work after locktime', async () => {
  let nowMs = 1_000
  const state = retryState()
  const timers: Array<{
    callback: () => void
    delayMs: number
    cleared: boolean
  }> = []
  let coordinatorRuns = 0
  let legacyRuns = 0
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps() {
        legacyRuns += 1
        return { activeSwaps: 0 }
      },
    } as never,
    connection: {} as never,
    loadState: async () => state,
    nowMs: () => nowMs,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false, unref() {} }
      timers.push(timer)
      return timer as never
    },
    clearTimer: (timer) => {
      ;(timer as unknown as { cleared: boolean }).cleared = true
    },
    recoverDurableSessions: async ({ scheduleRetry }) => {
      coordinatorRuns += 1
      if (coordinatorRuns === 1) {
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId:
            state.proofOperations['trade-retry/seller-lock']!
              .durableTradeRecovery!.operationId,
          delayMs: 25,
          reason: 'rate-limited',
        })
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId:
            state.proofOperations['trade-retry/seller-lock']!
              .durableTradeRecovery!.operationId,
          delayMs: 50,
          reason: 'reservation-race',
        })
      }
      return { sessions: [], orphans: [] }
    },
  })

  await runner.recover()
  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.delayMs, 25)
  assert.equal(coordinatorRuns, 1)
  assert.equal(legacyRuns, 1)

  nowMs = 2_000
  timers[0]?.callback()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(coordinatorRuns, 1)
  assert.equal(legacyRuns, 1)
})

test('daemon recovery retry fires one serialized owner pass while it remains before locktime', async () => {
  const state = retryState()
  const timers: Array<{
    callback: () => void
    delayMs: number
    unref(): void
  }> = []
  let coordinatorRuns = 0
  let legacyRuns = 0
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps() {
        legacyRuns += 1
        return { activeSwaps: 0 }
      },
    } as never,
    connection: {} as never,
    loadState: async () => state,
    nowMs: () => 1_000,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} }
      timers.push(timer)
      return timer as never
    },
    recoverDurableSessions: async ({ scheduleRetry }) => {
      coordinatorRuns += 1
      if (coordinatorRuns === 1) {
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId:
            state.proofOperations['trade-retry/seller-lock']!
              .durableTradeRecovery!.operationId,
          delayMs: 25,
          reason: 'rate-limited',
        })
      }
      return { sessions: [], orphans: [] }
    },
  })

  await runner.recover()
  assert.equal(timers.length, 1)
  timers[0]?.callback()
  for (let attempt = 0; attempt < 20 && coordinatorRuns < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  assert.equal(coordinatorRuns, 2)
  assert.equal(legacyRuns, 2)
})

test('global recovery does not rescan every outstanding retry timer', async () => {
  const state = retryState()
  let stateLoads = 0
  let coordinatorRuns = 0
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps() {
        return { activeSwaps: 0 }
      },
    } as never,
    connection: {} as never,
    loadState: async () => {
      stateLoads += 1
      return state
    },
    nowMs: () => 1_000,
    setTimer: (() => ({ unref() {} })) as never,
    recoverDurableSessions: async ({ scheduleRetry }) => {
      coordinatorRuns += 1
      if (coordinatorRuns === 1) {
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId:
            state.proofOperations['trade-retry/seller-lock']!
              .durableTradeRecovery!.operationId,
          delayMs: 25,
          reason: 'rate-limited',
        })
      }
      return { sessions: [], orphans: [] }
    },
  })

  await runner.recover()
  stateLoads = 0
  await runner.recover()

  assert.equal(stateLoads, 1)
})

test('daemon recovery owner does not interleave an inbound cipher write with a paused session CAS', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-event-owner-cas-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = eventState()
    state.swaps['trade-event'] = {
      tradeId: 'trade-event',
      orderId: 'order-event',
      marketId: 'cond-YES',
      role: 'seller',
      messages: {},
      step: 'seller-opened',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    }
    await writeStateWithDurableSessionKeys(state)
    let beginRecovery: (() => void) | undefined
    let releaseRecovery: (() => void) | undefined
    const recoveryStarted = new Promise<void>((resolve) => {
      beginRecovery = resolve
    })
    const recoveryRelease = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let recoveryRuns = 0
    let eventActions = 0
    const runner = createDaemonDurableTradeRecoveryRunner({
      executor: {
        async resumeActiveSwaps() {
          return { activeSwaps: 0 }
        },
      } as never,
      connection: {} as never,
      loadState: async () => (await readState())!,
      recoverDurableSessions: async () => {
        recoveryRuns += 1
        const revision = (await readState())!.durableTradeSessions[
          'trade-event'
        ]!.revision
        if (recoveryRuns === 1) {
          beginRecovery!()
          await recoveryRelease
          assert.equal(
            (await readState())!.durableTradeSessions['trade-event']!.revision,
            revision,
            'an inbound event must not mutate the session during a coordinator CAS',
          )
        }
        return { sessions: [], orphans: [] }
      },
    })

    const recovery = runner.recover()
    await recoveryStarted
    const inbound = runner.runTradeEvent(
      'trade-event',
      () => recordSwapMessage('trade-event', 'adaptor-point', 'inbound-cipher'),
      async (swap) => {
        eventActions += 1
        assert.equal(swap?.messages.adaptorPoint, 'inbound-cipher')
      },
    )
    await Promise.resolve()
    assert.equal(
      (await readState())!.durableTradeSessions['trade-event']!.revision,
      0,
    )

    releaseRecovery!()
    await recovery
    await inbound

    assert.equal(recoveryRuns, 2)
    assert.equal(eventActions, 1)
    assert.equal(
      (await readState())!.durableTradeSessions['trade-event']!.receivedCiphers[
        'adaptor-point'
      ]?.ciphertext,
      'inbound-cipher',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

function retryState(): DaemonState {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-retry',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'mint-submitted',
    operationKey: 'trade-retry/seller-lock',
    kind: 'cashu-atomic',
  })
  const session: DurableTradeSession = {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: operation.tradeId,
    role: operation.role,
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 2,
    buyerLocktimeSecs: 1,
    ephemeralKeyHandle: {
      keyId: 'retry-key',
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 2,
      buyerLocktimeSecs: 1,
    },
    stage: 'mint-submitted',
    proofOperations: [operation],
    receivedCiphers: {},
    outboundCiphers: {},
  }
  const state = emptyDaemonState()
  state.durableTradeSessions[session.tradeId] = session
  state.proofOperations['trade-retry/seller-lock'] = {
    operationId: 'trade-retry/seller-lock',
    durableTradeRecovery: operation,
    kind: 'swap-lock',
    state: 'mint-submitted',
    mintUrl: session.mintUrl,
    inputs: [],
    outputs: {},
    metadata: { unit: 'sat' },
    createdAt: 1,
    updatedAt: 1,
  }
  return state
}

function eventState(): DaemonState {
  const state = emptyDaemonState()
  state.durableTradeSessions['trade-event'] = {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: 'trade-event',
    role: 'seller',
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    ephemeralKeyHandle: {
      keyId: 'event-key',
      tradeId: 'trade-event',
      role: 'seller',
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
  return state
}
