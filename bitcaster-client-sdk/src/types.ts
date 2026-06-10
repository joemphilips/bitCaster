export interface SdkMarketOutcome {
  id: string
  label: string
}

export interface SdkOrderBookLevel {
  price: number
  amount: number
  total?: number
}

export interface SdkOrderBook {
  bids: SdkOrderBookLevel[]
  asks: SdkOrderBookLevel[]
  spread: number
}

export type SdkMarketType = 'yesno' | 'categorical' | 'numeric' | 'twodimensional'
export type SdkTradeSide = 'buy' | 'sell'
export type SdkOrderType = 'market' | 'limit'

export interface SdkMarketForTrading {
  id: string
  type: SdkMarketType
  outcomes?: SdkMarketOutcome[]
  baseAsset?: 'sat' | 'usd' | 'jpy'
  divisibility?: number
}

export interface SdkTradeSelection {
  side: string
  outcomeId?: string
}

export interface SdkSubmitOrderRequest {
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSats: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
}
