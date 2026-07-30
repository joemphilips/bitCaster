import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRangeSettlementDelta, parseTradeCreatedPayload } from '../src/tradeHubConnection.ts'

test('parseTradeCreatedPayload accepts current TradeCreated contract shape', () => {
  assert.deepEqual(
    parseTradeCreatedPayload(
      'trade-1',
      'seller-pubkey',
      'buyer-pubkey',
      '2026-05-21T00:02:00.000Z',
      '2026-05-21T00:01:00.000Z',
      'cond-YES',
      100,
      100,
      42,
      'Mint',
      'YES',
      'NO',
      'sat',
      'msat',
      10_000,
      'Outcome',
    ),
    {
      tradeId: 'trade-1',
      sellerPubkey: 'seller-pubkey',
      buyerPubkey: 'buyer-pubkey',
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
      baseAsset: 'sat',
      collateralUnit: 'msat',
      divisibility: 10_000,
    },
  )
})

test('parseTradeCreatedPayload rejects a missing or non-msat collateral unit', () => {
  const args = [
    'trade-1',
    'seller-pubkey',
    'buyer-pubkey',
    '2026-05-21T00:02:00.000Z',
    '2026-05-21T00:01:00.000Z',
    'cond-YES',
    100,
    100,
    42,
    'Mint',
    'YES',
    'NO',
    'sat',
  ] as const
  assert.throws(() => parseTradeCreatedPayload(...args), /unexpected shape/)
  assert.throws(() => parseTradeCreatedPayload(...args, 'sat'), /unexpected shape/)
})

test('parseTradeCreatedPayload rejects missing marketId before local order binding', () => {
  assert.throws(
    () =>
      parseTradeCreatedPayload(
        'trade-1',
        'seller-pubkey',
        'buyer-pubkey',
        '2026-05-21T00:02:00.000Z',
        '2026-05-21T00:01:00.000Z',
        undefined,
      ),
    /TradeCreated payload had unexpected shape/,
  )
  assert.throws(
    () =>
      parseTradeCreatedPayload(
        'trade-1',
        'seller-pubkey',
        'buyer-pubkey',
        '2026-05-21T00:02:00.000Z',
        '2026-05-21T00:01:00.000Z',
        '   ',
      ),
    /TradeCreated payload had unexpected shape/,
  )
})

test('parseRangeSettlementDelta accepts owner-filtered lifecycle notifications', () => {
  assert.deepEqual(
    parseRangeSettlementDelta({
      orderId: '5f612d3d-c561-429a-947b-f00fa51a7845',
      marketId: 'condition-YES',
      status: 'SettlementPending',
    }),
    {
      orderId: '5f612d3d-c561-429a-947b-f00fa51a7845',
      marketId: 'condition-YES',
    },
  )
})

test('parseRangeSettlementDelta rejects malformed notifications', () => {
  assert.throws(() => parseRangeSettlementDelta(null), /unexpected shape/)
  assert.throws(() => parseRangeSettlementDelta({ marketId: 'condition-YES' }), /unexpected shape/)
  assert.throws(
    () => parseRangeSettlementDelta({ orderId: 'order-1', marketId: '   ' }),
    /unexpected shape/,
  )
})
