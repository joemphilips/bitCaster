import { describe, expect, it } from 'vitest'
import { toPortfolioMarketDetailId } from '../PortfolioPage'

describe('toPortfolioMarketDetailId', () => {
  it('strips the outcome suffix from per-outcome market ids', () => {
    expect(toPortfolioMarketDetailId('abc123-YES')).toBe('abc123')
    expect(toPortfolioMarketDetailId('abc123-A|B')).toBe('abc123')
  })

  it('leaves condition ids unchanged', () => {
    expect(toPortfolioMarketDetailId('abc123')).toBe('abc123')
  })
})
