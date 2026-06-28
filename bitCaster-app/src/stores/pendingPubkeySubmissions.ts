import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const PENDING_PUBKEY_TTL_MS = 60 * 60 * 1000

export interface PendingPubkeyEntry {
  tradeId: string
  orderId: string
  marketId: string
  pubkey: string
  privkey: string
  deadline: string
  submitted: boolean
}

interface PendingPubkeyState {
  byTradeId: Record<string, PendingPubkeyEntry>
  addPendingPubkey: (entry: PendingPubkeyEntry) => void
  markSubmitted: (tradeId: string) => void
  removePendingPubkey: (tradeId: string) => void
}

export const usePendingPubkeySubmissionsStore = create<PendingPubkeyState>()(
  persist(
    (set) => ({
      byTradeId: {},
      addPendingPubkey: (entry) => set((state) => ({
        byTradeId: { ...state.byTradeId, [entry.tradeId]: entry },
      })),
      markSubmitted: (tradeId) => set((state) => {
        const current = state.byTradeId[tradeId]
        if (!current) return state
        return {
          byTradeId: {
            ...state.byTradeId,
            [tradeId]: { ...current, submitted: true },
          },
        }
      }),
      removePendingPubkey: (tradeId) => set((state) => {
        if (!(tradeId in state.byTradeId)) return state
        const next = { ...state.byTradeId }
        delete next[tradeId]
        return { byTradeId: next }
      }),
    }),
    {
      name: 'bitcaster-pending-pubkeys',
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const cutoff = Date.now() - PENDING_PUBKEY_TTL_MS
        state.byTradeId = Object.fromEntries(
          Object.entries(state.byTradeId).filter(([, entry]) => {
            const deadlineMs = new Date(entry.deadline).getTime()
            return Number.isFinite(deadlineMs) && deadlineMs >= cutoff
          }),
        )
      },
    },
  ),
)
