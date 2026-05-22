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
