import type { SubmitOrderRequest } from '@/lib/markets'
import type {
  MarketDetail,
  OrderBook,
  OrderType,
  TradeSelection,
  TradeSide,
} from '@/types/market-detail'

export interface TradeTicket {
  marketId: string
  request: Omit<SubmitOrderRequest, 'ephemeralPubkey'>
}

export type TradeTicketErrorCode =
  | 'missing-selection'
  | 'invalid-amount'
  | 'unsupported-market'
  | 'no-market-liquidity'
  | 'missing-order-book'

export class TradeTicketError extends Error {
  constructor(
    public readonly code: TradeTicketErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TradeTicketError'
  }
}

function canonicalOutcomeName(
  market: MarketDetail,
  selection: TradeSelection,
): string | null {
  if (market.type === 'yesno') {
    if (selection.side === 'yes') return 'YES'
    if (selection.side === 'no') return 'NO'
    return null
  }

  if (market.type === 'categorical') {
    const selected = market.outcomes.find((o) => o.id === selection.outcomeId)
    return selected?.label ?? null
  }

  if (market.type === 'numeric') {
    if (selection.side === 'hi') return 'HI'
    if (selection.side === 'lo') return 'LO'
  }

  return null
}

function marketPriceFor(
  side: TradeSide,
  orderBook: OrderBook | null | undefined,
): number {
  if (!orderBook) {
    throw new TradeTicketError(
      'missing-order-book',
      'No live order book is loaded for this outcome yet. Use Limit to post an order, or try again after the book loads.',
    )
  }

  const executable = side === 'buy' ? orderBook.asks[0] : orderBook.bids[0]
  if (!executable) {
    throw new TradeTicketError(
      'no-market-liquidity',
      'No matching liquidity is available right now. Switch to Limit to post an order to the book.',
    )
  }

  return executable.price
}

export function buildTradeTicket(params: {
  market: MarketDetail
  selection: TradeSelection | null
  amountSats: number
  side: TradeSide
  orderType: OrderType
  limitPrice: number
  orderBook?: OrderBook | null
}): TradeTicket {
  const { market, selection, amountSats, side, orderType, limitPrice, orderBook } = params

  if (!selection) {
    throw new TradeTicketError('missing-selection', 'Choose an outcome before placing an order.')
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new TradeTicketError('invalid-amount', 'Enter an amount greater than zero.')
  }

  const outcomeName = canonicalOutcomeName(market, selection)
  if (!outcomeName) {
    throw new TradeTicketError(
      'unsupported-market',
      'This market type is not supported by the trading form yet.',
    )
  }

  const price =
    orderType === 'limit'
      ? Math.min(Math.max(Math.round(limitPrice), 1), 99)
      : marketPriceFor(side, orderBook)

  return {
    marketId: `${market.id}-${outcomeName}`,
    request: {
      outcomeId: outcomeName,
      side: side === 'buy' ? 'Buy' : 'Sell',
      price,
      amountSats,
      timeInForce: orderType === 'market' ? 'FAK' : 'GTC',
    },
  }
}
