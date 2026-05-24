import { describe, expect, it } from 'vitest'
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
} from '@bitcaster/client-sdk/tradeFlow'
import { TRADE_MESSAGE_TYPES } from '@bitcaster/client-sdk/tradeSession'

describe('shared trade-flow event planner', () => {
  it('accepts own TradeCreated payloads and resolves local role', () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: 'abc',
      sellerPubkey: 'ABC',
      buyerPubkey: 'def',
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: 'DirectSwap',
    })

    expect(decision).toMatchObject({
      accepted: true,
      role: 'seller',
      counterpartyPubkey: 'def',
      sellerLocktime: 120,
      buyerLocktime: 60,
    })
  })

  it('rejects malformed settlement metadata fail-closed before locking proofs', () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: 'abc',
      sellerPubkey: 'abc',
      buyerPubkey: 'def',
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: 'SellSellMerge',
    })

    expect(decision).toMatchObject({
      accepted: false,
      reason: 'invalid-protocol',
    })
  })

  it('plans buyer response once both seller ciphertexts are present', () => {
    const first = decideSwapMessage({
      role: 'buyer',
      messages: {},
      messageType: TRADE_MESSAGE_TYPES.adaptorPoint,
      ciphertext: 'cipher-a',
    })
    expect(first).toMatchObject({
      messageKey: 'adaptorPoint',
      action: 'none',
    })

    const second = decideSwapMessage({
      role: 'buyer',
      messages: first.messages,
      messageType: TRADE_MESSAGE_TYPES.lockedProofsSeller,
      ciphertext: 'cipher-s',
    })
    expect(second).toMatchObject({
      messageKey: 'lockedProofsSeller',
      action: 'buyer-respond',
    })
  })

  it('maps engine trade states to driver actions', () => {
    expect(decideTradeStateChanged('Settling')).toBe('settlement-claim')
    expect(decideTradeStateChanged('Confirmed')).toBe('finish-confirmed')
    expect(decideTradeStateChanged('Cancelled')).toBe('finish-failed')
    expect(decideTradeStateChanged('Unknown')).toBe('none')
  })
})
