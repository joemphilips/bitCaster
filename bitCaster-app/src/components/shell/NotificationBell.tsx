import { useEffect, useState } from "react";
import { Bell, Check, X, TrendingUp, AlertCircle, Flag, Trophy, CircleX } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type Notification,
  selectUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications";
import { splitMarketId } from "@/lib/orderStatus";
import { portfolioClosedPositionHref } from "@/lib/portfolioRoute";
import { formatTimeAgo } from "@/lib/format";
import { formatAmount } from "@/lib/formatAmount";

interface NotificationBellProps {
  /** Called when the user picks a notification — parent handles routing. */
  onNavigate?: (href: string) => void;
  /** Visual variant: desktop inline button vs. mobile bottom-nav tile. */
  variant?: "desktop" | "mobile";
}

const BADGE_BASE_CLASSES =
  "absolute min-w-[16px] h-4 px-1 rounded-full bg-[#f7931a] text-white text-[10px] font-bold flex items-center justify-center";

// Empty-array singleton so the "panel closed" subscription returns a stable
// reference — otherwise every notification-store mutation would re-render the
// bell even while it's just displaying the badge.
const EMPTY_ITEMS: Notification[] = [];

export function NotificationBell({ onNavigate, variant = "desktop" }: NotificationBellProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const unreadCount = useNotificationsStore(selectUnreadCount);
  const items = useNotificationsStore((s) => (isOpen ? s.items : EMPTY_ITEMS));
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);

  // Mark everything read the moment the panel opens. The user has "seen"
  // them; the badge should reflect that even if they click away without
  // interacting with any individual entry.
  useEffect(() => {
    if (isOpen && unreadCount > 0) markAllRead();
  }, [isOpen, unreadCount, markAllRead]);

  const handleNotificationClick = (n: Notification) => {
    setIsOpen(false);
    const href = notificationHref(n);
    if (href !== null && onNavigate) onNavigate(href);
  };

  const badge =
    unreadCount > 0 ? (
      <span
        className={`${BADGE_BASE_CLASSES} ${
          variant === "mobile" ? "-top-1 -right-1.5" : "-top-0.5 -right-0.5"
        }`}
      >
        {unreadCount > 99 ? "99+" : unreadCount}
      </span>
    ) : null;

  const trigger =
    variant === "mobile" ? (
      <button
        onClick={() => setIsOpen(true)}
        className="flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 transition-colors relative w-full h-full"
      >
        <div className="relative">
          <Bell className="w-5 h-5" />
          {badge}
        </div>
        <span className="text-xs font-medium">{t("nav.notifications")}</span>
      </button>
    ) : (
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
        aria-label={t("nav.notifications")}
      >
        <Bell className="w-5 h-5" />
        {badge}
      </button>
    );

  return (
    <div className="relative">
      {trigger}

      {isOpen && (
        <>
          <div
            className={variant === "mobile" ? "fixed inset-0 z-[60]" : "fixed inset-0 z-40"}
            onClick={() => setIsOpen(false)}
          />
          <div
            className={
              variant === "mobile"
                ? "fixed inset-x-0 bottom-16 top-14 z-[60] bg-white dark:bg-slate-900 flex flex-col"
                : "absolute right-0 mt-2 w-80 max-h-[70vh] bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-50 overflow-hidden flex flex-col"
            }
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t("nav.notifications")}
              </h3>
              <div className="flex items-center gap-1">
                {items.length > 0 && (
                  <button
                    onClick={clear}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t("common.clearAll")}
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded"
                  aria-label={t("notification.close")}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {items.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t("notification.empty")}
                </div>
              ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        onClick={() => handleNotificationClick(n)}
                        className="w-full text-left px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-start gap-3"
                      >
                        <NotificationIcon kind={n.kind} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-900 dark:text-slate-100">
                            {formatNotification(n, t)}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {formatTimeAgo(n.occurredAt)}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NotificationIcon({ kind }: { kind: Notification["kind"] }) {
  if (kind === "accepted") {
    return <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />;
  }
  if (kind === "Filled") {
    return <Check className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />;
  }
  if (kind === "Matched" || kind === "partially_filled") {
    return <TrendingUp className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />;
  }
  if (kind === "market_closed") {
    return <Flag className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />;
  }
  if (kind === "position_lost") {
    return <CircleX className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />;
  }
  if (kind === "position_won") {
    return <Trophy className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />;
  }
  return <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />;
}

/**
 * Order entries open their market. A liked-market close stores the bare
 * condition ID. A held-position result opens that position in Portfolio.
 */
function notificationHref(n: Notification): string | null {
  switch (n.kind) {
    case "market_closed": {
      const conditionId = n.conditionId || n.marketId;
      return conditionId ? `/markets/${conditionId}` : null;
    }
    case "position_won":
    case "position_lost":
      return portfolioClosedPositionHref(n.marketId);
    default: {
      const parts = splitMarketId(n.marketId);
      return parts ? `/markets/${parts.conditionId}` : null;
    }
  }
}

function formatNotification(
  n: Notification,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts = splitMarketId(n.marketId);
  const marketLabel = parts ? parts.outcomeName : n.marketId;
  const filled = n.filledAmountSubunits ?? n.filledAmountSats ?? 0;
  const remaining = n.remainingAmountSubunits ?? n.remainingAmountSats ?? 0;
  if (n.kind === "accepted") {
    return t("notification.accepted", { market: marketLabel });
  }
  if (n.kind === "Filled") {
    return t("notification.filled", { amount: formatAmount(filled, n.unit), market: marketLabel });
  }
  if (n.kind === "partially_filled") {
    return t("notification.partiallyFilled", {
      amount: formatAmount(filled, n.unit),
      remaining: formatAmount(remaining, n.unit),
      market: marketLabel,
    });
  }
  if (n.kind === "Matched") {
    return t("notification.matched", { amount: formatAmount(filled, n.unit), market: marketLabel });
  }
  if (n.kind === "market_closed") {
    // Entries stored before titles were kept hold only the bare condition ID.
    return n.marketTitle
      ? t("notification.marketClosed", { market: n.marketTitle })
      : t("notification.marketClosedTitle");
  }
  if (n.kind === "position_won") {
    return t("notification.positionWon", { market: n.marketTitle ?? marketLabel });
  }
  if (n.kind === "position_lost") {
    return t("notification.positionLost", { market: n.marketTitle ?? marketLabel });
  }
  if (n.kind === "cancelled") {
    return t("notification.cancelled", { market: marketLabel });
  }
  if (n.kind === "expired") {
    return t("notification.expired", { market: marketLabel });
  }
  if (n.kind === "evicted_capacity") {
    return t("notification.evictedCapacity", { market: marketLabel });
  }
  if (n.kind === "rejected_capacity") {
    return t("notification.rejectedCapacity", { market: marketLabel });
  }
  return t("notification.failed", { market: marketLabel });
}
