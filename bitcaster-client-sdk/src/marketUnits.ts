export type MarketBaseAsset = 'sat' | 'usd' | 'jpy'

export const DEFAULT_MARKET_BASE_ASSET: MarketBaseAsset = 'sat'
export const DEFAULT_MARKET_DIVISIBILITY = 1_000
export const SYSTEM_DIVISIBILITY = 1_000

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
  if (normalized === 'usd' || normalized === 'jpy' || normalized === 'sat') {
    return normalized
  }
  return null
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
  if (baseAsset === 'usd') return 'cents'
  if (baseAsset === 'jpy') return 'yen'
  return 'sats'
}

export function defaultCollateralUnit(value: MarketBaseAsset | string | null | undefined): string {
  return normalizeMarketBaseAsset(value)
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
    return `${sign}$${(absoluteAmount / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
  if (normalized === 'jpy') {
    return `${sign}¥${Math.trunc(absoluteAmount).toLocaleString()}`
  }
  return `${sign}${Math.trunc(absoluteAmount).toLocaleString()} sats`
}

export function formatWholeShareFaceValue(
  spec: MarketUnitSpec,
): string {
  return formatShareFace(normalizeMarketDivisibility(spec.divisibility), spec.baseAsset)
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
  divisibility: number | null | undefined,
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  const normalizedDivisibility = normalizeMarketDivisibility(divisibility)
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset)
  if (normalizedBaseAsset === 'usd') {
    return `$${(normalizedDivisibility / 100).toFixed(2)}`
  }
  return `${normalizedDivisibility.toString()} sat`
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
  divisibility: number,
): boolean {
  return (
    Number.isSafeInteger(faceAmountSubunits) &&
    faceAmountSubunits > 0 &&
    faceAmountSubunits % divisibility === 0
  )
}

export function quotePaymentSubunits(params: {
  faceAmountSubunits: number
  priceNumerator: number
  divisibility: number
}): number {
  const { faceAmountSubunits, priceNumerator, divisibility } = params
  if (!validateWholeShareFaceAmount(faceAmountSubunits, divisibility)) {
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
