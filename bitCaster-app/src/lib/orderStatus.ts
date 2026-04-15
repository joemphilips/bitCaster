import { useEffect, useRef } from 'react'
import type { components } from '@/generated/api'
import { usePendingTradesStore } from '@/stores/pendingTrades'
import {
  type NotificationKind,
  useNotificationsStore,
} from '@/stores/notifications'

export type OrderStatusResponse = components['schemas']['OrderStatusResponse']

/**
 * Mirrors `OrderStatusResponse.status` from `openapi.yaml`. "resting" is the
 * only status the InMemoryMatchingEngine ever returns today; the real engine
 * reports the full set.
 */
export type OrderStatus =
  | 'resting'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'filled',
  'cancelled',
])

export async function fetchOrderStatus(
  marketId: string,
  orderId: string,
): Promise<OrderStatusResponse | null> {
  const response = await fetch(`/api/v1/${marketId}/orders/${orderId}`)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Failed to fetch order status: ${response.status}`)
  }
  return response.json()
}

const POLL_INTERVAL_MS = 5_000

/**
 * Foreground-only poll loop that watches every pending trade's status on the
 * matching engine and fires notifications on state transitions.
 *
 * Design notes:
 *  - Pull-based. The engine does not (yet) push status over SignalR, so we
 *    poll each resting order at a slow cadence. Cheap because the number of
 *    pending trades per user is tiny (most users have zero; active traders
 *    might have a handful).
 *  - Pauses when the tab is hidden and fires one catch-up poll on the next
 *    visibility change. No point hammering the API for a tab the user isn't
 *    looking at.
 *  - Uses a ref of last-seen fill counts so a repeated snapshot ("3 → 3
 *    fills") doesn't re-emit the same partial-fill notification. The store
 *    also dedups by id, but tracking locally lets the happy path avoid the
 *    store write entirely.
 *
 * Mount this once at the application root, the same way as
 * `useBookmarkSync` / `useCreatorSync`.
 */
export function usePendingTradesPoller(): void {
  const lastFillCountRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // True from the moment a `tick()` begins network work to the moment its
    // trailing `setTimeout` lands. Used so a visibilitychange firing mid-tick
    // doesn't spawn a parallel tick chain.
    let inFlight = false

    const scheduleNext = () => {
      if (cancelled) return
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    const tick = async () => {
      if (cancelled || inFlight) return
      if (document.visibilityState !== 'visible') {
        // Don't reschedule — the visibilitychange handler will kick a poll
        // when the tab comes back.
        return
      }

      inFlight = true
      try {
        const trades = Object.values(usePendingTradesStore.getState().byOrderId)
        if (trades.length === 0) {
          scheduleNext()
          return
        }

        const addNotification = useNotificationsStore.getState().add
        const removePendingTrade = usePendingTradesStore.getState().remove

        await Promise.allSettled(
          trades.map(async (trade) => {
            let status: OrderStatusResponse | null
            try {
              status = await fetchOrderStatus(trade.marketId, trade.orderId)
            } catch {
              // Transient failure — we'll retry on the next tick. Swallowing
              // here keeps a dead engine from spamming console.error every 5s.
              return
            }
            if (!status || cancelled) return

            const current = status.status as OrderStatus
            const isTerminal = TERMINAL_STATUSES.has(current)
            const fillCount = status.fills.length
            const lastFillCount =
              lastFillCountRef.current.get(trade.orderId) ?? 0

            // Terminal status short-circuits partial-fill: a "filled" that
            // also has new fills shouldn't generate two separate bell entries
            // for the same settlement.
            if (
              !isTerminal &&
              current === 'partially_filled' &&
              fillCount > lastFillCount
            ) {
              addNotification({
                id: `${trade.orderId}-partially_filled-${fillCount}`,
                kind: 'partially_filled',
                orderId: trade.orderId,
                marketId: trade.marketId,
                filledAmountSats: status.filledAmountSats,
                remainingAmountSats: status.remainingAmountSats,
                occurredAt: Date.now(),
                read: false,
              })
              lastFillCountRef.current.set(trade.orderId, fillCount)
            }

            if (isTerminal) {
              const kind = current as NotificationKind
              addNotification({
                id: `${trade.orderId}-${kind}`,
                kind,
                orderId: trade.orderId,
                marketId: trade.marketId,
                filledAmountSats: status.filledAmountSats,
                remainingAmountSats: status.remainingAmountSats,
                occurredAt: Date.now(),
                read: false,
              })
              removePendingTrade(trade.orderId)
              lastFillCountRef.current.delete(trade.orderId)
            }
          }),
        )
      } finally {
        inFlight = false
      }

      scheduleNext()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // If a tick is already running, the `inFlight` guard in `tick()` will
      // turn this into a no-op; the running tick's own `scheduleNext()` will
      // take over.
      void tick()
    }

    // Kick off the first poll immediately so users don't wait 5s after load.
    void tick()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}

/**
 * Split a marketId of the form `{conditionId}-{outcomeName}` back into its
 * parts. `conditionId` is a lowercase hex string (32 bytes → 64 chars), so
 * splitting on the first hyphen is safe even if outcome names later grow
 * hyphens of their own. Returns `null` for malformed IDs so callers can fall
 * back to the raw string.
 */
export function splitMarketId(
  marketId: string,
): { conditionId: string; outcomeName: string } | null {
  const idx = marketId.indexOf('-')
  if (idx <= 0 || idx >= marketId.length - 1) return null
  return {
    conditionId: marketId.slice(0, idx),
    outcomeName: marketId.slice(idx + 1),
  }
}
