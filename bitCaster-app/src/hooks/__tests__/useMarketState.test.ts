import { describe, it, expect } from 'vitest'
import { useMarketState } from '../useMarketState'
import type { MarketDetail, ResolutionStatus } from '@/types/market-detail'

function fixture(status: ResolutionStatus): Pick<MarketDetail, 'resolution'> {
  return {
    resolution: {
      criteria: 't',
      source: 'oracle',
      resolutionDate: '2026-01-01T00:00:00Z',
      status,
    },
  }
}

describe('useMarketState (T4.1.d)', () => {
  it("returns 'Closed' for a fixture market with resolution.status === 'resolved'", () => {
    expect(useMarketState(fixture('resolved'))).toBe('Closed')
  })

  it("returns 'Closed' for a market awaiting on-chain finalisation", () => {
    expect(useMarketState(fixture('pending_resolution'))).toBe('Closed')
  })

  it("returns 'Closed' for a disputed market — still no new orders", () => {
    expect(useMarketState(fixture('disputed'))).toBe('Closed')
  })

  it("returns 'Open' for an active market", () => {
    expect(useMarketState(fixture('open'))).toBe('Open')
  })

  it('returns Open as a safe default when the market is still loading (null)', () => {
    expect(useMarketState(null)).toBe('Open')
  })
})
