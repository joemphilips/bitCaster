import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface BrowserPartialLockFailure {
  tradeId: string
  orderId: string
  mintUrl: string
  refundLocktime: number
  affectedKeysets: string[]
  detail: string
  createdAt: number
}

interface PartialLockFailureState {
  byTradeId: Record<string, BrowserPartialLockFailure>
  upsert: (record: BrowserPartialLockFailure) => void
  remove: (tradeId: string) => void
  list: () => BrowserPartialLockFailure[]
}

export const usePartialLockFailuresStore = create<PartialLockFailureState>()(
  persist(
    (set, get) => ({
      byTradeId: {},
      upsert: (record) =>
        set((state) => ({
          byTradeId: { ...state.byTradeId, [record.tradeId]: record },
        })),
      remove: (tradeId) =>
        set((state) => {
          if (!(tradeId in state.byTradeId)) return state
          const next = { ...state.byTradeId }
          delete next[tradeId]
          return { byTradeId: next }
        }),
      list: () => Object.values(get().byTradeId),
    }),
    { name: 'bitcaster-partial-lock-failures' },
  ),
)
