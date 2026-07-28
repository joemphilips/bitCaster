import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  conditionIdFromMarketId,
  generateEphemeralKeypair,
  handleMatchedForMaker,
  handlePendingPubkeySubmissions,
  joinTradeWithRetry,
  parseMatchedDelta,
  type KeypairStore,
  type MatchedDelta,
} from '../src/tradeIgnition.ts'

test('generateEphemeralKeypair returns compressed secp256k1 hex keys', () => {
  const keypair = generateEphemeralKeypair()

  assert.match(keypair.privateKeyHex, /^[0-9a-f]{64}$/)
  assert.match(keypair.publicKeyHex, /^0[23][0-9a-f]{64}$/)
})

test('conditionIdFromMarketId splits on the rightmost dash', () => {
  assert.equal(conditionIdFromMarketId('condition-with-dashes-YES'), 'condition-with-dashes')
  assert.equal(conditionIdFromMarketId('abcdef-NO'), 'abcdef')
})

test('parseMatchedDelta accepts camelCase payloads', () => {
  const parsed = parseMatchedDelta({
    marketId: 'condition-YES',
    tradeId: '11111111-1111-4111-8111-111111111111',
    makerOrderId: '22222222-2222-4222-8222-222222222222',
    takerOrderId: '33333333-3333-4333-8333-333333333333',
    executionPrice: 51,
    amountSubunits: 1_000,
    path: 'Complementary',
    matchedAt: '2026-06-30T00:00:00Z',
    deadline: '2026-06-30T00:00:10Z',
    collateralUnit: 'msat',
    baseAsset: 'sat',
    divisibility: 10_000,
    quotePaymentSubunits: 51_000,
    outcomeFaceAmountSubunits: 1_000_000,
    tokenSide: 'Outcome',
  })

  assert.deepEqual(parsed, {
    marketId: 'condition-YES',
    tradeId: '11111111-1111-4111-8111-111111111111',
    makerOrderId: '22222222-2222-4222-8222-222222222222',
    takerOrderId: '33333333-3333-4333-8333-333333333333',
    executionPrice: 51,
    amountSubunits: 1_000,
    path: 'Complementary',
    matchedAt: '2026-06-30T00:00:00Z',
    deadline: '2026-06-30T00:00:10Z',
    collateralUnit: 'msat',
    baseAsset: 'sat',
    divisibility: 10_000,
    quotePaymentSubunits: 51_000,
    outcomeFaceAmountSubunits: 1_000_000,
    tokenSide: 'Outcome',
  })
})

test('parseMatchedDelta accepts a complete PascalCase payload', () => {
  const parsed = parseMatchedDelta({
    MarketId: 'condition-YES',
    TradeId: '11111111-1111-4111-8111-111111111111',
    MakerOrderId: '22222222-2222-4222-8222-222222222222',
    TakerOrderId: '33333333-3333-4333-8333-333333333333',
    ExecutionPrice: 51,
    AmountSubunits: 1_000,
    Path: 'Mint',
    MatchedAt: '2026-06-30T11:59:59Z',
    Deadline: '2026-06-30T12:00:00Z',
    CollateralUnit: 'msat',
    BaseAsset: 'sat',
    Divisibility: 10_000,
    QuotePaymentSubunits: 51_000,
    OutcomeFaceAmountSubunits: 1_000_000,
    TokenSide: 'Complement',
  })

  assert.equal(parsed?.path, 'Mint')
  assert.equal(parsed?.matchedAt, '2026-06-30T11:59:59Z')
  assert.equal(parsed?.deadline, '2026-06-30T12:00:00Z')
  assert.equal(parsed?.baseAsset, 'sat')
  assert.equal(parsed?.tokenSide, 'Complement')
})

test('parseMatchedDelta returns null for incomplete payloads', () => {
  assert.equal(parseMatchedDelta({ tradeId: 'missing-market' }), null)
  for (const required of [
    'path',
    'matchedAt',
    'collateralUnit',
    'baseAsset',
    'divisibility',
    'quotePaymentSubunits',
    'outcomeFaceAmountSubunits',
    'tokenSide',
  ]) {
    const payload: Record<string, unknown> = { ...matchedDelta() }
    delete payload[required]
    assert.equal(parseMatchedDelta(payload), null, `accepted missing ${required}`)
  }
  assert.equal(parseMatchedDelta(null), null)
})

test('handleMatchedForMaker submits only once for our maker order', async () => {
  const seenTradeIds = new Set<string>()
  const submissions: Array<{ tradeId: string; pubkey: string; conditionId: string }> = []
  const store = memoryStore({ t1: '02'.padEnd(66, 'a') })

  const params = {
    keypairStore: store,
    seenTradeIds,
    isOurOrder: async (orderId: string) => orderId === 'maker-1',
    submitEphemeralPubkey: async (tradeId: string, pubkey: string, conditionId: string) => {
      submissions.push({ tradeId, pubkey, conditionId })
      return { tradeId, role: 'maker', bothReceived: false }
    },
  }

  const first = await handleMatchedForMaker(
    {
      ...matchedDelta(),
      marketId: 'condition-YES',
      tradeId: 't1',
      makerOrderId: 'maker-1',
      takerOrderId: 'taker-1',
    },
    params,
  )
  const second = await handleMatchedForMaker(
    {
      ...matchedDelta(),
      marketId: 'condition-YES',
      tradeId: 't1',
      makerOrderId: 'maker-1',
      takerOrderId: 'taker-1',
    },
    params,
  )

  assert.deepEqual(first, { submitted: true, tradeId: 't1', role: 'maker' })
  assert.deepEqual(second, { submitted: false, tradeId: 't1', reason: 'duplicate' })
  assert.deepEqual(submissions, [
    { tradeId: 't1', pubkey: '02'.padEnd(66, 'a'), conditionId: 'condition' },
  ])
})

test('handleMatchedForMaker ignores taker-only and foreign-maker matches', async () => {
  const submissions: string[] = []
  const params = {
    keypairStore: memoryStore({ t1: '02'.padEnd(66, 'a') }),
    isOurOrder: async (orderId: string) => orderId === 'our-taker-order',
    submitEphemeralPubkey: async (tradeId: string) => {
      submissions.push(tradeId)
      return { tradeId, role: 'maker', bothReceived: false }
    },
  }

  const result = await handleMatchedForMaker(
    {
      ...matchedDelta(),
      marketId: 'condition-YES',
      tradeId: 't1',
      makerOrderId: 'foreign-maker-order',
      takerOrderId: 'our-taker-order',
    },
    params,
  )

  assert.deepEqual(result, { submitted: false, tradeId: 't1', reason: 'not-maker-order' })
  assert.deepEqual(submissions, [])
})

test('handlePendingPubkeySubmissions submits each pending taker pubkey once', async () => {
  const seenTradeIds = new Set<string>(['already'])
  const submissions: Array<{ tradeId: string; pubkey: string; conditionId?: string }> = []

  const results = await handlePendingPubkeySubmissions(
    {
      pendingPubkeySubmissions: [
        {
          tradeId: 'already',
          role: 'taker',
          fillAmountSubunits: 50,
          deadline: '2026-06-30T00:00:10Z',
        },
        { tradeId: 'new', role: 'taker', fillAmountSubunits: 50, deadline: '2026-06-30T00:00:10Z' },
      ],
    },
    {
      conditionId: 'condition',
      keypairStore: memoryStore({ new: '03'.padEnd(66, 'b') }),
      seenTradeIds,
      submitEphemeralPubkey: async (tradeId, pubkey, conditionId) => {
        submissions.push({ tradeId, pubkey, conditionId })
        return { tradeId, role: 'taker', bothReceived: false }
      },
    },
  )

  assert.deepEqual(results, [
    { submitted: false, tradeId: 'already', reason: 'duplicate' },
    { submitted: true, tradeId: 'new', role: 'taker' },
  ])
  assert.deepEqual(submissions, [
    { tradeId: 'new', pubkey: '03'.padEnd(66, 'b'), conditionId: 'condition' },
  ])
})

test('joinTradeWithRetry retries while awaiting trade-created and dedupes successful joins', async () => {
  const joinedTradeIds = new Set<string>()
  let attempts = 0

  const first = await joinTradeWithRetry({
    tradeId: 't1',
    joinedTradeIds,
    getSwapStep: async () => 'awaiting-trade-created',
    invokeJoinTrade: async () => {
      attempts += 1
      return attempts < 3 ? { success: false, error: 'not-ready' } : { success: true }
    },
    delay: async () => {},
  })
  const second = await joinTradeWithRetry({
    tradeId: 't1',
    joinedTradeIds,
    getSwapStep: async () => 'awaiting-trade-created',
    invokeJoinTrade: async () => {
      throw new Error('must not invoke duplicate join')
    },
    delay: async () => {},
  })

  assert.deepEqual(first, { success: true })
  assert.deepEqual(second, { success: true, deduped: true })
  assert.equal(attempts, 3)
})

test('joinTradeWithRetry stops replay-miss retries when the swap step changes', async () => {
  let attempts = 0
  const result = await joinTradeWithRetry({
    tradeId: 't1',
    getSwapStep: async () => (attempts === 0 ? 'awaiting-trade-created' : 'trade-created'),
    invokeJoinTrade: async () => {
      attempts += 1
      return { success: false, error: 'not-ready' }
    },
    delay: async () => {},
  })

  assert.deepEqual(result, { success: false, error: 'not-ready' })
  assert.equal(attempts, 1)
})

function memoryStore(publicKeys: Record<string, string>): KeypairStore {
  return {
    async getOrCreatePublicKey(tradeId: string): Promise<string> {
      return publicKeys[tradeId] ?? '02'.padEnd(66, '0')
    },
    async getPrivateKey(): Promise<string | null> {
      return null
    },
  }
}

function matchedDelta(): MatchedDelta {
  return {
    marketId: 'condition-YES',
    tradeId: '11111111-1111-4111-8111-111111111111',
    makerOrderId: '22222222-2222-4222-8222-222222222222',
    takerOrderId: '33333333-3333-4333-8333-333333333333',
    executionPrice: 51,
    amountSubunits: 1_000,
    path: 'Complementary',
    matchedAt: '2026-06-30T00:00:00Z',
    deadline: '2026-06-30T00:00:10Z',
    collateralUnit: 'msat',
    baseAsset: 'sat',
    divisibility: 10_000,
    quotePaymentSubunits: 51_000,
    outcomeFaceAmountSubunits: 1_000_000,
    tokenSide: 'Outcome',
  }
}
