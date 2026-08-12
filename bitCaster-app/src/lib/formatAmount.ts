import {
  formatAmount as formatSdkAmount,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";

/**
 * App-level subunit-aware amount formatter. Delegates to the SDK's
 * `formatMarketSubunits` so every surface renders identical strings
 * ("1,000 sats", "$1.23", "¥120") — do NOT fork the label spelling here.
 */
export function formatAmount(amountSubunits: number, baseAsset: MarketBaseAsset): string {
  return formatSdkAmount(amountSubunits, baseAsset);
}

/** Display name for the product funding unit. */
export const formatUnitName = marketUnitLabel;

/** Display name for the product collateral subunit. */
export const formatUnitSubunitName = marketSubunitLabel;

export interface AmountByUnit {
  unit: MarketBaseAsset;
  amount: number;
}

/**
 * Sum explicitly sat-denominated product amounts.
 */
export function groupAmountsByUnit<T>(
  items: Iterable<T>,
  getUnit: (item: T) => MarketBaseAsset,
  getAmount: (item: T) => number,
): AmountByUnit[] {
  const totals = new Map<MarketBaseAsset, number>();
  for (const item of items) {
    const unit = normalizeMarketBaseAsset(getUnit(item));
    totals.set(unit, (totals.get(unit) ?? 0) + getAmount(item));
  }
  return Array.from(totals.entries()).map(([unit, amount]) => ({ unit, amount }));
}
