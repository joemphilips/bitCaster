import { useEffect, useState } from 'react'
import { Bell, Check, X, TrendingUp, AlertCircle, Flag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  type Notification,
  selectUnreadCount,
  useNotificationsStore,
} from '@/stores/notifications'
import { splitMarketId } from '@/lib/orderStatus'
import { formatTimeAgo } from '@/lib/format'

interface NotificationBellProps {
  /** Called when the user picks a notification — parent handles routing. */
  onNavigate?: (href: string) => void
  /** Visual variant: desktop inline button vs. mobile bottom-nav tile. */
  variant?: 'desktop' | 'mobile'
}

const BADGE_BASE_CLASSES =
  'absolute min-w-[16px] h-4 px-1 rounded-full bg-[#f7931a] text-white text-[10px] font-bold flex items-center justify-center'

// Empty-array singleton so the "panel closed" subscription returns a stable
// reference — otherwise every notification-store mutation would re-render the
// bell even while it's just displaying the badge.
const EMPTY_ITEMS: Notification[] = []

export function NotificationBell({
  onNavigate,
  variant = 'desktop',
}: NotificationBellProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const unreadCount = useNotificationsStore(selectUnreadCount)
  const items = useNotificationsStore((s) => (isOpen ? s.items : EMPTY_ITEMS))
  const markAllRead = useNotificationsStore((s) => s.markAllRead)
  const clear = useNotificationsStore((s) => s.clear)

  // Mark everything read the moment the panel opens. The user has "seen"
  // them; the badge should reflect that even if they click away without
  // interacting with any individual entry.
  useEffect(() => {
    if (isOpen && unreadCount > 0) markAllRead()
  }, [isOpen, unreadCount, markAllRead])

  const handleNotificationClick = (n: Notification) => {
    setIsOpen(false)
    const parts = splitMarketId(n.marketId)
    if (parts && onNavigate) onNavigate(`/markets/${parts.conditionId}`)
  }

  const badge =
    unreadCount > 0 ? (
      <span
        className={`${BADGE_BASE_CLASSES} ${
          variant === 'mobile' ? '-top-1 -right-1.5' : '-top-0.5 -right-0.5'
        }`}
      >
        {unreadCount > 99 ? '99+' : unreadCount}
      </span>
    ) : null

  const trigger =
    variant === 'mobile' ? (
      <button
        onClick={() => setIsOpen(true)}
        className="flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 transition-colors relative w-full h-full"
      >
        <div className="relative">
          <Bell className="w-5 h-5" />
          {badge}
        </div>
        <span className="text-xs font-medium">{t('nav.notifications')}</span>
      </button>
    ) : (
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {badge}
      </button>
    )

  return (
    <div className="relative">
      {trigger}

      {isOpen && (
        <>
          <div
            className={variant === 'mobile' ? 'fixed inset-0 z-[60]' : 'fixed inset-0 z-40'}
            onClick={() => setIsOpen(false)}
          />
          <div
            className={
              variant === 'mobile'
                ? 'fixed inset-x-0 bottom-16 top-14 z-[60] bg-white dark:bg-slate-900 flex flex-col'
                : 'absolute right-0 mt-2 w-80 max-h-[70vh] bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-50 overflow-hidden flex flex-col'
            }
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('nav.notifications')}
              </h3>
              <div className="flex items-center gap-1">
                {items.length > 0 && (
                  <button
                    onClick={clear}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t('common.clearAll')}
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded"
                  aria-label="Close notifications"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {items.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t('notification.empty')}
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
  )
}

function NotificationIcon({ kind }: { kind: Notification['kind'] }) {
  if (kind === 'accepted') {
    return <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
  }
  if (kind === 'filled') {
    return <Check className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
  }
  if (kind === 'matched' || kind === 'partially_filled') {
    return <TrendingUp className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
  }
  if (kind === 'market_closed') {
    return <Flag className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
  }
  return <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
}

function formatNotification(n: Notification, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const parts = splitMarketId(n.marketId)
  const marketLabel = parts ? parts.outcomeName : n.marketId
  if (n.kind === 'accepted') {
    return t('notification.accepted', { market: marketLabel })
  }
  if (n.kind === 'filled') {
    return t('notification.filled', { sats: n.filledAmountSats, market: marketLabel })
  }
  if (n.kind === 'partially_filled') {
    return t('notification.partiallyFilled', { sats: n.filledAmountSats, remaining: n.remainingAmountSats, market: marketLabel })
  }
  if (n.kind === 'matched') {
    return t('notification.matched', { sats: n.filledAmountSats, market: marketLabel })
  }
  if (n.kind === 'market_closed') {
    return t('notification.marketClosed', { market: n.finalOutcome ?? marketLabel })
  }
  return t('notification.cancelled', { market: marketLabel })
}
