import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProductMarketDivisibility } from "@/types/market";

/**
 * TTL for persisted entries. A pending trade older than this is assumed to be
 * abandoned (tab closed, app uninstalled, etc.).
 */
const PENDING_TRADE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Per-order metadata retained after submission for order lifecycle recovery.
 */
export interface PendingTrade {
  orderId: string;
  marketId: string;
  clientOrderId?: string;
  /** Unix ms when the order was submitted — useful for TTL/expiry handling. */
  submittedAt: number;
  /** Market base asset and denominator captured from the accepted order. */
  baseAsset: "sat";
  divisibility: ProductMarketDivisibility;
  side?: "Buy" | "Sell";
  tokenSide?: "Outcome" | "Complement";
  priceSubunits?: number | null;
  amountSubunits?: number | null;
}

interface PendingTradeState {
  byOrderId: Record<string, PendingTrade>;
  add: (trade: PendingTrade) => void;
  remove: (orderId: string) => void;
  get: (orderId: string) => PendingTrade | undefined;
}

/**
 * Persisted store keyed by orderId. Outlives page reloads so the swap can
 * resume if the user refreshes mid-trade.
 */
export const usePendingTradesStore = create<PendingTradeState>()(
  persist(
    (set, get) => ({
      byOrderId: {},
      add: (trade) => {
        set((s) => ({
          byOrderId: { ...s.byOrderId, [trade.orderId]: trade },
        }));
      },
      remove: (orderId) => {
        set((s) => {
          if (!(orderId in s.byOrderId)) return s;
          const next = { ...s.byOrderId };
          delete next[orderId];
          return { byOrderId: next };
        });
      },
      get: (orderId) => get().byOrderId[orderId],
    }),
    {
      name: "bitcaster-pending-trades",
      // Purge expired order metadata on hydrate.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const cutoff = Date.now() - PENDING_TRADE_TTL_MS;
        const entries = Object.entries(state.byOrderId);
        const fresh = entries.filter(([, t]) => t.submittedAt >= cutoff);
        if (fresh.length !== entries.length) {
          state.byOrderId = Object.fromEntries(fresh);
        }
      },
    },
  ),
);
