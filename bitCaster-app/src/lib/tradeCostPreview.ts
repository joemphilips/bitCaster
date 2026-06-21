import type { LimitOrderPreview, OrderBook, TradeSide } from '@/types/market-detail'
import { normalizeMarketDivisibility, shareFaceSubunits } from '@bitcaster/client-sdk/marketUnits'

export { shareFaceSubunits } from '@bitcaster/client-sdk/marketUnits'

export function displaySharesToFaceSats(
  displayShares: number,
  baseAsset: string | null | undefined = 'sat',
): number {
  return displayShares * shareFaceSubunits(baseAsset)
}

export function faceSatsToDisplayShares(
  faceSats: number,
  baseAsset: string | null | undefined = 'sat',
): number {
  return Math.floor(faceSats / shareFaceSubunits(baseAsset))
}

/**
 * Derived cost breakdown for a buy of display shares at a given `price`.
 *
 * The trade input is user-facing display shares. One display share is a
 * market-divisibility-sized conditional-token face lot; boundary code converts to wire
 * `amountSats` via {@link displaySharesToFaceSats}. The figures here are NEVER
 * sent on the wire; they exist only to (a) populate the trade preview panels
 * and (b) drive the pre-submit balance check.
 *
 * Quote sats = display shares * price. This is equivalent to the engine's
 * exact settlement formula because:
 *
 *   faceSats   = displayShares * shareFaceSubunits(baseAsset)
 *   quoteSats  = faceSats * price / divisibility
 *
 * On top of the quote the user pays the creator fee (a percentage of the
 * quote) and the mint fee. The creator fee is computed on the QUOTE/COST
 * basis, never on the face.
 *
 *   quoteSats  = displayShares * price
 *   creatorFee = round(quoteSats * feePercent / 100)
 *   mintFee    = ceil(quoteSats * mintInputFeePpk / 1000)
 *   totalCost  = quoteSats + creatorFee + mintFee
 *
 * `mintInputFeePpk` is the per-input fee (`input_fee_ppk`, parts-per-thousand)
 * the active mint advertises on its keysets. For the first-release bitCaster
 * mint config it is `0`, so the mint fee resolves to `0 sats`.
 */
export interface TradeCostBreakdown {
  quoteSats: number
  creatorFee: number
  mintFee: number
  totalCost: number
}

export function computeTradeCost(params: {
  displayShares: number
  price: number
  feePercent: number
  mintInputFeePpk: number
  baseAsset?: string | null
  divisibility?: number | null
}): TradeCostBreakdown {
  const { displayShares, price, feePercent, mintInputFeePpk, baseAsset = 'sat' } = params
  const divisibility = normalizeMarketDivisibility(params.divisibility)
  const quoteSats = (displaySharesToFaceSats(displayShares, baseAsset) * price) / divisibility
  const creatorFee = Math.round((quoteSats * feePercent) / 100)
  const mintFee = Math.ceil((quoteSats * mintInputFeePpk) / 1000)
  return {
    quoteSats,
    creatorFee,
    mintFee,
    totalCost: quoteSats + creatorFee + mintFee,
  }
}

/**
 * Display-only cost preview for a limit buy/sell. Thin wrapper over
 * {@link computeTradeCost} shaped to the limit preview panel.
 */
export function computeLimitOrderPreview(params: {
  displayShares: number
  limitPrice: number
  feePercent: number
  mintInputFeePpk: number
  engineScoreFeeSats?: number | null
  baseAsset?: string | null
  divisibility?: number | null
}): LimitOrderPreview {
  const {
    displayShares,
    limitPrice,
    feePercent,
    mintInputFeePpk,
    engineScoreFeeSats = null,
    baseAsset = 'sat',
  } = params
  const cost = computeTradeCost({
    displayShares,
    price: limitPrice,
    feePercent,
    mintInputFeePpk,
    baseAsset,
    divisibility: params.divisibility,
  })
  return {
    limitPrice,
    amount: displayShares,
    sharesIfFilled: displayShares,
    quoteSats: cost.quoteSats,
    creatorFee: cost.creatorFee,
    mintFee: cost.mintFee,
    engineScoreFeeSats,
    potentialPayout: displaySharesToFaceSats(displayShares, baseAsset),
    totalCost: cost.totalCost,
  }
}

export interface MarketOrderQuotePreview {
  executableDisplayShares: number
  averageExecutionPrice: number
  quoteSats: number
  filledFaceSats: number
}

export function computeMarketOrderQuotePreview(params: {
  displayShares: number
  tradeSide: TradeSide
  orderBook: OrderBook | null | undefined
  complementaryOrderBook?: OrderBook | null | undefined
  baseAsset?: string | null
  divisibility?: number | null
}): MarketOrderQuotePreview | null {
  const {
    displayShares,
    tradeSide,
    orderBook,
    complementaryOrderBook,
    baseAsset = 'sat',
  } = params
  const divisibility = normalizeMarketDivisibility(params.divisibility)
  const faceSubunitsPerDisplayShare = shareFaceSubunits(baseAsset)
  if ((!orderBook && !complementaryOrderBook) || displayShares <= 0 || divisibility <= 0) return null

  const remainingFaceTarget = displaySharesToFaceSats(displayShares, baseAsset)
  let remainingFace = remainingFaceTarget
  let quoteSats = 0
  let filledFaceSats = 0

  const consume = (
    levels: OrderBook['bids'],
    priceForLevel: (price: number) => number,
  ) => {
    for (const level of levels) {
      if (remainingFace <= 0) break
      const fillFace = Math.min(remainingFace, level.amount)
      if (fillFace <= 0) continue
      quoteSats += (fillFace * priceForLevel(level.price)) / divisibility
      filledFaceSats += fillFace
      remainingFace -= fillFace
    }
  }

  consume(
    tradeSide === 'sell' ? (orderBook?.bids ?? []) : (orderBook?.asks ?? []),
    (price) => price,
  )
  if (tradeSide === 'buy') {
    consume(complementaryOrderBook?.bids ?? [], (price) => divisibility - price)
  }

  if (filledFaceSats <= 0) return null

  const executableDisplayShares = filledFaceSats / faceSubunitsPerDisplayShare
  return {
    executableDisplayShares,
    averageExecutionPrice: (quoteSats * divisibility) / filledFaceSats,
    quoteSats,
    filledFaceSats,
  }
}
