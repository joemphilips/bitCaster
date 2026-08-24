import {
  parseMarketDivisibility,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from './marketUnits.ts'
import { parseOrderRouteId } from './orderRoute.ts'

export type SupportedOrderSide = 'Buy' | 'Sell'
export type SupportedTimeInForce = 'FAK' | 'FOK'

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

export type OrderIntentValidation = { valid: true } | { valid: false; message: string }

export function validateOrderIntent(request: unknown): OrderIntentValidation {
  const shape = validateOrderRoutingIdentity(request)
  if (!shape.valid) return shape
  const intent = request as OrderIntentForValidation
  if (intent.baseAsset !== 'sat') {
    return {
      valid: false,
      message: 'Order rejected: baseAsset must be sat.',
    }
  }
  const divisibility = parseMarketDivisibility(intent.divisibility)
  if (divisibility === null) {
    return {
      valid: false,
      message: 'Order rejected: divisibility must be 10000 or 1000000.',
    }
  }
  const price = intent.price
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
      message: `Order rejected: amountSubunits must be a positive integer in ${shareFace} sub-unit increments.`,
    }
  }

  return { valid: true }
}

/**
 * Validates only the fields needed to identify and route an order before
 * market-owned unit and economics metadata is available.
 */
export function validateOrderRoutingIdentity(request: unknown): OrderIntentValidation {
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
  const orderRoute = parseOrderRouteId(intent.marketId)
  if (orderRoute === null || orderRoute.outcomeId !== intent.outcomeId) {
    return {
      valid: false,
      message: 'Order rejected: outcome id must match the primitive outcome segment of market id.',
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
  if (
    intent.timeInForce !== 'FAK' &&
    intent.timeInForce !== 'FOK'
  ) {
    return {
      valid: false,
      message: 'Order rejected: timeInForce must be FAK or FOK.',
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
