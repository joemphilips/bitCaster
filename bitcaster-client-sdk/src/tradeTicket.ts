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
): number {
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
