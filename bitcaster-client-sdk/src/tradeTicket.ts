import type {
  SdkMarketForTrading,
  SdkOrderBook,
  SdkOrderType,
  SdkSubmitOrderRequest,
  SdkTradeSelection,
  SdkTradeSide,
} from './types.ts'
import {
  canonicalizePreviewFokOrderRequest,
  decodePreviewFokOrderResponse,
  type PreviewFokOrderRequest,
} from './fokOrderPreview.ts'
import {
  normalizeMarketDivisibility,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from './marketUnits.ts'
import { resolveOutcomeSets } from './outcomeSets.ts'
import { checkOrderSettlementSupport } from './settlementSupport.ts'

export interface TradeTicket {
  marketId: string
  request: SdkSubmitOrderRequest
}

export type TradeTicketErrorCode =
  | 'missing-selection'
  | 'invalid-amount'
  | 'invalid-preview'
  | 'unsupported-settlement'

export class TradeTicketError extends Error {
  readonly code: TradeTicketErrorCode

  constructor(code: TradeTicketErrorCode, message: string) {
    super(message)
    this.name = 'TradeTicketError'
    this.code = code
  }
}

function resolveTradeOutcome(
  market: SdkMarketForTrading,
  selection: SdkTradeSelection,
): ReturnType<typeof resolveOutcomeSets> {
  return resolveOutcomeSets(market, selection)
}

function marketPriceFor(side: SdkTradeSide, divisibility: number): number {
  return side === 'Buy' ? divisibility - 1 : 1
}

export function buildTradeTicket(params: {
  market: SdkMarketForTrading
  selection: SdkTradeSelection | null
  amountSubunits?: number
  amountSats?: number
  side: SdkTradeSide
  orderType: SdkOrderType
  limitPrice: number
  orderBook?: SdkOrderBook | null
  complementaryOrderBook?: SdkOrderBook | null
}): TradeTicket {
  const { market, selection, side, orderType, limitPrice } = params
  const amountSubunits = params.amountSubunits ?? params.amountSats

  if (!selection) {
    throw new TradeTicketError('missing-selection', 'Choose an outcome before placing an order.')
  }
  if (
    typeof amountSubunits !== 'number' ||
    !Number.isSafeInteger(amountSubunits) ||
    amountSubunits <= 0
  ) {
    throw new TradeTicketError('invalid-amount', 'Enter an amount greater than zero.')
  }
  const divisibility = normalizeMarketDivisibility(market.divisibility, market.baseAsset)
  const shareFace = divisibility
  if (!validateWholeShareFaceAmount(amountSubunits, shareFace)) {
    throw new TradeTicketError(
      'invalid-amount',
      `Enter an amount in ${shareFace} sub-unit increments.`,
    )
  }

  const resolvedOutcome = resolveTradeOutcome(market, selection)
  if (!resolvedOutcome) {
    throw new TradeTicketError('missing-selection', 'Choose an outcome before placing an order.')
  }
  const requestSide = side === 'Buy' ? 'Buy' : 'Sell'
  const settlementSupport = checkOrderSettlementSupport({
    request: { side: requestSide },
  })
  if (!settlementSupport.supported) {
    throw new TradeTicketError('unsupported-settlement', settlementSupport.message)
  }

  const price =
    orderType === 'limit'
      ? Math.min(Math.max(Math.round(limitPrice), 1), divisibility - 1)
      : marketPriceFor(side, divisibility)
  if (!validatePriceNumerator(price, divisibility)) {
    throw new TradeTicketError('invalid-amount', `Enter a price from 1 to ${divisibility - 1}.`)
  }

  const request: SdkSubmitOrderRequest = {
    outcomeId: resolvedOutcome.publicOutcomeSetId,
    tokenSide: resolvedOutcome.tokenSide,
    side: requestSide,
    price,
    amountSubunits,
    timeInForce: 'FOK',
  }

  return {
    marketId: `${market.id}-${resolvedOutcome.publicOutcomeSetId}`,
    request,
  }
}

/**
 * Derive a protected FOK ticket from one matching, caller-owned preview.
 *
 * The caller must obtain the preview for the current route, amount, selected
 * token, side, price bound, and authentication identity. This operation does
 * not refresh a preview or establish identity freshness. A null or omitted
 * `priceOverride` uses the fillable preview's selected-token worst price. An
 * explicit override must equal the preview request price and is copied
 * without slippage or widening.
 */
export function buildProtectedTradeTicket(params: {
  ticket: TradeTicket
  previewRequest: PreviewFokOrderRequest
  previewResponse: unknown
  priceOverride?: number | null
}): TradeTicket {
  const { ticket, previewRequest, previewResponse } = params
  const priceOverride = params.priceOverride ?? null

  validateTradeTicketShape(ticket)

  let request: PreviewFokOrderRequest
  let response: ReturnType<typeof decodePreviewFokOrderResponse>
  try {
    request = canonicalizePreviewFokOrderRequest(previewRequest)
    response = decodePreviewFokOrderResponse(previewResponse, request)
  } catch (error) {
    throw invalidPreviewError(error)
  }

  if (
    ticket.marketId !== request.marketId ||
    ticket.request.side !== request.side ||
    ticket.request.tokenSide !== request.tokenSide ||
    ticket.request.amountSubunits !== request.faceAmountSubunits ||
    ticket.request.price !== request.price ||
    ticket.request.outcomeId !== request.marketId.slice(request.marketId.lastIndexOf('-') + 1)
  ) {
    throw new TradeTicketError(
      'invalid-preview',
      'The order preview does not match the trade ticket.',
    )
  }

  if (priceOverride !== null) {
    if (!Number.isSafeInteger(priceOverride) || priceOverride !== request.price) {
      throw new TradeTicketError(
        'invalid-preview',
        'The explicit price bound does not match the order preview.',
      )
    }
  }

  if (response.priceDenominator === null || response.worstPrice === null) {
    throw new TradeTicketError(
      'invalid-preview',
      'The fillable order preview has incomplete price metadata.',
    )
  }

  const protectedPrice = priceOverride ?? response.worstPrice
  if (!validatePriceNumerator(protectedPrice, response.priceDenominator)) {
    throw new TradeTicketError('invalid-preview', 'The protected price is invalid.')
  }

  return {
    marketId: ticket.marketId,
    request: {
      ...ticket.request,
      price: protectedPrice,
    },
  }
}

function validateTradeTicketShape(ticket: TradeTicket): void {
  if (
    typeof ticket !== 'object' ||
    ticket === null ||
    typeof ticket.marketId !== 'string' ||
    typeof ticket.request !== 'object' ||
    ticket.request === null
  ) {
    throw new TradeTicketError('invalid-preview', 'The trade ticket is invalid.')
  }

  const request = ticket.request
  if (
    typeof request.outcomeId !== 'string' ||
    request.outcomeId.length < 1 ||
    !isTokenSide(request.tokenSide) ||
    !isTradeSide(request.side) ||
    !Number.isSafeInteger(request.price) ||
    !Number.isSafeInteger(request.amountSubunits) ||
    request.amountSubunits <= 0 ||
    request.timeInForce !== 'FOK'
  ) {
    throw new TradeTicketError('invalid-preview', 'The trade ticket is invalid.')
  }
}

function isTokenSide(value: unknown): value is TradeTicket['request']['tokenSide'] {
  switch (value) {
    case 'Outcome':
    case 'Complement':
      return true
    default:
      return false
  }
}

function isTradeSide(value: unknown): value is SdkTradeSide {
  switch (value) {
    case 'Buy':
    case 'Sell':
      return true
    default:
      return false
  }
}

function invalidPreviewError(error: unknown): TradeTicketError {
  return new TradeTicketError(
    'invalid-preview',
    error instanceof Error ? error.message : 'The order preview is invalid.',
  )
}
