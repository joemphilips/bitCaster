import { useEffect, useMemo, useState } from "react";
import { Bell, Check, X, TrendingUp, AlertCircle, Flag, Trophy, CircleX } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type Notification,
  type NotificationKind,
  selectUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications";
import {
  isFinalFunds,
  offersRetry,
  showsOrderFailure,
  useOrderFailureNotices,
  type OrderFailureNotice,
} from "@/stores/orderFailureNotices";
import { requestTradeRetry } from "@/stores/tradeRetryRequest";
import { useWalletStore } from "@/stores/wallet";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { fundsSentence, orderFailureReasonText } from "@/lib/orderFailureText";
import { useCtfRangeOrderLocks } from "@/hooks/useCtfRangeOrderLocks";
import { assertNever } from "@/lib/enumDiscipline";
import { splitMarketId } from "@/lib/orderStatus";
import { portfolioClosedPositionHref } from "@/lib/portfolioRoute";
import { formatTimeAgo } from "@/lib/format";
import { formatNotificationText, notificationMarketName } from "@/lib/notificationText";

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
const NO_FAILURES: Readonly<Record<string, OrderFailureNotice>> = {};

export function NotificationBell({ onNavigate, variant = "desktop" }: NotificationBellProps) {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const unreadCount = useNotificationsStore(selectUnreadCount);
  const items = useNotificationsStore((s) => (isOpen ? s.items : EMPTY_ITEMS));
  const notices = useOrderFailureNotices((s) => (isOpen ? s.notices : NO_FAILURES));
  const failures = useMemo(
    () =>
      new Map(
        Object.values(notices)
          .filter(showsOrderFailure)
          .map((notice) => [notice.orderId, notice] as const),
      ),
    [notices],
  );
  // Only the journal of the current wallet can name the locked funds.
  const scopeId = browserWalletScopeIdFromMnemonic(useWalletStore((s) => s.mnemonic));
  const pendingOperations = useMemo(
    () =>
      [...failures.values()]
        .filter((notice) => notice.scopeId === scopeId && !isFinalFunds(notice.funds))
        .map((notice) => notice.operationId),
    [failures, scopeId],
  );
  const locks = useCtfRangeOrderLocks(scopeId, pendingOperations);
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

  /** Retry opens the market page first; that page prefills the trade form. */
  const handleRetry = (failure: OrderFailureNotice) => {
    const lock = locks?.[failure.operationId];
    if (lock === undefined) return;
    setIsOpen(false);
    requestTradeRetry(lock.retry);
    onNavigate?.(`/markets/${lock.retry.conditionId}`);
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
                  {items.map((n) => {
                    const failure = carriesFailureReason(n.kind)
                      ? failures.get(n.orderId)
                      : undefined;
                    const lock =
                      failure === undefined ? null : (locks?.[failure.operationId] ?? null);
                    const pending = failure !== undefined && !isFinalFunds(failure.funds);
                    const reason =
                      failure === undefined ? null : orderFailureReasonText(t, failure.reason);
                    // A pending refund of this wallet waits for the journal read.
                    const funds =
                      failure === undefined ||
                      (pending && failure.scopeId === scopeId && locks === undefined)
                        ? null
                        : fundsSentence(t, failure.funds, { lock, locale: i18n.language });
                    return (
                      <li key={n.id}>
                        <button
                          onClick={() => handleNotificationClick(n)}
                          className="w-full text-left px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-start gap-3"
                        >
                          <NotificationIcon kind={n.kind} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-slate-900 dark:text-slate-100">
                              {formatNotificationText(n, t)}
                            </div>
                            {reason !== null && (
                              <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                                {reason}
                              </div>
                            )}
                            {funds !== null && (
                              <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                                {funds}
                              </div>
                            )}
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                              {formatTimeAgo(n.occurredAt)}
                            </div>
                          </div>
                        </button>
                        {failure !== undefined &&
                          pending &&
                          lock !== null &&
                          offersRetry(failure.reason) && (
                            <div className="-mt-2 pb-1 pl-11 pr-4">
                              <button
                                type="button"
                                className="-ml-2 inline-flex min-h-11 items-center rounded px-2 text-sm font-medium text-slate-900 underline hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-700"
                                aria-label={t("settlementProgress.retryTrade", {
                                  market: notificationMarketName(n),
                                })}
                                onClick={() => handleRetry(failure)}
                              >
                                {t("settlementProgress.retry")}
                              </button>
                            </div>
                          )}
                      </li>
                    );
                  })}
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
 * Only the entry that ends an order without a trade shows the failure notice,
 * as the panel does: a failed settlement, a cancelled FOK, an expired order,
 * or an order that the order book capacity removed or refused.
 */
function carriesFailureReason(kind: NotificationKind): boolean {
  switch (kind) {
    case "Failed":
    case "cancelled":
    case "expired":
    case "evicted_capacity":
    case "rejected_capacity":
      return true;
    case "accepted":
    case "Matched":
    case "Filled":
    case "partially_filled":
    case "market_closed":
    case "position_won":
    case "position_lost":
      return false;
    default:
      return assertNever(kind);
  }
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
