import type { LimitOrderPreview } from '@/types/market-detail'

/**
 * Derived cost breakdown for a buy of `shares` face at a given `price`.
 *
 * The trade input is a SHARE/FACE count. That share count is the wire
 * `amountSats` (a multiple of 100) submitted to the engine — see
 * `buildTradeTicket`. The figures here are NEVER sent on the wire; they exist
 * only to (a) populate the trade preview panels and (b) drive the pre-submit
 * balance check. The balance gate and the displayed Total cost MUST share this
 * formula so the gate can never over-require (P22 C LOW): for a buy at
 * price < 100 the actual spend is strictly less than the face amount, so
 * gating on face would block trades the user can actually afford.
 *
 * Quote sats = face * price / 100 — the engine derives the quote it charges
 * from `face × price` where `price` is the 1..99 probability. On top of the
 * quote the user pays the creator fee (a percentage of the quote) and the mint
 * fee. The creator fee is computed on the QUOTE/COST basis, never on the face.
 *
 *   quoteSats  = round(shares * price / 100)
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
  shares: number
  price: number
  feePercent: number
  mintInputFeePpk: number
}): TradeCostBreakdown {
  const { shares, price, feePercent, mintInputFeePpk } = params
  const quoteSats = Math.round((shares * price) / 100)
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
  shares: number
  limitPrice: number
  feePercent: number
  mintInputFeePpk: number
}): LimitOrderPreview {
  const { shares, limitPrice, feePercent, mintInputFeePpk } = params
  const cost = computeTradeCost({
    shares,
    price: limitPrice,
    feePercent,
    mintInputFeePpk,
  })
  return {
    limitPrice,
    amount: shares,
    creatorFee: cost.creatorFee,
    mintFee: cost.mintFee,
    totalCost: cost.totalCost,
  }
}
