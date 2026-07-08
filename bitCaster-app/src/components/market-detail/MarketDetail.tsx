import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { MarketDetailProps } from "@/types/market-detail";
import { useMarketState } from "@/hooks/useMarketState";
import { MarketHeader } from "./MarketHeader";
import { TradingPanel } from "./TradingPanel";
import { PriceChart } from "./PriceChart";
import { OrderBookSection } from "./OrderBookSection";
import { ResolutionInfo } from "./ResolutionInfo";
import { RelatedMarkets } from "./RelatedMarkets";
import { CommentSection } from "./CommentSection";
import { canonicalizeOutcomeSet } from "@/lib/outcomeSets";
import { deriveExecutableOrderBook } from "./orderBookViewModel";

function formatNumericPrice(value: number, unit: string): string {
  if (unit === "USD") return `$${value.toLocaleString()}`;
  return `${value.toLocaleString()} ${unit}`;
}

function computeCurrentDisplay(market: MarketDetailProps["market"]): string {
  const isResolved = market.resolution.status === "resolved";

  if (market.type === "numeric") {
    if (isResolved && market.attestedValue != null) {
      return `Resolved: ${formatNumericPrice(market.attestedValue, market.unit)}`;
    }
    return formatNumericPrice(market.currentPrice, market.unit);
  }

  if (isResolved && market.resolution.finalOutcome) {
    return `Resolved: ${market.resolution.finalOutcome}`;
  }

  if (market.type === "yesno") {
    const latestPoint = market.priceHistory.data.at(-1);
    const latestYesPrice =
      latestPoint && Number.isFinite(latestPoint.price)
        ? latestPoint.price
        : market.currentOdds.yes;
    return `${latestYesPrice.toFixed(2)}%`;
  }

  return "";
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
  tradeFeasibility,
  isTradeSubmitting,
  onShare,
  onCommentPost,
  onCommentLike,
  onLoadMoreComments,
  onRelatedMarketClick,
  onTradeSideChange,
  onOrderTypeChange,
  onLimitPriceChange,
  userHoldings,
  walletReady = true,
  onWalletRequired,
  onTopUpRequired,
}: MarketDetailProps) {
  const { t } = useTranslation();
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
  const currentDisplay = computeCurrentDisplay(market);

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

  return (
    <div className="min-h-screen bg-slate-50 pb-[calc(9rem+env(safe-area-inset-bottom))] dark:bg-slate-900 lg:pb-0">
      {/* Desktop Layout: Two Columns (single column when resolved) */}
      <div className="max-w-7xl mx-auto">
        <div
          className="p-4 lg:grid lg:grid-cols-[1fr_380px] lg:gap-6 lg:p-6"
        >
          {/* Left Column - Main Content */}
          <div className="space-y-6">
            {/* Header */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <MarketHeader market={market} onShare={onShare} />
            </div>

            {/* Resolution Info (shown immediately after header for resolved markets) */}
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

            {/* Mobile: Trading Panel (disabled, not hidden, after close). */}
            <div className="lg:hidden" data-testid="trading-panel-mobile">
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
                tradeFeasibility={tradeFeasibility}
                isTradeSubmitting={isTradeSubmitting}
                onCommentPost={onCommentPost}
                onTradeSideChange={onTradeSideChange}
                onOrderTypeChange={onOrderTypeChange}
                onLimitPriceChange={onLimitPriceChange}
                userHoldings={userHoldings}
                walletReady={walletReady}
                onWalletRequired={onWalletRequired}
                onTopUpRequired={onTopUpRequired}
                disabled={isTradingDisabled}
              />
            </div>

            {/* Price Chart */}
            <PriceChart
              priceHistory={market.priceHistory}
              chartTimeframe={chartTimeframe}
              onTimeframeChange={onTimeframeChange}
              outcomePriceHistories={outcomePriceHistories}
              outcomes={market.type === "categorical" ? outcomes : undefined}
              currentDisplay={currentDisplay}
              comments={market.comments}
              unit={market.type === "numeric" ? market.unit : undefined}
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
                  const primaryOutcomeId = outcomeBookKey(
                    yesNoOutcomes(market)[0]?.label ?? "Yes",
                  );
                  const directBook =
                    market.outcomeOrderBooks?.[primaryOutcomeId] ??
                    market.orderBook;
                  const complementBook = Object.entries(
                    market.outcomeOrderBooks ?? {},
                  ).find(([id]) => id !== primaryOutcomeId)?.[1];
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
                      book: market.outcomeOrderBooks?.[
                        outcomeBookKey(outcome.label)
                      ] ?? {
                        bids: [],
                        asks: [],
                        spread: 0,
                      },
                      complementBook: Object.entries(
                        market.outcomeOrderBooks ?? {},
                      ).find(
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

            {/* Resolution Info (in normal position for open markets) */}
            {!isResolved && <ResolutionInfo resolution={market.resolution} />}

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

          {/* Right Column - Trading Panel (disabled, not hidden, after close). */}
          <div className="hidden lg:block" data-testid="trading-panel-desktop">
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
                tradeFeasibility={tradeFeasibility}
                isTradeSubmitting={isTradeSubmitting}
                onCommentPost={onCommentPost}
                onTradeSideChange={onTradeSideChange}
                onOrderTypeChange={onOrderTypeChange}
                onLimitPriceChange={onLimitPriceChange}
                userHoldings={userHoldings}
                walletReady={walletReady}
                onWalletRequired={onWalletRequired}
                onTopUpRequired={onTopUpRequired}
                disabled={isTradingDisabled}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: Sticky Bottom Trade Bar (only for open markets) */}
      {!isTradingDisabled && (
        <div className="fixed left-0 right-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 lg:hidden">
          {tradeSelection ? (
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
                  {isTradeSubmitting && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
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
