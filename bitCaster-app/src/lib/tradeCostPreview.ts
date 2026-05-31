import type { LimitOrderPreview } from '@/types/market-detail'

export const FACE_SATS_PER_DISPLAY_SHARE = 100

export function displaySharesToFaceSats(displayShares: number): number {
  return displayShares * FACE_SATS_PER_DISPLAY_SHARE
}

export function faceSatsToDisplayShares(faceSats: number): number {
  return Math.floor(faceSats / FACE_SATS_PER_DISPLAY_SHARE)
}

/**
 * Derived cost breakdown for a buy of display shares at a given `price`.
 *
 * The trade input is user-facing display shares. One display share is a
 * 100-sat conditional-token face lot; boundary code converts to wire
 * `amountSats` via {@link displaySharesToFaceSats}. The figures here are NEVER
 * sent on the wire; they exist only to (a) populate the trade preview panels
 * and (b) drive the pre-submit balance check.
 *
 * Quote sats = display shares * price. This is equivalent to the engine's
 * exact settlement formula because:
 *
 *   faceSats   = displayShares * 100
 *   quoteSats  = faceSats * price / 100
 *              = displayShares * price
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
}): TradeCostBreakdown {
  const { displayShares, price, feePercent, mintInputFeePpk } = params
  const quoteSats = displayShares * price
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
}): LimitOrderPreview {
  const { displayShares, limitPrice, feePercent, mintInputFeePpk } = params
  const cost = computeTradeCost({
    displayShares,
    price: limitPrice,
    feePercent,
    mintInputFeePpk,
  })
  return {
    limitPrice,
    amount: displayShares,
    quoteSats: cost.quoteSats,
    creatorFee: cost.creatorFee,
    mintFee: cost.mintFee,
    totalCost: cost.totalCost,
  }
}
