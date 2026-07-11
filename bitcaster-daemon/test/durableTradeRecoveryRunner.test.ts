import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { createDaemonDurableTradeRecoveryRunner } from '../src/durableTradeRecovery.ts'
import { emptyDaemonState, type DaemonState } from '../src/state.ts'

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
  let coordinatorRuns = 0
  const runner = createDaemonDurableTradeRecoveryRunner({
    executor: {
      async resumeActiveSwaps() {
        calls.push('legacy')
        return { activeSwaps: 0 }
      },
    } as never,
    connection: {} as never,
    loadState: async () => emptyDaemonState(),
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
  const queuedEvent = runner.runTradeEvent('trade-event', async () => {
    calls.push('event-executor')
  })
  const bootstrap = runner.finishBootstrap()
  await bootstrapStarted
  assert.deepEqual(calls, ['coordinator:1'])

  releaseBootstrap!()
  await bootstrap
  await queuedEvent

  assert.deepEqual(calls, [
    'coordinator:1',
    'legacy',
    'coordinator:2',
    'legacy',
    'event-executor',
  ])
})

test('daemon recovery retry is one-shot, coalesced, and does no work after locktime', async () => {
  let nowMs = 1_000
  const state = retryState()
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
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
      (timer as unknown as { cleared: boolean }).cleared = true
    },
    recoverDurableSessions: async ({ scheduleRetry }) => {
      coordinatorRuns += 1
      if (coordinatorRuns === 1) {
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId: state.proofOperations['trade-retry/seller-lock']!.durableTradeRecovery!.operationId,
          delayMs: 25,
          reason: 'rate-limited',
        })
        await scheduleRetry({
          tradeId: 'trade-retry',
          operationId: state.proofOperations['trade-retry/seller-lock']!.durableTradeRecovery!.operationId,
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
