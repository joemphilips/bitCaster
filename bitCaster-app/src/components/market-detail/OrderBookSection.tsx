import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrderBook } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'
import { mapSnapshotToOrderBook } from '@/lib/markets'
import {
  joinMarket,
  leaveMarket,
  onOrderBookUpdated,
} from '@/lib/marketHub'

interface OrderBookSectionProps {
  orderBook: OrderBook
  selectedOutcomeId?: string
  outcomeOrderBooks?: Record<string, OrderBook>
  onOutcomeChange?: (outcomeId: string) => void
  outcomes?: Array<{ id: string; label: string }>
  /**
   * Fully-qualified per-outcome market ID (`{conditionId}-{outcomeName}`).
   * When present, the component subscribes to live `OrderBookUpdated`
   * pushes from MarketHub for this market. Initial snapshot comes from the
   * `orderBook` prop (fetched by the parent), so users see depth before
   * the first push lands.
   *
   * Omit to render a static book (e.g. historical view, tests).
   */
  liveMarketId?: string
}

export function OrderBookSection({
  orderBook,
  selectedOutcomeId,
  outcomeOrderBooks,
  onOutcomeChange,
  outcomes,
  liveMarketId,
}: OrderBookSectionProps) {
  const { t } = useTranslation()

  // Local mirror of the prop — updated in place when a MarketHub push lands.
  // Falls back to the initial `orderBook` prop until the first push arrives,
  // so users never see an empty book while the subscription handshake runs.
  const [liveOrderBook, setLiveOrderBook] = useState<OrderBook>(orderBook)
  useEffect(() => {
    // Reset to the fresh parent-provided snapshot whenever the upstream
    // `orderBook` prop changes (e.g. after a manual refetch) — otherwise a
    // stale live-book from the previous market would linger.
    setLiveOrderBook(orderBook)
  }, [orderBook])

  useEffect(() => {
    if (!liveMarketId) return
    let cancelled = false

    const unsubscribe = onOrderBookUpdated(liveMarketId, (snapshot) => {
      if (cancelled) return
      setLiveOrderBook(mapSnapshotToOrderBook(snapshot))
    })

    // JoinMarket sends an initial snapshot back to the caller — we apply it
    // via the handler above, which also handles every subsequent push.
    joinMarket(liveMarketId).catch((err) => {
      console.warn('[OrderBookSection] joinMarket failed:', err)
    })

    return () => {
      cancelled = true
      unsubscribe()
      void leaveMarket(liveMarketId)
    }
  }, [liveMarketId])

  // Use outcome-specific order book if available
  const activeOrderBook = selectedOutcomeId && outcomeOrderBooks
    ? outcomeOrderBooks[selectedOutcomeId] || liveOrderBook
    : liveOrderBook

  const maxTotal = Math.max(
    ...activeOrderBook.bids.map((b) => b.total),
    ...activeOrderBook.asks.map((a) => a.total),
    1
  )

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {t('orderBook.title')}
        </h3>

        {/* Outcome Selector for Categorical Markets */}
        {outcomes && outcomes.length > 0 && (
          <select
            value={selectedOutcomeId || outcomes[0]?.id}
            onChange={(e) => onOutcomeChange?.(e.target.value)}
            className="text-sm bg-slate-100 dark:bg-slate-700 border-0 rounded-lg px-3 py-1.5 text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-blue-500"
          >
            {outcomes.map((outcome) => (
              <option key={outcome.id} value={outcome.id}>
                {outcome.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Spread Indicator */}
      <div className="flex items-center justify-center gap-2 py-2 mb-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('orderBook.spread')}</span>
        <span className="text-sm font-mono font-medium text-slate-700 dark:text-slate-300">
          {activeOrderBook.spread.toFixed(1)}%
        </span>
      </div>

      {/* Depth Visualization */}
      <div className="relative h-24 mb-4 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-900">
        {/* Bids (Left - Green) */}
        <div className="absolute inset-y-0 left-0 w-1/2 flex flex-col justify-end">
          {activeOrderBook.bids.slice(0, 4).map((bid, i) => {
            const width = (bid.total / maxTotal) * 100
            return (
              <div
                key={`bid-${i}`}
                className="h-1/4 flex items-center justify-end pr-2"
              >
                <div
                  className="h-full bg-emerald-500/30 dark:bg-emerald-500/40 rounded-l transition-all"
                  style={{ width: `${width}%` }}
                />
              </div>
            )
          })}
        </div>

        {/* Asks (Right - Red) */}
        <div className="absolute inset-y-0 right-0 w-1/2 flex flex-col justify-end">
          {activeOrderBook.asks.slice(0, 4).map((ask, i) => {
            const width = (ask.total / maxTotal) * 100
            return (
              <div
                key={`ask-${i}`}
                className="h-1/4 flex items-center justify-start pl-2"
              >
                <div
                  className="h-full bg-red-500/30 dark:bg-red-500/40 rounded-r transition-all"
                  style={{ width: `${width}%` }}
                />
              </div>
            )
          })}
        </div>

        {/* Center Line */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-300 dark:bg-slate-600" />
      </div>

      {/* Order Tables */}
      <div className="grid grid-cols-2 gap-4">
        {/* Bids */}
        <div>
          <div className="flex items-center gap-1 mb-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              {t('orderBook.bids')}
            </span>
          </div>
          <div className="space-y-1">
            {activeOrderBook.bids.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-slate-500 py-2">{t('orderBook.noBids')}</p>
            ) : (
              activeOrderBook.bids.slice(0, 5).map((bid, i) => (
                <div
                  key={`bid-row-${i}`}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="font-mono text-emerald-600 dark:text-emerald-400">
                    {bid.price}%
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 font-mono">
                    {formatBtc(bid.amount)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Asks */}
        <div>
          <div className="flex items-center gap-1 mb-2">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              {t('orderBook.asks')}
            </span>
          </div>
          <div className="space-y-1">
            {activeOrderBook.asks.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-slate-500 py-2">{t('orderBook.noAsks')}</p>
            ) : (
              activeOrderBook.asks.slice(0, 5).map((ask, i) => (
                <div
                  key={`ask-row-${i}`}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="font-mono text-red-600 dark:text-red-400">
                    {ask.price}%
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 font-mono">
                    {formatBtc(ask.amount)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
