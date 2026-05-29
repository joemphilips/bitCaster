import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Market } from '@/types/market'
import type { Notification } from '@/stores/notifications'

/**
 * Liked-market close detection (P22 Link G2).
 *
 * A *liked* market is, by definition, not currently being viewed, so the
 * client is not joined to its MarketHub group and the live
 * `MarketStatusChanged` push won't reach it. The PRIMARY trigger is therefore
 * a reconcile on the data `useLikedMarkets` already fetches — on app boot and
 * on `visibilitychange`. We diff each bookmarked market's catalogue `state`
 * against the last state we recorded; an `open -> closed` transition emits a
 * `market_closed` notification. There is no polling loop — the reconcile rides
 * the existing fetch.
 */

interface LastSeenStatesState {
  /** marketId -> last observed catalogue state. */
  states: Record<string, Market['state']>
  /** Replace the whole map (one write per reconcile). */
  setStates: (next: Record<string, Market['state']>) => void
  clear: () => void
}

export const useLikedMarketStateStore = create<LastSeenStatesState>()(
  persist(
    (set) => ({
      states: {},
      setStates: (next) => set({ states: next }),
      clear: () => set({ states: {} }),
    }),
    { name: 'bitcaster-liked-market-states' },
  ),
)

/**
 * Pure reconcile: given the markets currently resolved for the user's
 * bookmarks and the last-seen state map, return the `market_closed`
 * notifications to emit and the next state map to persist.
 *
 * Only `open -> closed` transitions produce a notification. A market seen as
 * `closed` for the first time (no prior record) does NOT notify — we only
 * have a record once the user has seen it open, so a freshly-bookmarked
 * already-closed market is silent. This avoids a burst of stale notifications
 * the first time the feature ships or when a user imports an old bookmark set.
 *
 * Notifications dedupe on `{marketId}-market_closed`, so a market that stays
 * closed across reconciles never re-fires (the store also dedups by id).
 */
export function reconcileLikedMarketCloses(
  markets: Market[],
  lastSeen: Record<string, Market['state']>,
  now = Date.now(),
): { notifications: Notification[]; nextStates: Record<string, Market['state']> } {
  const notifications: Notification[] = []
  const nextStates: Record<string, Market['state']> = {}

  for (const market of markets) {
    const previous = lastSeen[market.id]
    nextStates[market.id] = market.state

    if (previous === 'open' && market.state === 'closed') {
      // `market.id` is the bare conditionId (markets list maps
      // `id = entry.conditionId`). The winning outcome is NOT encoded in the
      // id — it comes from the oracle attestation — so we do not try to derive
      // `finalOutcome` here; the catalogue/portfolio surface shows it on click.
      notifications.push({
        id: `${market.id}-market_closed`,
        kind: 'market_closed',
        orderId: '',
        marketId: market.id,
        filledAmountSats: 0,
        remainingAmountSats: 0,
        occurredAt: now,
        read: false,
        conditionId: market.id,
        closedAt: now,
      })
    }
  }

  return { notifications, nextStates }
}
