import { describe, expect, it } from 'vitest'
import {
  BINARY_AMM_FUNDING_TIERS,
  calculateAmmFundingPreview,
  fundingTierBudget,
} from '../marketMakerFunding'

describe('market-maker funding math', () => {
  it('matches the binary Standard tier closed forms', () => {
    expect(calculateAmmFundingPreview(100_000, 2)).toEqual({
      depthPerCentSats: 5_800,
      cost50To60Sats: 32_200,
    })
  })

  it('keeps categorical tiers as hardcoded round SAT and USD amounts', () => {
    const [none, minimal, standard, deep] = BINARY_AMM_FUNDING_TIERS

    expect(fundingTierBudget(none, 'sat')).toBe(0)
    expect(fundingTierBudget(minimal, 'sat')).toBe(1_500)
    expect(fundingTierBudget(standard, 'sat')).toBe(15_000)
    expect(fundingTierBudget(deep, 'sat')).toBe(30_000)

    expect(fundingTierBudget(none, 'usd')).toBe(0)
    expect(fundingTierBudget(minimal, 'usd')).toBe(1_500_000)
    expect(fundingTierBudget(standard, 'usd')).toBe(15_000_000)
    expect(fundingTierBudget(deep, 'usd')).toBe(30_000_000)
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
