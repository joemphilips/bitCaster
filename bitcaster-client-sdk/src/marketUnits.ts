export type MarketBaseAsset = 'sat'
export type CashuProofUnit = 'sat' | 'msat'
export type CtfCollateralUnit = 'msat'

export const DEFAULT_MARKET_BASE_ASSET: MarketBaseAsset = 'sat'
export const DEFAULT_SAT_MARKET_DIVISIBILITY = 10_000
export const NUMERIC_MARKET_DIVISIBILITY = 1_000_000
export const CTF_COLLATERAL_UNIT: CtfCollateralUnit = 'msat'
export type MarketDivisibility =
  | typeof DEFAULT_SAT_MARKET_DIVISIBILITY
  | typeof NUMERIC_MARKET_DIVISIBILITY

/**
 * Default LMSR quote-grid step for a market price denominator D.
 * D > 100 targets approximately 0.1% spacing.
 */
export function defaultPriceStepSubunits(divisibility: number): number {
  if (!Number.isInteger(divisibility) || divisibility < 100) {
    throw new Error(`divisibility must be an integer >= 100, got ${divisibility}`)
  }
  if (divisibility <= 100) return 1
  return Math.max(1, Math.floor(divisibility / 1_000))
}

export interface CollateralUnitInfo {
  baseAsset: MarketBaseAsset
  /** Multiplier from a user-facing sat amount into native collateral subunits. */
  scale: number
}

export const COLLATERAL_UNIT_REGISTRY: Readonly<Record<CashuProofUnit, CollateralUnitInfo>> = {
  sat: { baseAsset: 'sat', scale: 1 },
  msat: { baseAsset: 'sat', scale: 1_000 },
}

export interface MarketUnitSpec {
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
}

/**
 * Kept as the public validation entry point for existing SDK consumers.
 * Unlike the former implementation, this function never supplies a default.
 */
export function normalizeMarketBaseAsset(value: unknown): MarketBaseAsset {
  return requireMarketBaseAsset(value)
}

export function parseMarketBaseAsset(value: unknown): MarketBaseAsset | null {
  return value === DEFAULT_MARKET_BASE_ASSET ? DEFAULT_MARKET_BASE_ASSET : null
}

export function parseCashuProofUnit(value: unknown): CashuProofUnit | null {
  if (value === 'sat' || value === 'msat') return value
  return null
}

function requireMarketBaseAsset(value: unknown): MarketBaseAsset {
  const parsed = parseMarketBaseAsset(value)
  if (parsed !== null) return parsed
  throw new Error(`unsupported base asset: ${String(value)}`)
}

function requireCashuProofUnit(value: unknown): CashuProofUnit {
  const parsed = parseCashuProofUnit(value)
  if (parsed !== null) return parsed
  throw new Error(`unsupported Cashu proof unit: ${String(value)}`)
}

export function collateralScaleForUnit(unit: unknown): number {
  return COLLATERAL_UNIT_REGISTRY[requireCashuProofUnit(unit)].scale
}

export function cashuAmountToMarketSubunits(amount: number, unit: unknown): number {
  const proofUnit = requireCashuProofUnit(unit)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Cashu proof amount must be a non-negative safe integer: ${amount}`)
  }
  const result = proofUnit === 'sat' ? amount * 1_000 : amount
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Cashu proof amount exceeds safe market subunit range: ${amount} ${proofUnit}`)
  }
  return result
}

export function isCollateralUnitOf(unit: unknown, baseAsset: unknown): boolean {
  const proofUnit = parseCashuProofUnit(unit)
  const parsedBaseAsset = parseMarketBaseAsset(baseAsset)
  return (
    proofUnit !== null &&
    parsedBaseAsset !== null &&
    COLLATERAL_UNIT_REGISTRY[proofUnit].baseAsset === parsedBaseAsset
  )
}

export function defaultMarketDivisibility(baseAsset: unknown): number {
  requireMarketBaseAsset(baseAsset)
  return DEFAULT_SAT_MARKET_DIVISIBILITY
}

export function normalizeMarketDivisibility(
  value: unknown,
  baseAsset: unknown,
): MarketDivisibility {
  requireMarketBaseAsset(baseAsset)
  const parsed = parseMarketDivisibility(value)
  if (parsed !== null) return parsed
  throw new Error(`unsupported market divisibility: ${String(value)}`)
}

export function parseMarketDivisibility(value: unknown): MarketDivisibility | null {
  return value === DEFAULT_SAT_MARKET_DIVISIBILITY || value === NUMERIC_MARKET_DIVISIBILITY
    ? value
    : null
}

export function marketUnitLabel(value: unknown): string {
  requireMarketBaseAsset(value)
  return 'sats'
}

export function marketSubunitLabel(value: unknown): string {
  requireMarketBaseAsset(value)
  return 'sats'
}

export function bufferSubunits(baseAsset: unknown, deficit: number): number {
  requireMarketBaseAsset(baseAsset)
  if (deficit <= 0) return 0
  if (!Number.isFinite(deficit)) throw new Error('deficit must be finite')
  return Math.max(Math.ceil(deficit * 0.2), 10_000)
}

/**
 * Conservative fixed settlement-fee estimate for trade cost display.
 * Mint-provided proof-count fees remain authoritative for settlement.
 */
export function estimatedSettlementFeeSubunits(baseAsset: unknown): number {
  requireMarketBaseAsset(baseAsset)
  return 10_000
}

export function defaultCollateralUnit(value: unknown): CtfCollateralUnit {
  requireMarketBaseAsset(value)
  return CTF_COLLATERAL_UNIT
}

export function formatMarketSubunits(amountSubunits: number, baseAsset: unknown): string {
  requireMarketBaseAsset(baseAsset)
  if (!Number.isFinite(amountSubunits)) return '0 sats'
  const sign = amountSubunits < 0 ? '-' : ''
  const absoluteAmount = Math.abs(amountSubunits)
  return `${sign}${(absoluteAmount / 1_000).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  })} sats`
}

export function formatAmount(amountSubunits: number, baseAsset: unknown): string {
  return formatMarketSubunits(amountSubunits, baseAsset)
}

export function formatWholeShareFaceValue(spec: MarketUnitSpec): string {
  return formatShareFace(spec.baseAsset, spec.divisibility)
}

export function formatPricePercentage(priceNumerator: number, divisibility: number): string {
  const parsedDivisibility = requireMarketDivisibility(divisibility)
  const percent = Number.isFinite(priceNumerator) ? (priceNumerator / parsedDivisibility) * 100 : 0
  return `${percent.toFixed(2)}%`
}

export function formatShareFace(baseAsset: unknown, divisibility: number): string {
  requireMarketBaseAsset(baseAsset)
  return formatMarketSubunits(requireMarketDivisibility(divisibility), baseAsset)
}

export function formatPricePercent(priceNumerator: number, divisibility: number): string {
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
  const { faceAmountSubunits, priceNumerator } = params
  const divisibility = requireMarketDivisibility(params.divisibility)
  if (!validateWholeShareFaceAmount(faceAmountSubunits, divisibility)) {
    throw new Error('faceAmountSubunits must be a positive whole-share amount')
  }
  if (!validatePriceNumerator(priceNumerator, divisibility)) {
    throw new Error('priceNumerator must be between 1 and divisibility - 1')
  }
  return (faceAmountSubunits / divisibility) * priceNumerator
}

export function normalizeMarketCreationLiquiditySats(params: {
  baseAsset: MarketBaseAsset
  liquiditySats?: number | null
}): number {
  requireMarketBaseAsset(params.baseAsset)
  const liquiditySats = params.liquiditySats ?? 0
  if (!Number.isSafeInteger(liquiditySats) || liquiditySats < 0) {
    throw new Error('liquiditySats must be a non-negative safe integer')
  }
  return liquiditySats
}

function requireMarketDivisibility(value: unknown): number {
  const parsed = parseMarketDivisibility(value)
  if (parsed !== null) return parsed
  throw new Error(`unsupported market divisibility: ${String(value)}`)
}
