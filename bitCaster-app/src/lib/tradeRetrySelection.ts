import { outcomeSetMarketId, resolveOutcomeSets } from "@bitcaster/client-sdk/outcomeSets";
import type { SdkMarketForTrading } from "@bitcaster/client-sdk/types";
import type { TradeSelection } from "@/types/market-detail";
import type { TradeRetryRequest } from "@/stores/tradeRetryRequest";
import { assertNever } from "@/lib/enumDiscipline";

/**
 * The trade form selection that sends an order on the same route and token as
 * the retried order. It uses the same resolution as a new order, so the form
 * cannot select a route that the order did not use. Null when this market has
 * no such selection.
 */
export function tradeSelectionForRetry(
  market: SdkMarketForTrading,
  retry: Pick<TradeRetryRequest, "orderRouteId" | "tokenSide">,
): TradeSelection | null {
  return (
    selectionCandidates(market).find((selection) => {
      const resolved = resolveOutcomeSets(market, selection);
      return (
        resolved !== null &&
        resolved.tokenSide === retry.tokenSide &&
        outcomeSetMarketId(market.id, resolved.publicOutcomeSetId) === retry.orderRouteId
      );
    }) ?? null
  );
}

/** The selections that the trade form offers for this market type. */
function selectionCandidates(market: SdkMarketForTrading): TradeSelection[] {
  switch (market.type) {
    case "yesno":
      return [{ side: "yes" }, { side: "no" }];
    case "categorical":
      return (market.outcomes ?? []).flatMap((outcome) => [
        { side: "yes" as const, outcomeId: outcome.id },
        { side: "no" as const, outcomeId: outcome.id },
      ]);
    // The trade form offers no FOK order for these market types.
    case "numeric":
    case "twodimensional":
      return [];
    default:
      return assertNever(market.type);
  }
}
