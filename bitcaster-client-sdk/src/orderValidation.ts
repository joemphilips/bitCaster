export type SupportedOrderSide = 'Buy' | 'Sell'
export type SupportedTimeInForce = 'FAK' | 'FOK' | 'GTC'

export interface OrderIntentForValidation {
  marketId?: unknown
  outcomeId?: unknown
  side?: unknown
  price?: unknown
  amountSats?: unknown
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
  if (intent.side !== 'Buy' && intent.side !== 'Sell') {
    return {
      valid: false,
      message: 'Order rejected: side must be Buy or Sell.',
    }
  }
  const price = intent.price
  if (
    typeof price !== 'number' ||
    !Number.isInteger(price) ||
    price < 1 ||
    price > 99
  ) {
    return {
      valid: false,
      message: 'Order rejected: price must be an integer from 1 to 99.',
    }
  }
  const amountSats = intent.amountSats
  if (
    typeof amountSats !== 'number' ||
    !Number.isInteger(amountSats) ||
    amountSats <= 0 ||
    amountSats % 100 !== 0
  ) {
    return {
      valid: false,
      message:
        'Order rejected: amountSats must be a positive integer in 100 sat increments.',
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
