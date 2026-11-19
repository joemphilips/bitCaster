import { create } from "zustand";

/**
 * The order inputs that a Retry starts again from. It holds no preview, fee
 * consent, or capability: the market page reads a new preview, and the user
 * confirms the order as usual.
 */
export interface TradeRetryRequest {
  readonly conditionId: string;
  /** The public `{conditionId}-{outcome}` route of the failed order. */
  readonly orderRouteId: string;
  readonly tokenSide: "Outcome" | "Complement";
  readonly side: "Buy" | "Sell";
  /** Share face subunits. */
  readonly amountSubunits: number;
}

/**
 * The one Retry that waits for its market page. It stays in memory only, so a
 * reload or another tab never prefills a form.
 */
export const useTradeRetryRequest = create<{ readonly request: TradeRetryRequest | null }>(() => ({
  request: null,
}));

/** A new request replaces an earlier one, also for the same order. */
export function requestTradeRetry(request: TradeRetryRequest): void {
  useTradeRetryRequest.setState({ request: { ...request } });
}

/** The market page took this request. A later request stays. */
export function takeTradeRetryRequest(request: TradeRetryRequest): void {
  if (useTradeRetryRequest.getState().request === request)
    useTradeRetryRequest.setState({ request: null });
}
