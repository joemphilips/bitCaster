import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleMatchedForMaker } from '../src/marketHubConnection.ts'

test('handleMatchedForMaker submits pubkey when maker order is known', async () => {
  const submitted: Array<{ tradeId: string; pubkey: string; conditionId?: string }> = []
  const processed = new Set<string>()
  const stored = new Map<string, { privateKeyHex: string; publicKeyHex: string }>()

  await handleMatchedForMaker({
    delta: {
      marketId: 'cond-with-dash-YES',
      tradeId: 'trade-1',
      makerOrderId: 'maker-order',
      takerOrderId: 'taker-order',
      deadline: '2026-06-30T00:00:00.000Z',
    },
    processedTradeIds: processed,
    knownOrderIds: new Set(['maker-order']),
    getOrCreateEphemeralKeypair: async (tradeId) => {
      const existing = stored.get(tradeId)
      if (existing) return existing
      const created = { privateKeyHex: 'priv', publicKeyHex: 'pub' }
      stored.set(tradeId, created)
      return created
    },
    submitEphemeralPubkey: async (tradeId, pubkey, conditionId) => {
      submitted.push({ tradeId, pubkey, conditionId })
    },
  })

  assert.deepEqual(submitted, [
    { tradeId: 'trade-1', pubkey: 'pub', conditionId: 'cond-with-dash' },
  ])
})

test('handleMatchedForMaker ignores other orders and dedupes by trade id', async () => {
  const processed = new Set<string>()
  let submitCount = 0
  const input = {
    delta: {
      marketId: 'cond-YES',
      tradeId: 'trade-1',
      makerOrderId: 'maker-order',
      takerOrderId: 'known-taker-order',
      deadline: '2026-06-30T00:00:00.000Z',
    },
    processedTradeIds: processed,
    knownOrderIds: new Set(['known-taker-order']),
    getOrCreateEphemeralKeypair: async () => ({ privateKeyHex: 'priv', publicKeyHex: 'pub' }),
    submitEphemeralPubkey: async () => {
      submitCount += 1
    },
  }

  await handleMatchedForMaker(input)
  assert.equal(submitCount, 0)

  await handleMatchedForMaker({
    ...input,
    knownOrderIds: new Set(['maker-order']),
  })
  await handleMatchedForMaker({
    ...input,
    knownOrderIds: new Set(['maker-order']),
  })

  assert.equal(submitCount, 1)
})
