import type { LimitOrderPreview } from '@/types/market-detail'

/**
 * Display-only cost preview for a limit buy/sell.
 *
 * The trade input is a SHARE/FACE count. That share count is the wire
 * `amountSats` (a multiple of 100) submitted to the engine — see
 * `buildTradeTicket`. The figures here are NEVER sent on the wire; they exist
 * only to (a) populate the limit preview panel and (b) drive the balance
 * check.
 *
 * Quote sats = face * price / 100 — the engine derives the quote it charges
 * from `face × price` where `price` is the 1..99 probability. On top of the
 * quote the user pays the creator fee (a percentage of the quote) and the mint
 * fee.
 *
 *   totalCost = round(shares * limitPrice / 100)
 *             + round(quote * feePercent / 100)
 *             + ceil(quote * mintInputFeePpk / 1000)
 *
 * `mintInputFeePpk` is the per-input fee (`input_fee_ppk`, parts-per-thousand)
 * the active mint advertises on its keysets. For the first-release bitCaster
 * mint config it is `0`, so the mint fee resolves to `0 sats`.
 */
export function computeLimitOrderPreview(params: {
  shares: number
  limitPrice: number
  feePercent: number
  mintInputFeePpk: number
}): LimitOrderPreview {
  const { shares, limitPrice, feePercent, mintInputFeePpk } = params
  const quoteSats = Math.round((shares * limitPrice) / 100)
  const creatorFee = Math.round((quoteSats * feePercent) / 100)
  const mintFee = Math.ceil((quoteSats * mintInputFeePpk) / 1000)
  return {
    limitPrice,
    amount: shares,
    creatorFee,
    mintFee,
    totalCost: quoteSats + creatorFee + mintFee,
  }
}
