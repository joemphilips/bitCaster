import { useMemo } from "react";
import { splitMarketId } from "@/lib/orderStatus";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import { usePendingTradesStore, type PendingTrade } from "@/stores/pendingTrades";

/**
 * The market titles that this browser knows, by market. A pending trade keeps
 * the title of its order; an order notification keeps it after the order ends.
 */
export function useMarketTitles(): ReadonlyMap<string, string> {
  const items = useNotificationsStore((state) => state.items);
  const pending = usePendingTradesStore((state) => state.byOrderId);
  return useMemo(() => marketTitles(items, Object.values(pending)), [items, pending]);
}

/** The market title of one order, read once, for example when a failure is recorded. */
export function knownMarketTitle(orderId: string, marketId: string): string | null {
  const trade = usePendingTradesStore.getState().byOrderId[orderId];
  if (trade?.marketTitle) return trade.marketTitle;
  const items = useNotificationsStore.getState().items;
  const own = items.find((item) => item.orderId === orderId && item.marketTitle);
  return own?.marketTitle ?? marketTitles(items, []).get(marketId) ?? null;
}

/** A stored title wins; without one, name the outcome, as an old order notification does. */
export function marketLabel(
  marketId: string,
  titles: ReadonlyMap<string, string>,
  storedTitle: string | null = null,
): string {
  return storedTitle ?? titles.get(marketId) ?? splitMarketId(marketId)?.outcomeName ?? marketId;
}

function marketTitles(
  items: readonly Notification[],
  pending: readonly PendingTrade[],
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const trade of pending)
    if (trade.marketTitle && !titles.has(trade.marketId))
      titles.set(trade.marketId, trade.marketTitle);
  for (const item of items)
    if (item.marketTitle && !titles.has(item.marketId)) titles.set(item.marketId, item.marketTitle);
  return titles;
}
