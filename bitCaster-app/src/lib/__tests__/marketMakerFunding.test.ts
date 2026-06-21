import { describe, expect, it } from 'vitest'
import {
  calculateAmmFundingPreview,
  displayedFundingBudgetSats,
} from '../marketMakerFunding'

describe('market-maker funding math', () => {
  it('matches the binary Standard tier closed forms', () => {
    expect(calculateAmmFundingPreview(100_000, 2)).toEqual({
      depthPerCentSats: 5_800,
      cost50To60Sats: 32_200,
    })
  })

  it('scales displayed categorical tiers by log2(outcome count)', () => {
    expect(displayedFundingBudgetSats(10_000, 4)).toBe(20_000)
    expect(displayedFundingBudgetSats(100_000, 4)).toBe(200_000)
    expect(displayedFundingBudgetSats(1_000_000, 4)).toBe(2_000_000)
  })
})

describe('contract regeneration outputs', () => {
  it('keeps both generated clients present', () => {
    const generatedFiles = import.meta.glob(
      [
        '../../generated/api.ts',
        '../../../../BitCaster.MatchingEngine.Contracts/Generated/ApiContracts.g.cs',
      ],
      { eager: true, query: '?raw', import: 'default' },
    )

    expect(generatedFiles['../../generated/api.ts']).toBeTruthy()
    expect(
      generatedFiles[
        '../../../../BitCaster.MatchingEngine.Contracts/Generated/ApiContracts.g.cs'
      ],
    ).toBeTruthy()
  })
})
