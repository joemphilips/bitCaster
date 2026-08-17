import { useMemo } from "react";
import { computeSpreadMidpoint } from "@/components/market-detail/orderBookViewModel";
import type { MarketDetail, OrderBook } from "@/types/market-detail";
import type { LatestConfirmedTrade } from "@/types/market";
import {
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { outcomeSetMarketId, parseOutcomeSetId } from "@bitcaster/client-sdk/outcomeSets";

export interface UseMarketPriceInput {
  market: MarketDetail | null | undefined;
  marketId: string | null | undefined;
  outcomeSetId: string | null | undefined;
  orderBook?: OrderBook | null;
}

export interface MarketPriceState {
  /** Confirmed-trade market price. Null means no valid confirmed trade exists. */
  currentPrice: number | null;
  /** Explicit order-entry seam. This may use the book midpoint or uniform midpoint. */
  defaultOrderPrice: number;
}

export function defaultLimitPriceForDivisibility(divisibility: number, baseAsset: string): number {
  return Math.max(1, Math.floor(normalizeMarketDivisibility(divisibility, baseAsset) / 2));
}

export function clampOrderPrice(price: number, divisibility: number): number {
  if (!Number.isFinite(price)) return Math.max(1, Math.floor(divisibility / 2));
  return Math.max(1, Math.min(divisibility - 1, Math.round(price)));
}

function compareEventOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function latestTradeAcrossOutcomes(
  trades: readonly LatestConfirmedTrade[],
): LatestConfirmedTrade | null {
  return trades.reduce<LatestConfirmedTrade | null>((latest, trade) => {
    if (!latest || compareEventOrder(latest.eventOrder, trade.eventOrder) < 0) return trade;
    return latest;
  }, null);
}

function latestTradeForOutcome(
  trades: readonly LatestConfirmedTrade[],
  primitiveOutcomeId: string,
): LatestConfirmedTrade | null {
  return trades.reduce<LatestConfirmedTrade | null>((latest, trade) => {
    if (trade.primitiveOutcomeId !== primitiveOutcomeId) return latest;
    if (!latest || compareEventOrder(latest.eventOrder, trade.eventOrder) < 0) return trade;
    return latest;
  }, null);
}

function numericPrimitiveIds(
  market: Pick<MarketDetail, "registeredPrimitiveOutcomeIds">,
): { hi: string; lo: string } | null {
  const registered = market.registeredPrimitiveOutcomeIds ?? [];
  const hi = registered.find((id) => id === "HI");
  const lo = registered.find((id) => id === "LO");
  // Numeric markets have one exact, registered HI/LO pair. Do not infer
  // identities from case variants or from an unregistered route.
  if (!hi || !lo || registered.length !== 2) return null;
  return { hi, lo };
}

function primitivePriceFromTrade(
  trade: LatestConfirmedTrade,
  primitiveOutcomeId: string,
): number | null {
  if (trade.primitiveOutcomeId === primitiveOutcomeId) return trade.priceTick;
  return trade.divisibility - trade.priceTick;
}

function primitiveIdForOutcome(
  market: MarketDetail,
  outcomeSetId: string,
): string | null {
  const members = parseOutcomeSetId(outcomeSetId);
  if (members.length !== 1) return null;
  const member = members[0];
  const registered = market.registeredPrimitiveOutcomeIds ?? [];
  if (registered.includes(member)) return member;
  const outcome = market.outcomes?.find(
    (candidate) => candidate.id === member || candidate.label === member,
  );
  return outcome && registered.includes(outcome.id) ? outcome.id : null;
}

function deriveYesNoPrice(
  market: Extract<MarketDetail, { type: "yesno" }>,
  outcomeSetId: string | null | undefined,
): number | null {
  if (!outcomeSetId) return null;
  const latest = latestTradeAcrossOutcomes(market.latestConfirmedTrades ?? []);
  if (!latest) return null;
  const yesId = market.registeredPrimitiveOutcomeIds?.find((id) => id.toLowerCase() === "yes");
  const noId = market.registeredPrimitiveOutcomeIds?.find((id) => id.toLowerCase() === "no");
  if (
    !yesId ||
    !noId ||
    (latest.primitiveOutcomeId !== yesId && latest.primitiveOutcomeId !== noId)
  ) {
    return null;
  }
  const yesRouteIds = new Set([
    yesId,
    ...(market.outcomes ?? [])
      .filter((outcome) => outcome.label.toLowerCase() === "yes")
      .flatMap((outcome) => [outcome.id, outcome.label]),
  ]);
  const noRouteIds = new Set([
    noId,
    ...(market.outcomes ?? [])
      .filter((outcome) => outcome.label.toLowerCase() === "no")
      .flatMap((outcome) => [outcome.id, outcome.label]),
  ]);
  const requested = yesRouteIds.has(outcomeSetId)
    ? yesId
    : noRouteIds.has(outcomeSetId)
      ? noId
      : null;
  if (!requested) return null;
  return primitivePriceFromTrade(latest, requested);
}

function deriveCategoricalPrice(
  market: Extract<MarketDetail, { type: "categorical" }>,
  outcomeSetId: string | null | undefined,
): number | null {
  if (!outcomeSetId) return null;
  const primitiveId = primitiveIdForOutcome(market, outcomeSetId);
  if (primitiveId) {
    return latestTradeForOutcome(market.latestConfirmedTrades ?? [], primitiveId)?.priceTick ?? null;
  }

  // A one-vs-rest route is the complement of one primitive outcome. Derive it
  // from that same primitive's latest fill instead of mixing sales or making a
  // condition-wide normalization assumption.
  const members = parseOutcomeSetId(outcomeSetId);
  const universe = market.registeredPrimitiveOutcomeIds ?? [];
  if (
    members.length !== universe.length - 1 ||
    new Set(members).size !== members.length ||
    members.some((member) => !universe.includes(member))
  ) {
    return null;
  }
  const missing = universe.find((id) => !members.includes(id));
  if (!missing) return null;
  const latest = latestTradeForOutcome(market.latestConfirmedTrades ?? [], missing);
  return latest ? latest.divisibility - latest.priceTick : null;
}

function deriveNumericPrice(
  market: Extract<MarketDetail, { type: "numeric" }>,
  outcomeSetId: string | null | undefined,
): number | null {
  const ids = numericPrimitiveIds(market);
  if (!ids) return null;
  const latest = latestTradeAcrossOutcomes(market.latestConfirmedTrades ?? []);
  if (!latest) return null;
  if (latest.primitiveOutcomeId !== ids.hi && latest.primitiveOutcomeId !== ids.lo) return null;
  const hiTick = latest.primitiveOutcomeId === ids.hi
    ? latest.priceTick
    : latest.divisibility - latest.priceTick;
  if (!Number.isFinite(hiTick / latest.divisibility)) return null;
  if (outcomeSetId === ids.lo) return latest.divisibility - hiTick;
  return outcomeSetId === ids.hi || outcomeSetId == null
    ? hiTick
    : null;
}

export function deriveNumericCurrentValue(
  market: Pick<Extract<MarketDetail, { type: "numeric" }>,
    | "loBound"
    | "hiBound"
    | "latestConfirmedTrades"
    | "latestConfirmedTradesValid"
    | "registeredPrimitiveOutcomeIds">,
): number | null {
  if (market.latestConfirmedTradesValid === false) return null;
  const ids = numericPrimitiveIds(market);
  if (!ids) return null;
  const latest = latestTradeAcrossOutcomes(market.latestConfirmedTrades ?? []);
  if (!latest) return null;
  if (latest.primitiveOutcomeId !== ids.hi && latest.primitiveOutcomeId !== ids.lo) return null;
  const hiTick = latest.primitiveOutcomeId === ids.hi
    ? latest.priceTick
    : latest.divisibility - latest.priceTick;
  const value = market.loBound + (hiTick / latest.divisibility) * (market.hiBound - market.loBound);
  return Number.isFinite(value) ? value : null;
}

export function deriveConfirmedMarketPrice(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): number | null {
  if (market.latestConfirmedTradesValid === false) return null;
  switch (market.type) {
    case "yesno":
      return deriveYesNoPrice(market, outcomeSetId);
    case "categorical":
      return deriveCategoricalPrice(market, outcomeSetId);
    case "numeric":
      return deriveNumericPrice(market, outcomeSetId);
    default:
      return null;
  }
}

export function useMarketPrice({
  market,
  marketId,
  outcomeSetId,
  orderBook,
}: UseMarketPriceInput): MarketPriceState {
  // Price data is scoped to the exact outcome-set market route. A detail
  // response can still be present for one condition while navigation is
  // moving to another, so never let that response provide a price for the
  // active route unless both identities match exactly.
  const exactMarketIdentity =
    market != null &&
    marketId != null &&
    outcomeSetId != null &&
    outcomeSetMarketId(market.id, outcomeSetId) === marketId;
  const divisibility = exactMarketIdentity && market
    ? normalizeMarketDivisibility(market.divisibility, market.baseAsset)
    : DEFAULT_SAT_MARKET_DIVISIBILITY;
  const baseAsset = exactMarketIdentity && market ? market.baseAsset : "sat";
  const currentPrice = useMemo(
    () => (exactMarketIdentity && market ? deriveConfirmedMarketPrice(market, outcomeSetId) : null),
    [exactMarketIdentity, market, outcomeSetId],
  );
  const scopedOrderBook = exactMarketIdentity ? orderBook : null;
  const defaultOrderPrice = useMemo(() => {
    const midpoint = computeSpreadMidpoint(scopedOrderBook);
    if (midpoint != null) return clampOrderPrice(midpoint, divisibility);
    if (currentPrice != null) return clampOrderPrice(currentPrice, divisibility);
    return defaultLimitPriceForDivisibility(divisibility, baseAsset);
  }, [scopedOrderBook, currentPrice, divisibility, baseAsset]);

  return { currentPrice, defaultOrderPrice };
}
