import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideTradeCreated,
  type TradeCreatedDecisionInput,
  type TradeCreatedExpectedOrder,
} from '../src/tradeFlow.ts'
import { validateTradeCreatedProtocol } from '../src/tradeSession.ts'

function tradeInput(overrides: Partial<TradeCreatedDecisionInput> = {}): TradeCreatedDecisionInput {
  return {
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    outcomeFaceAmountSubunits: 1_000_000,
    quotePaymentSubunits: 400_000,
    baseAsset: 'sat',
    divisibility: 10_000,
    ...overrides,
  }
}

test('decideTradeCreated uses shared trade-session protocol validation', () => {
  const payload = tradeInput({
    ownEphemeralPubkey: 'abc',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'YES',
  })
  const sharedError = validateTradeCreatedProtocol(payload)
  const decision = decideTradeCreated(payload)

  assert.equal(sharedError, 'Trade rejected: mint split keep and lock outcome sets are identical.')
  assert.deepEqual(decision, {
    accepted: false,
    reason: 'invalid-protocol',
    error: sharedError,
    role: 'seller',
    counterpartyPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
  })
})

test('decideTradeCreated accepts exact sat product settlement metadata', () => {
  assert.deepEqual(decideTradeCreated(tradeInput()), {
    accepted: true,
    role: 'buyer',
    counterpartyPubkey: 'abc',
    sellerLocktime: 120,
    buyerLocktime: 60,
  })
})

test('decideTradeCreated rejects missing or noncanonical product base assets', () => {
  for (const baseAsset of [undefined, null, '', 'SAT', ' sat', 'sat ', 'usd', 'jpy', 'btc']) {
    const decision = decideTradeCreated(tradeInput({ baseAsset: baseAsset as unknown as string }))
    assert.equal(decision.accepted, false)
    if (!decision.accepted) {
      assert.equal(decision.reason, 'invalid-protocol')
      assert.match(decision.error, /Trade unit must be exactly sat/)
    }
  }
})

test('decideTradeCreated rejects missing or unsupported divisibilities', () => {
  for (const divisibility of [undefined, null, 0, 100, 1_000, 2_000, 10_001]) {
    const decision = decideTradeCreated(
      tradeInput({ divisibility: divisibility as unknown as number }),
    )
    assert.equal(decision.accepted, false)
    if (!decision.accepted) {
      assert.equal(decision.reason, 'invalid-protocol')
      assert.match(decision.error, /Trade divisibility is unsupported/)
    }
  }
})

test('decideTradeCreated accepts explicit numeric metadata without a local expectation', () => {
  const decision = decideTradeCreated(
    tradeInput({
      divisibility: 1_000_000,
      outcomeFaceAmountSubunits: 1_000_000,
      quotePaymentSubunits: 400_000,
    }),
  )
  assert.equal(decision.accepted, true)
})

test('decideTradeCreated requires both canonical amounts for every divisibility', () => {
  for (const divisibility of [10_000, 1_000_000]) {
    for (const overrides of [
      { outcomeFaceAmountSubunits: undefined },
      { outcomeFaceAmountSubunits: 0 },
      { outcomeFaceAmountSubunits: 1.5 },
      { quotePaymentSubunits: undefined },
      { quotePaymentSubunits: 0 },
      { quotePaymentSubunits: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const decision = decideTradeCreated(tradeInput({ divisibility, ...overrides }))
      assert.equal(decision.accepted, false)
      if (!decision.accepted) {
        assert.match(decision.error, /settlement metadata.*(missing|positive safe integer)/i)
      }
    }
  }
})

test('decideTradeCreated rejects mismatched local unit expectations', () => {
  const baseAssetMismatch = decideTradeCreated(
    tradeInput({ expectedBaseAsset: 'usd', expectedDivisibility: 10_000 }),
  )
  assert.equal(baseAssetMismatch.accepted, false)
  if (!baseAssetMismatch.accepted) {
    assert.match(baseAssetMismatch.error, /Expected trade unit is unsupported/)
  }

  const divisibilityMismatch = decideTradeCreated(
    tradeInput({ expectedBaseAsset: 'sat', expectedDivisibility: 1_000_000 }),
  )
  assert.equal(divisibilityMismatch.accepted, false)
  if (!divisibilityMismatch.accepted) {
    assert.match(divisibilityMismatch.error, /divisibility mismatch/i)
  }
})

test('decideTradeCreated validates buyer quote against submitted order limit', () => {
  const decision = decideTradeCreated(
    tradeInput({
      outcomeFaceAmountSubunits: 1_000_000,
      quotePaymentSubunits: 400_001,
      expectedOrder: order({
        side: 'Buy',
        tokenSide: 'Outcome',
        priceSubunits: 4_000,
      }),
    }),
  )

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.match(decision.error, /exceeds the submitted order price/i)
  }
})

test('decideTradeCreated validates exact maker bid-as-complement quote', () => {
  const expectedOrder = order({
    side: 'bid',
    tokenSide: 'Complement',
    priceSubunits: 2_000,
    quotePolicy: 'exact',
  })
  const accepted = decideTradeCreated(
    tradeInput({
      ownEphemeralPubkey: 'abc',
      quotePaymentSubunits: 800_000,
      expectedOrder,
    }),
  )
  assert.equal(accepted.accepted, true)

  const rejected = decideTradeCreated(
    tradeInput({
      ownEphemeralPubkey: 'abc',
      quotePaymentSubunits: 800_001,
      expectedOrder,
    }),
  )
  assert.equal(rejected.accepted, false)
  if (!rejected.accepted) {
    assert.match(rejected.error, /does not satisfy the submitted order price/i)
  }
})

test('decideTradeCreated accepts mint seller settlement backed by outcome-side bid', () => {
  const decision = decideTradeCreated(
    tradeInput({
      ownEphemeralPubkey: 'abc',
      quotePaymentSubunits: 900_000,
      expectedOrder: order({
        side: 'Buy',
        tokenSide: 'Outcome',
        priceSubunits: 1_000,
        quotePolicy: 'exact',
      }),
    }),
  )
  assert.equal(decision.accepted, true)
})

test('decideTradeCreated fails closed when expected order economics are required but missing', () => {
  const decision = decideTradeCreated(tradeInput({ requireExpectedOrder: true }))
  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.match(decision.error, /Expected order economics are missing/i)
  }
})

test('decideTradeCreated enforces direct-settlement role and order side', () => {
  const seller = decideTradeCreated(
    tradeInput({
      ownEphemeralPubkey: 'abc',
      settlementKind: 'DirectSwap',
      expectedOrder: order({ side: 'Sell', tokenSide: 'Outcome' }),
    }),
  )
  assert.equal(seller.accepted, true)

  const wrongSellerSide = decideTradeCreated(
    tradeInput({
      ownEphemeralPubkey: 'abc',
      settlementKind: 'DirectSwap',
      expectedOrder: order({ side: 'Buy', tokenSide: 'Outcome' }),
    }),
  )
  assert.equal(wrongSellerSide.accepted, false)
  if (!wrongSellerSide.accepted) {
    assert.match(wrongSellerSide.error, /role does not match/)
  }
})

function order(overrides: Partial<TradeCreatedExpectedOrder>): TradeCreatedExpectedOrder {
  return {
    side: 'Buy',
    tokenSide: 'Outcome',
    priceSubunits: 4_000,
    amountSubunits: 1_000_000,
    ...overrides,
  }
}
