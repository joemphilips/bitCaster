import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * TTL for persisted entries. A pending trade older than this is assumed to be
 * abandoned (tab closed, app uninstalled, etc.) — keeping ephemeral privkeys
 * in localStorage indefinitely is an unnecessary long-lived secret.
 */
const PENDING_TRADE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Per-order crypto material that the client generates before submitting and
 * needs to keep around until the order fully settles (or is cancelled).
 *
 * The ephemeral keypair is used by the atomic-swap protocol after the engine
 * reports MATCHED: the counterparty encrypts messages to `ephemeralPubkey`,
 * and the client decrypts them with `ephemeralPrivkey`. The privkey never
 * leaves the browser.
 *
 * PR1 only populates this store on order submission; PR3 will consume it
 * during swap execution.
 */
export interface PendingTrade {
  orderId: string
  marketId: string
  /** 33-byte compressed secp256k1 pubkey, hex. */
  ephemeralPubkey: string
  /** 32-byte secp256k1 scalar, hex. Never sent anywhere. */
  ephemeralPrivkey: string
  /** Unix ms when the order was submitted — useful for TTL/expiry handling. */
  submittedAt: number
  /** Market base asset and denominator captured from the accepted order. */
  baseAsset?: string | null
  divisibility?: number | null
  side?: 'Buy' | 'Sell'
  tokenSide?: 'Outcome' | 'Complement'
  priceSubunits?: number | null
  amountSubunits?: number | null
  /** Reserved complete-set proofs created before a mint-maker buy rests. */
  preflightSplit?: PendingPreflightSplit
}

export interface PendingPreflightSplit {
  reservationId: string
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
  amountSubunits: number
}

interface PendingTradeState {
  byOrderId: Record<string, PendingTrade>
  add: (trade: PendingTrade) => void
  remove: (orderId: string) => void
  get: (orderId: string) => PendingTrade | undefined
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
        }))
      },
      remove: (orderId) => {
        set((s) => {
          if (!(orderId in s.byOrderId)) return s
          const next = { ...s.byOrderId }
          delete next[orderId]
          return { byOrderId: next }
        })
      },
      get: (orderId) => get().byOrderId[orderId],
    }),
    {
      name: 'bitcaster-pending-trades',
      // Purge expired entries on hydrate so long-abandoned privkeys don't
      // accumulate in localStorage forever.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const cutoff = Date.now() - PENDING_TRADE_TTL_MS
        const entries = Object.entries(state.byOrderId)
        const fresh = entries.filter(([, t]) => t.submittedAt >= cutoff)
        if (fresh.length !== entries.length) {
          state.byOrderId = Object.fromEntries(fresh)
        }
      },
    },
  ),
)
