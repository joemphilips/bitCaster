export type MarketBaseAsset = 'sat' | 'usd' | 'jpy'

export const DEFAULT_MARKET_BASE_ASSET: MarketBaseAsset = 'sat'
export const SYSTEM_DIVISIBILITY = 10_000
export const DEFAULT_MARKET_DIVISIBILITY = SYSTEM_DIVISIBILITY

export interface CollateralUnitInfo {
  baseAsset: MarketBaseAsset
  /** How many collateral units equal one NUT-01 minor unit of the base asset. */
  scale: number
}

export const COLLATERAL_UNIT_REGISTRY: Readonly<Record<string, CollateralUnitInfo>> = {
  sat: { baseAsset: 'sat', scale: 1 },
  msat: { baseAsset: 'sat', scale: 1_000 },
  // NUT-01 USD amounts are already denominated in cents, so usd scale is 1.
  usd: { baseAsset: 'usd', scale: 1 },
  'milli-cent': { baseAsset: 'usd', scale: 1_000 },
  jpy: { baseAsset: 'jpy', scale: 1 },
}

export interface MarketUnitSpec {
  baseAsset?: MarketBaseAsset | null
  divisibility?: number | null
}

export function normalizeMarketBaseAsset(
  value: MarketBaseAsset | string | null | undefined,
): MarketBaseAsset {
  return parseMarketBaseAsset(value) ?? DEFAULT_MARKET_BASE_ASSET
}

export function parseMarketBaseAsset(
  value: MarketBaseAsset | string | null | undefined,
): MarketBaseAsset | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  return COLLATERAL_UNIT_REGISTRY[normalized]?.baseAsset ?? null
}

export function collateralScaleForUnit(
  unit: string | null | undefined,
): number {
  const normalized = unit?.trim().toLowerCase()
  if (!normalized) return 1
  return COLLATERAL_UNIT_REGISTRY[normalized]?.scale ?? 1
}

export function isCollateralUnitOf(
  unit: string | null | undefined,
  baseAsset: string | null | undefined,
): boolean {
  const unitInfo = COLLATERAL_UNIT_REGISTRY[unit?.trim().toLowerCase() ?? '']
  const expectedBaseAsset = parseMarketBaseAsset(baseAsset)
  return unitInfo != null && expectedBaseAsset !== null && unitInfo.baseAsset === expectedBaseAsset
}

export function normalizeMarketDivisibility(value: number | null | undefined): number {
  if (typeof value !== 'number') return DEFAULT_MARKET_DIVISIBILITY
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MARKET_DIVISIBILITY
}

export function parseMarketDivisibility(value: number | null | undefined): number | null {
  if (typeof value !== 'number') return null
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function marketUnitLabel(value: MarketBaseAsset | string | null | undefined): string {
  const baseAsset = normalizeMarketBaseAsset(value)
  if (baseAsset === 'usd') return 'USD'
  if (baseAsset === 'jpy') return 'JPY'
  return 'sats'
}

export function marketSubunitLabel(value: MarketBaseAsset | string | null | undefined): string {
  const baseAsset = normalizeMarketBaseAsset(value)
  if (baseAsset === 'usd') return 'milli-cents'
  if (baseAsset === 'jpy') return 'yen'
  return 'msat'
}

export function defaultCollateralUnit(value: MarketBaseAsset | string | null | undefined): string {
  const asset = normalizeMarketBaseAsset(value)
  if (asset === 'usd') return 'milli-cent'
  return 'msat'
}

export function shareFaceSubunits(baseAsset: string | null | undefined): number {
  const asset = normalizeMarketBaseAsset(baseAsset)
  if (asset === 'usd') return 100_000
  return 1_000_000
}

export function formatMarketSubunits(
  amountSubunits: number,
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  const normalized = normalizeMarketBaseAsset(baseAsset)
  if (!Number.isFinite(amountSubunits)) {
    return normalized === 'usd' ? '$0.00' : `0 ${marketSubunitLabel(normalized)}`
  }
  const sign = amountSubunits < 0 ? '-' : ''
  const absoluteAmount = Math.abs(amountSubunits)
  if (normalized === 'usd') {
    return `${sign}$${(absoluteAmount / 100_000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
  if (normalized === 'jpy') {
    return `${sign}¥${Math.trunc(absoluteAmount).toLocaleString()}`
  }
  return `${sign}${(absoluteAmount / 1_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  })} sats`
}

export function formatAmount(
  amountSubunits: number,
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  return formatMarketSubunits(amountSubunits, baseAsset)
}

export function formatWholeShareFaceValue(
  spec: MarketUnitSpec,
): string {
  return formatShareFace(spec.baseAsset)
}

export function formatPricePercentage(
  priceNumerator: number,
  divisibility: number | null | undefined,
): string {
  const normalizedDivisibility = normalizeMarketDivisibility(divisibility)
  const percent = Number.isFinite(priceNumerator)
    ? (priceNumerator / normalizedDivisibility) * 100
    : 0
  return `${percent.toFixed(2)}%`
}

export function formatShareFace(
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  const asset = normalizeMarketBaseAsset(baseAsset)
  if (asset === 'usd') return '$1.00'
  return '1000 sats'
}

export function formatPricePercent(
  priceNumerator: number,
  divisibility: number | null | undefined,
): string {
  return formatPricePercentage(priceNumerator, divisibility)
}

export function validatePriceNumerator(price: number, divisibility: number): boolean {
  return Number.isInteger(price) && price >= 1 && price <= divisibility - 1
}

export function validateWholeShareFaceAmount(
  faceAmountSubunits: number,
  shareFace: number,
): boolean {
  return (
    Number.isSafeInteger(faceAmountSubunits) &&
    faceAmountSubunits > 0 &&
    Number.isSafeInteger(shareFace) &&
    shareFace > 0 &&
    faceAmountSubunits % shareFace === 0
  )
}

export function quotePaymentSubunits(params: {
  faceAmountSubunits: number
  priceNumerator: number
  divisibility: number
  shareFaceSubunits?: number
}): number {
  const { faceAmountSubunits, priceNumerator, divisibility } = params
  const shareFace = params.shareFaceSubunits ?? divisibility
  if (!validateWholeShareFaceAmount(faceAmountSubunits, shareFace)) {
    throw new Error('faceAmountSubunits must be a positive whole-share amount')
  }
  if (!validatePriceNumerator(priceNumerator, divisibility)) {
    throw new Error('priceNumerator must be between 1 and divisibility - 1')
  }
  return (faceAmountSubunits / divisibility) * priceNumerator
}

export function normalizeMarketCreationLiquiditySats(params: {
  baseAsset?: MarketBaseAsset | string | null
  liquiditySats?: number | null
}): number {
  const liquiditySats = params.liquiditySats ?? 0
  if (!Number.isSafeInteger(liquiditySats) || liquiditySats < 0) return 0
  return normalizeMarketBaseAsset(params.baseAsset) === DEFAULT_MARKET_BASE_ASSET
    ? liquiditySats
    : 0
}
