import { useActiveSwapsStore } from "@/stores/activeSwaps";
import { usePendingTradesStore } from "@/stores/pendingTrades";

type SanitizedActiveSwap = {
  tradeId: string;
  orderId: string;
  marketId: string;
  role: string | null;
  step: string;
  error: string | null;
  messageTypes: string[];
  inFlightSteps: string[];
};

type SanitizedPendingTrade = {
  orderId: string;
  marketId: string;
  submittedAt: number;
  hasPreflightSplit: boolean;
};

export type SwapDiagnosticsSnapshot = {
  activeTrade: SanitizedActiveSwap | null;
  activeTradeIds: string[];
  pendingOrderIds: string[];
  pendingTrades: Record<string, SanitizedPendingTrade>;
};

declare global {
  interface Window {
    __BITCASTER_E2E__?: {
      getSwapDiagnostics: (tradeId: string) => SwapDiagnosticsSnapshot;
    };
  }
}

export function getSwapDiagnostics(tradeId: string): SwapDiagnosticsSnapshot {
  const activeState = useActiveSwapsStore.getState();
  const pendingState = usePendingTradesStore.getState();
  const pendingTrades = Object.fromEntries(
    Object.entries(pendingState.byOrderId).map(([orderId, trade]) => [
      orderId,
      {
        orderId: trade.orderId,
        marketId: trade.marketId,
        submittedAt: trade.submittedAt,
        hasPreflightSplit: Boolean(trade.preflightSplit),
      },
    ]),
  );

  return {
    activeTrade: sanitizeActiveSwap(activeState.byTradeId[tradeId] ?? null),
    activeTradeIds: Object.keys(activeState.byTradeId),
    pendingOrderIds: Object.keys(pendingState.byOrderId),
    pendingTrades,
  };
}

export function installE2EDiagnostics(): void {
  if (typeof window === "undefined") return;
  window.__BITCASTER_E2E__ = { getSwapDiagnostics };
}

function sanitizeActiveSwap(
  swap:
    | ReturnType<typeof useActiveSwapsStore.getState>["byTradeId"][string]
    | null,
): SanitizedActiveSwap | null {
  if (!swap) return null;
  return {
    tradeId: swap.tradeId,
    orderId: swap.orderId,
    marketId: swap.marketId,
    role: swap.role,
    step: swap.step,
    error: swap.error,
    messageTypes: Object.keys(swap.messages),
    inFlightSteps: Object.keys(swap.inFlightSteps),
  };
}
