/**
 * Zustand store for active atomic swap trades.
 *
 * Tracks each trade from MATCHED through to CONFIRMED (or FAILED), including
 * the ephemeral keypair used for ECDH and the counterparty's pubkey.
 *
 * Persisted to localStorage so a page reload mid-swap can resume. Private
 * keys are Uint8Array but Zustand's persist middleware serialises via JSON
 * (which doesn't preserve Uint8Array), so we store them as hex strings and
 * re-hydrate on read.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TradeRole = 'seller' | 'buyer'

export type TradeLifecycleState =
  | 'matched'
  | 'settling'
  | 'confirmed'
  | 'retrying'
  | 'failed'

/** Serialised form stored in localStorage — private key as hex. */
export interface PersistedTradeEntry {
  tradeId: string
  role: TradeRole
  state: TradeLifecycleState
  /** 32-byte scalar, hex. */
  ephemeralPrivkeyHex: string
  /** 33-byte compressed point, hex. */
  ephemeralPubkeyHex: string
  counterpartyPubkey?: string
  locktimes?: { sellerUnix: number; buyerUnix: number }
  createdAt: number
}

/** Runtime view — private key as Uint8Array. */
export interface TradeEntry extends Omit<PersistedTradeEntry, 'ephemeralPrivkeyHex'> {
  ephemeralPrivkey: Uint8Array
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

interface TradeStoreState {
  byTradeId: Record<string, PersistedTradeEntry>

  /** Add or replace a trade record. */
  upsert: (entry: TradeEntry) => void

  /** Transition a trade to a new lifecycle state. */
  updateState: (tradeId: string, newState: TradeLifecycleState) => void

  /** Record the counterparty pubkey once the TradeCreated event arrives. */
  setCounterpartyPubkey: (tradeId: string, pubkey: string) => void

  /** Record locktimes from the TradeCreated event. */
  setLocktimes: (
    tradeId: string,
    locktimes: { sellerUnix: number; buyerUnix: number },
  ) => void

  /** Remove a completed or failed trade. */
  remove: (tradeId: string) => void

  /** Return the runtime TradeEntry for a trade, or undefined. */
  get: (tradeId: string) => TradeEntry | undefined
}

// ---------------------------------------------------------------------------
// Hex ↔ Uint8Array helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function toRuntime(entry: PersistedTradeEntry): TradeEntry {
  const { ephemeralPrivkeyHex, ...rest } = entry
  return { ...rest, ephemeralPrivkey: hexToBytes(ephemeralPrivkeyHex) }
}

function toPersisted(entry: TradeEntry): PersistedTradeEntry {
  const { ephemeralPrivkey, ...rest } = entry
  return {
    ...rest,
    ephemeralPrivkeyHex: Array.from(ephemeralPrivkey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const TRADE_TTL_MS = 24 * 60 * 60 * 1000 // 1 day — locktimes are seconds, not days

export const useTradeStore = create<TradeStoreState>()(
  persist(
    (set, get) => ({
      byTradeId: {},

      upsert: (entry: TradeEntry) => {
        set((s) => ({
          byTradeId: {
            ...s.byTradeId,
            [entry.tradeId]: toPersisted(entry),
          },
        }))
      },

      updateState: (tradeId: string, newState: TradeLifecycleState) => {
        set((s) => {
          const existing = s.byTradeId[tradeId]
          if (!existing) return s
          return {
            byTradeId: {
              ...s.byTradeId,
              [tradeId]: { ...existing, state: newState },
            },
          }
        })
      },

      setCounterpartyPubkey: (tradeId: string, pubkey: string) => {
        set((s) => {
          const existing = s.byTradeId[tradeId]
          if (!existing) return s
          return {
            byTradeId: {
              ...s.byTradeId,
              [tradeId]: { ...existing, counterpartyPubkey: pubkey },
            },
          }
        })
      },

      setLocktimes: (
        tradeId: string,
        locktimes: { sellerUnix: number; buyerUnix: number },
      ) => {
        set((s) => {
          const existing = s.byTradeId[tradeId]
          if (!existing) return s
          return {
            byTradeId: {
              ...s.byTradeId,
              [tradeId]: { ...existing, locktimes },
            },
          }
        })
      },

      remove: (tradeId: string) => {
        set((s) => {
          if (!(tradeId in s.byTradeId)) return s
          const next = { ...s.byTradeId }
          delete next[tradeId]
          return { byTradeId: next }
        })
      },

      get: (tradeId: string) => {
        const entry = get().byTradeId[tradeId]
        return entry ? toRuntime(entry) : undefined
      },
    }),
    {
      name: 'bitcaster-trades',
      // Evict entries older than the TTL on rehydration
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const cutoff = Date.now() - TRADE_TTL_MS
        const entries = Object.entries(state.byTradeId)
        const fresh = entries.filter(([, t]) => t.createdAt >= cutoff)
        if (fresh.length !== entries.length) {
          state.byTradeId = Object.fromEntries(fresh)
        }
      },
    },
  ),
)
