import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseTradeCreatedPayload,
  parseTradeStateChangedPayload,
} from '../src/tradeHubConnection.ts'

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
      100,
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
      divisibility: 100,
    },
  )
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

test('parseTradeStateChangedPayload retains the allowlisted terminal failure reason', () => {
  assert.deepEqual(
    parseTradeStateChangedPayload(
      'trade-1',
      'Failed',
      'maker-collateral-failure',
    ),
    {
      tradeId: 'trade-1',
      newState: 'Failed',
      failureReason: 'maker-collateral-failure',
    },
  )
})
