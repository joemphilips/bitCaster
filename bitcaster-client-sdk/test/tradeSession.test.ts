import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TRADE_MESSAGE_TYPES,
  cacheSwapCipher,
  decideSwapRole,
  hasBothSellerCiphers,
  isSwapCipherMessageType,
  isTradeMessageType,
  validateLocktimeOrdering,
  validateTradeCreatedProtocol,
} from '../src/tradeSession.ts'

test('validateLocktimeOrdering requires seller proofs to unlock after buyer proofs', () => {
  assert.equal(validateLocktimeOrdering(120, 100, 5), null)
  assert.match(
    validateLocktimeOrdering(105, 100, 5) ?? '',
    /locktime ordering violates protocol invariant/,
  )
  assert.match(
    validateLocktimeOrdering(Number.NaN, 100, 5) ?? '',
    /invalid locktime values/,
  )
})

test('validateTradeCreatedProtocol accepts direct and complete complementary metadata', () => {
  assert.equal(
    validateTradeCreatedProtocol({
      sellerLocktime: 120,
      buyerLocktime: 100,
      settlementKind: 'DirectSwap',
    }),
    null,
  )
  assert.equal(
    validateTradeCreatedProtocol({
      sellerLocktime: 120,
      buyerLocktime: 100,
      settlementKind: 'ComplementarySplit',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
    }),
    null,
  )
})

test('validateTradeCreatedProtocol rejects unsupported or ambiguous settlement metadata', () => {
  for (const [fields, expected] of [
    [
      {
        sellerLocktime: 120,
        buyerLocktime: 100,
        settlementKind: 'SellSellMerge',
      },
      /unsupported settlement kind/,
    ],
    [
      {
        sellerLocktime: 120,
        buyerLocktime: 100,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: '',
        sellerLockOutcomeSetId: 'NO',
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
      },
      /missing seller outcome-set metadata/,
    ],
    [
      {
        sellerLocktime: 120,
        buyerLocktime: 100,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'YES',
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
      },
      /keep and lock outcome sets are identical/,
    ],
    [
      {
        sellerLocktime: 120,
        buyerLocktime: 100,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
        outcomeFaceAmountSats: 0,
        quotePaymentSats: 42,
      },
      /missing a positive outcome face amount/,
    ],
    [
      {
        sellerLocktime: 120,
        buyerLocktime: 100,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 0,
      },
      /missing a positive quote payment/,
    ],
  ] as const) {
    assert.match(validateTradeCreatedProtocol(fields) ?? '', expected)
  }
})

test('decideSwapRole and message helpers are deterministic at the SDK boundary', () => {
  assert.equal(
    decideSwapRole({
      ownEphemeralPubkey: 'ABC',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
    }),
    'seller',
  )
  assert.equal(
    decideSwapRole({
      ownEphemeralPubkey: 'DEF',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
    }),
    'buyer',
  )
  assert.equal(
    decideSwapRole({
      ownEphemeralPubkey: '999',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
    }),
    null,
  )

  assert.equal(isTradeMessageType(TRADE_MESSAGE_TYPES.settlementComplete), true)
  assert.equal(isSwapCipherMessageType(TRADE_MESSAGE_TYPES.settlementComplete), false)
  assert.equal(isSwapCipherMessageType(TRADE_MESSAGE_TYPES.lockedProofsBuyer), true)

  const received: {
    adaptorPoint?: string
    lockedProofsSeller?: string
    lockedProofsBuyer?: string
  } = {}
  cacheSwapCipher(received, TRADE_MESSAGE_TYPES.adaptorPoint, 'cipher-a')
  cacheSwapCipher(received, TRADE_MESSAGE_TYPES.lockedProofsSeller, 'cipher-b')
  cacheSwapCipher(received, TRADE_MESSAGE_TYPES.settlementComplete, 'ignored')

  assert.deepEqual(received, {
    adaptorPoint: 'cipher-a',
    lockedProofsSeller: 'cipher-b',
  })
  assert.equal(hasBothSellerCiphers(received), true)
})
