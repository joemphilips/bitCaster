import { DEFAULT_SAT_MARKET_DIVISIBILITY } from "@bitcaster/client-sdk/marketUnits";
import { splitMarketId } from "@/lib/orderStatus";
import type { Notification } from "@/stores/notifications";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Text of one notification in the active language. The bell and the order
 * toast use it, so the same event reads the same in both places.
 */
export function formatNotificationText(n: Notification, t: Translate): string {
  const parts = splitMarketId(n.marketId);
  // Entries stored before titles were kept name the route outcome instead.
  const market = n.marketTitle ?? (parts ? parts.outcomeName : n.marketId);
  // Order amounts are share face subunits. Order entries stored before the
  // denominator was kept all come from sat markets with D = 1,000.
  const divisibility = n.divisibility ?? DEFAULT_SAT_MARKET_DIVISIBILITY;
  const shares = (amountSubunits: number) => {
    const count = amountSubunits / divisibility;
    return t("trade.shareCount", {
      count,
      formattedCount: count.toLocaleString(undefined, { maximumFractionDigits: 6 }),
    });
  };
  const filled = n.filledAmountSubunits ?? n.filledAmountSats ?? 0;
  const remaining = n.remainingAmountSubunits ?? n.remainingAmountSats ?? 0;
  if (n.kind === "accepted") {
    return t("notification.accepted", { market });
  }
  if (n.kind === "Filled") {
    return t("notification.filled", { amount: shares(filled), market });
  }
  if (n.kind === "partially_filled") {
    return t("notification.partiallyFilled", {
      amount: shares(filled),
      remaining: shares(remaining),
      market,
    });
  }
  if (n.kind === "Matched") {
    return t("notification.matched", { amount: shares(filled), market });
  }
  if (n.kind === "market_closed") {
    // Entries stored before titles were kept hold only the bare condition ID.
    return n.marketTitle
      ? t("notification.marketClosed", { market: n.marketTitle })
      : t("notification.marketClosedTitle");
  }
  if (n.kind === "position_won") {
    return t("notification.positionWon", { market });
  }
  if (n.kind === "position_lost") {
    return t("notification.positionLost", { market });
  }
  if (n.kind === "cancelled") {
    return t("notification.cancelled", { market });
  }
  if (n.kind === "expired") {
    return t("notification.expired", { market });
  }
  if (n.kind === "evicted_capacity") {
    return t("notification.evictedCapacity", { market });
  }
  if (n.kind === "rejected_capacity") {
    return t("notification.rejectedCapacity", { market });
  }
  return t("notification.failed", { market });
}
