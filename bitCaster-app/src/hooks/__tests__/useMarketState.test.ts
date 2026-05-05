import { describe, it, expect } from 'vitest'
import { useMarketState, type MarketState } from '../useMarketState'

describe('useMarketState (ADR-009 Amendment 2026-05-04 — engine state authority)', () => {
  it("returns 'Open' for engine state 'open'", () => {
    expect(useMarketState('open')).toBe('Open')
  })

  it("returns 'Closed' for engine state 'closed'", () => {
    expect(useMarketState('closed')).toBe('Closed')
  })

  it("returns 'Open' as a safe pre-fetch default when state is null", () => {
    // Pre-fetch — the catalogue request is in flight. Render Open so the
    // trade pane and bookmark affordances do not flash hidden during load.
    expect(useMarketState(null)).toBe('Open')
  })

  it("returns 'Open' as a safe pre-fetch default when state is undefined", () => {
    expect(useMarketState(undefined)).toBe('Open')
  })

  it('regression: a fresh market with no oracle attestation renders Open (P7)', () => {
    // The pre-fix bug was `attestation.status !== 'pending'` reading `true`
    // when status was undefined → newly-created markets rendered as Closed.
    // Engine state is the authority now: a freshly registered market has
    // `state='open'` and is ALWAYS Open regardless of mintd's attestation.
    const freshlyRegistered: MarketState = 'open'
    expect(useMarketState(freshlyRegistered)).toBe('Open')
  })
})
