import { describe, expect, it } from 'vitest'
import { displayedFundingBudgetSats } from '../marketMakerFunding'

describe('market-maker funding math', () => {
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
