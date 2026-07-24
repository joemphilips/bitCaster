import type { LimitOrderPreview, OrderBook, TradeSide } from "@/types/market-detail";
import { normalizeMarketDivisibility } from "@bitcaster/client-sdk/marketUnits";

export function displaySharesToFaceSubunits(
  displayShares: number,
  baseAsset: string | null | undefined = "sat",
  divisibility?: number | null,
): number {
  return displayShares * normalizeMarketDivisibility(divisibility, baseAsset);
}

export function faceSubunitsToDisplayShares(
  faceSubunits: number,
  baseAsset: string | null | undefined = "sat",
  divisibility?: number | null,
): number {
  return Math.floor(faceSubunits / normalizeMarketDivisibility(divisibility, baseAsset));
}

/**
 * Derived cost breakdown for a buy of display shares at a given `price`.
 *
 * The trade input is user-facing display shares. One display share is a
 * market-divisibility-sized conditional-token face lot; boundary code converts to wire
 * `amountSubunits` via {@link displaySharesToFaceSubunits}. The figures here are NEVER
 * sent on the wire; they exist only to (a) populate the trade preview panels
 * and (b) drive the pre-submit balance check.
 *
 * Quote subunits = display shares * price. This is equivalent to the engine's
 * exact settlement formula because:
 *
 *   faceSubunits  = displayShares * divisibility
 *   quoteSubunits = faceSubunits * price / divisibility
 *
 * On top of the quote the user pays the creator fee (a percentage of the
 * quote) and the mint fee. The creator fee is computed on the QUOTE/COST
 * basis, never on the face.
 *
 *   quoteSubunits = displayShares * price
 *   creatorFee    = round(quoteSubunits * feePercent / 100)
 *   mintFee       = ceil(quoteSubunits * mintInputFeePpk / 1000)
 *   totalCost     = quoteSubunits + creatorFee + mintFee
 *
 * `mintInputFeePpk` is the per-input fee (`input_fee_ppk`, parts-per-thousand)
 * the active mint advertises on its keysets. For the first-release bitCaster
 * mint config it is `0`, so the mint fee resolves to `0 sats`.
 */
export interface TradeCostBreakdown {
  quoteSubunits: number;
  creatorFee: number;
  mintFee: number;
  totalCost: number;
}

export function computeTradeCost(params: {
  displayShares: number;
  price: number;
  feePercent: number;
  mintInputFeePpk: number;
  baseAsset?: string | null;
  divisibility?: number | null;
}): TradeCostBreakdown {
  const { displayShares, price, feePercent, mintInputFeePpk, baseAsset = "sat" } = params;
  const divisibility = normalizeMarketDivisibility(params.divisibility, baseAsset);
  const quoteSubunits =
    (displaySharesToFaceSubunits(displayShares, baseAsset, divisibility) * price) / divisibility;
  const creatorFee = Math.round((quoteSubunits * feePercent) / 100);
  const mintFee = Math.ceil((quoteSubunits * mintInputFeePpk) / 1000);
  return {
    quoteSubunits,
    creatorFee,
    mintFee,
    totalCost: quoteSubunits + creatorFee + mintFee,
  };
}

/**
 * Display-only cost preview for a limit buy/sell. Thin wrapper over
 * {@link computeTradeCost} shaped to the limit preview panel.
 */
export function computeLimitOrderPreview(params: {
  displayShares: number;
  limitPrice: number;
  feePercent: number;
  mintInputFeePpk: number;
  engineScoreFeeSats?: number | null;
  baseAsset?: string | null;
  divisibility?: number | null;
}): LimitOrderPreview {
  const {
    displayShares,
    limitPrice,
    feePercent,
    mintInputFeePpk,
    engineScoreFeeSats = null,
    baseAsset = "sat",
  } = params;
  const cost = computeTradeCost({
    displayShares,
    price: limitPrice,
    feePercent,
    mintInputFeePpk,
    baseAsset,
    divisibility: params.divisibility,
  });
  return {
    limitPrice,
    amount: displayShares,
    sharesIfFilled: displayShares,
    quoteSubunits: cost.quoteSubunits,
    creatorFee: cost.creatorFee,
    mintFee: cost.mintFee,
    engineScoreFeeSats,
    potentialPayout: displaySharesToFaceSubunits(displayShares, baseAsset, params.divisibility),
    totalCost: cost.totalCost,
  };
}

export interface MarketOrderQuotePreview {
  executableDisplayShares: number;
  averageExecutionPrice: number;
  quoteSubunits: number;
  filledFaceSubunits: number;
}

export function computeMarketOrderQuotePreview(params: {
  displayShares: number;
  tradeSide: TradeSide;
  orderBook: OrderBook | null | undefined;
  complementaryOrderBook?: OrderBook | null | undefined;
  baseAsset?: string | null;
  divisibility?: number | null;
}): MarketOrderQuotePreview | null {
  const { displayShares, tradeSide, orderBook, complementaryOrderBook, baseAsset = "sat" } = params;
  const divisibility = normalizeMarketDivisibility(params.divisibility, baseAsset);
  const faceSubunitsPerDisplayShare = divisibility;
  if ((!orderBook && !complementaryOrderBook) || displayShares <= 0 || divisibility <= 0)
    return null;

  const remainingFaceTarget = displaySharesToFaceSubunits(displayShares, baseAsset, divisibility);
  let remainingFace = remainingFaceTarget;
  let quoteSubunits = 0;
  let filledFaceSubunits = 0;

  const consume = (levels: OrderBook["bids"], priceForLevel: (price: number) => number) => {
    for (const level of levels) {
      if (remainingFace <= 0) break;
      const fillFace = Math.min(remainingFace, level.amount);
      if (fillFace <= 0) continue;
      quoteSubunits += (fillFace * priceForLevel(level.price)) / divisibility;
      filledFaceSubunits += fillFace;
      remainingFace -= fillFace;
    }
  };

  consume(
    tradeSide === "Sell" ? (orderBook?.bids ?? []) : (orderBook?.asks ?? []),
    (price) => price,
  );
  if (tradeSide === "Buy") {
    consume(complementaryOrderBook?.bids ?? [], (price) => divisibility - price);
  }

  if (filledFaceSubunits <= 0) return null;

  const executableDisplayShares = filledFaceSubunits / faceSubunitsPerDisplayShare;
  return {
    executableDisplayShares,
    averageExecutionPrice: (quoteSubunits * divisibility) / filledFaceSubunits,
    quoteSubunits,
    filledFaceSubunits,
  };
}
