import { describe, expect, it } from 'vitest'
import {
  MIN_LOCKTIME_DELTA_SECS,
  validateLocktimeOrdering,
} from '../atomicSwap'

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
