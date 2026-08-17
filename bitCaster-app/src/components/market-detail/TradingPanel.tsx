import React, { useState, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import type {
  MarketDetail,
  TradeSelection,
  TradePreview,
  LimitOrderPreview,
  TradeSide,
  TradeTab,
  OrderType,
  YesNoMarketDetail,
  CategoricalMarketDetail,
} from "@/types/market-detail";
import { useTranslation } from "react-i18next";
import {
  formatMarketSubunits,
  formatPricePercentage,
  formatShareFace,
  marketUnitLabel,
  estimatedSettlementFeeSubunits,
  type MarketBaseAsset,
  normalizeMarketBaseAsset,
  parseMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { DepositStep } from "@/components/market-creation/DepositStep";
import {
  complementOutcomeSetId,
  outcomeSetIdsForMarketBooks,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { hasExecutableLiquidity } from "./orderBookViewModel";

function formatNullablePrice(
  price: number | null,
  divisibility: number,
  authority: Pick<MarketDetail, "latestConfirmedTrades" | "latestConfirmedTradesValid">,
  noTrades: string,
  priceUnavailable: string,
): string {
  if (authority.latestConfirmedTradesValid !== true) return priceUnavailable;
  return price == null ? noTrades : formatPricePercentage(price, divisibility);
}

interface TradingPanelProps {
  market: MarketDetail;
  tradeSelection: TradeSelection | null;
  tradeAmount: number;
  tradePreview: TradePreview | null;
  tradeSide: TradeSide;
  orderType: OrderType;
  limitOrderPreview?: LimitOrderPreview | null;
  limitPrice?: number;
  userHoldings?: number;
  tradeSubmitStatus?: {
    kind: "info" | "success" | "error";
    message: string;
  } | null;
  onTradeSubmitStatusDismiss?: () => void;
  tradeFeasibility?: {
    canBack: boolean;
    reason?: "funds" | "outcome-tokens";
    message?: string;
  } | null;
  isTradeSubmitting?: boolean;
  onTradeSelect?: (selection: TradeSelection) => void;
  onTradeClear?: () => void;
  onAmountChange?: (amount: number) => void;
  onTradeConfirm?: (comment?: string) => void;
  onCommentPost?: (content: string) => void;
  onTradeSideChange?: (side: TradeSide) => void;
  tradeTab?: TradeTab;
  onTradeTabChange?: (tab: TradeTab) => void;
  onOrderTypeChange?: (type: OrderType) => void;
  onLimitPriceChange?: (price: number) => void;
  walletReady?: boolean;
  onWalletRequired?: (comment?: string) => void;
  onTopUpRequired?: (comment?: string) => void;
  disabled?: boolean;
}

type TradingTab = TradeTab;

function fallbackOutcomeLabels(market: MarketDetail): string[] {
  if (market.type === "yesno") {
    return market.outcomes?.map((outcome) => outcome.label) ?? ["Yes", "No"];
  }
  if (market.type === "categorical") return market.outcomes.map((outcome) => outcome.label);
  return ["HI", "LO"];
}

function routeIdsForMarket(market: MarketDetail): string[] {
  const configuredIds = outcomeSetIdsForMarketBooks(market);
  const bookIds = Object.keys(market.outcomeOrderBooks ?? {});
  const ids = [...new Set([...configuredIds, ...bookIds])];
  if (ids.length > 0) return ids;
  return fallbackOutcomeLabels(market).map((label) => label.trim()).filter(Boolean);
}

function routeBookForMarket(market: MarketDetail, routeId: string) {
  const primaryRouteId = routeIdsForMarket(market)[0];
  return market.outcomeOrderBooks?.[routeId] ??
    (routeId === primaryRouteId ? market.orderBook : undefined);
}

function complementRouteIdForMarket(market: MarketDetail, routeId: string): string {
  return complementOutcomeSetId(fallbackOutcomeLabels(market), routeId);
}

function selectedRouteIdsForMarket(
  market: MarketDetail,
  selection: TradeSelection,
): { selectedOutcomeSetId: string; complementOutcomeSetId: string } | null {
  const resolved = resolveOutcomeSets(market, selection);
  if (resolved) {
    return {
      selectedOutcomeSetId: resolved.selectedOutcomeSetId,
      complementOutcomeSetId: resolved.complementOutcomeSetId,
    };
  }

  const routeIds = routeIdsForMarket(market);
  if (routeIds.length === 0) return null;
  const selectedIndex =
    market.type === "categorical"
      ? routeIds.findIndex((routeId) => routeId === selection.outcomeId)
      : selection.side === "no" || selection.side === "lo"
        ? 1
        : 0;
  const selectedOutcomeSetId = routeIds[selectedIndex >= 0 ? selectedIndex : 0];
  return {
    selectedOutcomeSetId,
    complementOutcomeSetId: complementRouteIdForMarket(market, selectedOutcomeSetId),
  };
}

function possibleTradeSelections(market: MarketDetail): TradeSelection[] {
  if (market.type === "categorical") {
    return market.outcomes.flatMap((outcome) => [
      { side: "yes", outcomeId: outcome.id },
      { side: "no", outcomeId: outcome.id },
    ]);
  }
  if (market.type === "yesno") {
    return [{ side: "yes" }, { side: "no" }];
  }
  return [{ side: "hi" }, { side: "lo" }];
}

// Buy quick-presets are user-facing display shares. Boundary code maps each
// display share to a market-divisibility-sized conditional-token face lot
// before submit.
const QUICK_SHARE_PRESETS = [1, 5, 10, 50];
const QUICK_SELL_PERCENTAGES = [25, 50, 75, 100];

// Custom scrollable container with chevron buttons
function ScrollableContainer({
  children,
  className,
  groupName = "scroll",
}: {
  children: React.ReactNode;
  className?: string;
  groupName?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      setCanScrollUp(scrollTop > 2);
      setCanScrollDown(scrollTop < scrollHeight - clientHeight - 2);
    }
  };

  useEffect(() => {
    checkScroll();
    const resizeObserver = new ResizeObserver(checkScroll);
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [children]);

  const scroll = (direction: "up" | "down", e: React.MouseEvent) => {
    e.stopPropagation();
    if (scrollRef.current) {
      scrollRef.current.scrollBy({
        top: direction === "up" ? -100 : 100,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className={`relative group/${groupName}`}>
      {canScrollUp && (
        <button
          onClick={(e) => scroll("up", e)}
          className="absolute left-1/2 -translate-x-1/2 -top-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/scroll:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className={className}
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {children}
      </div>

      {canScrollDown && (
        <button
          onClick={(e) => scroll("down", e)}
          className="absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/scroll:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function YesNoOutcomes({
  market,
  tradeSelection,
  tradeSide,
  onTradeSelect,
  disabled = false,
}: {
  market: YesNoMarketDetail;
  tradeSelection: TradeSelection | null;
  tradeSide: TradeSide;
  onTradeSelect?: (selection: TradeSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isSell = tradeSide === "Sell";
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        data-testid="trade-outcome-yes"
        disabled={disabled}
        onClick={() => onTradeSelect?.({ side: "yes" })}
        className={`relative p-4 rounded-xl border-2 transition-all ${
          tradeSelection?.side === "yes"
            ? "border-emerald-500 bg-emerald-500/10"
            : "border-slate-200 dark:border-slate-700 hover:border-emerald-500/50 hover:bg-emerald-500/5"
        }`}
      >
        <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
          {isSell ? t("trade.sellYes") : t("common.yes")}
        </div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">
          {formatNullablePrice(
            market.currentOdds.yes,
            market.divisibility,
            market,
            t("trade.noTrades"),
            t("market.priceUnavailable"),
          )}
        </div>
      </button>

      <button
        data-testid="trade-outcome-no"
        disabled={disabled}
        onClick={() => onTradeSelect?.({ side: "no" })}
        className={`relative p-4 rounded-xl border-2 transition-all ${
          tradeSelection?.side === "no"
            ? "border-red-500 bg-red-500/10"
            : "border-slate-200 dark:border-slate-700 hover:border-red-500/50 hover:bg-red-500/5"
        }`}
      >
        <div className="text-xs font-medium text-red-600 dark:text-red-400 uppercase tracking-wider mb-1">
          {isSell ? t("trade.sellNo") : t("common.no")}
        </div>
        <div className="text-2xl font-bold text-slate-900 dark:text-white">
          {formatNullablePrice(
            market.currentOdds.no,
            market.divisibility,
            market,
            t("trade.noTrades"),
            t("market.priceUnavailable"),
          )}
        </div>
      </button>
    </div>
  );
}

function CategoricalOutcomes({
  market,
  tradeSelection,
  tradeSide,
  onTradeSelect,
  disabled = false,
}: {
  market: CategoricalMarketDetail;
  tradeSelection: TradeSelection | null;
  tradeSide: TradeSide;
  onTradeSelect?: (selection: TradeSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isSell = tradeSide === "Sell";
  return (
    <ScrollableContainer className="space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-hide">
      {market.outcomes.map((outcome) => {
        const isSelected = tradeSelection?.outcomeId === outcome.id;
        return (
          <div
            key={outcome.id}
            className={`p-3 rounded-xl border transition-all ${
              isSelected
                ? "border-blue-500 bg-blue-500/10"
                : "border-slate-200 dark:border-slate-700"
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-900 dark:text-white truncate mr-2">
                {outcome.label}
              </span>
              <span className="text-sm font-bold text-slate-600 dark:text-slate-400">
                {formatNullablePrice(
                  outcome.odds,
                  market.divisibility,
                  market,
                  t("trade.noTrades"),
                  t("market.priceUnavailable"),
                )}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                data-testid={`buy-yes-${outcome.label}`}
                disabled={disabled}
                onClick={() => onTradeSelect?.({ side: "yes", outcomeId: outcome.id })}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === "yes"
                    ? "bg-emerald-500 text-white"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                }`}
              >
                {isSell ? t("trade.sellYes") : t("trade.buyYes")}
              </button>
              <button
                data-testid={`buy-no-${outcome.label}`}
                disabled={disabled}
                onClick={() => onTradeSelect?.({ side: "no", outcomeId: outcome.id })}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === "no"
                    ? "bg-red-500 text-white"
                    : "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                }`}
              >
                {isSell ? t("trade.sellNo") : t("trade.buyNo")}
              </button>
            </div>
          </div>
        );
      })}
    </ScrollableContainer>
  );
}

function MarketLimitToggle({
  orderType,
  onOrderTypeChange,
  disabled = false,
}: {
  orderType: OrderType;
  onOrderTypeChange?: (type: OrderType) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex bg-slate-100 dark:bg-slate-700/50 rounded-lg p-1 mb-4">
      <button
        onClick={() => onOrderTypeChange?.("market")}
        disabled={disabled}
        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
          orderType === "market"
            ? "bg-blue-600 text-white shadow-sm"
            : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
        }`}
      >
        {t("trade.market")}
      </button>
      <button
        onClick={() => onOrderTypeChange?.("limit")}
        disabled={disabled}
        className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
          orderType === "limit"
            ? "bg-blue-600 text-white shadow-sm"
            : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
        }`}
      >
        {t("trade.limit")}
      </button>
    </div>
  );
}

function LimitPriceInput({
  limitPrice,
  baseAsset,
  divisibility,
  onLimitPriceChange,
  disabled = false,
}: {
  limitPrice: number;
  baseAsset: MarketBaseAsset;
  divisibility: number;
  onLimitPriceChange?: (price: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [priceText, setPriceText] = useState(formatLimitPriceInputValue(limitPrice, baseAsset));
  const [isFocused, setIsFocused] = useState(false);
  const maxPrice = Math.max(1, divisibility - 1);
  const maxDisplayPrice = limitPriceToDisplayAmount(maxPrice, baseAsset);
  const inputStep = limitPriceInputStep(baseAsset);
  const displayUnit = marketUnitLabel(baseAsset);

  useEffect(() => {
    if (!isFocused) {
      setPriceText(formatLimitPriceInputValue(limitPrice, baseAsset));
    }
  }, [limitPrice, baseAsset, isFocused]);

  const handlePriceBlur = () => {
    const trimmed = priceText.trim();
    if (trimmed === "") {
      setPriceText(formatLimitPriceInputValue(limitPrice, baseAsset));
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setPriceText(formatLimitPriceInputValue(limitPrice, baseAsset));
      return;
    }

    const priceSubunits = limitPriceDisplayAmountToSubunits(parsed, baseAsset);
    const clamped = Math.min(maxPrice, Math.max(1, priceSubunits));
    onLimitPriceChange?.(clamped);
    setPriceText(formatLimitPriceInputValue(clamped, baseAsset));
  };

  return (
    <div className="mb-4">
      <label className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-2 block">
        {t("trade.limitPrice")}
      </label>
      <div className="relative">
        <input
          data-testid="limit-price-input"
          type="number"
          disabled={disabled}
          value={priceText}
          onChange={(e) => setPriceText(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            handlePriceBlur();
          }}
          min={limitPriceToDisplayAmount(1, baseAsset)}
          max={maxDisplayPrice}
          step={inputStep}
          className="w-full pr-14 pl-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-sm">
          {displayUnit}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        {t("trade.pricePerShare", {
          price: formatPriceWithProbability(limitPrice, divisibility, baseAsset),
        })}
      </p>
    </div>
  );
}

function limitPriceDisplayScale(baseAsset: MarketBaseAsset): number {
  if (baseAsset !== "sat") throw new Error(`unsupported base asset: ${String(baseAsset)}`);
  return 1_000;
}

function limitPriceToDisplayAmount(priceSubunits: number, baseAsset: MarketBaseAsset): number {
  return priceSubunits / limitPriceDisplayScale(baseAsset);
}

function limitPriceDisplayAmountToSubunits(
  displayAmount: number,
  baseAsset: MarketBaseAsset,
): number {
  return Math.round(displayAmount * limitPriceDisplayScale(baseAsset));
}

function limitPriceInputStep(baseAsset: MarketBaseAsset): number {
  if (baseAsset !== "sat") throw new Error(`unsupported base asset: ${String(baseAsset)}`);
  return 0.001;
}

function formatLimitPriceInputValue(priceSubunits: number, baseAsset: MarketBaseAsset): string {
  return String(limitPriceToDisplayAmount(priceSubunits, baseAsset));
}

function formatLimitPriceAmount(priceSubunits: number, baseAsset: MarketBaseAsset): string {
  const displayAmount = limitPriceToDisplayAmount(
    Number.isFinite(priceSubunits) ? priceSubunits : 0,
    baseAsset,
  );
  if (baseAsset !== "sat") throw new Error(`unsupported base asset: ${String(baseAsset)}`);
  return `${displayAmount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  })} sats`;
}

function formatPriceWithProbability(
  price: number,
  divisibility: number,
  baseAsset: MarketBaseAsset,
): string {
  return `${formatLimitPriceAmount(price, baseAsset)} (${formatPricePercentage(price, divisibility)})`;
}

function LimitOrderPreviewSection({
  preview,
  divisibility,
  baseAsset,
  formatAmount,
}: {
  preview: LimitOrderPreview;
  divisibility: number;
  baseAsset: MarketBaseAsset;
  formatAmount: (amount: number) => string;
}) {
  const { t } = useTranslation();
  const estimatedSettlementFee = estimatedSettlementFeeSubunits(baseAsset);
  const totalWithFee = preview.totalCost + estimatedSettlementFee;
  return (
    <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 space-y-2 mb-4">
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t("trade.pricePerShareLabel")}</span>
        <span className="font-medium text-slate-600 dark:text-slate-300">
          {formatPriceWithProbability(preview.limitPrice, divisibility, baseAsset)}
        </span>
      </div>
      <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between">
        <span className="text-slate-700 dark:text-slate-300 font-medium">
          {t("trade.quotePayment")}
        </span>
        <span className="font-bold text-blue-600 dark:text-blue-400" data-testid="limit-total-cost">
          {formatAmount(preview.totalCost - preview.mintFee)}
        </span>
      </div>
      {preview.mintFee > 0 && (
        <div className="flex justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400" title={t("trade.mintFeeTooltip")}>
            {t("trade.mintFee")}
          </span>
          <span
            className="font-medium text-slate-600 dark:text-slate-300"
            data-testid="limit-mint-fee"
          >
            {formatAmount(preview.mintFee)}
          </span>
        </div>
      )}
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">
          {t("trade.estimatedSettlementFee")}
        </span>
        <span
          className="font-medium text-slate-600 dark:text-slate-300"
          data-testid="limit-settlement-fee"
        >
          {formatAmount(estimatedSettlementFee)}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-700 dark:text-slate-300 font-medium">
          {t("trade.totalWithFee")}
        </span>
        <span
          className="font-bold text-blue-600 dark:text-blue-400"
          data-testid="limit-grand-total"
        >
          {formatAmount(totalWithFee)}
        </span>
      </div>
    </div>
  );
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
  onTradeSubmitStatusDismiss,
  tradeFeasibility,
  isTradeSubmitting = false,
  onTradeSideChange,
  tradeTab: controlledTradeTab,
  onTradeTabChange,
  onOrderTypeChange,
  onLimitPriceChange,
  walletReady = true,
  onWalletRequired,
  onTopUpRequired,
  disabled = false,
}: TradingPanelProps) {
  const { t } = useTranslation();
  const [tradeComment, setTradeComment] = useState("");
  const [localActiveTab, setLocalActiveTab] = useState<TradingTab>(tradeSide);
  const activeTab = controlledTradeTab ?? localActiveTab;
  const activeTradeSide: TradeSide = activeTab === "Sell" ? "Sell" : "Buy";
  const isSell = activeTradeSide === "Sell";
  const isLimit = orderType === "limit";
  const baseAsset = normalizeMarketBaseAsset(market.baseAsset);
  const unitLabel = marketUnitLabel(baseAsset);
  const validDivisibility = parseMarketDivisibility(market.divisibility);
  const divisibility = validDivisibility ?? 0;
  const wholeShareLabel = divisibility > 0 ? formatShareFace(baseAsset, divisibility) : "";
  const formatAmount = (amount: number) => formatMarketSubunits(amount, baseAsset);
  const estimatedSettlementFee = estimatedSettlementFeeSubunits(baseAsset);
  const shareCountLabel = (shares: number) =>
    t("trade.shareCount", { count: shares.toLocaleString() });
  const [tradeAmountText, setTradeAmountText] = useState(
    tradeAmount > 0 ? String(tradeAmount) : "",
  );
  const [isTradeAmountFocused, setIsTradeAmountFocused] = useState(false);
  const userHoldingShares = userHoldings == null ? null : Math.floor(userHoldings / divisibility);
  const tradingDisabled = disabled;
  const marketOrderHasNoLiquidity =
    !isLimit &&
    !!tradeSelection &&
    tradeAmount > 0 &&
    tradePreview?.hasExecutableLiquidity === false;
  const backingBlocked = walletReady && tradeFeasibility?.canBack === false;
  const backingBlockReason = tradeFeasibility?.reason ?? (isSell ? "outcome-tokens" : "funds");
  const backingBlockMessage =
    backingBlockReason === "outcome-tokens"
      ? t("trade.insufficientOutcomeTokens")
      : t("trade.insufficientFunds");
  const buyNeedsTopUp = backingBlocked && backingBlockReason === "funds";

  useEffect(() => {
    if (controlledTradeTab == null) {
      setLocalActiveTab((current) => (current === "Liquidity" ? current : tradeSide));
    }
  }, [controlledTradeTab, tradeSide]);

  const selectTradeTab = (side: TradeSide) => {
    setLocalActiveTab(side);
    onTradeTabChange?.(side);
    onTradeSideChange?.(side);
  };

  const selectLiquidityTab = () => {
    setLocalActiveTab("Liquidity");
    onTradeTabChange?.("Liquidity");
  };

  const hasRouteLiquidity = (routeId: string, side: TradeSide): boolean => {
    const complementRouteId = complementRouteIdForMarket(market, routeId);
    return hasExecutableLiquidity({
      book: routeBookForMarket(market, routeId),
      complementBook: routeBookForMarket(market, complementRouteId),
      divisibility,
      side,
    });
  };

  const hasTradeLiquidity = (() => {
    if (activeTab === "Liquidity") return true;
    if (tradeSelection) {
      const resolved = selectedRouteIdsForMarket(market, tradeSelection);
      return resolved ? hasRouteLiquidity(resolved.selectedOutcomeSetId, activeTradeSide) : false;
    }

    const possibleOutcomeSets = possibleTradeSelections(market)
      .map((selection) => resolveOutcomeSets(market, selection))
      .filter(
        (outcomeSets): outcomeSets is NonNullable<ReturnType<typeof resolveOutcomeSets>> =>
          outcomeSets != null,
      );
    if (possibleOutcomeSets.length > 0) {
      return possibleOutcomeSets.some((outcomeSets) =>
        hasRouteLiquidity(outcomeSets.selectedOutcomeSetId, activeTradeSide),
      );
    }

    return routeIdsForMarket(market).some((routeId) =>
      hasRouteLiquidity(routeId, activeTradeSide),
    );
  })();

  const outcomeCount =
    market.type === "categorical"
      ? market.outcomes.length
      : market.type === "yesno"
        ? market.outcomes?.length ?? market.registeredPrimitiveOutcomeIds?.length ?? 2
        : market.registeredPrimitiveOutcomeIds?.length ?? 2;

  useEffect(() => {
    if (!isTradeAmountFocused) {
      setTradeAmountText(tradeAmount > 0 ? String(tradeAmount) : "");
    }
  }, [tradeAmount, isTradeAmountFocused]);

  const handleShareAmountBlur = () => {
    const trimmed = tradeAmountText.trim();
    if (trimmed === "") {
      onAmountChange?.(0);
      setTradeAmountText("");
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onAmountChange?.(0);
      setTradeAmountText("");
      return;
    }

    const rounded = Math.max(1, Math.round(parsed));
    onAmountChange?.(rounded);
    setTradeAmountText(String(rounded));
  };

  // Build confirm button text
  const getConfirmText = () => {
    if (isTradeSubmitting) return t("trade.submittingOrder");
    if (!walletReady) return t("wallet.startTrading");
    if (!tradeAmount || tradeAmount <= 0) return t("trade.enterAmount");
    if (buyNeedsTopUp) return t("trade.topUpWalletUnit", { unit: unitLabel });
    if (backingBlocked) return backingBlockMessage;
    if (marketOrderHasNoLiquidity) return t("trade.noExecutableLiquidity");
    const sideLabel = tradeSelection?.side.toUpperCase() ?? "";
    const amountLabel = shareCountLabel(tradeAmount);

    if (isSell && isLimit) return t("trade.confirmLimitSell", { amount: amountLabel });
    if (isSell) return t("trade.confirmSell", { side: sideLabel, amount: amountLabel });
    if (isLimit) return t("trade.confirmLimitBuy", { amount: amountLabel });
    return t("trade.confirmBuy", { side: sideLabel, amount: amountLabel });
  };

  if (market.type === "numeric") {
    return (
      <div
        data-trading-panel
        className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5"
      >
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
          {t("trade.title")}
        </h3>
        <p
          data-testid="numeric-trading-unavailable"
          className="py-4 text-sm text-slate-500 dark:text-slate-400"
        >
          {t("market.numericTradingUnavailable")}
        </p>
      </div>
    );
  }

  return (
    <div
      data-trading-panel
      className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5"
    >
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">
        {t("trade.title")}
      </h3>

      {!tradingDisabled && (
        <div role="tablist" aria-label={t("trade.title")} className="grid grid-cols-3 mb-4">
          {(["Buy", "Sell"] as const).map((side) => (
            <button
              key={side}
              type="button"
              role="tab"
              aria-selected={activeTab === side}
              data-testid={`trade-tab-${side.toLowerCase()}`}
              onClick={() => selectTradeTab(side)}
              className={`py-2.5 text-sm font-semibold transition-colors border-b-2 ${
                activeTab === side
                  ? "text-slate-900 dark:text-white border-slate-900 dark:border-white"
                  : "text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-700 dark:hover:text-slate-300"
              }`}
            >
              {t(`trade.${side.toLowerCase()}`)}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "Liquidity"}
            data-testid="trade-tab-liquidity"
            onClick={selectLiquidityTab}
            className={`py-2.5 text-sm font-semibold transition-colors border-b-2 ${
              activeTab === "Liquidity"
                ? "text-slate-900 dark:text-white border-slate-900 dark:border-white"
                : "text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            {t("market.liquidity")}
          </button>
        </div>
      )}

      {tradingDisabled ? (
        <div data-testid="closed-trade-liquidity" className="space-y-3 py-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("market.closedBannerDescription")}
          </p>
        </div>
      ) : activeTab === "Liquidity" ? (
        validDivisibility != null ? (
          <DepositStep
            conditionId={market.id}
            defaultAmountSats={0}
            outcomeCount={outcomeCount}
            baseAsset={baseAsset}
            divisibility={validDivisibility}
            presentation="detail"
          />
        ) : (
          <div data-testid="empty-trade-liquidity" className="space-y-3 py-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("trade.emptyBookDescription")}
            </p>
          </div>
        )
      ) : !hasTradeLiquidity ? (
        <div data-testid="empty-trade-liquidity" className="space-y-3 py-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("trade.emptyBookDescription")}
          </p>
          <button
            type="button"
            data-testid="open-liquidity-tab"
            onClick={selectLiquidityTab}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
          >
            {t("market.liquidity")}
          </button>
        </div>
      ) : (
        <>
          <MarketLimitToggle
            orderType={orderType}
            onOrderTypeChange={onOrderTypeChange}
            disabled={tradingDisabled}
          />

          {/* Outcomes based on market type */}
          {market.type === "yesno" && (
            <YesNoOutcomes
              market={market}
              tradeSelection={tradeSelection}
              tradeSide={activeTradeSide}
              onTradeSelect={onTradeSelect}
              disabled={tradingDisabled}
            />
          )}
          {market.type === "categorical" && (
            <CategoricalOutcomes
              market={market}
              tradeSelection={tradeSelection}
              tradeSide={activeTradeSide}
              onTradeSelect={onTradeSelect}
              disabled={tradingDisabled}
            />
          )}
        </>
      )}

      {/* Trade Form (shown when outcome selected) */}
      {!tradingDisabled && activeTab !== "Liquidity" && hasTradeLiquidity && tradeSelection && (
        <div className="mt-5 pt-5 border-t border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
              {t("trade.shares")}
            </span>
            <button
              onClick={onTradeClear}
              disabled={tradingDisabled}
              className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Sell-side balance shows outcome shares held. Buy-side wallet
              balance is intentionally omitted from this panel. */}
          {isSell && userHoldingShares != null && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
              {t("trade.balanceShares", { count: userHoldingShares.toLocaleString() })}
            </p>
          )}
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            {t("trade.wholeShareValue", { amount: wholeShareLabel })}
          </p>

          {/* Shares Input — one displayed share maps to a market-divisibility
              conditional-token face lot at the protocol boundary. No ₿ prefix:
              this is a share count, not a sats amount. */}
          <div className="relative mb-3">
            <input
              data-testid="trade-amount-input"
              type="number"
              disabled={tradingDisabled}
              value={tradeAmountText}
              onChange={(e) => {
                const next = e.target.value;
                setTradeAmountText(next);
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed > 0) {
                  onAmountChange?.(Math.max(1, Math.round(parsed)));
                } else if (next.trim() === "") {
                  onAmountChange?.(0);
                }
              }}
              onFocus={() => setIsTradeAmountFocused(true)}
              onBlur={() => {
                setIsTradeAmountFocused(false);
                handleShareAmountBlur();
              }}
              step={1}
              min={1}
              placeholder="1"
              className="w-full pl-4 pr-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Quick Amount / Percentage Buttons */}
          <div className="flex gap-2 mb-4">
            {isSell
              ? QUICK_SELL_PERCENTAGES.map((pct) => {
                  const calculatedAmount = userHoldingShares
                    ? Math.round((userHoldingShares * pct) / 100)
                    : 0;
                  return (
                    <button
                      key={pct}
                      disabled={tradingDisabled}
                      onClick={() => onAmountChange?.(calculatedAmount)}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                        tradeAmount === calculatedAmount && calculatedAmount > 0
                          ? "bg-blue-500 text-white"
                          : "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600"
                      }`}
                    >
                      {pct}%
                    </button>
                  );
                })
              : QUICK_SHARE_PRESETS.map((shares) => (
                  <button
                    key={shares}
                    disabled={tradingDisabled}
                    onClick={() => onAmountChange?.(Math.round(tradeAmount || 0) + shares)}
                    className="flex-1 py-2 rounded-lg text-xs font-medium transition-colors bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600"
                  >
                    +{shares}
                  </button>
                ))}
          </div>

          {/* Limit Price Input (shown for limit orders, below amount) */}
          {isLimit && (
            <LimitPriceInput
              limitPrice={limitPrice}
              baseAsset={baseAsset}
              divisibility={divisibility}
              onLimitPriceChange={onLimitPriceChange}
              disabled={tradingDisabled}
            />
          )}

          {/* Market Order Preview */}
          {!isLimit && tradePreview && tradeAmount > 0 && (
            <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 space-y-2 mb-4">
              {tradePreview.hasExecutableLiquidity === false ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  {t("trade.noExecutableLiquidityDescription")}
                </div>
              ) : (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500 dark:text-slate-400">
                      {t("trade.pricePerShareLabel")}
                    </span>
                    <span
                      className="font-medium text-slate-600 dark:text-slate-300"
                      data-testid="trade-average-execution-price"
                    >
                      {formatPriceWithProbability(
                        tradePreview.averageExecutionPrice ?? 0,
                        divisibility,
                        baseAsset,
                      )}
                    </span>
                  </div>
                </>
              )}
              {tradePreview.hasExecutableLiquidity !== false && (
                <>
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between">
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {t("trade.quotePayment")}
                    </span>
                    <span
                      className="font-bold text-blue-600 dark:text-blue-400"
                      data-testid="trade-total-cost"
                    >
                      {formatAmount(tradePreview.totalCost - tradePreview.mintFee)}
                    </span>
                  </div>
                  {tradePreview.mintFee > 0 && (
                    <div className="flex justify-between text-sm">
                      <span
                        className="text-slate-500 dark:text-slate-400"
                        title={t("trade.mintFeeTooltip")}
                      >
                        {t("trade.mintFee")}
                      </span>
                      <span
                        className="font-medium text-slate-600 dark:text-slate-300"
                        data-testid="trade-mint-fee"
                      >
                        {formatAmount(tradePreview.mintFee)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500 dark:text-slate-400">
                      {t("trade.estimatedSettlementFee")}
                    </span>
                    <span
                      className="font-medium text-slate-600 dark:text-slate-300"
                      data-testid="trade-settlement-fee"
                    >
                      {formatAmount(estimatedSettlementFee)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {t("trade.totalWithFee")}
                    </span>
                    <span
                      className="font-bold text-blue-600 dark:text-blue-400"
                      data-testid="trade-grand-total"
                    >
                      {formatAmount(tradePreview.totalCost + estimatedSettlementFee)}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Limit Order Preview */}
          {isLimit && limitOrderPreview && tradeAmount > 0 && (
            <LimitOrderPreviewSection
              preview={limitOrderPreview}
              divisibility={divisibility}
              baseAsset={baseAsset}
              formatAmount={formatAmount}
            />
          )}

          {tradeSubmitStatus && (
            <div
              role="status"
              data-testid="trade-submit-status"
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                tradeSubmitStatus.kind === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                  : tradeSubmitStatus.kind === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">{tradeSubmitStatus.message}</span>
                {onTradeSubmitStatusDismiss && (
                  <button
                    type="button"
                    onClick={onTradeSubmitStatusDismiss}
                    aria-label={t("common.close")}
                    className="rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}

          {backingBlocked && (
            <div
              role="status"
              data-testid="trade-feasibility-status"
              className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>{backingBlockMessage}</span>
              </div>
            </div>
          )}

          {/* Optional Comment with Trade */}
          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">
              {t("trade.comment")}
            </label>
            <textarea
              value={tradeComment}
              disabled={tradingDisabled}
              onChange={(e) => setTradeComment(e.target.value.slice(0, 280))}
              placeholder={t("trade.commentPlaceholder")}
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
              if (tradingDisabled) return;
              if (!walletReady) {
                onWalletRequired?.(tradeComment.trim() || undefined);
                return;
              }
              if (buyNeedsTopUp) {
                const comment = tradeComment.trim();
                onTopUpRequired?.(comment || undefined);
                return;
              }
              const comment = tradeComment.trim();
              onTradeConfirm?.(comment || undefined);
              if (comment) {
                onCommentPost?.(comment);
                setTradeComment("");
              }
            }}
            disabled={
              isTradeSubmitting ||
              tradingDisabled ||
              (buyNeedsTopUp ? !onTopUpRequired : backingBlocked) ||
              marketOrderHasNoLiquidity ||
              (walletReady && (!tradeAmount || tradeAmount <= 0))
            }
            title={backingBlocked && !buyNeedsTopUp ? backingBlockMessage : undefined}
            className={`w-full py-3 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed ${
              !walletReady
                ? "bg-[#f7931a] hover:bg-[#e8850f] text-white"
                : "bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white"
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
  );
}
