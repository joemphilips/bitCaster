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
import type { Proof } from '@cashu/cashu-ts'
import type { AdaptorPoint } from '@/lib/adaptor'

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

export interface SellerProtocolState {
  adaptorPoint: AdaptorPoint
}

export interface BuyerProtocolState {
  /** Bob's pre-sigs over Bob's locked sat proofs — extract `t` from these. */
  ownPreSigsHex: string[]
  /** The proofs Bob locked to Alice; needed for the NUT-07 poll. */
  lockedSatProofs: Proof[]
  /** Alice's pre-sigs from her locked-proofs message — adapted on claim. */
  sellerPreSigsHex: string[]
}

export type SwapWorkKey = 'seller-open' | 'buyer-respond' | 'settle'

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
  /** Face amount of outcome tokens the seller locks. */
  outcomeFaceAmountSats: number | null
  /** Regular sats the buyer locks. */
  quotePaymentSats: number | null
  step: SwapStep
  messages: SwapMessages
  sellerState: SellerProtocolState | null
  buyerState: BuyerProtocolState | null
  inFlightSteps: Partial<Record<SwapWorkKey, true>>
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
    settlementAmounts?: {
      outcomeFaceAmountSats?: number
      quotePaymentSats?: number
    },
  ) => void
  recordMessage: (
    tradeId: string,
    messageType: keyof SwapMessages,
    ciphertext: string,
  ) => void
  setSellerState: (tradeId: string, state: SellerProtocolState) => void
  setBuyerState: (tradeId: string, state: BuyerProtocolState) => void
  claimStep: (tradeId: string, key: SwapWorkKey) => boolean
  releaseStep: (tradeId: string, key: SwapWorkKey) => void
  clearProtocolState: (tradeId: string) => void
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
export const useActiveSwapsStore = create<ActiveSwapsState>()((set, get) => ({
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
        outcomeFaceAmountSats: null,
        quotePaymentSats: null,
        step: 'awaiting-trade-created',
        messages: {},
        sellerState: null,
        buyerState: null,
        inFlightSteps: {},
        error: null,
        startedAt: Date.now(),
      }
      return { byTradeId: { ...s.byTradeId, [tradeId]: swap } }
    })
  },

  setRoleAndCounterparty: (
    tradeId,
    role,
    counterpartyPubkey,
    locktimes,
    settlementAmounts,
  ) => {
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
            outcomeFaceAmountSats:
              settlementAmounts?.outcomeFaceAmountSats ??
              existing.outcomeFaceAmountSats,
            quotePaymentSats:
              settlementAmounts?.quotePaymentSats ?? existing.quotePaymentSats,
            step:
              existing.step === 'awaiting-trade-created'
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

  setSellerState: (tradeId, sellerState) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, sellerState },
        },
      }
    })
  },

  setBuyerState: (tradeId, buyerState) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, buyerState },
        },
      }
    })
  },

  claimStep: (tradeId, key) => {
    const existing = get().byTradeId[tradeId]
    if (!existing || existing.inFlightSteps[key]) return false
    set((s) => {
      const current = s.byTradeId[tradeId]
      if (!current || current.inFlightSteps[key]) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...current,
            inFlightSteps: { ...current.inFlightSteps, [key]: true },
          },
        },
      }
    })
    return true
  },

  releaseStep: (tradeId, key) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing || !existing.inFlightSteps[key]) return s
      const nextInFlight = { ...existing.inFlightSteps }
      delete nextInFlight[key]
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, inFlightSteps: nextInFlight },
        },
      }
    })
  },

  clearProtocolState: (tradeId) => {
    set((s) => {
      const existing = s.byTradeId[tradeId]
      if (!existing) return s
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            sellerState: null,
            buyerState: null,
            inFlightSteps: {},
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
