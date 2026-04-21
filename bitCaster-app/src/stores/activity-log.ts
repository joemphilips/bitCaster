import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ActivityItem, ActivityType, ActivityStatus } from '@/types/portfolio'

interface ActivityLogState {
  items: ActivityItem[]
  addActivity: (entry: {
    type: ActivityType
    amountSats: number
    status: ActivityStatus
    txId?: string | null
    lightningInvoice?: string | null
    marketId?: string
    marketTitle?: string
  }) => void
}

let _nextId = Date.now()

export const useActivityLogStore = create<ActivityLogState>()(
  persist(
    (set) => ({
      items: [],
      addActivity: (entry) => {
        const item: ActivityItem = {
          id: String(_nextId++),
          type: entry.type,
          amountSats: entry.amountSats,
          date: new Date().toISOString(),
          status: entry.status,
          txId: entry.txId ?? null,
          lightningInvoice: entry.lightningInvoice ?? null,
          marketId: entry.marketId,
          marketTitle: entry.marketTitle,
        }
        set((s) => ({ items: [item, ...s.items].slice(0, 500) }))
      },
    }),
    {
      name: 'bitcaster-activity-log',
      partialize: (s) => ({ items: s.items }),
    },
  ),
)
