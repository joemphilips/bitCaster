import type {
  SdkMarketForTrading,
  SdkOrderBook,
  SdkOrderType,
  SdkSubmitOrderRequest,
  SdkTradeSelection,
  SdkTradeSide,
} from './types.ts'
import {
  normalizeMarketDivisibility,
  shareFaceSubunits,
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
  | 'no-market-liquidity'
  | 'missing-order-book'
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

function marketPriceFor(
  side: SdkTradeSide,
  divisibility: number,
  orderBook: SdkOrderBook | null | undefined,
  complementaryOrderBook: SdkOrderBook | null | undefined,
): number {
  const direct = side === 'buy' ? orderBook?.asks[0] : orderBook?.bids[0]
  if (direct) return side === 'buy' ? divisibility - 1 : 1

  if (side === 'buy') {
    const complementaryBid = complementaryOrderBook?.bids[0]
    if (complementaryBid) return divisibility - 1
  }

  if (!orderBook && !complementaryOrderBook) {
    throw new TradeTicketError(
      'missing-order-book',
      'No live order book is loaded for this outcome yet. Use Limit to post an order, or try again after the book loads.',
    )
  }

  throw new TradeTicketError(
    'no-market-liquidity',
    'No matching liquidity is available right now. Switch to Limit to post an order to the book.',
  )
}

export function buildTradeTicket(params: {
  market: SdkMarketForTrading
  selection: SdkTradeSelection | null
  amountSats: number
  side: SdkTradeSide
  orderType: SdkOrderType
  limitPrice: number
  orderBook?: SdkOrderBook | null
  complementaryOrderBook?: SdkOrderBook | null
}): TradeTicket {
  const {
    market,
    selection,
    amountSats,
    side,
    orderType,
    limitPrice,
    orderBook,
    complementaryOrderBook,
  } = params

  if (!selection) {
    throw new TradeTicketError(
      'missing-selection',
      'Choose an outcome before placing an order.',
    )
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new TradeTicketError(
      'invalid-amount',
      'Enter an amount greater than zero.',
    )
  }
  const divisibility = normalizeMarketDivisibility(market.divisibility)
  const shareFace = shareFaceSubunits(market.baseAsset)
  if (!validateWholeShareFaceAmount(amountSats, shareFace)) {
    throw new TradeTicketError(
      'invalid-amount',
      `Enter an amount in ${shareFace} sub-unit increments.`,
    )
  }

  const resolvedOutcome = resolveTradeOutcome(market, selection)
  if (!resolvedOutcome) {
    throw new TradeTicketError(
      'missing-selection',
      'Choose an outcome before placing an order.',
    )
  }
  const requestSide = side === 'buy' ? 'Buy' : 'Sell'
  const settlementSupport = checkOrderSettlementSupport({
    request: { side: requestSide },
  })
  if (!settlementSupport.supported) {
    throw new TradeTicketError('unsupported-settlement', settlementSupport.message)
  }

  const price =
    orderType === 'limit'
      ? Math.min(Math.max(Math.round(limitPrice), 1), divisibility - 1)
      : marketPriceFor(side, divisibility, orderBook, complementaryOrderBook)
  if (!validatePriceNumerator(price, divisibility)) {
    throw new TradeTicketError(
      'invalid-amount',
      `Enter a price from 1 to ${divisibility - 1}.`,
    )
  }

  const request: SdkSubmitOrderRequest = {
    outcomeId: resolvedOutcome.publicOutcomeSetId,
    tokenSide: resolvedOutcome.tokenSide,
    side: requestSide,
    price,
    amountSats,
    timeInForce: orderType === 'market' ? 'FAK' : 'GTC',
  }

  return {
    marketId: `${market.id}-${resolvedOutcome.publicOutcomeSetId}`,
    request,
  }
}
