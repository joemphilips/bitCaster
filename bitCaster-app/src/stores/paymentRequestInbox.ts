import { create } from "zustand";
import type { MarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";

/**
 * The tab keeps received payments by PaymentRequest id in memory.
 * The continuous NIP-17 listener updates this store.
 * The Receive view can show payments that arrive before it mounts.
 * Navigation keeps this state. A reload clears it.
 */
export interface InboxEntry {
  id: string;
  walletScopeId: string;
  amountSubunits: number;
  baseAsset: MarketBaseAsset;
  receivedAt: number;
}

export interface PendingPaymentRequest {
  id: string;
  mintUrl: string;
  walletScopeId: string;
  createdAt: number;
}

interface InboxState {
  entries: Record<string, InboxEntry>;
  pending: Record<string, PendingPaymentRequest>;
  registerPending: (id: string, mintUrl: string, walletScopeId: string) => void;
  markReceived: (
    id: string,
    amountSubunits: number,
    baseAsset: MarketBaseAsset,
    walletScopeId: string,
  ) => void;
  clear: (id: string) => void;
}

export const usePaymentRequestInbox = create<InboxState>((set) => ({
  entries: {},
  pending: {},
  registerPending: (id, mintUrl, walletScopeId) =>
    set((s) => ({
      pending: {
        ...s.pending,
        [id]: { id, mintUrl, walletScopeId, createdAt: Date.now() },
      },
    })),
  markReceived: (id, amountSubunits, baseAsset, walletScopeId) =>
    set((s) => {
      if (s.pending[id]?.walletScopeId !== walletScopeId) return s;
      const pending = { ...s.pending };
      delete pending[id];
      return {
        pending,
        entries: {
          ...s.entries,
          [id]: { id, walletScopeId, amountSubunits, baseAsset, receivedAt: Date.now() },
        },
      };
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.entries)) return s;
      const next = { ...s.entries };
      delete next[id];
      return { entries: next };
    }),
}));
