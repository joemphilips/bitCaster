export type MarketBaseAsset = 'sat' | 'usd' | 'jpy'

export const DEFAULT_MARKET_BASE_ASSET: MarketBaseAsset = 'sat'
export const DEFAULT_MARKET_DIVISIBILITY = 100
export const MIN_MARKET_DIVISIBILITY = 100
export const MAX_MARKET_DIVISIBILITY = 1_000_000
export const SUPPORTED_MARKET_DIVISIBILITIES = [100, 1_000] as const

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
  return isValidMarketDivisibility(value)
    ? value
    : DEFAULT_MARKET_DIVISIBILITY
}

export function parseMarketDivisibility(value: number | null | undefined): number | null {
  return isValidMarketDivisibility(value) ? value : null
}

export function isValidMarketDivisibility(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_MARKET_DIVISIBILITY &&
    value <= MAX_MARKET_DIVISIBILITY &&
    value % 100 === 0
  )
}

export function isSupportedMarketDivisibility(value: number): boolean {
  return SUPPORTED_MARKET_DIVISIBILITIES.includes(
    value as (typeof SUPPORTED_MARKET_DIVISIBILITIES)[number],
  )
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
  return formatMarketSubunits(
    normalizeMarketDivisibility(spec.divisibility),
    spec.baseAsset,
  )
}

export function formatPricePercent(
  priceNumerator: number,
  divisibility: number | null | undefined,
): string {
  const normalizedDivisibility = normalizeMarketDivisibility(divisibility)
  if (!Number.isFinite(priceNumerator)) return '0.0%'
  const percent = (priceNumerator / normalizedDivisibility) * 100
  return `${percent.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  })}%`
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
