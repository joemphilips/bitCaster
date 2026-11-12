import { assertNever } from "@/lib/enumDiscipline";
import type { MarketState } from "@/hooks/useMarketState";

/**
 * The displayed resolution state of a market.
 *
 * - `open`: the market accepts orders, or the engine state is still loading.
 * - `awaitingResolution`: trading has closed, and the outcome is not known.
 *   A deadline close, or the time before the oracle answers, has this state.
 * - `resolved`: the engine reports the verified final outcome.
 */
export type MarketResolutionState = "open" | "awaitingResolution" | "resolved";

/** The locale key of the label for each state after trading has closed. */
export const MARKET_RESOLUTION_LABEL_KEYS = {
  awaitingResolution: "marketStatus.awaitingResolution",
  resolved: "marketStatus.resolved",
} as const satisfies Record<Exclude<MarketResolutionState, "open">, string>;

/** An engine final outcome is known when it has a visible character. */
export function isMarketOutcomeKnown(finalOutcome: string | null | undefined): boolean {
  return !!finalOutcome?.trim();
}

/**
 * Derive the resolution state from the engine trading state and the engine
 * final outcome. Closure alone does not resolve a market. Only a known
 * outcome does.
 */
export function marketResolutionState(
  state: MarketState | null | undefined,
  finalOutcome: string | null | undefined,
): MarketResolutionState {
  const outcomeKnown = isMarketOutcomeKnown(finalOutcome);
  if (state == null) return outcomeKnown ? "resolved" : "open";
  switch (state) {
    case "open":
      return outcomeKnown ? "resolved" : "open";
    case "closed":
      return outcomeKnown ? "resolved" : "awaitingResolution";
    default:
      return assertNever(state);
  }
}
