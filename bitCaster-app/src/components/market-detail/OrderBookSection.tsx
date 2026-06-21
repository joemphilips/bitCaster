import { useTranslation } from 'react-i18next'
import type { OrderBook } from '@/types/market-detail'
import {
  formatMarketSubunits,
  formatPricePercent,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from '@bitcaster/client-sdk/marketUnits'
import { buildOrderBookDepthRows } from './orderBookViewModel'

interface OrderBookSectionProps {
  orderBook: OrderBook
  selectedOutcomeId?: string
  outcomeOrderBooks?: Record<string, OrderBook>
  onOutcomeChange?: (outcomeId: string) => void
  outcomes?: Array<{ id: string; label: string }>
  baseAsset?: string | null
  divisibility?: number | null
  title?: string
  outcomeId?: string
}

export function OrderBookSection({
  orderBook,
  selectedOutcomeId,
  outcomeOrderBooks,
  onOutcomeChange,
  outcomes,
  baseAsset: baseAssetInput,
  divisibility: divisibilityInput,
  title,
  outcomeId,
}: OrderBookSectionProps) {
  const { t } = useTranslation()
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const divisibility = normalizeMarketDivisibility(divisibilityInput)

  // Use outcome-specific order book if available
  const activeOrderBook = selectedOutcomeId && outcomeOrderBooks
    ? outcomeOrderBooks[selectedOutcomeId] || orderBook
    : orderBook
  const depthLimit = Number.isFinite(activeOrderBook.depthLimit) && activeOrderBook.depthLimit && activeOrderBook.depthLimit > 0
    ? Math.floor(activeOrderBook.depthLimit)
    : 5
  const visibleBids = activeOrderBook.bids.slice(0, depthLimit)
  const visibleAsks = activeOrderBook.asks.slice(0, depthLimit)
  const bidRows = buildOrderBookDepthRows(visibleBids, 'bid')
  const askRows = buildOrderBookDepthRows(visibleAsks, 'ask')
  const bidPlaceholders = Array.from({ length: Math.max(0, depthLimit - visibleBids.length) })
  const askPlaceholders = Array.from({ length: Math.max(0, depthLimit - visibleAsks.length) })

  return (
    <div
      data-testid="order-book-panel"
      data-outcome-id={outcomeId}
      className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {title ?? t('orderBook.title')}
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

      <div className="rounded-xl border border-slate-100 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 p-2">
        <div className="grid grid-cols-[1fr_auto] px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          <span>{t('orderBook.price')}</span>
          <span>{t('orderBook.amount')}</span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1 px-3 pt-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              {t('orderBook.bids')}
            </span>
          </div>
          {activeOrderBook.bids.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 px-3 py-2">{t('orderBook.noBids')}</p>
          ) : (
            <>
            {bidRows.map((row, i) => (
              <div
                key={`bid-row-${i}`}
                data-testid="order-book-bid-row"
                data-outcome-id={outcomeId}
                data-depth-percent={row.depthPercent}
                data-depth-side={row.side}
                className="relative overflow-hidden rounded-lg px-3 py-1.5 text-xs"
              >
                <div
                  data-testid="order-book-bid-depth-fill"
                  aria-hidden="true"
                  className="absolute inset-y-0 right-0 bg-emerald-500/10 dark:bg-emerald-500/20 transition-all"
                  style={{ width: `${row.depthPercent}%` }}
                />
                <div className="relative grid grid-cols-[1fr_auto] items-center gap-3">
                  <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                    {formatPricePercent(row.order.price, divisibility)}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300 font-mono">
                    {formatMarketSubunits(row.order.amount, baseAsset)}
                  </span>
                </div>
              </div>
            ))}
            {bidPlaceholders.map((_, i) => (
              <div
                key={`bid-row-placeholder-${i}`}
                data-testid="order-book-bid-placeholder"
                aria-hidden="true"
                className="h-7"
              />
            ))}
            </>
          )}

          <div className="flex items-center justify-center gap-2 rounded-lg bg-white/80 dark:bg-slate-800/70 px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{t('orderBook.spread')}</span>
            <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300">
              {formatPricePercent(activeOrderBook.spread, divisibility)}
            </span>
          </div>

          <div className="flex items-center gap-1 px-3 pt-1">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              {t('orderBook.asks')}
            </span>
          </div>
          {activeOrderBook.asks.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 px-3 py-2">{t('orderBook.noAsks')}</p>
          ) : (
            <>
            {askRows.map((row, i) => (
              <div
                key={`ask-row-${i}`}
                data-testid="order-book-ask-row"
                data-outcome-id={outcomeId}
                data-depth-percent={row.depthPercent}
                data-depth-side={row.side}
                className="relative overflow-hidden rounded-lg px-3 py-1.5 text-xs"
              >
                <div
                  data-testid="order-book-ask-depth-fill"
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-red-500/10 dark:bg-red-500/20 transition-all"
                  style={{ width: `${row.depthPercent}%` }}
                />
                <div className="relative grid grid-cols-[1fr_auto] items-center gap-3">
                  <span className="font-mono font-medium text-red-600 dark:text-red-400">
                    {formatPricePercent(row.order.price, divisibility)}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300 font-mono">
                    {formatMarketSubunits(row.order.amount, baseAsset)}
                  </span>
                </div>
              </div>
            ))}
            {askPlaceholders.map((_, i) => (
              <div
                key={`ask-row-placeholder-${i}`}
                data-testid="order-book-ask-placeholder"
                aria-hidden="true"
                className="h-7"
              />
            ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
