import {
  normalizeMarketDivisibility,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from './marketUnits.ts'

export type SupportedOrderSide = 'Buy' | 'Sell'
export type SupportedTimeInForce = 'FAK' | 'FOK' | 'GTC'

export interface OrderIntentForValidation {
  marketId?: unknown
  outcomeId?: unknown
  tokenSide?: unknown
  side?: unknown
  price?: unknown
  amountSubunits?: unknown
  baseAsset?: unknown
  divisibility?: unknown
  timeInForce?: unknown
}

export type OrderIntentValidation =
  | { valid: true }
  | { valid: false; message: string }

export function validateOrderIntent(
  request: unknown,
): OrderIntentValidation {
  if (!isRecord(request)) {
    return { valid: false, message: 'Order rejected: missing order request.' }
  }

  const intent = request as OrderIntentForValidation
  if (!isNonEmptyString(intent.marketId)) {
    return { valid: false, message: 'Order rejected: market id is required.' }
  }
  if (!isNonEmptyString(intent.outcomeId)) {
    return { valid: false, message: 'Order rejected: outcome id is required.' }
  }
  if (intent.marketId.includes('|')) {
    return {
      valid: false,
      message: 'Order rejected: market id must be a primitive outcome book.',
    }
  }
  if (intent.outcomeId.includes('|')) {
    return {
      valid: false,
      message: 'Order rejected: outcome id must be a primitive outcome name.',
    }
  }
  const marketOutcomeSegment = primitiveOutcomeSegment(intent.marketId)
  if (
    !marketOutcomeSegment ||
    marketOutcomeSegment !== intent.outcomeId
  ) {
    return {
      valid: false,
      message:
        'Order rejected: outcome id must match the primitive outcome segment of market id.',
    }
  }
  if (intent.tokenSide !== 'Outcome' && intent.tokenSide !== 'Complement') {
    return {
      valid: false,
      message: 'Order rejected: tokenSide must be Outcome or Complement.',
    }
  }
  if (intent.side !== 'Buy' && intent.side !== 'Sell') {
    return {
      valid: false,
      message: 'Order rejected: side must be Buy or Sell.',
    }
  }
  const price = intent.price
  const divisibility =
    typeof intent.divisibility === 'number'
      ? normalizeMarketDivisibility(intent.divisibility, typeof intent.baseAsset === 'string' ? intent.baseAsset : undefined)
      : normalizeMarketDivisibility(undefined, typeof intent.baseAsset === 'string' ? intent.baseAsset : undefined)
  if (typeof price !== 'number' || !validatePriceNumerator(price, divisibility)) {
    return {
      valid: false,
      message: `Order rejected: price must be an integer from 1 to ${divisibility - 1}.`,
    }
  }
  const amountSubunits = intent.amountSubunits
  const shareFace = divisibility
  if (
    typeof amountSubunits !== 'number' ||
    !validateWholeShareFaceAmount(amountSubunits, shareFace)
  ) {
    return {
      valid: false,
      message:
        `Order rejected: amountSubunits must be a positive integer in ${shareFace} sub-unit increments.`,
    }
  }
  if (
    intent.timeInForce !== 'FAK' &&
    intent.timeInForce !== 'FOK' &&
    intent.timeInForce !== 'GTC'
  ) {
    return {
      valid: false,
      message: 'Order rejected: timeInForce must be FAK, FOK, or GTC.',
    }
  }

  return { valid: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function primitiveOutcomeSegment(marketId: string): string | null {
  const index = marketId.lastIndexOf('-')
  if (index <= 0 || index >= marketId.length - 1) return null
  return marketId.slice(index + 1)
}
