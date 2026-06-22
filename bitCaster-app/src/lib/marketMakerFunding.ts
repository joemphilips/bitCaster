export const BINARY_AMM_FUNDING_TIERS = [
  { id: 'none', budgetSats: 0, budgetUsdSubunits: 0, warning: true },
  { id: 'minimal', budgetSats: 1_500_000, budgetUsdSubunits: 1_500_000, warning: false },
  { id: 'standard', budgetSats: 15_000_000, budgetUsdSubunits: 15_000_000, warning: false },
  { id: 'deep', budgetSats: 30_000_000, budgetUsdSubunits: 30_000_000, warning: false },
] as const

export type AmmFundingTierId = typeof BINARY_AMM_FUNDING_TIERS[number]['id'] | 'custom'

export const MIN_THIN_LIQUIDITY_WARNING_SATS = 10_000

export function fundingTierBudget(
  tier: typeof BINARY_AMM_FUNDING_TIERS[number],
  baseAsset: string | null | undefined,
): number {
  return baseAsset === 'usd' ? tier.budgetUsdSubunits : tier.budgetSats
}

export function formatFundingBudget(
  amount: number,
  baseAsset: string | null | undefined,
  options: { wholeUsd?: boolean } = {},
): string {
  if (baseAsset === 'usd') {
    const dollars = Math.max(0, amount) / 100_000
    return `$${dollars.toLocaleString(undefined, {
      minimumFractionDigits: options.wholeUsd ? 0 : 2,
      maximumFractionDigits: options.wholeUsd ? 0 : 2,
    })}`
  }
  return `${Math.max(0, Math.round(amount / 1_000)).toLocaleString()} sats`
}

export function outcomeFundingScale(outcomeCount: number): number {
  return Math.max(1, Math.log2(Math.max(2, outcomeCount)))
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
