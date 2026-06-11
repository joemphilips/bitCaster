import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  onMarketStatusChanged,
  type MarketStatusChanged,
} from '@/lib/marketHub'
import { useNotificationsStore } from '@/stores/notifications'
import { useSettingsStore } from '@/stores/settings'
import {
  useLikedMarketStateStore,
  reconcileLikedMarketCloses,
} from '@/lib/likedMarketClose'
import { showWebNotification } from '@/lib/webNotifications'
import type { Market } from '@/types/market'

/**
 * P22 Link G2 — best-effort live `MarketStatusChanged` push while the market
 * detail page is mounted (SECONDARY trigger).
 *
 * The PRIMARY trigger is `useLikedMarketCloseReconcile` at the app root.  This
 * hook fires only while the user is actively viewing the market, providing a
 * low-latency `open -> closed` update that complements the boot/visibility
 * reconcile.
 *
 * Requirements:
 *   - `conditionId` must be joined to the MarketHub via `joinMarket` before
 *     status pushes are delivered.  `OrderBookSection` joins the market via
 *     `joinMarket(liveMarketId)` on mount, so this hook receives pushes as
 *     long as `OrderBookSection` is present.
 *   - Call `onRefresh` when a push arrives so the market state is refreshed in
 *     the parent component (e.g. `MarketDetailPage`).
 *   - Feed into the same notification + reconcile-state paths that
 *     `useLikedMarketCloseReconcile` uses, so the stored last-seen state stays
 *     consistent and the notification bell fires once regardless of which path
 *     detected the transition first.
 *
 * Idempotency: `useNotificationsStore.add` dedups on `id`
 * (`{marketId}-market_closed`), so a race where both this hook and the
 * background reconcile fire within the same session produces exactly one bell
 * entry.  `useLikedMarketStateStore` is updated here too so the reconcile sees
 * the up-to-date last-seen state and does not re-emit on the next
 * visibilitychange refetch.
 *
 * @param conditionId  Bare condition ID (no outcome suffix).  Pass `null` /
 *   `undefined` while loading — the effect is a no-op until it resolves.
 * @param onRefresh  Callback invoked when a status push arrives; the caller
 *   should trigger a background market detail refresh.
 */
export function useMarketStatusLive(
  conditionId: string | null | undefined,
  onRefresh: () => void,
): void {
  const { t } = useTranslation()

  useEffect(() => {
    if (!conditionId) return

    const handleStatus = (status: MarketStatusChanged) => {
      // Always ask the parent to refresh so the UI reflects the new state.
      onRefresh()

      if (status.state !== 'closed') return

      // Mirror the reconcile path: build a minimal Market shape, run it through
      // the pure reconcile logic so we re-use the same notification construction
      // and dedup semantics as the boot reconcile.
      const minimalMarket: Market = {
        id: conditionId,
        title: '',
        state: 'closed',
        type: 'yesno',
        currentOdds: { yes: 50, no: 50 },
        imageUrl: '',
        categoryTags: [],
        metaTags: [],
        volume: 0,
        liquidity: 0,
        liquiditySats: 0,
        volumeLifetimeSats: 0,
        closingDate: '',
        createdDate: '',
        activeSince: '',
        creatorFeePercent: 0,
        baseMarket: 'sats',
      }

      const lastSeen = useLikedMarketStateStore.getState().states
      const { notifications, nextStates } = reconcileLikedMarketCloses(
        [minimalMarket],
        lastSeen,
      )

      // Update the shared last-seen map so the background reconcile does not
      // re-fire after the next visibilitychange refetch.
      useLikedMarketStateStore.getState().setStates({
        ...lastSeen,
        ...nextStates,
      })

      if (notifications.length === 0) return

      const addNotification = useNotificationsStore.getState().add
      const optedIn = useSettingsStore.getState().likedMarketCloseNotifications

      for (const notification of notifications) {
        addNotification(notification)
        if (optedIn) {
          showWebNotification(t('notification.marketClosedTitle'), {
            body: t('notification.marketClosed', {
              market: notification.marketId,
            }),
            tag: notification.id,
          })
        }
      }
    }

    const unsubscribe = onMarketStatusChanged(conditionId, handleStatus)
    return unsubscribe
  }, [conditionId, onRefresh, t])
}
