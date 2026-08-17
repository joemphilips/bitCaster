import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { MarketDetailProps, TradeTab } from "@/types/market-detail";
import { useMarketState } from "@/hooks/useMarketState";
import { MarketHeader } from "./MarketHeader";
import { TradingPanel } from "./TradingPanel";
import { PriceChart } from "./PriceChart";
import { OrderBookSection } from "./OrderBookSection";
import { ResolutionInfo } from "./ResolutionInfo";
import { RelatedMarkets } from "./RelatedMarkets";
import { CommentSection } from "./CommentSection";
import { canonicalizeOutcomeSet } from "@/lib/outcomeSets";
import { deriveExecutableOrderBook, hasExecutableLiquidity } from "./orderBookViewModel";
import { outcomeSetIdsForMarketBooks, resolveOutcomeSets } from "@/lib/outcomeSets";
import { formatPricePercentage } from "@bitcaster/client-sdk/marketUnits";

function formatNumericPrice(value: number, unit: string, precision: number): string {
  const safePrecision = Number.isFinite(precision)
    ? Math.min(Math.max(Math.trunc(precision), 0), 8)
    : 0;
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: safePrecision,
    maximumFractionDigits: safePrecision,
  });
  if (unit === "USD") return `$${formatted}`;
  return `${formatted} ${unit}`;
}

function computeCurrentDisplay(
  market: MarketDetailProps["market"],
  t: (key: string) => string,
): string {
  const isResolved = market.resolution.status === "resolved";
  const priceAuthorityUnavailable = market.latestConfirmedTradesValid === false;

  if (market.type === "numeric") {
    if (isResolved && market.attestedValue != null) {
      return `Resolved: ${formatNumericPrice(market.attestedValue, market.unit, market.precision)}`;
    }
    // Numeric HI/LO probability ticks are not a native numeric trade
    // representation. Keep the public current value unavailable until the
    // contract carries one, regardless of any legacy currentPrice field.
    return t("market.priceUnavailable");
  }

  if (isResolved && market.resolution.finalOutcome) {
    return `Resolved: ${market.resolution.finalOutcome}`;
  }

  if (market.type === "yesno") {
    return market.currentOdds.yes == null
      ? t(priceAuthorityUnavailable ? "market.priceUnavailable" : "trade.noTrades")
      : formatPricePercentage(market.currentOdds.yes, market.divisibility);
  }

  return market.outcomes.some((outcome) => outcome.odds != null)
    ? ""
    : t(priceAuthorityUnavailable ? "market.priceUnavailable" : "trade.noTrades");
}

function yesNoOutcomes(market: MarketDetailProps["market"]) {
  if (market.type !== "yesno") return [];
  return market.outcomes?.length
    ? market.outcomes
    : [
        { id: "Yes", label: "Yes", odds: market.currentOdds.yes },
        { id: "No", label: "No", odds: market.currentOdds.no },
  ];
}

function hasSelectedTradeLiquidity(
  market: MarketDetailProps["market"],
  tradeSelection: MarketDetailProps["tradeSelection"],
  tradeSide: MarketDetailProps["tradeSide"],
): boolean {
  if (!tradeSelection) return false;
  const resolved = resolveOutcomeSets(market, tradeSelection);
  if (!resolved) return false;
  const primaryRouteId = outcomeSetIdsForMarketBooks(market)[0] ?? resolved.selectedOutcomeSetId;
  const bookFor = (routeId: string) =>
    market.outcomeOrderBooks?.[routeId] ??
    (routeId === primaryRouteId ? market.orderBook : undefined);
  return hasExecutableLiquidity({
    book: bookFor(resolved.selectedOutcomeSetId),
    complementBook: bookFor(resolved.complementOutcomeSetId),
    divisibility: market.divisibility,
    side: tradeSide,
  });
}

export function MarketDetail({
  market,
  chartTimeframe,
  tradeSelection,
  tradeAmount,
  tradePreview,
  tradeSide,
  orderType,
  limitOrderPreview,
  limitPrice,
  onTimeframeChange,
  onTradeSelect,
  onTradeClear,
  onAmountChange,
  onTradeConfirm,
  tradeSubmitStatus,
  onTradeSubmitStatusDismiss,
  tradeFeasibility,
  isTradeSubmitting,
  onShare,
  onCommentPost,
  onCommentLike,
  onLoadMoreComments,
  onRelatedMarketClick,
  onTradeSideChange,
  tradeTab: controlledTradeTab,
  onTradeTabChange,
  onOrderTypeChange,
  onLimitPriceChange,
  userHoldings,
  walletReady = true,
  onWalletRequired,
  onTopUpRequired,
}: MarketDetailProps) {
  const { t } = useTranslation();
  const [localTradeTab, setLocalTradeTab] = useState<TradeTab>(tradeSide);
  const activeTradeTab = controlledTradeTab ?? localTradeTab;
  const previousMarketIdRef = useRef(market.id);
  useEffect(() => {
    if (previousMarketIdRef.current === market.id) return;
    previousMarketIdRef.current = market.id;
    setLocalTradeTab(tradeSide);
    onTradeTabChange?.(tradeSide);
  }, [market.id, onTradeTabChange, tradeSide]);
  useEffect(() => {
    if (controlledTradeTab == null) {
      setLocalTradeTab((current) => (current === "Liquidity" ? current : tradeSide));
    }
  }, [controlledTradeTab, tradeSide]);
  const outcomes =
    market.type === "categorical"
      ? market.outcomes
      : market.type === "yesno"
        ? yesNoOutcomes(market)
        : undefined;
  const marketOrderHasNoLiquidity =
    orderType === "market" &&
    !!tradeSelection &&
    tradeAmount > 0 &&
    tradePreview?.hasExecutableLiquidity === false;
  const backingBlocked = walletReady && tradeFeasibility?.canBack === false;
  const backingBlockReason =
    tradeFeasibility?.reason ?? (tradeSide === "Sell" ? "outcome-tokens" : "funds");
  const buyNeedsTopUp = backingBlocked && backingBlockReason === "funds";

  // Get outcome-specific data for categorical markets
  const outcomePriceHistories =
    market.type === "categorical" ? market.outcomePriceHistories : undefined;
  const outcomeBookKey = (label: string) => canonicalizeOutcomeSet([label]);

  // Compute current display for price chart
  const currentDisplay = computeCurrentDisplay(market, t);

  // Determine market state per ADR-009 (Amendment 2026-05-04 — detail-page
  // compliance). The detail page reads engine `state` for lifecycle
  // (Open / Closed) and reduces mintd's `attestation.*` to outcome metadata
  // (which outcome the oracle attested, when, whether the announcement
  // window expired). `isResolved` keeps the existing semantics for the
  // resolution-info badge — surfaced when mintd reports a resolved outcome,
  // independent of the engine's lifecycle state. `isTradingDisabled` is the
  // single closed-state gate consulted across the trade and deposit
  // affordances. The engine state is authoritative for routine rendering; a
  // stale or backfilled deadline must not hide the trade pane while the engine
  // still says the market is open.
  const isResolved = market.resolution.status === "resolved";
  const marketState = useMarketState(market.state);
  const isEffectivelyClosed = marketState === "Closed";
  const isTradingDisabled = isEffectivelyClosed;
  const activeTradeSide = activeTradeTab === "Sell" ? "Sell" : "Buy";
  const selectedTradeHasLiquidity = hasSelectedTradeLiquidity(
    market,
    tradeSelection,
    activeTradeSide,
  );

  const handleTradeTabChange = (tab: TradeTab) => {
    setLocalTradeTab(tab);
    onTradeTabChange?.(tab);
  };

  const tradingPanel = (
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
      onTradeSubmitStatusDismiss={onTradeSubmitStatusDismiss}
      tradeFeasibility={tradeFeasibility}
      isTradeSubmitting={isTradeSubmitting}
      onCommentPost={onCommentPost}
      onTradeSideChange={onTradeSideChange}
      tradeTab={activeTradeTab}
      onTradeTabChange={handleTradeTabChange}
      onOrderTypeChange={onOrderTypeChange}
      onLimitPriceChange={onLimitPriceChange}
      userHoldings={userHoldings}
      walletReady={walletReady}
      onWalletRequired={onWalletRequired}
      onTopUpRequired={onTopUpRequired}
      disabled={isTradingDisabled}
    />
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-[calc(9rem+env(safe-area-inset-bottom))] dark:bg-slate-900 lg:pb-0">
      {/* Desktop Layout: Two Columns (single column when resolved) */}
      <div className="max-w-7xl mx-auto">
        <div className="p-4 lg:grid lg:grid-cols-[1fr_380px] lg:gap-6 lg:p-6">
          {/* Header stays before the panel on mobile and occupies the first
              column above the content on desktop. */}
          <div className="order-1 space-y-6 lg:col-start-1 lg:row-start-1">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <MarketHeader market={market} onShare={onShare} />
            </div>

            {isResolved && <ResolutionInfo resolution={market.resolution} />}

            {isEffectivelyClosed && (
              <div
                role="status"
                data-testid="market-closed-banner"
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
              >
                <p className="font-semibold">{t("market.closedBannerTitle")}</p>
                <p>{t("market.closedBannerDescription")}</p>
              </div>
            )}
          </div>

          <div
            className="order-2 lg:col-start-2 lg:row-start-1 lg:row-span-full"
            data-testid="trading-panel-responsive"
          >
            <div className="lg:sticky lg:top-6">{tradingPanel}</div>
          </div>

          <div className="order-3 space-y-6 lg:col-start-1 lg:row-start-2">
            <PriceChart
              priceHistory={market.priceHistory}
              chartTimeframe={chartTimeframe}
              onTimeframeChange={onTimeframeChange}
              outcomePriceHistories={outcomePriceHistories}
              outcomes={market.type === "categorical" ? outcomes : undefined}
              currentDisplay={currentDisplay}
              comments={market.comments}
              unit={market.type === "numeric" ? market.unit : undefined}
              disabledNumeric={market.type === "numeric"}
            />

            {/* Order Book. Live state is owned by MarketDetailPage so depth,
                previews, and submit-time ticket building all read the same
                book snapshots. Closed markets render the last known book. */}
            {market.type === "yesno" && (
              <div className="relative" data-testid="order-book-section">
                {isEffectivelyClosed && (
                  <span
                    data-testid="market-closed-badge"
                    className="absolute right-3 top-3 z-10 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold uppercase text-rose-600 dark:text-rose-400"
                  >
                    {t("market.closed")}
                  </span>
                )}
                {(() => {
                  const primaryOutcomeId = outcomeBookKey(yesNoOutcomes(market)[0]?.label ?? "Yes");
                  const directBook =
                    market.outcomeOrderBooks?.[primaryOutcomeId] ?? market.orderBook;
                  const complementBook = Object.entries(market.outcomeOrderBooks ?? {}).find(
                    ([id]) => id !== primaryOutcomeId,
                  )?.[1];
                  return (
                    <OrderBookSection
                      outcomeId={primaryOutcomeId}
                      orderBook={deriveExecutableOrderBook({
                        book: directBook,
                        complementBook,
                        divisibility: market.divisibility,
                        completeness: "executable",
                      })}
                      baseAsset={market.baseAsset}
                      divisibility={market.divisibility}
                    />
                  );
                })()}
              </div>
            )}

            {market.type === "categorical" && (
              <div className="space-y-4" data-testid="categorical-order-books">
                {market.outcomes.slice(0, 8).map((outcome) => (
                  <OrderBookSection
                    key={outcome.id}
                    title={outcome.label}
                    outcomeId={outcomeBookKey(outcome.label)}
                    orderBook={deriveExecutableOrderBook({
                      book: market.outcomeOrderBooks?.[outcomeBookKey(outcome.label)] ?? {
                        bids: [],
                        asks: [],
                        spread: 0,
                      },
                      complementBook: Object.entries(market.outcomeOrderBooks ?? {}).find(
                        ([id]) => id !== outcomeBookKey(outcome.label),
                      )?.[1],
                      divisibility: market.divisibility,
                      completeness: "executable",
                    })}
                    baseAsset={market.baseAsset}
                    divisibility={market.divisibility}
                  />
                ))}
              </div>
            )}

            {!isResolved && <ResolutionInfo resolution={market.resolution} />}
            <RelatedMarkets markets={market.relatedMarkets} onMarketClick={onRelatedMarketClick} />
            <CommentSection
              comments={market.comments}
              onCommentLike={onCommentLike}
              onLoadMoreComments={onLoadMoreComments}
            />
          </div>
        </div>
      </div>

      {/* Mobile: Sticky Bottom Trade Bar (only for open markets) */}
      {!isTradingDisabled && activeTradeTab !== "Liquidity" && (
        <div className="fixed left-0 right-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 lg:hidden">
          {tradeSelection && selectedTradeHasLiquidity ? (
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tradeSelection.side.toUpperCase()}
                  {tradeSelection.outcomeId && ` - ${tradeSelection.outcomeId}`}
                </p>
                <p className="text-sm font-medium text-slate-900 dark:text-white">
                  {marketOrderHasNoLiquidity
                    ? t("trade.noExecutableLiquidity")
                    : tradeAmount > 0
                      ? t("trade.shareCount", {
                          count: tradeAmount.toLocaleString(),
                        })
                      : t("trade.enterAmount")}
                </p>
              </div>
              <button
                onClick={onTradeClear}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => {
                  if (!walletReady) {
                    onWalletRequired?.();
                    return;
                  }
                  if (buyNeedsTopUp) {
                    onTopUpRequired?.();
                    return;
                  }
                  onTradeConfirm?.();
                }}
                disabled={
                  isTradeSubmitting ||
                  (buyNeedsTopUp ? !onTopUpRequired : backingBlocked) ||
                  marketOrderHasNoLiquidity ||
                  (walletReady && (!tradeAmount || tradeAmount <= 0))
                }
                title={
                  backingBlocked && !buyNeedsTopUp
                    ? (tradeFeasibility.message ??
                      (backingBlockReason === "outcome-tokens"
                        ? t("trade.insufficientOutcomeTokens")
                        : t("trade.insufficientFunds")))
                    : undefined
                }
                className={`px-6 py-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed ${
                  !walletReady
                    ? "bg-[#f7931a] hover:bg-[#e8850f] text-white"
                    : "bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white"
                }`}
              >
                <span className="inline-flex items-center justify-center gap-2">
                  {isTradeSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isTradeSubmitting
                    ? t("trade.submittingOrder")
                    : walletReady
                      ? buyNeedsTopUp
                        ? t("trade.topUpWallet")
                        : t("market.confirm")
                      : t("wallet.startTrading")}
                </span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (!walletReady) {
                  onWalletRequired?.();
                  return;
                }
                const panel = document.querySelector("[data-trading-panel]");
                panel?.scrollIntoView({ behavior: "smooth" });
              }}
              className={`w-full py-3 rounded-xl font-semibold transition-colors ${
                !walletReady
                  ? "bg-[#f7931a] hover:bg-[#e8850f] text-white"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {walletReady ? t("trade.title") : t("wallet.startTrading")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
