export const BINARY_AMM_FUNDING_TIERS = [
  { id: "none", budgetSats: 0, warning: true },
  { id: "minimal", budgetSats: 10_000, warning: true },
  { id: "standard", budgetSats: 100_000, warning: false },
  { id: "deep", budgetSats: 500_000, warning: false },
] as const;

export type AmmFundingTierId = (typeof BINARY_AMM_FUNDING_TIERS)[number]["id"] | "custom";

export const MIN_THIN_LIQUIDITY_WARNING_SATS = 10_000;

export function fundingTierBudget(
  tier: (typeof BINARY_AMM_FUNDING_TIERS)[number],
  baseAsset: "sat",
): number {
  if (baseAsset !== "sat") throw new Error(`unsupported base asset: ${String(baseAsset)}`);
  return tier.budgetSats * 1_000;
}

export function formatFundingBudget(amountSubunits: number, baseAsset: "sat"): string {
  if (baseAsset !== "sat") throw new Error(`unsupported base asset: ${String(baseAsset)}`);
  const sats = Math.max(0, amountSubunits) / 1_000;
  return `${sats.toLocaleString()} sats`;
}

export function outcomeFundingScale(outcomeCount: number): number {
  return Math.max(1, Math.log2(Math.max(2, outcomeCount)));
}

export interface AmmFundingPreview {
  depthPerCentSats: number;
  cost50To60Sats: number;
}

export function calculateAmmFundingPreview(
  budgetSats: number,
  outcomeCount: number,
): AmmFundingPreview {
  const effectiveBudgetSats = Math.max(0, budgetSats) * outcomeFundingScale(outcomeCount);
  return {
    depthPerCentSats: Math.round(0.058 * effectiveBudgetSats),
    cost50To60Sats: Math.round(0.322 * effectiveBudgetSats),
  };
}
