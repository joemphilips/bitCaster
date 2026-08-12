import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLikedMarkets } from "@/hooks/useLikedMarkets";
import { useNotificationsStore } from "@/stores/notifications";
import { useSettingsStore } from "@/stores/settings";
import { useLikedMarketStateStore, reconcileLikedMarketCloses } from "@/lib/likedMarketClose";
import { showWebNotification } from "@/lib/webNotifications";

/**
 * P22 Link G2 — liked-market close reconcile (PRIMARY trigger).
 *
 * Mount once at the app root (alongside `useBookmarkSync` etc.). Watches the
 * catalogue `state` of the user's bookmarked markets and, on an `open ->
 * closed` transition, drops a `market_closed` bell notification. When the user
 * has opted into close notifications (Settings, G3) and the browser has
 * granted permission, it also fires a client-side Web `Notification`.
 *
 * The data comes from `useLikedMarkets` (no extra fetch); on
 * `visibilitychange` we ask it to refetch so a backgrounded tab catches up the
 * moment the user returns. There is no polling loop.
 */
export function useLikedMarketCloseReconcile(): void {
  const { t } = useTranslation();
  const { markets, loading, error, refetch } = useLikedMarkets();

  // Refetch when the tab becomes visible again so we reconcile against fresh
  // catalogue state rather than whatever we loaded on the last foreground.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);

  // Guard so the same markets array (referentially churning across renders)
  // doesn't re-run the reconcile when nothing changed.
  const lastReconciledRef = useRef<string>("");

  useEffect(() => {
    if (loading || error) return;
    if (markets.length === 0) return;

    const signature = markets.map((m) => `${m.id}:${m.state}`).join("|");
    if (signature === lastReconciledRef.current) return;
    lastReconciledRef.current = signature;

    const lastSeen = useLikedMarketStateStore.getState().states;
    const { notifications, nextStates } = reconcileLikedMarketCloses(markets, lastSeen);

    useLikedMarketStateStore.getState().setStates(nextStates);

    if (notifications.length === 0) return;

    const addNotification = useNotificationsStore.getState().add;
    const optedIn = useSettingsStore.getState().likedMarketCloseNotifications;

    for (const notification of notifications) {
      addNotification(notification);
      if (optedIn) {
        const market = markets.find((m) => m.id === notification.marketId);
        showWebNotification(t("notification.marketClosedTitle"), {
          body: t("notification.marketClosed", {
            market: market?.title ?? notification.finalOutcome ?? notification.marketId,
          }),
          tag: notification.id,
        });
      }
    }
  }, [markets, loading, error, t]);
}
