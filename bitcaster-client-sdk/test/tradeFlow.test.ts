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
    settlementKind: 'ComplementarySplit',
    sellerKeepOutcomeSetId: 'YES',
    sellerLockOutcomeSetId: 'YES',
    outcomeFaceAmountSats: 100,
    quotePaymentSats: 99,
  }

  const sharedError = validateTradeCreatedProtocol(payload)
  const decision = decideTradeCreated(payload)

  assert.equal(sharedError, 'Trade rejected: complementary split keep and lock outcome sets are identical.')
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
