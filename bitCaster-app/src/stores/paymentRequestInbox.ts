import { create } from "zustand";
import type { MarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";

/**
 * A received payment keyed by the originating PaymentRequest id.
 * Populated by the continuous NIP-17 listener; consumed by the
 * "Receive via request" view so the "Waiting…" → "Received" transition
 * survives reloads, navigation, and payments that arrive before the
 * view is mounted.
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
