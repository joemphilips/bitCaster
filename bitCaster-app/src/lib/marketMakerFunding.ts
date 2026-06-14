export const BINARY_AMM_FUNDING_TIERS = [
  { id: 'none', baseBudgetSats: 0, warning: true },
  { id: 'minimal', baseBudgetSats: 10_000, warning: false },
  { id: 'standard', baseBudgetSats: 100_000, warning: false },
  { id: 'deep', baseBudgetSats: 1_000_000, warning: false },
] as const

export type AmmFundingTierId = typeof BINARY_AMM_FUNDING_TIERS[number]['id'] | 'custom'

export function outcomeFundingScale(outcomeCount: number): number {
  return Math.max(1, Math.log2(Math.max(2, outcomeCount)))
}

export function displayedFundingBudgetSats(baseBudgetSats: number, outcomeCount: number): number {
  return Math.round(baseBudgetSats * outcomeFundingScale(outcomeCount))
}
