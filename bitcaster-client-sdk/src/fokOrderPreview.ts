import type { components } from './generated/api.ts'

export type PreviewFokOrderRequest = components['schemas']['PreviewFokOrderRequest']
export type PreviewFokOrderResponse = components['schemas']['PreviewFokOrderResponse']
export type FokPreviewReason = components['schemas']['FokPreviewReason']
export type PreviewFokOrderCapacityRequest = components['schemas']['PreviewFokOrderCapacityRequest']
export type PreviewFokOrderCapacityResponse =
  components['schemas']['PreviewFokOrderCapacityResponse']
export type FokCapacityPreviewStatus = components['schemas']['FokCapacityPreviewStatus']

export const FOK_PREVIEW_RESPONSE_BYTES_MAX = 16 * 1_024

const FOK_PREVIEW_REASONS = [
  'fillable',
  'insufficient_liquidity',
  'price_limit',
  'request_too_large',
  'market_unavailable',
  'temporarily_unavailable',
] as const satisfies readonly FokPreviewReason[]
const FOK_CAPACITY_PREVIEW_STATUSES = [
  'ready',
  'market_unavailable',
  'temporarily_unavailable',
] as const satisfies readonly FokCapacityPreviewStatus[]

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

/** Build the public fields only. Omitted price means Auto; null is invalid. */
export function canonicalizePreviewFokOrderCapacityRequest(
  request: PreviewFokOrderCapacityRequest,
): PreviewFokOrderCapacityRequest {
  validateCapacityRequest(request, null)
  return {
    marketId: request.marketId,
    side: request.side,
    tokenSide: request.tokenSide,
    ...(request.price === undefined ? {} : { price: request.price }),
  }
}

export function decodePreviewFokOrderCapacityResponse(
  value: unknown,
  request: PreviewFokOrderCapacityRequest,
): PreviewFokOrderCapacityResponse {
  const record = exactCapacityPreviewRecord(value)
  const status = record.status
  if (!isCapacityPreviewStatus(status)) {
    throw new Error('capacity preview status is invalid')
  }

  const response: PreviewFokOrderCapacityResponse = {
    status,
    referencePrice: nullablePrice(record.referencePrice, 'capacity preview reference price'),
    effectiveLimitPrice: nullablePrice(
      record.effectiveLimitPrice,
      'capacity preview effective limit price',
    ),
    maxFaceAmountSubunits: nullableMonetary(
      record.maxFaceAmountSubunits,
      'capacity preview maximum face amount',
    ),
    quotePaymentSubunits: nullableMonetary(
      record.quotePaymentSubunits,
      'capacity preview quote payment',
    ),
    worstPrice: nullablePrice(record.worstPrice, 'capacity preview worst price'),
    priceDenominator: nullablePriceDenominator(record.priceDenominator),
    previewRevision: nullableBoundedString(record.previewRevision, 'capacity preview revision'),
  }
  validateCapacityPreviewResponse(response, request)
  return response
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
  const executionEstimate = [quotePaymentSubunits, averagePrice, worstPrice, projectedFinalPrice]
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
    const selectedFinalPrice =
      request.tokenSide === 'Complement'
        ? priceDenominator - projectedFinalPrice
        : projectedFinalPrice
    const finalSatisfiesLimit =
      request.side === 'Buy'
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

function exactCapacityPreviewRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('capacity preview response object is invalid')
  }
  const record = value as Record<string, unknown>
  const required = [
    'status',
    'referencePrice',
    'effectiveLimitPrice',
    'maxFaceAmountSubunits',
    'quotePaymentSubunits',
    'worstPrice',
    'priceDenominator',
    'previewRevision',
  ] as const
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key as (typeof required)[number]))
  ) {
    throw new Error('capacity preview response fields are invalid')
  }
  return record
}

function validateCapacityPreviewResponse(
  response: PreviewFokOrderCapacityResponse,
  request: PreviewFokOrderCapacityRequest,
): void {
  validateCapacityRequest(request, null)
  switch (response.status) {
    case 'market_unavailable':
    case 'temporarily_unavailable':
      if (
        response.referencePrice !== null ||
        response.effectiveLimitPrice !== null ||
        response.maxFaceAmountSubunits !== null ||
        response.quotePaymentSubunits !== null ||
        response.worstPrice !== null ||
        response.priceDenominator !== null ||
        response.previewRevision !== null
      ) {
        throw new Error('unavailable capacity preview facts must be null')
      }
      return
    case 'ready':
      validateReadyCapacityPreview(response, request)
      return
    default:
      return assertNever(response.status)
  }
}

function validateReadyCapacityPreview(
  response: PreviewFokOrderCapacityResponse,
  request: PreviewFokOrderCapacityRequest,
): void {
  const {
    referencePrice,
    effectiveLimitPrice,
    maxFaceAmountSubunits,
    quotePaymentSubunits,
    worstPrice,
    priceDenominator,
    previewRevision,
  } = response
  if (
    priceDenominator === null ||
    previewRevision === null ||
    maxFaceAmountSubunits === null ||
    quotePaymentSubunits === null
  ) {
    throw new Error('ready capacity preview facts are incomplete')
  }
  validateCapacityRequest(request, priceDenominator)
  if (referencePrice !== null && referencePrice >= priceDenominator) {
    throw new Error('capacity preview reference price is invalid')
  }
  if (effectiveLimitPrice !== null && effectiveLimitPrice >= priceDenominator) {
    throw new Error('capacity preview effective limit price is invalid')
  }
  if (worstPrice !== null && worstPrice >= priceDenominator) {
    throw new Error('capacity preview worst price is invalid')
  }
  if (maxFaceAmountSubunits % priceDenominator !== 0) {
    throw new Error('capacity preview face amount is not a whole-share multiple')
  }

  if (referencePrice === null) {
    if (maxFaceAmountSubunits !== 0 || quotePaymentSubunits !== 0 || worstPrice !== null) {
      throw new Error('capacity preview without a reference must be empty')
    }
    if (request.price === undefined) {
      if (effectiveLimitPrice !== null) {
        throw new Error('automatic capacity limit requires a reference price')
      }
    } else if (effectiveLimitPrice !== request.price) {
      throw new Error('custom capacity limit does not match the request')
    }
    return
  }

  if (effectiveLimitPrice === null) {
    throw new Error('capacity preview reference requires an effective limit')
  }
  if (request.price === undefined) {
    // Check approved arithmetic only. The server owns the book price source.
    const expectedLimit = automaticCapacityLimit(request.side, priceDenominator, referencePrice)
    if (effectiveLimitPrice !== expectedLimit) {
      throw new Error('automatic capacity limit is inconsistent with its reference')
    }
  } else if (effectiveLimitPrice !== request.price) {
    throw new Error('custom capacity limit does not match the request')
  }

  if (maxFaceAmountSubunits === 0) {
    if (quotePaymentSubunits !== 0 || worstPrice !== null) {
      throw new Error('zero capacity preview facts are inconsistent')
    }
    return
  }
  if (
    quotePaymentSubunits === 0 ||
    quotePaymentSubunits >= maxFaceAmountSubunits ||
    worstPrice === null ||
    !capacityPriceIsWithinBounds(request.side, referencePrice, worstPrice, effectiveLimitPrice)
  ) {
    throw new Error('positive capacity preview price facts are inconsistent')
  }
}

function automaticCapacityLimit(
  side: PreviewFokOrderCapacityRequest['side'],
  priceDenominator: number,
  referencePrice: number,
): number {
  const allowance = Math.floor((priceDenominator * 20) / 100)
  const rawLimit = (() => {
    switch (side) {
      case 'Buy':
        return referencePrice + allowance
      case 'Sell':
        return referencePrice - allowance
      default:
        return assertNever(side)
    }
  })()
  return Math.max(1, Math.min(priceDenominator - 1, rawLimit))
}

function capacityPriceIsWithinBounds(
  side: PreviewFokOrderCapacityRequest['side'],
  referencePrice: number,
  worstPrice: number,
  effectiveLimitPrice: number,
): boolean {
  switch (side) {
    case 'Buy':
      return worstPrice >= referencePrice && worstPrice <= effectiveLimitPrice
    case 'Sell':
      return worstPrice <= referencePrice && worstPrice >= effectiveLimitPrice
    default:
      return assertNever(side)
  }
}

function isFokPreviewReason(value: unknown): value is FokPreviewReason {
  return typeof value === 'string' && (FOK_PREVIEW_REASONS as readonly string[]).includes(value)
}

function isCapacityPreviewStatus(value: unknown): value is FokCapacityPreviewStatus {
  return (
    typeof value === 'string' &&
    (FOK_CAPACITY_PREVIEW_STATUSES as readonly string[]).includes(value)
  )
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2 || value > 1_000_000) {
    throw new Error('preview price denominator is invalid')
  }
  return value
}

function validateRequest(request: PreviewFokOrderRequest, priceDenominator: number | null): void {
  validatePreviewRouteFields(request.marketId, request.side, request.tokenSide)
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

function validateCapacityRequest(
  request: PreviewFokOrderCapacityRequest,
  priceDenominator: number | null,
): void {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('capacity preview request is invalid')
  }
  validatePreviewRouteFields(request.marketId, request.side, request.tokenSide)
  if (
    request.price !== undefined &&
    (typeof request.price !== 'number' ||
      !Number.isSafeInteger(request.price) ||
      request.price < 1 ||
      request.price > 999_999)
  ) {
    throw new Error('capacity preview custom price is invalid')
  }
  if (
    priceDenominator !== null &&
    request.price !== undefined &&
    request.price >= priceDenominator
  ) {
    throw new Error('capacity preview custom price is invalid')
  }
}

function validatePreviewRouteFields(marketId: unknown, side: unknown, tokenSide: unknown): void {
  if (
    typeof marketId !== 'string' ||
    marketId.length < 3 ||
    marketId.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*-[a-zA-Z0-9]+$/.test(marketId)
  ) {
    throw new Error('preview market id is invalid')
  }
  if (side !== 'Buy' && side !== 'Sell') {
    throw new Error('preview side is invalid')
  }
  if (tokenSide !== 'Outcome' && tokenSide !== 'Complement') {
    throw new Error('preview token side is invalid')
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected capacity preview value: ${String(value)}`)
}
