import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProductMarketDivisibility } from "@/types/market";

/**
 * Per-order metadata retained after submission for order lifecycle recovery.
 */
export interface PendingTrade {
  orderId: string;
  /** Missing only on legacy persisted orders whose wallet cannot be inferred. */
  walletId?: string;
  marketId: string;
  clientOrderId?: string;
  /** Unix ms when the order was submitted — useful for recovery diagnostics. */
  submittedAt: number;
  /** Market base asset and denominator captured from the accepted order. */
  baseAsset: "sat";
  divisibility: ProductMarketDivisibility;
  side?: "Buy" | "Sell";
  tokenSide?: "Outcome" | "Complement";
  priceSubunits?: number | null;
  amountSubunits?: number | null;
}

export type NewPendingTrade = Omit<PendingTrade, "walletId"> & { walletId: string };

interface PendingTradeState {
  byOrderId: Record<string, PendingTrade>;
  add: (trade: NewPendingTrade) => void;
  remove: (orderId: string, walletId: string) => void;
  removeReconciledUnscoped: (observed: PendingTrade) => void;
  get: (orderId: string) => PendingTrade | undefined;
  hasPendingForWallet: (walletId: string) => boolean;
  hasUnscopedPending: () => boolean;
}

const CANONICAL_WALLET_ID = /^[0-9a-f]{64}$/;

function isCanonicalWalletId(walletId: unknown): walletId is string {
  return typeof walletId === "string" && CANONICAL_WALLET_ID.test(walletId);
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
        if (!isCanonicalWalletId(trade.walletId)) {
          throw new Error("Pending trade wallet id is invalid.");
        }
        set((s) => ({
          byOrderId: { ...s.byOrderId, [trade.orderId]: trade },
        }));
      },
      remove: (orderId, walletId) => {
        if (!isCanonicalWalletId(walletId)) return;
        set((s) => {
          const current = s.byOrderId[orderId];
          if (!current || current.walletId !== walletId) return s;
          const next = { ...s.byOrderId };
          delete next[orderId];
          return { byOrderId: next };
        });
      },
      removeReconciledUnscoped: (observed) => {
        set((s) => {
          const current = s.byOrderId[observed.orderId];
          if (current !== observed || current.walletId !== undefined) return s;
          const next = { ...s.byOrderId };
          delete next[observed.orderId];
          return { byOrderId: next };
        });
      },
      get: (orderId) => get().byOrderId[orderId],
      hasPendingForWallet: (walletId) =>
        isCanonicalWalletId(walletId) &&
        Object.values(get().byOrderId).some((trade) => trade.walletId === walletId),
      hasUnscopedPending: () =>
        Object.values(get().byOrderId).some((trade) => !isCanonicalWalletId(trade.walletId)),
    }),
    {
      name: "bitcaster-pending-trades",
    },
  ),
);
