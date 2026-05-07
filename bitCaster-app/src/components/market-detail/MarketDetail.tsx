import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketDetailProps } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'
import { useMarketState } from '@/hooks/useMarketState'
import { MarketHeader } from './MarketHeader'
import { TradingPanel } from './TradingPanel'
import { PriceChart } from './PriceChart'
import { OrderBookSection } from './OrderBookSection'
import { ResolutionInfo } from './ResolutionInfo'
import { ActivityFeed } from './ActivityFeed'
import { RelatedMarkets } from './RelatedMarkets'
import { CommentSection } from './CommentSection'
import { WalletRequiredModal } from '@/components/shared/WalletRequiredModal'

function formatNumericPrice(value: number, unit: string): string {
  if (unit === 'USD') return `$${value.toLocaleString()}`
  return `${value.toLocaleString()} ${unit}`
}

function computeCurrentDisplay(market: MarketDetailProps['market']): string {
  const isResolved = market.resolution.status === 'resolved'

  if (market.type === 'numeric') {
    if (isResolved && market.attestedValue != null) {
      return `Resolved: ${formatNumericPrice(market.attestedValue, market.unit)}`
    }
    return formatNumericPrice(market.currentPrice, market.unit)
  }

  if (isResolved && market.resolution.finalOutcome) {
    return `Resolved: ${market.resolution.finalOutcome}`
  }

  if (market.type === 'yesno') {
    return `${market.currentOdds.yes.toFixed(1)}%`
  }

  if (market.type === 'categorical') {
    const sorted = [...market.outcomes].sort((a, b) => b.odds - a.odds)
    const leader = sorted[0]
    if (leader) {
      return `${leader.label} ${leader.odds.toFixed(1)}%`
    }
    return ''
  }

  return ''
}

export function MarketDetail({
  market,
  chartTimeframe,
  chartType,
  tradeSelection,
  tradeAmount,
  tradePreview,
  tradeSide,
  orderType,
  limitOrderPreview,
  limitPrice,
  onTimeframeChange,
  onChartTypeChange,
  onTradeSelect,
  onTradeClear,
  onAmountChange,
  onTradeConfirm,
  tradeSubmitStatus,
  onShare,
  onCommentPost,
  onCommentLike,
  onLoadMoreTrades,
  onLoadMoreComments,
  onRelatedMarketClick,
  onCreatorClick,
  onTradeSideChange,
  onOrderTypeChange,
  onLimitPriceChange,
  userHoldings,
  walletBalanceSats,
  walletReady = true,
}: MarketDetailProps) {
  const { t } = useTranslation()
  const [showWalletModal, setShowWalletModal] = useState(false)
  // Get outcomes for categorical markets
  const outcomes = market.type === 'categorical' ? market.outcomes : undefined

  // Get outcome-specific data for categorical markets
  const outcomePriceHistories = market.type === 'categorical' ? market.outcomePriceHistories : undefined

  // Compute current display for price chart
  const currentDisplay = computeCurrentDisplay(market)

  // Determine market state per ADR-009 (Amendment 2026-05-04 — detail-page
  // compliance). The detail page reads engine `state` for lifecycle
  // (Open / Closed) and reduces mintd's `attestation.*` to outcome metadata
  // (which outcome the oracle attested, when, whether the announcement
  // window expired). `isResolved` keeps the existing semantics for the
  // resolution-info badge — surfaced when mintd reports a resolved outcome,
  // independent of the engine's lifecycle state. `isTradingEnabled` is the
  // single closed-state gate consulted across the trade and deposit
  // affordances; it follows the engine.
  const isResolved = market.resolution.status === 'resolved'
  const marketState = useMarketState(market.state)
  const isTradingEnabled = marketState === 'Open'

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      {/* Desktop Layout: Two Columns (single column when resolved) */}
      <div className="max-w-7xl mx-auto">
        <div className={`${isTradingEnabled ? 'lg:grid lg:grid-cols-[1fr_380px] lg:gap-6' : ''} p-4 lg:p-6`}>
          {/* Left Column - Main Content */}
          <div className="space-y-6">
            {/* Header */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <MarketHeader
                market={market}
                onShare={onShare}
                onCreatorClick={onCreatorClick}
              />
            </div>

            {/* Resolution Info (shown immediately after header for resolved markets) */}
            {isResolved && (
              <ResolutionInfo resolution={market.resolution} />
            )}

            {/* Mobile: Trading Panel (shown at top on mobile, only for open markets) */}
            {isTradingEnabled && (
              <div className="lg:hidden">
                <TradingPanel
                  market={market}
                  tradeSelection={tradeSelection}
                  tradeAmount={tradeAmount}
                  tradePreview={tradePreview}
                  tradeSide={tradeSide}
                  orderType={orderType}
                  limitOrderPreview={limitOrderPreview}
                  limitPrice={limitPrice}
                  onTradeSelect={onTradeSelect}
                  onTradeClear={onTradeClear}
                  onAmountChange={onAmountChange}
                  onTradeConfirm={onTradeConfirm}
                  tradeSubmitStatus={tradeSubmitStatus}
                  onCommentPost={onCommentPost}
                  onTradeSideChange={onTradeSideChange}
                  onOrderTypeChange={onOrderTypeChange}
                  onLimitPriceChange={onLimitPriceChange}
                  userHoldings={userHoldings}
                  walletBalanceSats={walletBalanceSats}
                  walletReady={walletReady}
                />
              </div>
            )}

            {/* Price Chart */}
            <PriceChart
              priceHistory={market.priceHistory}
              chartTimeframe={chartTimeframe}
              chartType={chartType}
              onTimeframeChange={onTimeframeChange}
              onChartTypeChange={onChartTypeChange}
              outcomePriceHistories={outcomePriceHistories}
              outcomes={outcomes}
              currentDisplay={currentDisplay}
              comments={market.comments}
              unit={market.type === 'numeric' ? market.unit : undefined}
            />

            {/* Order Book — only for binary yes/no markets in Phase 1.
                `liveMarketId` threads the per-outcome market ID through to
                the SignalR subscription so the book updates live without
                a page reload. The initial snapshot comes via `orderBook`
                (prefetched in MarketDetailPage).
                Closed markets render the order book frozen (no live
                subscription) so users still get last-traded context — see
                ADR-010 P4.1. */}
            {market.type === 'yesno' && (
              <div className="relative" data-testid="order-book-section">
                {marketState === 'Closed' && (
                  <span
                    data-testid="market-closed-badge"
                    className="absolute right-3 top-3 z-10 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold uppercase text-rose-600 dark:text-rose-400"
                  >
                    {t('market.closed')}
                  </span>
                )}
                <OrderBookSection
                  orderBook={market.orderBook}
                  liveMarketId={isTradingEnabled ? `${market.id}-Yes` : undefined}
                />
              </div>
            )}

            {/* Resolution Info (in normal position for open markets) */}
            {!isResolved && (
              <ResolutionInfo resolution={market.resolution} />
            )}

            {/* Activity Feed (Trades only) */}
            <ActivityFeed
              trades={market.recentTrades}
              onLoadMoreTrades={onLoadMoreTrades}
            />

            {/* Related Markets */}
            <RelatedMarkets
              markets={market.relatedMarkets}
              onMarketClick={onRelatedMarketClick}
            />

            {/* Comments */}
            <CommentSection
              comments={market.comments}
              onCommentLike={onCommentLike}
              onLoadMoreComments={onLoadMoreComments}
            />
          </div>

          {/* Right Column - Trading Panel (sticky on desktop, only for open markets) */}
          {isTradingEnabled && (
            <div className="hidden lg:block">
              <div className="sticky top-6">
                <TradingPanel
                  market={market}
                  tradeSelection={tradeSelection}
                  tradeAmount={tradeAmount}
                  tradePreview={tradePreview}
                  tradeSide={tradeSide}
                  orderType={orderType}
                  limitOrderPreview={limitOrderPreview}
                  limitPrice={limitPrice}
                  onTradeSelect={onTradeSelect}
                  onTradeClear={onTradeClear}
                  onAmountChange={onAmountChange}
                  onTradeConfirm={onTradeConfirm}
                  tradeSubmitStatus={tradeSubmitStatus}
                  onCommentPost={onCommentPost}
                  onTradeSideChange={onTradeSideChange}
                  onOrderTypeChange={onOrderTypeChange}
                  onLimitPriceChange={onLimitPriceChange}
                  userHoldings={userHoldings}
                  walletBalanceSats={walletBalanceSats}
                  walletReady={walletReady}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mobile: Sticky Bottom Trade Bar (only for open markets) */}
      {isTradingEnabled && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 safe-area-pb">
          {tradeSelection ? (
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tradeSelection.side.toUpperCase()}
                  {tradeSelection.outcomeId && ` - ${tradeSelection.outcomeId}`}
                </p>
                <p className="text-sm font-medium text-slate-900 dark:text-white">
                  {tradeAmount > 0 ? formatBtc(tradeAmount) : t('trade.enterAmount')}
                </p>
              </div>
              <button
                onClick={onTradeClear}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  if (!walletReady) {
                    setShowWalletModal(true)
                    return
                  }
                  onTradeConfirm?.()
                }}
                disabled={walletReady && (!tradeAmount || tradeAmount <= 0)}
                className={`px-6 py-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed ${
                  !walletReady
                    ? 'bg-[#f7931a] hover:bg-[#e8850f] text-white'
                    : 'bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white'
                }`}
              >
                {walletReady ? t('market.confirm') : t('wallet.createWallet')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (!walletReady) {
                  setShowWalletModal(true)
                  return
                }
                const panel = document.querySelector('[data-trading-panel]')
                panel?.scrollIntoView({ behavior: 'smooth' })
              }}
              className={`w-full py-3 rounded-xl font-semibold transition-colors ${
                !walletReady
                  ? 'bg-[#f7931a] hover:bg-[#e8850f] text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {walletReady ? t('trade.title') : t('wallet.createWallet')}
            </button>
          )}
        </div>
      )}

      {showWalletModal && <WalletRequiredModal onClose={() => setShowWalletModal(false)} />}
    </div>
  )
}
