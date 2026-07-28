import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleMatchedForMaker } from '../src/marketHubConnection.ts'

const matchedDelta = {
  marketId: 'cond-with-dash-YES',
  tradeId: 'trade-1',
  makerOrderId: 'maker-order',
  takerOrderId: 'taker-order',
  executionPrice: 5_000,
  amountSubunits: 10_000,
  path: 'Complementary',
  matchedAt: '2026-06-29T00:00:00.000Z',
  deadline: '2026-06-30T00:00:00.000Z',
  baseAsset: 'sat',
  collateralUnit: 'msat',
  divisibility: 10_000,
  quotePaymentSubunits: 5_000,
  outcomeFaceAmountSubunits: 10_000,
  tokenSide: 'Outcome',
} as const

test('handleMatchedForMaker submits pubkey when maker order is known', async () => {
  const submitted: Array<{ tradeId: string; pubkey: string; conditionId?: string }> = []
  const processed = new Set<string>()
  const stored = new Map<string, { privateKeyHex: string; publicKeyHex: string }>()

  await handleMatchedForMaker({
    delta: matchedDelta,
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
      ...matchedDelta,
      takerOrderId: 'known-taker-order',
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

test('handleMatchedForMaker rejects incomplete product facts before every effect', async () => {
  const required = [
    'baseAsset',
    'collateralUnit',
    'divisibility',
    'executionPrice',
    'amountSubunits',
    'quotePaymentSubunits',
    'outcomeFaceAmountSubunits',
    'tokenSide',
    'path',
    'matchedAt',
  ] as const

  for (const field of required) {
    const malformed = { ...matchedDelta } as Record<string, unknown>
    delete malformed[field]
    const processed = new Set<string>()
    let keyCalls = 0
    let submitCalls = 0

    await assert.rejects(() =>
      handleMatchedForMaker({
        delta: malformed,
        processedTradeIds: processed,
        knownOrderIds: new Set(['maker-order']),
        getOrCreateEphemeralKeypair: async () => {
          keyCalls += 1
          return { privateKeyHex: 'priv', publicKeyHex: 'pub' }
        },
        submitEphemeralPubkey: async () => {
          submitCalls += 1
        },
      }),
    )
    assert.deepEqual([...processed], [], field)
    assert.equal(keyCalls, 0, field)
    assert.equal(submitCalls, 0, field)
  }
})
