import type { components } from './generated/api.ts'

export type PreviewFokOrderRequest = components['schemas']['PreviewFokOrderRequest']
export type PreviewFokOrderResponse = components['schemas']['PreviewFokOrderResponse']
export type FokPreviewReason = components['schemas']['FokPreviewReason']

export const FOK_PREVIEW_RESPONSE_BYTES_MAX = 16 * 1_024

const FOK_PREVIEW_REASONS = [
  'fillable',
  'insufficient_liquidity',
  'price_limit',
  'request_too_large',
  'market_unavailable',
  'temporarily_unavailable',
] as const satisfies readonly FokPreviewReason[]

/**
 * Build the public preview body from the generated request shape.
 * This prevents caller-owned fields from crossing the public boundary.
 */
export function canonicalizePreviewFokOrderRequest(
  request: PreviewFokOrderRequest,
): PreviewFokOrderRequest {
  validateRequest(request, null)
  return {
    marketId: request.marketId,
    side: request.side,
    tokenSide: request.tokenSide,
    price: request.price,
    faceAmountSubunits: request.faceAmountSubunits,
  }
}

export function decodePreviewFokOrderResponse(
  value: unknown,
  request: PreviewFokOrderRequest,
): PreviewFokOrderResponse {
  const record = exactPreviewRecord(value)
  const fullFillAvailable = record.fullFillAvailable
  if (typeof fullFillAvailable !== 'boolean') throw new Error('preview fill flag is invalid')

  const reason = record.reason
  if (!isFokPreviewReason(reason)) throw new Error('preview reason is invalid')

  const previewRevision = nullableBoundedString(record.previewRevision, 'preview revision')
  const quotePaymentSubunits = nullableMonetary(
    record.quotePaymentSubunits,
    'preview quote payment',
  )
  const averagePrice = nullableFiniteNonnegative(record.averagePrice, 'preview average price')
  const worstPrice = nullablePrice(record.worstPrice, 'preview worst price')
  const currentLatestTradePrice = nullablePrice(
    record.currentLatestTradePrice,
    'preview current latest trade price',
  )
  const projectedFinalPrice = nullablePrice(
    record.projectedFinalPrice,
    'preview projected final price',
  )
  const priceDenominator = nullablePriceDenominator(record.priceDenominator)
  const subsidyMayHelp = record.subsidyMayHelp
  if (typeof subsidyMayHelp !== 'boolean') throw new Error('preview subsidy hint is invalid')

  validateRequest(request, priceDenominator)
  if (fullFillAvailable !== (reason === 'fillable')) {
    throw new Error('preview fill flag does not match reason')
  }
  const executionEstimate = [
    quotePaymentSubunits,
    averagePrice,
    worstPrice,
    projectedFinalPrice,
  ]
  if (fullFillAvailable) {
    if (executionEstimate.some((field) => field === null)) {
      throw new Error('preview execution estimate nullability is invalid')
    }
  } else if (executionEstimate.some((field) => field !== null)) {
    throw new Error('preview execution estimate nullability is invalid')
  }
  if ((previewRevision === null) !== (priceDenominator === null)) {
    throw new Error('preview snapshot metadata is invalid')
  }
  if (priceDenominator === null && currentLatestTradePrice !== null) {
    throw new Error('preview current latest trade price is invalid')
  }
  if (fullFillAvailable && (previewRevision === null || priceDenominator === null)) {
    throw new Error('preview fillable snapshot metadata is invalid')
  }
  if (averagePrice !== null && priceDenominator !== null && averagePrice >= priceDenominator) {
    throw new Error('preview average price is invalid')
  }
  if (priceDenominator !== null && request.faceAmountSubunits % priceDenominator !== 0) {
    throw new Error('preview face amount is invalid')
  }
  if (subsidyMayHelp && reason !== 'insufficient_liquidity') {
    throw new Error('preview subsidy hint is invalid')
  }
  if (priceDenominator !== null) {
    for (const [name, price] of [
      ['preview request price', request.price],
      ['preview worst price', worstPrice],
      ['preview current latest trade price', currentLatestTradePrice],
      ['preview projected final price', projectedFinalPrice],
    ] as const) {
      if (price !== null && price >= priceDenominator) {
        throw new Error(`${name} is invalid`)
      }
    }
  }
  if (fullFillAvailable && averagePrice !== null && worstPrice !== null) {
    if (request.side === 'Buy' && (worstPrice > request.price || averagePrice > worstPrice)) {
      throw new Error('preview buy price limit is invalid')
    }
    if (request.side === 'Sell' && (worstPrice < request.price || averagePrice < worstPrice)) {
      throw new Error('preview sell price limit is invalid')
    }
  }
  if (fullFillAvailable && projectedFinalPrice !== null && priceDenominator !== null) {
    const selectedFinalPrice = request.tokenSide === 'Complement'
      ? priceDenominator - projectedFinalPrice
      : projectedFinalPrice
    const finalSatisfiesLimit = request.side === 'Buy'
      ? selectedFinalPrice <= request.price
      : selectedFinalPrice >= request.price
    if (!finalSatisfiesLimit) {
      throw new Error('preview final price limit is invalid')
    }
  }

  return {
    fullFillAvailable,
    reason,
    previewRevision,
    quotePaymentSubunits,
    averagePrice,
    worstPrice,
    currentLatestTradePrice,
    projectedFinalPrice,
    priceDenominator,
    subsidyMayHelp,
  }
}

function exactPreviewRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('preview response object is invalid')
  }
  const record = value as Record<string, unknown>
  const required = [
    'fullFillAvailable',
    'reason',
    'previewRevision',
    'quotePaymentSubunits',
    'averagePrice',
    'worstPrice',
    'currentLatestTradePrice',
    'projectedFinalPrice',
    'priceDenominator',
    'subsidyMayHelp',
  ] as const
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key as (typeof required)[number]))
  ) {
    throw new Error('preview response fields are invalid')
  }
  return record
}

function isFokPreviewReason(value: unknown): value is FokPreviewReason {
  return typeof value === 'string' && (FOK_PREVIEW_REASONS as readonly string[]).includes(value)
}

function nullableBoundedString(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function nullableMonetary(value: unknown, name: string): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100_000_000_000_000
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function nullableFiniteNonnegative(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function nullablePrice(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function nullablePriceDenominator(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 2 ||
    value > 1_000_000
  ) {
    throw new Error('preview price denominator is invalid')
  }
  return value
}

function validateRequest(request: PreviewFokOrderRequest, priceDenominator: number | null): void {
  if (
    typeof request.marketId !== 'string' ||
    request.marketId.length < 3 ||
    request.marketId.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*-[a-zA-Z0-9]+$/.test(request.marketId)
  ) {
    throw new Error('preview market id is invalid')
  }
  if (request.side !== 'Buy' && request.side !== 'Sell') {
    throw new Error('preview side is invalid')
  }
  if (request.tokenSide !== 'Outcome' && request.tokenSide !== 'Complement') {
    throw new Error('preview token side is invalid')
  }
  if (!Number.isSafeInteger(request.price) || request.price < 1 || request.price > 999_999) {
    throw new Error('preview request price is invalid')
  }
  if (
    !Number.isSafeInteger(request.faceAmountSubunits) ||
    request.faceAmountSubunits < 1 ||
    request.faceAmountSubunits > 100_000_000_000_000
  ) {
    throw new Error('preview face amount is invalid')
  }
  if (priceDenominator !== null && request.price >= priceDenominator) {
    throw new Error('preview request price is invalid')
  }
}
