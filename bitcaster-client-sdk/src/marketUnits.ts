export type MarketBaseAsset = 'sat' | 'usd' | 'jpy'
export type CashuProofUnit = 'sat' | 'msat' | 'usd'

/**
 * Default LMSR quote-grid step for a market price denominator D.
 * D = 100 keeps legacy one-cent behaviour; D > 100 targets ~0.1% spacing.
 */
export function defaultPriceStepSubunits(divisibility: number): number {
  if (!Number.isInteger(divisibility) || divisibility < 100) {
    throw new Error(`divisibility must be an integer >= 100, got ${divisibility}`)
  }
  if (divisibility <= 100) return 1
  return Math.max(1, Math.floor(divisibility / 1_000))
}

export const DEFAULT_MARKET_BASE_ASSET: MarketBaseAsset = 'sat'
export const DEFAULT_SAT_MARKET_DIVISIBILITY = 10_000
export const DEFAULT_USD_MARKET_DIVISIBILITY = 1_000

export interface CollateralUnitInfo {
  baseAsset: MarketBaseAsset
  /** Multiplier from a user-facing base amount into native collateral subunits. */
  scale: number
}

export const COLLATERAL_UNIT_REGISTRY: Readonly<Record<string, CollateralUnitInfo>> = {
  // 'sat' collateral unit: mint fee settings are in sats, proofs are in sats.
  sat: { baseAsset: 'sat', scale: 1 },
  // 'msat' collateral unit: mint fee settings are in sats, proofs are in msat.
  // Scale converts base-asset sats to collateral msat subunits.
  msat: { baseAsset: 'sat', scale: 1_000 },
  // NUT-01 USD amounts are already denominated in cents, so usd scale is 1.
  usd: { baseAsset: 'usd', scale: 1 },
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

export function parseCashuProofUnit(
  value: CashuProofUnit | string | null | undefined,
): CashuProofUnit | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'sat' || normalized === 'msat' || normalized === 'usd') {
    return normalized
  }
  return null
}

function requireMarketBaseAsset(
  value: MarketBaseAsset | string | null | undefined,
): MarketBaseAsset {
  const parsed = parseMarketBaseAsset(value)
  if (parsed !== null) return parsed
  if (value == null || value.trim() === '') return DEFAULT_MARKET_BASE_ASSET
  throw new Error(`unsupported base asset: ${value}`)
}

export function collateralScaleForUnit(unit: string | null | undefined): number {
  const normalized = unit?.trim().toLowerCase()
  if (!normalized) throw new Error('collateralScaleForUnit: unit is required')
  const info = COLLATERAL_UNIT_REGISTRY[normalized]
  if (!info) throw new Error(`collateralScaleForUnit: unknown unit '${unit}'`)
  return info.scale
}

export function cashuAmountToMarketSubunits(amount: number, unit: CashuProofUnit | string): number {
  const normalized = parseCashuProofUnit(unit)
  if (!normalized) throw new Error(`unsupported Cashu proof unit: ${unit}`)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Cashu proof amount must be a non-negative safe integer: ${amount}`)
  }
  const result = normalized === 'sat' ? amount * 1_000 : amount
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Cashu proof amount exceeds safe market subunit range: ${amount} ${normalized}`)
  }
  return result
}

export function isCollateralUnitOf(
  unit: string | null | undefined,
  baseAsset: string | null | undefined,
): boolean {
  const unitInfo = COLLATERAL_UNIT_REGISTRY[unit?.trim().toLowerCase() ?? '']
  const expectedBaseAsset = parseMarketBaseAsset(baseAsset)
  return unitInfo != null && expectedBaseAsset !== null && unitInfo.baseAsset === expectedBaseAsset
}

export function defaultMarketDivisibility(
  baseAsset: MarketBaseAsset | string | null | undefined,
): number {
  const asset = requireMarketBaseAsset(baseAsset)
  if (asset === 'usd') return DEFAULT_USD_MARKET_DIVISIBILITY
  if (asset === 'sat') return DEFAULT_SAT_MARKET_DIVISIBILITY
  throw new Error(`unsupported base asset: ${asset}`)
}

export function normalizeMarketDivisibility(
  value: number | null | undefined,
  baseAsset?: MarketBaseAsset | string | null,
): number {
  if (typeof value !== 'number') return defaultMarketDivisibility(baseAsset)
  return Number.isSafeInteger(value) && value > 0 ? value : defaultMarketDivisibility(baseAsset)
}

export function parseMarketDivisibility(value: number | null | undefined): number | null {
  if (typeof value !== 'number') return null
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function marketUnitLabel(value: MarketBaseAsset | string | null | undefined): string {
  const baseAsset = requireMarketBaseAsset(value)
  if (baseAsset === 'usd') return 'USD'
  if (baseAsset === 'jpy') return 'JPY'
  if (baseAsset === 'sat') return 'sats'
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

export function marketSubunitLabel(value: MarketBaseAsset | string | null | undefined): string {
  const baseAsset = requireMarketBaseAsset(value)
  if (baseAsset === 'usd') return 'cents'
  if (baseAsset === 'jpy') return 'yen'
  if (baseAsset === 'sat') return 'sats'
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

export function bufferSubunits(
  baseAsset: MarketBaseAsset | string | null | undefined,
  deficit: number,
): number {
  const asset = requireMarketBaseAsset(baseAsset)
  if (deficit <= 0) return 0
  if (!Number.isFinite(deficit)) throw new Error('deficit must be finite')
  const floor = asset === 'sat' ? 10_000 : asset === 'usd' ? 10 : null
  if (floor === null) throw new Error(`unsupported base asset: ${asset}`)
  return Math.max(Math.ceil(deficit * 0.2), floor)
}

/**
 * Conservative estimated settlement fee for trade cost breakdown display.
 * This is a fixed estimate (not a live mint fee fetch) per P46-B1 plan.
 * Floor: 10 sats (10_000 msat) for sat markets, 10 cents for USD markets.
 */
export function estimatedSettlementFeeSubunits(
  baseAsset: MarketBaseAsset | string | null | undefined,
): number {
  const asset = requireMarketBaseAsset(baseAsset)
  const floor = asset === 'sat' ? 10_000 : asset === 'usd' ? 10 : null
  if (floor === null) throw new Error(`unsupported base asset: ${asset}`)
  return floor
}

export function defaultCollateralUnit(
  value: MarketBaseAsset | string | null | undefined,
): CashuProofUnit {
  const asset = requireMarketBaseAsset(value)
  if (asset === 'usd') return 'usd'
  if (asset === 'sat') return 'msat'
  throw new Error(`unsupported base asset: ${asset}`)
}

export function formatMarketSubunits(
  amountSubunits: number,
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  const normalized = requireMarketBaseAsset(baseAsset)
  if (!Number.isFinite(amountSubunits)) {
    if (normalized === 'usd') return '$0.00'
    if (normalized === 'sat') return `0 ${marketSubunitLabel(normalized)}`
    if (normalized === 'jpy') return `0 ${marketSubunitLabel(normalized)}`
    throw new Error(`unsupported base asset: ${normalized}`)
  }
  const sign = amountSubunits < 0 ? '-' : ''
  const absoluteAmount = Math.abs(amountSubunits)
  if (normalized === 'usd') {
    // NUT-01: USD amounts are in cents. 1 USD = 100 cents.
    return `${sign}$${(absoluteAmount / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
  if (normalized === 'jpy') {
    return `${sign}¥${Math.trunc(absoluteAmount).toLocaleString()}`
  }
  if (normalized === 'sat')
    return `${sign}${(absoluteAmount / 1000).toLocaleString(undefined, {
      maximumFractionDigits: 3,
    })} sats`
  throw new Error(`unsupported base asset: ${normalized}`)
}

export function formatAmount(
  amountSubunits: number,
  baseAsset: MarketBaseAsset | string | null | undefined,
): string {
  return formatMarketSubunits(amountSubunits, baseAsset)
}

export function formatWholeShareFaceValue(spec: MarketUnitSpec): string {
  return formatShareFace(
    spec.baseAsset,
    normalizeMarketDivisibility(spec.divisibility, spec.baseAsset),
  )
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
  divisibility?: number | null,
): string {
  const asset = normalizeMarketBaseAsset(baseAsset)
  const shareFace = normalizeMarketDivisibility(divisibility, asset)
  if (asset === 'usd') {
    return `$${(shareFace / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
  return formatMarketSubunits(shareFace, asset)
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
}): number {
  const { faceAmountSubunits, priceNumerator, divisibility } = params
  const shareFace = divisibility
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
