import { describe, expect, it } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import {
  buyerPrepareSwap,
  MIN_LOCKTIME_DELTA_SECS,
  sellerPrepareSwap,
  type SwapContext,
  validateLocktimeOrdering,
} from '../atomicSwap'
import {
  computeSharedSecret,
  decrypt,
  deriveEncryptionKey,
  generateEphemeralKeypair,
} from '../ecdh'

// ---------------------------------------------------------------------------
// validateLocktimeOrdering
//
// The protocol requires `T_YES > T_sat + Δ` — i.e.
// `sellerLocktime > buyerLocktime + MIN_LOCKTIME_DELTA_SECS`. The frontend
// gate mirrors the wallet-service's defense-in-depth check so a buggy or
// malicious engine cannot trick the user into locking proofs in a vulnerable
// shape.
// ---------------------------------------------------------------------------

describe('validateLocktimeOrdering', () => {
  const buyer = 1_700_000_000

  it('accepts the engine default (90s vs 60s — Δ = 30s)', () => {
    expect(validateLocktimeOrdering(buyer + 30, buyer)).toBeNull()
  })

  it('accepts the minimum gap exactly above Δ', () => {
    expect(
      validateLocktimeOrdering(buyer + MIN_LOCKTIME_DELTA_SECS + 1, buyer),
    ).toBeNull()
  })

  it('rejects an inverted ordering', () => {
    const err = validateLocktimeOrdering(buyer, buyer + 60)
    expect(err).toMatch(/locktime ordering/i)
    expect(err).toContain(`sellerLocktime=${buyer}`)
    expect(err).toContain(`buyerLocktime=${buyer + 60}`)
  })

  it('rejects equal locktimes', () => {
    expect(validateLocktimeOrdering(buyer, buyer)).toMatch(/locktime ordering/i)
  })

  it('rejects when the gap is exactly Δ (boundary is strict)', () => {
    expect(
      validateLocktimeOrdering(buyer + MIN_LOCKTIME_DELTA_SECS, buyer),
    ).toMatch(/locktime ordering/i)
  })

  it('rejects non-finite values', () => {
    expect(validateLocktimeOrdering(NaN, buyer)).toMatch(/invalid locktime/i)
    expect(validateLocktimeOrdering(buyer + 30, NaN)).toMatch(/invalid locktime/i)
    expect(validateLocktimeOrdering(Infinity, buyer)).toMatch(/invalid locktime/i)
  })
})

describe('buyerPrepareSwap', () => {
  it('returns the verified seller pre-sigs from Alice locked-proofs ciphertext', async () => {
    const sellerKey = generateEphemeralKeypair()
    const buyerKey = generateEphemeralKeypair()
    const sellerCtx: SwapContext = {
      tradeId: 'trade-1',
      role: 'seller',
      ephemeralKey: sellerKey,
      counterpartyPubkey: buyerKey.publicKey,
      sellerLocktime: 1_700_000_100,
      buyerLocktime: 1_700_000_000,
      mintUrl: 'https://mint.test',
    }
    const buyerCtx: SwapContext = {
      ...sellerCtx,
      role: 'buyer',
      ephemeralKey: buyerKey,
      counterpartyPubkey: sellerKey.publicKey,
    }

    const sellerOut = await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )

    const sharedKey = await deriveEncryptionKey(
      computeSharedSecret(buyerKey.privateKey, sellerKey.publicKey),
    )
    const sellerLockedPlain = await decrypt(sharedKey, sellerOut.lockedProofsCipher)
    const sellerLocked = JSON.parse(sellerLockedPlain) as { preSigs: string[] }
    expect(buyerOut.sellerPreSigsHex).toEqual(sellerLocked.preSigs)
    expect(buyerOut.sellerPreSigsHex).toHaveLength(1)
  })
})

function proof(secret: string, amount: number): Proof {
  return {
    id: 'test-keyset',
    amount,
    secret,
    C: '02'.padEnd(66, '0'),
  } as Proof
}
