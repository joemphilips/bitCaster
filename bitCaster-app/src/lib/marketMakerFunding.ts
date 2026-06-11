export const BINARY_AMM_FUNDING_TIERS = [
  { id: 'minimal', baseBudgetSats: 10_000, warning: true },
  { id: 'standard', baseBudgetSats: 100_000, warning: false },
  { id: 'deep', baseBudgetSats: 1_000_000, warning: false },
] as const

export type AmmFundingTierId = typeof BINARY_AMM_FUNDING_TIERS[number]['id'] | 'custom'

export const MIN_THIN_LIQUIDITY_WARNING_SATS = 10_000

export function outcomeFundingScale(outcomeCount: number): number {
  return Math.max(1, Math.log2(Math.max(2, outcomeCount)))
}

export function displayedFundingBudgetSats(baseBudgetSats: number, outcomeCount: number): number {
  return Math.round(baseBudgetSats * outcomeFundingScale(outcomeCount))
}

export interface AmmFundingPreview {
  depthPerCentSats: number
  cost50To60Sats: number
}

export function calculateAmmFundingPreview(
  budgetSats: number,
  outcomeCount: number,
): AmmFundingPreview {
  const effectiveBudgetSats = Math.max(0, budgetSats) * outcomeFundingScale(outcomeCount)
  return {
    depthPerCentSats: Math.round(0.058 * effectiveBudgetSats),
    cost50To60Sats: Math.round(0.322 * effectiveBudgetSats),
  }
}
