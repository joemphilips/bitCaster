import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DaemonTradeRuntime,
  buildTradeResumePlan,
  type TradeRuntimeConnection,
} from '../src/tradeRuntime.ts'
import { emptyDaemonState, type DaemonState } from '../src/state.ts'

test('buildTradeResumePlan rejoins live orders and swaps only', () => {
  const state = emptyDaemonState()
  state.orders['resting'] = order('resting', 'cond-YES', 'resting', ['trade-a'])
  state.orders['filled'] = order('filled', 'cond-YES', 'filled', ['trade-filled'])
  state.swaps['trade-b'] = swap('trade-b', 'cond-NO', 'opened')
  state.swaps['trade-done'] = swap('trade-done', 'cond-NO', 'confirmed')

  assert.deepEqual(buildTradeResumePlan(state), {
    orders: [{ marketId: 'cond-YES', orderId: 'resting' }],
    trades: [
      { marketId: 'cond-YES', tradeId: 'trade-a' },
      { marketId: 'cond-NO', tradeId: 'trade-b' },
    ],
  })
})

test('DaemonTradeRuntime starts once and deduplicates joins', async () => {
  const calls: string[] = []
  const connection: TradeRuntimeConnection = {
    async start() {
      calls.push('start')
    },
    async stop() {
      calls.push('stop')
    },
    async joinOrder(marketId, orderId) {
      calls.push(`joinOrder:${marketId}:${orderId}`)
    },
    async joinTrade(tradeId) {
      calls.push(`joinTrade:${tradeId}`)
      return { success: true }
    },
    async sendSwapMessage(tradeId, messageType, ciphertext) {
      calls.push(`sendSwapMessage:${tradeId}:${messageType}:${ciphertext}`)
    },
  }
  const runtime = new DaemonTradeRuntime(connection)
  const state = emptyDaemonState()
  state.orders['resting'] = order('resting', 'cond-YES', 'resting', ['trade-a'])
  state.swaps['trade-a'] = swap('trade-a', 'cond-YES', 'opened')

  await runtime.start(state)
  await runtime.start(state)
  await runtime.stop()

  assert.deepEqual(calls, [
    'start',
    'joinOrder:cond-YES:resting',
    'joinTrade:trade-a',
    'stop',
  ])
})

test('DaemonTradeRuntime retries awaiting trade-created joins until replay succeeds', async () => {
  const calls: string[] = []
  let attempts = 0
  const connection: TradeRuntimeConnection = {
    async start() {
      calls.push('start')
    },
    async stop() {
      calls.push('stop')
    },
    async joinOrder(marketId, orderId) {
      calls.push(`joinOrder:${marketId}:${orderId}`)
    },
    async joinTrade(tradeId) {
      calls.push(`joinTrade:${tradeId}`)
      attempts += 1
      return attempts < 3
        ? { success: false, error: 'Trade was not found' }
        : { success: true }
    },
    async sendSwapMessage(tradeId, messageType, ciphertext) {
      calls.push(`sendSwapMessage:${tradeId}:${messageType}:${ciphertext}`)
    },
  }
  const runtime = new DaemonTradeRuntime(connection, { joinTradeRetryDelayMs: 0 })
  const state = emptyDaemonState()
  state.swaps['trade-a'] = swap('trade-a', 'cond-YES', 'awaiting-trade-created')

  await runtime.start(state)

  assert.deepEqual(calls, [
    'start',
    'joinTrade:trade-a',
    'joinTrade:trade-a',
    'joinTrade:trade-a',
  ])
})

test('DaemonTradeRuntime stops retrying when swap advances and schedules one recovery pass after exhaustion', async () => {
  const scheduledRecoveryDelays: number[] = []
  const joinCalls: string[] = []
  const connection: TradeRuntimeConnection = {
    async start() {},
    async stop() {},
    async joinOrder() {},
    async joinTrade(tradeId) {
      joinCalls.push(tradeId)
      return { success: false, error: 'Trade was not found' }
    },
    async sendSwapMessage() {},
  }
  const runtime = new DaemonTradeRuntime(connection, {
    joinTradeRetryDelayMs: 0,
    scheduleResumeActiveSwaps: (delayMs) => {
      scheduledRecoveryDelays.push(delayMs)
    },
  })
  const state = emptyDaemonState()
  state.swaps['trade-a'] = swap('trade-a', 'cond-YES', 'awaiting-trade-created')

  await runtime.start(state)
  await runtime.start(state)
  state.swaps['trade-a']!.step = 'opened'
  await runtime.start(state)

  assert.equal(joinCalls.length, 13)
  assert.deepEqual(scheduledRecoveryDelays, [10_000, 10_000])
})

function order(
  orderId: string,
  marketId: string,
  status: string,
  tradeIds: string[],
): DaemonState['orders'][string] {
  return {
    orderId,
    marketId,
    status,
    tradeIds,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

function swap(
  tradeId: string,
  marketId: string,
  step: DaemonState['swaps'][string]['step'],
): DaemonState['swaps'][string] {
  return {
    tradeId,
    marketId,
    messages: {},
    step,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}
