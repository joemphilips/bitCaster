import { describe, expect, it } from 'vitest'
import { computeStats } from '../usePortfolioState'
import type { Fund, Position } from '@/types/portfolio'

const basePosition: Position = {
  id: 'p',
  marketId: 'm',
  marketTitle: 'Market',
  marketImageUrl: '',
  side: 'yes',
  shares: 1,
  avgBuyPrice: 0,
  currentPrice: 0,
  currentValueSats: 0,
  profitLossSats: 0,
  profitLossPercent: 0,
  status: 'active',
  isWinner: false,
  isLoser: false,
  isPending: false,
  acquiredDate: new Date(0).toISOString(),
  mintUrl: 'https://mint.example',
}

describe('computeStats', () => {
  it('keeps portfolio totals per unit and never sums sats with cents', () => {
    const positions: Position[] = [
      { ...basePosition, id: 'sat-position', baseAsset: 'sat', currentValueSats: 1000 },
      { ...basePosition, id: 'usd-position', baseAsset: 'usd', currentValueSats: 23 },
    ]
    const funds: Fund[] = [
      { id: 'sat-fund', unit: 'sats', amount: 500, mintUrl: 'https://mint.example' },
      { id: 'usd-fund', unit: 'usd', amount: 77, mintUrl: 'https://mint.example' },
    ]

    const stats = computeStats(positions, funds)

    expect(stats.positionsValueByUnit).toEqual([
      { unit: 'sat', amount: 1000 },
      { unit: 'usd', amount: 23 },
    ])
    expect(stats.totalValueByUnit).toEqual([
      { unit: 'sat', amount: 1500 },
      { unit: 'usd', amount: 100 },
    ])
    expect(stats.totalValueSats).toBe(1500)
  })
})
