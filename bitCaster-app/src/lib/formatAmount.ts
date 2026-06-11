import {
  formatMarketSubunits,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  type MarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'

/**
 * App-level cents-aware amount formatter. Delegates to the SDK's
 * `formatMarketSubunits` so every surface renders identical strings
 * ("1,000 sats", "$1.23", "¥120") — do NOT fork the label spelling here.
 */
export function formatAmount(
  amountSubunits: number,
  baseAsset: MarketBaseAsset | string | null | undefined = 'sat',
): string {
  return formatMarketSubunits(amountSubunits, baseAsset)
}

/** Display name for a funding unit ("sats" / "USD" / "JPY"). */
export const formatUnitName = marketUnitLabel

/** Display name for the subunit a raw amount is entered in ("sats" / "cents" / "yen"). */
export const formatUnitSubunitName = marketSubunitLabel

export interface AmountByUnit {
  unit: MarketBaseAsset
  amount: number
}

/**
 * Sum amounts per normalized unit. This is the single shared guard that
 * keeps totals per unit — sats and cents must NEVER be summed together.
 */
export function groupAmountsByUnit<T>(
  items: Iterable<T>,
  getUnit: (item: T) => MarketBaseAsset | string | null | undefined,
  getAmount: (item: T) => number,
): AmountByUnit[] {
  const totals = new Map<MarketBaseAsset, number>()
  for (const item of items) {
    const unit = normalizeMarketBaseAsset(getUnit(item))
    totals.set(unit, (totals.get(unit) ?? 0) + getAmount(item))
  }
  return Array.from(totals.entries()).map(([unit, amount]) => ({ unit, amount }))
}
