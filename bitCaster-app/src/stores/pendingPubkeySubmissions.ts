import { create } from 'zustand'

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
  hydratePendingPubkeys: (entries: PendingPubkeyEntry[]) => void
  markSubmitted: (tradeId: string) => void
  removePendingPubkey: (tradeId: string) => void
}

export const usePendingPubkeySubmissionsStore = create<PendingPubkeyState>()(
    (set) => ({
      byTradeId: {},
      addPendingPubkey: (entry) => set((state) => ({
        byTradeId: { ...state.byTradeId, [entry.tradeId]: entry },
      })),
      hydratePendingPubkeys: (entries) => set((state) => ({
        byTradeId: {
          ...Object.fromEntries(entries.map((entry) => [entry.tradeId, entry])),
          ...state.byTradeId,
        },
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
)
