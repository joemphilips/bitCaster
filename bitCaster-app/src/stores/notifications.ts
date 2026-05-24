import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Cap on how many notifications we keep in memory / localStorage. Once the
 * list passes this, the oldest entries fall off. 100 is generous for a UI
 * that shows a handful per session — it just exists so the persisted blob
 * doesn't grow without bound across many trades.
 */
const MAX_NOTIFICATIONS = 100

/**
 * Mirrors the engine's terminal / partial order statuses so the bell can
 * render without translating between a separate vocabulary. `resting` never
 * produces a notification, so it's excluded here.
 */
export type NotificationKind = 'accepted' | 'matched' | 'filled' | 'partially_filled' | 'cancelled'

export interface Notification {
  /**
   * Stable, content-derived identifier so the poller can emit the same
   * notification twice (across reloads, retries, etc.) without creating
   * duplicate bell entries. Format:
   *
   *   filled / cancelled → `{orderId}-{kind}` (terminal, one per order)
   *   partially_filled   → `{orderId}-partially_filled-{fillCount}` (one per step)
   */
  id: string
  kind: NotificationKind
  orderId: string
  marketId: string
  /** Absolute sats filled at the moment this notification was generated. */
  filledAmountSats: number
  /** Sats remaining on the order at the moment this notification was generated. */
  remainingAmountSats: number
  /** Unix ms. */
  occurredAt: number
  read: boolean
}

interface NotificationState {
  items: Notification[]
  add: (n: Notification) => void
  markAllRead: () => void
  clear: () => void
}

/**
 * Unread count. Exposed as a selector helper to avoid re-subscribing the
 * bell to the whole items array for every render elsewhere.
 */
export const selectUnreadCount = (s: NotificationState): number =>
  s.items.reduce((c, n) => (n.read ? c : c + 1), 0)

export const useNotificationsStore = create<NotificationState>()(
  persist(
    (set) => ({
      items: [],
      add: (n) => {
        set((s) => {
          if (s.items.some((x) => x.id === n.id)) return s
          const next = [n, ...s.items]
          if (next.length > MAX_NOTIFICATIONS) next.length = MAX_NOTIFICATIONS
          return { items: next }
        })
      },
      markAllRead: () => {
        set((s) => {
          if (s.items.every((n) => n.read)) return s
          return { items: s.items.map((n) => (n.read ? n : { ...n, read: true })) }
        })
      },
      clear: () => set({ items: [] }),
    }),
    { name: 'bitcaster-notifications' },
  ),
)
