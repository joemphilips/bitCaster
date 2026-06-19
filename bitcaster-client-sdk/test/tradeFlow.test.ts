import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideTradeCreated } from '../src/tradeFlow.ts'
import { validateTradeCreatedProtocol } from '../src/tradeSession.ts'

test('decideTradeCreated uses shared trade-session protocol validation', () => {
  const payload = {
    ownEphemeralPubkey: 'abc',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'YES',
    outcomeFaceAmountSats: 100,
    quotePaymentSats: 99,
  }

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

test('decideTradeCreated validates canonical amounts without legacy sats fields', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.deepEqual(decision, {
    accepted: true,
    role: 'buyer',
    counterpartyPubkey: 'abc',
    sellerLocktime: 120,
    buyerLocktime: 60,
  })
})

test('decideTradeCreated accepts non-default canonical amounts when local expected unit is asserted', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.deepEqual(decision, {
    accepted: true,
    role: 'buyer',
    counterpartyPubkey: 'abc',
    sellerLocktime: 120,
    buyerLocktime: 60,
  })
})

test('decideTradeCreated rejects non-default canonical amounts when local expected unit is not asserted', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /expected unit|local unit|base asset|divisibility/i)
  }
})

test('decideTradeCreated rejects non-default canonical amounts when only expected divisibility is asserted', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /expected unit|local unit|base asset|divisibility/i)
  }
})

test('decideTradeCreated derives unambiguous sat/100 default from legacy-only payload when expected unit is missing', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    outcomeFaceAmountSats: 100,
    quotePaymentSats: 40,
  })

  assert.deepEqual(decision, {
    accepted: true,
    role: 'buyer',
    counterpartyPubkey: 'abc',
    sellerLocktime: 120,
    buyerLocktime: 60,
  })
})

test('decideTradeCreated validates payload unit against expected local unit', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'sat',
    divisibility: 100,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /unit mismatch/i)
  }
})

test('decideTradeCreated rejects omitted non-default payload metadata from expected local unit', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 400,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /unit mismatch/i)
  }
})

test('decideTradeCreated rejects non-default units without canonical amounts', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSats: 1_000,
    quotePaymentSats: 400,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /missing outcome face subunits/i)
  }
})

test('decideTradeCreated rejects unsupported explicit unit metadata', () => {
  for (const baseAsset of ['btc', ' sats ']) {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: 'def',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
      sellerLocktime: 120,
      buyerLocktime: 60,
      baseAsset,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 40,
    })

    assert.equal(decision.accepted, false)
    if (!decision.accepted) {
      assert.equal(decision.reason, 'invalid-protocol')
      assert.match(decision.error, /unit is unsupported/i)
    }
  }
})

test('decideTradeCreated rejects unsupported explicit divisibility metadata', () => {
  for (const divisibility of [1, 99, 101]) {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: 'def',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
      sellerLocktime: 120,
      buyerLocktime: 60,
      divisibility,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 40,
    })

    assert.equal(decision.accepted, false)
    if (!decision.accepted) {
      assert.equal(decision.reason, 'invalid-protocol')
      assert.match(decision.error, /divisibility is unsupported/i)
    }
  }
})

test('decideTradeCreated validates buyer quote against submitted order limit', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 401,
    expectedOrder: {
      side: 'Buy',
      tokenSide: 'Outcome',
      priceSubunits: 400,
      amountSubunits: 1_000,
    },
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /exceeds the submitted order price/i)
  }
})

test('decideTradeCreated validates exact maker bid-as-complement quote', () => {
  const accepted = decideTradeCreated({
    ownEphemeralPubkey: 'abc',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 800,
    expectedOrder: {
      side: 'bid',
      tokenSide: 'Complement',
      priceSubunits: 200,
      amountSubunits: 1_000,
      quotePolicy: 'exact',
    },
  })
  assert.equal(accepted.accepted, true)

  const rejected = decideTradeCreated({
    ownEphemeralPubkey: 'abc',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'usd',
    divisibility: 1_000,
    expectedBaseAsset: 'usd',
    expectedDivisibility: 1_000,
    outcomeFaceAmountSubunits: 1_000,
    quotePaymentSubunits: 801,
    expectedOrder: {
      side: 'bid',
      tokenSide: 'Complement',
      priceSubunits: 200,
      amountSubunits: 1_000,
      quotePolicy: 'exact',
    },
  })

  assert.equal(rejected.accepted, false)
  if (!rejected.accepted) {
    assert.equal(rejected.reason, 'invalid-protocol')
    assert.match(rejected.error, /does not satisfy the submitted order price/i)
  }
})

test('decideTradeCreated rejects mint seller settlement backed by outcome-side bid', () => {
  const rejected = decideTradeCreated({
    ownEphemeralPubkey: 'abc',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    baseAsset: 'sat',
    divisibility: 100,
    outcomeFaceAmountSubunits: 100,
    quotePaymentSubunits: 99,
    expectedOrder: {
      side: 'Buy',
      tokenSide: 'Outcome',
      priceSubunits: 1,
      amountSubunits: 100,
      quotePolicy: 'exact',
    },
  })

  assert.equal(rejected.accepted, false)
  if (!rejected.accepted) {
    assert.equal(rejected.reason, 'invalid-protocol')
    assert.match(rejected.error, /role does not match/i)
  }
})

test('decideTradeCreated fails closed when expected order economics are required but missing', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'def',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    outcomeFaceAmountSubunits: 100,
    quotePaymentSubunits: 40,
    requireExpectedOrder: true,
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /Expected order economics are missing/i)
  }
})

test('decideTradeCreated rejects buy-side mint seller without explicit token side', () => {
  const decision = decideTradeCreated({
    ownEphemeralPubkey: 'abc',
    sellerPubkey: 'abc',
    buyerPubkey: 'def',
    sellerLocktime: 120,
    buyerLocktime: 60,
    settlementKind: 'Mint',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'NO',
    outcomeFaceAmountSubunits: 100,
    quotePaymentSubunits: 60,
    expectedOrder: {
      side: 'Buy',
      priceSubunits: 40,
      amountSubunits: 100,
    },
  })

  assert.equal(decision.accepted, false)
  if (!decision.accepted) {
    assert.equal(decision.reason, 'invalid-protocol')
    assert.match(decision.error, /role does not match/)
  }
})
