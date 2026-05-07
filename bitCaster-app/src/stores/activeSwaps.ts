/**
 * In-memory state for atomic swaps that have crossed MATCHED but have not yet
 * reached CONFIRMED (or FAILED). Keyed by `tradeId`, never persisted.
 *
 * This store is the working memory of `useTradeSettlement` — it tracks which
 * fills have been promoted to in-progress swaps, what role the user plays in
 * each one, the ciphertexts received from the counterparty, and the small bits
 * of seller/buyer state that must survive across SignalR callbacks.
 *
 * The ephemeral private key never lives here — `pendingTrades` is the
 * authoritative source. We hold only `tradeId` plus a reference back into
 * `pendingTrades` via the `orderId` that produced the fill.
 *
 * Why in-memory and not sessionStorage / localStorage:
 *   - Phase scope per the plan: tab refreshes mid-handshake are out of scope.
 *     The handshake is short (seconds) and the engine's state machine is
 *     deterministic on message sequence — a refreshed tab can be made to
 *     resume in a future iteration without changing the storage shape here.
 *   - Storing per-trade ciphertexts in localStorage would compound key
 *     exposure for no benefit during the live handshake.
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwapRole = 'seller' | 'buyer'

/**
 * Tracks which protocol messages have been observed for a given trade. Each
 * field holds the ciphertext from the wire so the seller/buyer driver can
 * pick up after a re-render without a second hub fetch.
 *
 * `adaptorPoint` and `lockedProofsSeller` come from the seller (Alice).
 * `lockedProofsBuyer` comes from the buyer (Bob).
 */
export interface SwapMessages {
  adaptorPoint?: string
  lockedProofsSeller?: string
  lockedProofsBuyer?: string
}

/** What stage of the protocol the local driver has finished. */
export type SwapStep =
  | 'awaiting-trade-created'
  | 'awaiting-counterparty'
  | 'driving'
  | 'awaiting-confirmation'
  | 'completed'
  | 'failed'

export interface ActiveSwap {
  tradeId: string
  /** The order whose fill triggered this swap. */
  orderId: string
  marketId: string
  /**
   * Ephemeral keypair seeded from `pendingTrades` at promote-time. Captured
   * here so the swap can survive even after the pending-trade entry is
   * evicted on terminal order status. Both halves are hex.
   */
  ephemeralPrivkeyHex: string
  ephemeralPubkeyHex: string
  role: SwapRole | null
  counterpartyPubkey: string | null
  /** Unix seconds — Alice's locktime per the protocol spec. */
  sellerLocktime: number | null
  /** Unix seconds — Bob's shorter locktime. */
  buyerLocktime: number | null
  step: SwapStep
  messages: SwapMessages
  /** Last error message if the swap fell into the `failed` step. */
  error: string | null
  startedAt: number
}

interface ActiveSwapsState {
  byTradeId: Record<string, ActiveSwap>
  promote: (init: {
    tradeId: string
    orderId: string
    marketId: string
    ephemeralPrivkeyHex: string
    ephemeralPubkeyHex: string
  }) => void
  setRoleAndCounterparty: (
    tradeId: string,
    role: SwapRole,
    counterpartyPubkey: string,
    locktimes: { sellerLocktime: number; buyerLocktime: number },
  ) => void
  recordMessage: (
    tradeId: string,
    messageType: keyof SwapMessages,
    ciphertext: string,
  ) => void
  setStep: (tradeId: string, step: SwapStep, error?: string) => void
  remove: (tradeId: string) => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Lightweight zustand store, no middleware. Reads / writes happen from the
 * `useTradeSettlement` hook and from the SignalR callbacks fired by it.
 */
export const useActiveSwapsStore = create<ActiveSwapsState>()((set) => ({
  byTradeId: {},

  promote: ({
    tradeId,
    orderId,
    marketId,
    ephemeralPrivkeyHex,
    ephemeralPubkeyHex,
  }) => {
    set((s) => {
      if (s.byTradeId[tradeId]) return s
      const swap: ActiveSwap = {
        tradeId,
        orderId,
        marketId,
        ephemeralPrivkeyHex,
        ephemeralPubkeyHex,
        role: null,
        counterpartyPubkey: null,
        sellerLocktime: null,
        buyerLocktime: null,
        step: 'awaiting-trade-created',
        messages: {},
        error: null,
        startedAt: Date.now(),
      }
      return { byTradeId: { ...s.byTradeId, [tradeId]: swap } }
    })
  },

  setRoleAndCounterparty: (tradeId, role, counterpartyPubkey, locktimes) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            role,
            counterpartyPubkey,
            sellerLocktime: locktimes.sellerLocktime,
            buyerLocktime: locktimes.buyerLocktime,
            step: existing.step === 'awaiting-trade-created'
              ? 'awaiting-counterparty'
              : existing.step,
          },
        },
      }
    })
  },

  recordMessage: (tradeId, messageType, ciphertext) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            messages: { ...existing.messages, [messageType]: ciphertext },
          },
        },
      }
    })
  },

  setStep: (tradeId, step, error) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, step, error: error ?? existing.error },
        },
      }
    })
  },

  remove: (tradeId) => {
    set((s) => {
      if (!(tradeId in s.byTradeId)) return s
      const next = { ...s.byTradeId }
      delete next[tradeId]
      return { byTradeId: next }
    })
  },
}))
