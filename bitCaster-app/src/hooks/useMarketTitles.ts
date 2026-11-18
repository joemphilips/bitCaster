import { useMemo } from "react";
import { splitMarketId } from "@/lib/orderStatus";
import { useNotificationsStore } from "@/stores/notifications";

/** Order notifications keep the market title of the order, newest first. */
export function useMarketTitles(): ReadonlyMap<string, string> {
  const items = useNotificationsStore((state) => state.items);
  return useMemo(() => {
    const titles = new Map<string, string>();
    for (const item of items)
      if (item.marketTitle && !titles.has(item.marketId))
        titles.set(item.marketId, item.marketTitle);
    return titles;
  }, [items]);
}

/** Without a stored title, name the outcome, as an old order notification does. */
export function marketLabel(marketId: string, titles: ReadonlyMap<string, string>): string {
  return titles.get(marketId) ?? splitMarketId(marketId)?.outcomeName ?? marketId;
}
