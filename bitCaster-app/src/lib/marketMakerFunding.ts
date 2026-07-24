export const BINARY_AMM_FUNDING_TIERS = [
  { id: "none", budgetSats: 0, budgetUsdSubunits: 0, warning: true },
  { id: "minimal", budgetSats: 10_000, budgetUsdSubunits: 10_000, warning: true },
  { id: "standard", budgetSats: 100_000, budgetUsdSubunits: 100_000, warning: false },
  { id: "deep", budgetSats: 500_000, budgetUsdSubunits: 500_000, warning: false },
] as const;

export type AmmFundingTierId = (typeof BINARY_AMM_FUNDING_TIERS)[number]["id"] | "custom";

export const MIN_THIN_LIQUIDITY_WARNING_SATS = 10_000;

export function fundingTierBudget(
  tier: (typeof BINARY_AMM_FUNDING_TIERS)[number],
  baseAsset: string | null | undefined,
): number {
  if (baseAsset === "usd") return tier.budgetUsdSubunits;
  if (baseAsset === "sat") return tier.budgetSats * 1_000;
  throw new Error(`fundingTierBudget: unsupported base asset '${baseAsset}'`);
}

export function formatFundingBudget(
  amountSubunits: number,
  baseAsset: string | null | undefined,
  options: { wholeUsd?: boolean } = {},
): string {
  if (baseAsset === "usd") {
    const dollars = Math.max(0, amountSubunits) / 100;
    return `$${dollars.toLocaleString(undefined, {
      minimumFractionDigits: options.wholeUsd ? 0 : 2,
      maximumFractionDigits: options.wholeUsd ? 0 : 2,
    })}`;
  }
  if (baseAsset === "sat") {
    const sats = Math.max(0, amountSubunits) / 1_000;
    return `${sats.toLocaleString()} sats`;
  }
  throw new Error(`unsupported base asset: ${baseAsset}`);
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
