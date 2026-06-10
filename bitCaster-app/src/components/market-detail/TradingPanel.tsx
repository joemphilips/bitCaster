import React, { useState, useRef, useEffect } from 'react'
import { X, ChevronUp, ChevronDown, Loader2 } from 'lucide-react'
import type {
  MarketDetail,
  TradeSelection,
  TradePreview,
  LimitOrderPreview,
  TradeSide,
  OrderType,
  YesNoMarketDetail,
  CategoricalMarketDetail,
  NumericMarketDetail,
} from '@/types/market-detail'
import { useTranslation } from 'react-i18next'
import {
  formatMarketSubunits,
  formatWholeShareFaceValue,
  marketSubunitLabel,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from '@bitcaster/client-sdk/marketUnits'

interface TradingPanelProps {
  market: MarketDetail
  tradeSelection: TradeSelection | null
  tradeAmount: number
  tradePreview: TradePreview | null
  tradeSide: TradeSide
  orderType: OrderType
  limitOrderPreview?: LimitOrderPreview | null
  limitPrice?: number
  userHoldings?: number
  tradeSubmitStatus?: {
    kind: 'info' | 'success' | 'error'
    message: string
  } | null
  isTradeSubmitting?: boolean
  onTradeSelect?: (selection: TradeSelection) => void
  onTradeClear?: () => void
  onAmountChange?: (amount: number) => void
  onTradeConfirm?: (comment?: string) => void
  onCommentPost?: (content: string) => void
  onTradeSideChange?: (side: TradeSide) => void
  onOrderTypeChange?: (type: OrderType) => void
  preflightSplit?: boolean
  onPreflightSplitChange?: (enabled: boolean) => void
  onLimitPriceChange?: (price: number) => void
  walletReady?: boolean
  onWalletRequired?: (comment?: string) => void
}

// Buy quick-presets are user-facing display shares. Boundary code maps each
// display share to a market-divisibility-sized conditional-token face lot
// before submit.
const QUICK_SHARE_PRESETS = [1, 5, 10, 50]
const QUICK_SELL_PERCENTAGES = [25, 50, 75, 100]
const ENGINE_SCORE_FEE_SUBUNITS = 0

// Custom scrollable container with chevron buttons
function ScrollableContainer({
  children,
  className,
  groupName = 'scroll',
}: {
  children: React.ReactNode
  className?: string
  groupName?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      setCanScrollUp(scrollTop > 2)
      setCanScrollDown(scrollTop < scrollHeight - clientHeight - 2)
    }
  }

  useEffect(() => {
    checkScroll()
    const resizeObserver = new ResizeObserver(checkScroll)
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current)
    }
    return () => resizeObserver.disconnect()
  }, [children])

  const scroll = (direction: 'up' | 'down', e: React.MouseEvent) => {
    e.stopPropagation()
    if (scrollRef.current) {
      scrollRef.current.scrollBy({
        top: direction === 'up' ? -100 : 100,
        behavior: 'smooth',
      })
    }
  }

  return (
    <div className={`relative group/${groupName}`}>
      {canScrollUp && (
        <button
          onClick={(e) => scroll('up', e)}
          className="absolute left-1/2 -translate-x-1/2 -top-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/scroll:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className={className}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {children}
      </div>

      {canScrollDown && (
        <button
          onClick={(e) => scroll('down', e)}
          className="absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/scroll:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

function YesNoOutcomes({
  market,
  tradeSelection,
  tradeSide,
  onTradeSelect,
}: {
  market: YesNoMarketDetail
  tradeSelection: TradeSelection | null
  tradeSide: TradeSide
  onTradeSelect?: (selection: TradeSelection) => void
}) {
  const { t } = useTranslation()
  const isSell = tradeSide === 'sell'
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        data-testid="trade-outcome-yes"
        onClick={() => onTradeSelect?.({ side: 'yes' })}
        className={`relative p-4 rounded-xl border-2 transition-all ${
          tradeSelection?.side === 'yes'
            ? 'border-emerald-500 bg-emerald-500/10'
            : 'border-slate-200 dark:border-slate-700 hover:border-emerald-500/50 hover:bg-emerald-500/5'
        }`}
      >
        <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
          {isSell ? t('trade.sellYes') : t('common.yes')}
        </div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">
          {market.currentOdds.yes.toFixed(1)}%
        </div>
      </button>

      <button
        data-testid="trade-outcome-no"
        onClick={() => onTradeSelect?.({ side: 'no' })}
        className={`relative p-4 rounded-xl border-2 transition-all ${
          tradeSelection?.side === 'no'
            ? 'border-red-500 bg-red-500/10'
            : 'border-slate-200 dark:border-slate-700 hover:border-red-500/50 hover:bg-red-500/5'
        }`}
      >
        <div className="text-xs font-medium text-red-600 dark:text-red-400 uppercase tracking-wider mb-1">
          {isSell ? t('trade.sellNo') : t('common.no')}
        </div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">
          {market.currentOdds.no.toFixed(1)}%
        </div>
      </button>
    </div>
  )
}

function CategoricalOutcomes({
  market,
  tradeSelection,
  tradeSide,
  onTradeSelect,
}: {
  market: CategoricalMarketDetail
  tradeSelection: TradeSelection | null
  tradeSide: TradeSide
  onTradeSelect?: (selection: TradeSelection) => void
}) {
  const { t } = useTranslation()
  const isSell = tradeSide === 'sell'
  return (
    <ScrollableContainer className="space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-hide">
      {market.outcomes.map((outcome) => {
        const isSelected = tradeSelection?.outcomeId === outcome.id
        return (
          <div
            key={outcome.id}
            className={`p-3 rounded-xl border transition-all ${
              isSelected
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-900 dark:text-white truncate mr-2">
                {outcome.label}
              </span>
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">
                {outcome.odds.toFixed(1)}%
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                data-testid={`buy-yes-${outcome.label}`}
                onClick={() => onTradeSelect?.({ side: 'yes', outcomeId: outcome.id })}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === 'yes'
                    ? 'bg-emerald-500 text-white'
                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
                }`}
              >
                {isSell ? t('trade.sellYes') : t('trade.buyYes')}
              </button>
              <button
                data-testid={`buy-no-${outcome.label}`}
                onClick={() => onTradeSelect?.({ side: 'no', outcomeId: outcome.id })}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === 'no'
                    ? 'bg-red-500 text-white'
                    : 'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20'
                }`}
              >
                {isSell ? t('trade.sellNo') : t('trade.buyNo')}
              </button>
            </div>
          </div>
        )
      })}
    </ScrollableContainer>
  )
}

function NumericOutcomes({
  market,
  tradeSelection,
  tradeSide,
  onTradeSelect,
}: {
  market: NumericMarketDetail
  tradeSelection: TradeSelection | null
  tradeSide: TradeSide
  onTradeSelect?: (selection: TradeSelection) => void
}) {
  const { t } = useTranslation()
  const isSell = tradeSide === 'sell'
  const formatPrice = (value: number) => {
    if (market.unit === 'USD') return `$${value.toLocaleString()}`
    return `${value.toLocaleString()} ${market.unit}`
  }
  const rangePercent = ((market.currentPrice - market.loBound) / (market.hiBound - market.loBound)) * 100

  return (
    <div className="space-y-4">
      {/* Current implied price */}
      <div className="text-center p-4 bg-slate-50 dark:bg-slate-900 rounded-xl">
        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
          {t('market.impliedPrice')}
        </div>
        <div className="text-3xl font-bold text-slate-900 dark:text-white">
          {formatPrice(market.currentPrice)}
        </div>
      </div>

      {/* Range bar */}
      <div className="px-1">
        <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500 mb-1">
          <span>{formatPrice(market.loBound)}</span>
          <span>{formatPrice(market.hiBound)}</span>
        </div>
        <div className="relative h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-blue-500 rounded-full"
            style={{ width: `${rangePercent}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full shadow"
            style={{ left: `${rangePercent}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>
      </div>

      {/* Higher / Lower buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => onTradeSelect?.({ side: 'hi' })}
          className={`relative p-4 rounded-xl border-2 transition-all ${
            tradeSelection?.side === 'hi'
              ? 'border-emerald-500 bg-emerald-500/10'
              : 'border-slate-200 dark:border-slate-700 hover:border-emerald-500/50 hover:bg-emerald-500/5'
          }`}
        >
          <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
            {isSell ? t('trade.sellHigher') : t('trade.buyHigher')}
          </div>
          <div className="text-sm font-bold text-slate-900 dark:text-white">
            {t('market.hiToken')}
          </div>
        </button>

        <button
          onClick={() => onTradeSelect?.({ side: 'lo' })}
          className={`relative p-4 rounded-xl border-2 transition-all ${
            tradeSelection?.side === 'lo'
              ? 'border-red-500 bg-red-500/10'
              : 'border-slate-200 dark:border-slate-700 hover:border-red-500/50 hover:bg-red-500/5'
          }`}
        >
          <div className="text-xs font-medium text-red-600 dark:text-red-400 uppercase tracking-wider mb-1">
            {isSell ? t('trade.sellLower') : t('trade.buyLower')}
          </div>
          <div className="text-sm font-bold text-slate-900 dark:text-white">
            {t('market.loToken')}
          </div>
        </button>
      </div>
    </div>
  )
}

function BuySellToggle({
  tradeSide,
  onTradeSideChange,
}: {
  tradeSide: TradeSide
  onTradeSideChange?: (side: TradeSide) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-2 mb-3">
      <button
        onClick={() => onTradeSideChange?.('buy')}
        className={`py-2.5 text-sm font-semibold transition-colors border-b-2 ${
          tradeSide === 'buy'
            ? 'text-slate-900 dark:text-white border-slate-900 dark:border-white'
            : 'text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-700 dark:hover:text-slate-300'
        }`}
      >
        {t('trade.buy')}
      </button>
      <button
        onClick={() => onTradeSideChange?.('sell')}
        className={`py-2.5 text-sm font-semibold transition-colors border-b-2 ${
          tradeSide === 'sell'
            ? 'text-slate-900 dark:text-white border-slate-900 dark:border-white'
            : 'text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-700 dark:hover:text-slate-300'
        }`}
      >
        {t('trade.sell')}
      </button>
    </div>
  )
}

function MarketLimitToggle({
  orderType,
  onOrderTypeChange,
}: {
  orderType: OrderType
  onOrderTypeChange?: (type: OrderType) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex bg-slate-100 dark:bg-slate-700/50 rounded-lg p-1 mb-4">
      <button
        onClick={() => onOrderTypeChange?.('market')}
        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
          orderType === 'market'
            ? 'bg-blue-600 text-white shadow-sm'
            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
        }`}
      >
        {t('trade.market')}
      </button>
      <button
        onClick={() => onOrderTypeChange?.('limit')}
        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
          orderType === 'limit'
            ? 'bg-blue-600 text-white shadow-sm'
            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
        }`}
      >
        {t('trade.limit')}
      </button>
    </div>
  )
}

function LimitPriceInput({
  limitPrice,
  baseUnit,
  divisibility,
  onLimitPriceChange,
}: {
  limitPrice: number
  baseUnit: string
  divisibility: number
  onLimitPriceChange?: (price: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-4">
      <label className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-2 block">
        {t('trade.limitPrice')}
      </label>
      <div className="relative">
        <input
          type="number"
          value={limitPrice}
          onChange={(e) => {
            const val = Math.max(1, Number(e.target.value))
            onLimitPriceChange?.(val)
          }}
          min={1}
          className="w-full pr-14 pl-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-sm">
          {baseUnit}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        {t('trade.pricePerShare', {
          price: formatPriceWithProbability(limitPrice, divisibility),
        })}
      </p>
    </div>
  )
}

function probabilityFractionDigits(divisibility: number): number {
  return Math.max(0, Math.ceil(Math.log10(divisibility)) - 2)
}

function formatProbabilityPercent(price: number, divisibility: number): string {
  return ((price / divisibility) * 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: probabilityFractionDigits(divisibility),
  })
}

function formatPriceWithProbability(price: number, divisibility: number): string {
  return `${price.toLocaleString()} (${formatProbabilityPercent(price, divisibility)}%)`
}

function FeeRow({
  label,
  tooltip,
  value,
}: {
  label: string
  tooltip: string
  value: string
}) {
  return (
    <div className="flex justify-between text-sm" title={tooltip} aria-label={`${label}: ${tooltip}`}>
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-600 dark:text-slate-300">
        {value}
      </span>
    </div>
  )
}

function LimitOrderPreviewSection({
  preview,
  feePercent,
  divisibility,
  formatAmount,
}: {
  preview: LimitOrderPreview
  feePercent: number
  divisibility: number
  formatAmount: (amount: number) => string
}) {
  const { t } = useTranslation()
  return (
    <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 space-y-2 mb-4">
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t('trade.limitPrice')}</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {formatPriceWithProbability(preview.limitPrice, divisibility)}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t('trade.sharesIfFilled')}</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {(preview.sharesIfFilled ?? preview.amount).toLocaleString()}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t('trade.sharesTimesPrice')}</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {formatAmount(preview.quoteSats)}
        </span>
      </div>
      <FeeRow
        label={t('trade.creatorFee', { percent: feePercent })}
        tooltip={t('trade.creatorFeeTooltip')}
        value={formatAmount(preview.creatorFee)}
      />
      <FeeRow
        label={t('trade.mintFee')}
        tooltip={t('trade.mintFeeTooltip')}
        value={formatAmount(preview.mintFee)}
      />
      <FeeRow
        label={t('trade.engineScoreFee')}
        tooltip={t('trade.engineScoreFeeTooltip')}
        value={formatAmount(ENGINE_SCORE_FEE_SUBUNITS)}
      />
      <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between">
        <span className="text-slate-700 dark:text-slate-300 font-medium">{t('trade.totalCost')}</span>
        <span className="font-bold text-blue-600 dark:text-blue-400" data-testid="limit-total-cost">
          {formatAmount(preview.totalCost)}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-700 dark:text-slate-300 font-medium">{t('trade.payoutIfWin')}</span>
        <span className="font-bold text-emerald-600 dark:text-emerald-400" data-testid="limit-payout-if-win">
          {formatAmount(preview.potentialPayout)}
        </span>
      </div>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 pt-1">
        {t('trade.orderFillHint')}
      </p>
    </div>
  )
}

export function TradingPanel({
  market,
  tradeSelection,
  tradeAmount,
  tradePreview,
  tradeSide,
  orderType,
  limitOrderPreview,
  limitPrice = 50,
  onTradeSelect,
  onTradeClear,
  onAmountChange,
  onTradeConfirm,
  onCommentPost,
  userHoldings,
  tradeSubmitStatus,
  isTradeSubmitting = false,
  onTradeSideChange,
  onOrderTypeChange,
  preflightSplit = true,
  onPreflightSplitChange,
  onLimitPriceChange,
  walletReady = true,
  onWalletRequired,
}: TradingPanelProps) {
  const { t } = useTranslation()
  const [tradeComment, setTradeComment] = useState('')
  const isSell = tradeSide === 'sell'
  const isLimit = orderType === 'limit'
  const baseAsset = normalizeMarketBaseAsset(market.baseAsset)
  const divisibility = normalizeMarketDivisibility(market.divisibility)
  const subunitLabel = marketSubunitLabel(baseAsset)
  const wholeShareLabel = formatWholeShareFaceValue({ baseAsset, divisibility })
  const formatAmount = (amount: number) => formatMarketSubunits(amount, baseAsset)
  const shareCountLabel = (shares: number) =>
    t('trade.shareCount', { count: shares.toLocaleString() })
  const userHoldingShares =
    userHoldings == null ? null : Math.floor(userHoldings / divisibility)

  const handleShareAmountChange = (raw: number) => {
    if (!Number.isFinite(raw) || raw <= 0) {
      onAmountChange?.(0)
      return
    }
    onAmountChange?.(Math.floor(raw))
  }

  const handleShareAmountBlur = () => {
    if (tradeAmount > 0) {
      onAmountChange?.(Math.max(1, Math.round(tradeAmount)))
    }
  }

  // Build confirm button text
  const getConfirmText = () => {
    if (isTradeSubmitting) return t('trade.submittingOrder')
    if (!walletReady) return t('wallet.createWallet')
    if (!tradeAmount || tradeAmount <= 0) return t('trade.enterAmount')
    const sideLabel = tradeSelection?.side.toUpperCase() ?? ''
    const amountLabel = shareCountLabel(tradeAmount)

    if (isSell && isLimit) return t('trade.confirmLimitSell', { amount: amountLabel })
    if (isSell) return t('trade.confirmSell', { side: sideLabel, amount: amountLabel })
    if (isLimit) return t('trade.confirmLimitBuy', { amount: amountLabel })
    return t('trade.confirmBuy', { side: sideLabel, amount: amountLabel })
  }

  return (
    <div data-trading-panel className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
        {t('trade.title')}
      </h3>

      {/* Buy/Sell Toggle */}
      <BuySellToggle tradeSide={tradeSide} onTradeSideChange={onTradeSideChange} />

      {/* Market/Limit Sub-tabs */}
      <MarketLimitToggle orderType={orderType} onOrderTypeChange={onOrderTypeChange} />

      {/* Outcomes based on market type */}
      {market.type === 'yesno' && (
        <YesNoOutcomes
          market={market}
          tradeSelection={tradeSelection}
          tradeSide={tradeSide}
          onTradeSelect={onTradeSelect}
        />
      )}
      {market.type === 'categorical' && (
        <CategoricalOutcomes
          market={market}
          tradeSelection={tradeSelection}
          tradeSide={tradeSide}
          onTradeSelect={onTradeSelect}
        />
      )}
      {market.type === 'numeric' && (
        <NumericOutcomes
          market={market}
          tradeSelection={tradeSelection}
          tradeSide={tradeSide}
          onTradeSelect={onTradeSelect}
        />
      )}

      {/* Trade Form (shown when outcome selected) */}
      {tradeSelection && (
        <div className="mt-5 pt-5 border-t border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
              {t('trade.shares')}
            </span>
            <button
              onClick={onTradeClear}
              className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Sell-side balance shows outcome shares held. Buy-side wallet
              balance is intentionally omitted from this panel. */}
          {isSell && userHoldingShares != null && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
              {t('trade.balanceShares', { count: userHoldingShares.toLocaleString() })}
            </p>
          )}
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            {t('trade.wholeShareValue', { amount: wholeShareLabel })}
          </p>

          {/* Shares Input — one displayed share maps to a market-divisibility
              conditional-token face lot at the protocol boundary. No ₿ prefix:
              this is a share count, not a sats amount. */}
          <div className="relative mb-3">
            <input
              data-testid="trade-amount-input"
              type="number"
              value={tradeAmount || ''}
              onChange={(e) =>
                handleShareAmountChange(Number(e.target.value))
              }
              onBlur={handleShareAmountBlur}
              step={1}
              min={1}
              placeholder="1"
              className="w-full pl-4 pr-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Quick Amount / Percentage Buttons */}
          <div className="flex gap-2 mb-4">
            {isSell ? (
              QUICK_SELL_PERCENTAGES.map((pct) => {
                const calculatedAmount = userHoldingShares ? Math.round(userHoldingShares * pct / 100) : 0
                return (
                  <button
                    key={pct}
                    onClick={() => onAmountChange?.(calculatedAmount)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                      tradeAmount === calculatedAmount && calculatedAmount > 0
                        ? 'bg-blue-500 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    {pct}%
                  </button>
                )
              })
            ) : (
              QUICK_SHARE_PRESETS.map((shares) => (
                <button
                  key={shares}
                  onClick={() => onAmountChange?.(Math.round(tradeAmount || 0) + shares)}
                  className="flex-1 py-2 rounded-lg text-xs font-medium transition-colors bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600"
                >
                  +{shares}
                </button>
              ))
            )}
          </div>

          {/* Limit Price Input (shown for limit orders, below amount) */}
          {isLimit && (
            <LimitPriceInput
              limitPrice={limitPrice}
              baseUnit={subunitLabel}
              divisibility={divisibility}
              onLimitPriceChange={onLimitPriceChange}
            />
          )}

          {!isSell && isLimit && (
            <label className="mb-4 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              <input
                type="checkbox"
                checked={preflightSplit}
                onChange={(event) => onPreflightSplitChange?.(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>{t('trade.preflightSplit')}</span>
            </label>
          )}

          {/* Market Order Preview */}
          {!isLimit && tradePreview && tradeAmount > 0 && (
            <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 space-y-2 mb-4">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('trade.priceImpact')}</span>
                <span className={`font-medium ${tradePreview.priceImpact > 0 ? 'text-amber-500' : 'text-slate-600 dark:text-slate-300'}`}>
                  {tradePreview.priceImpact > 0 ? '+' : ''}{tradePreview.priceImpact.toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('trade.predictedOdds')}</span>
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  {tradePreview.predictedOdds.toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('trade.sharesTimesPrice')}</span>
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  {formatAmount(tradePreview.quoteSats)}
                </span>
              </div>
              <FeeRow
                label={t('trade.creatorFee', { percent: market.creator.feePercent })}
                tooltip={t('trade.creatorFeeTooltip')}
                value={formatAmount(tradePreview.creatorFee)}
              />
              <FeeRow
                label={t('trade.mintFee')}
                tooltip={t('trade.mintFeeTooltip')}
                value={formatAmount(tradePreview.mintFee)}
              />
              <FeeRow
                label={t('trade.engineScoreFee')}
                tooltip={t('trade.engineScoreFeeTooltip')}
                value={formatAmount(tradePreview.platformFee)}
              />
              {!isSell && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500 dark:text-slate-400">{t('trade.totalCost')}</span>
                  <span className="font-medium text-slate-600 dark:text-slate-300" data-testid="trade-total-cost">
                    {formatAmount(tradePreview.totalCost)}
                  </span>
                </div>
              )}
              <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between">
                <span className="text-slate-700 dark:text-slate-300 font-medium">
                  {isSell ? t('trade.proceeds') : t('trade.payoutIfWin')}
                </span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400" data-testid="trade-payout-if-win">
                  {formatAmount(isSell ? tradePreview.totalCost : tradePreview.potentialPayout)}
                </span>
              </div>
            </div>
          )}

          {/* Limit Order Preview */}
          {isLimit && limitOrderPreview && tradeAmount > 0 && (
            <LimitOrderPreviewSection
              preview={limitOrderPreview}
              feePercent={market.creator.feePercent}
              divisibility={divisibility}
              formatAmount={formatAmount}
            />
          )}

          {tradeSubmitStatus && (
            <div
              role="status"
              data-testid="trade-submit-status"
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                tradeSubmitStatus.kind === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : tradeSubmitStatus.kind === 'error'
                    ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300'
                    : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
              }`}
            >
              {tradeSubmitStatus.message}
            </div>
          )}

          {/* Optional Comment with Trade */}
          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">
              {t('trade.comment')}
            </label>
            <textarea
              value={tradeComment}
              onChange={(e) => setTradeComment(e.target.value.slice(0, 280))}
              placeholder={t('trade.commentPlaceholder')}
              rows={2}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
            <div className="text-right text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
              {tradeComment.length}/280
            </div>
          </div>

          {/* Confirm Button */}
          <button
            data-testid="trade-confirm"
            onClick={() => {
              if (!walletReady) {
                onWalletRequired?.(tradeComment.trim() || undefined)
                return
              }
              const comment = tradeComment.trim()
              onTradeConfirm?.(comment || undefined)
              if (comment) {
                onCommentPost?.(comment)
                setTradeComment('')
              }
            }}
            disabled={
              isTradeSubmitting || (walletReady && (!tradeAmount || tradeAmount <= 0))
            }
            className={`w-full py-3 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed ${
              !walletReady
                ? 'bg-[#f7931a] hover:bg-[#e8850f] text-white'
                : 'bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white'
            }`}
          >
            <span className="inline-flex items-center justify-center gap-2">
              {isTradeSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {getConfirmText()}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
