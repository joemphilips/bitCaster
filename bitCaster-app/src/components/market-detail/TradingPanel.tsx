import React, { useState, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import type {
  MarketDetail,
  TradeSelection,
  FokOrderPreviewState,
  TradeFeeFacts,
  TradeSide,
  TradeTab,
  OrderType,
  YesNoMarketDetail,
  CategoricalMarketDetail,
  SellHoldingsState,
  TradeFeasibilityReason,
} from "@/types/market-detail";
import type { UseFokOrderCapacityPreviewResult } from "@/hooks/useFokOrderCapacityPreview";
import { useTranslation } from "react-i18next";
import {
  formatPricePercentage,
  formatShareFace,
  marketUnitLabel,
  type MarketBaseAsset,
  normalizeMarketBaseAsset,
  parseMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { DepositStep } from "@/components/market-creation/DepositStep";
import { OutcomeLabel } from "@/components/shared/OutcomeLabel";
import { resolveOutcomeSets } from "@/lib/outcomeSets";
import { tradeFeasibilityMessageKey } from "./tradeFeasibilityMessage";

function formatNullablePrice(
  price: number | null,
  divisibility: number,
  authority: Pick<MarketDetail, "latestConfirmedTrades" | "latestConfirmedTradesValid">,
  noTrades: string,
  priceUnavailable: string,
): React.ReactNode {
  if (authority.latestConfirmedTradesValid !== true) {
    return <span aria-label={priceUnavailable}>—</span>;
  }
  if (price == null) return <span aria-label={noTrades}>—</span>;
  return formatPricePercentage(price, divisibility);
}

interface TradingPanelProps {
  market: MarketDetail;
  tradeSelection: TradeSelection | null;
  tradeAmount: number;
  tradePreview: FokOrderPreviewState | null;
  tradeFeeFacts?: TradeFeeFacts | null;
  feeConsentCurrent?: boolean;
  tradeSide: TradeSide;
  orderType: OrderType;
  limitOrderPreview?: FokOrderPreviewState | null;
  limitPrice?: number;
  tradeCapacityPreview?: UseFokOrderCapacityPreviewResult | null;
  automaticLimitPrice?: number | null;
  sellHoldings?: SellHoldingsState;
  tradeSubmitStatus?: {
    kind: "info" | "success" | "error";
    message: string;
  } | null;
  onTradeSubmitStatusDismiss?: () => void;
  tradeFeasibility?: {
    canBack: boolean;
    reason?: TradeFeasibilityReason;
    message?: string;
  } | null;
  onTradeFeasibilityRetry?: () => void;
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
  onFundingCredited?: () => void;
  disabled?: boolean;
}

type TradingTab = TradeTab;

// Buy quick-presets are user-facing display shares. Boundary code maps each
// display share to a market-divisibility-sized conditional-token face lot
// before submit.
const QUICK_SHARE_PRESETS = [1, 5, 10, 50];
const QUICK_SELL_PERCENTAGES = [25, 50, 75, 100];

type SellOutcomeAvailability =
  | { status: "loading" | "unavailable" }
  | { status: "zero"; reserved: boolean; ownedShares: number | null }
  | { status: "available"; shares: number; ownedShares: number | null };

function sellOutcomeAvailability(
  market: MarketDetail,
  sellHoldings: SellHoldingsState | undefined,
  selection: TradeSelection,
): SellOutcomeAvailability {
  if (sellHoldings?.status === "loading" || sellHoldings === undefined) {
    return { status: "loading" };
  }
  if (sellHoldings.status === "unavailable") return { status: "unavailable" };
  const outcomeSetId = resolveOutcomeSets(market, selection)?.selectedOutcomeSetId;
  if (outcomeSetId === undefined) return { status: "unavailable" };
  const holding = sellHoldings.byOutcomeSetId.get(outcomeSetId) ?? {
    selectableSubunits: 0,
    reservedSubunits: 0,
  };
  const divisibility = parseMarketDivisibility(market.divisibility);
  if (divisibility === null) return { status: "unavailable" };
  const sharesAvailableToSell = Math.floor(holding.selectableSubunits / divisibility);
  const wholeOwnedShares =
    (BigInt(holding.selectableSubunits) + BigInt(holding.reservedSubunits)) / BigInt(divisibility);
  const ownedShares =
    wholeOwnedShares <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wholeOwnedShares) : null;
  return sharesAvailableToSell > 0
    ? { status: "available", shares: sharesAvailableToSell, ownedShares }
    : { status: "zero", reserved: holding.reservedSubunits > 0, ownedShares };
}

function sellAvailabilityMessage(availability: SellOutcomeAvailability): {
  key: string;
  options?: Record<string, string>;
} {
  switch (availability.status) {
    case "loading":
      return { key: "trade.sellHoldingsLoading" };
    case "unavailable":
      return { key: "trade.sellHoldingsUnavailable" };
    case "zero":
      return {
        key: availability.reserved ? "trade.sellHoldingsReserved" : "trade.sellHoldingsZero",
      };
    case "available":
      if (availability.ownedShares === null) {
        return {
          key: "trade.sellHoldingsSelectableOnly",
          options: { formattedCount: availability.shares.toLocaleString() },
        };
      }
      return {
        key: "trade.sellHoldingsAvailable",
        options: {
          ownedCount: availability.ownedShares.toLocaleString(),
          selectableCount: availability.shares.toLocaleString(),
        },
      };
  }
}

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
  sellHoldings,
  onTradeSelect,
  disabled = false,
}: {
  market: YesNoMarketDetail;
  tradeSelection: TradeSelection | null;
  tradeSide: TradeSide;
  sellHoldings?: SellHoldingsState;
  onTradeSelect?: (selection: TradeSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isSell = tradeSide === "Sell";
  const yesAvailability = sellOutcomeAvailability(market, sellHoldings, { side: "yes" });
  const noAvailability = sellOutcomeAvailability(market, sellHoldings, { side: "no" });
  const availabilityText = (availability: SellOutcomeAvailability) => {
    const message = sellAvailabilityMessage(availability);
    return t(message.key, message.options);
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        data-testid="trade-outcome-yes"
        aria-label={isSell ? t("trade.sellYes") : t("common.yes")}
        aria-describedby={isSell ? "trade-outcome-yes-availability" : undefined}
        disabled={disabled || (isSell && yesAvailability.status !== "available")}
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
        {isSell && (
          <span
            id="trade-outcome-yes-availability"
            data-testid="trade-outcome-yes-availability"
            className="mt-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
          >
            {availabilityText(yesAvailability)}
          </span>
        )}
      </button>

      <button
        data-testid="trade-outcome-no"
        aria-label={isSell ? t("trade.sellNo") : t("common.no")}
        aria-describedby={isSell ? "trade-outcome-no-availability" : undefined}
        disabled={disabled || (isSell && noAvailability.status !== "available")}
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
        {isSell && (
          <span
            id="trade-outcome-no-availability"
            data-testid="trade-outcome-no-availability"
            className="mt-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
          >
            {availabilityText(noAvailability)}
          </span>
        )}
      </button>
    </div>
  );
}

function CategoricalOutcomes({
  market,
  tradeSelection,
  tradeSide,
  sellHoldings,
  onTradeSelect,
  disabled = false,
}: {
  market: CategoricalMarketDetail;
  tradeSelection: TradeSelection | null;
  tradeSide: TradeSide;
  sellHoldings?: SellHoldingsState;
  onTradeSelect?: (selection: TradeSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isSell = tradeSide === "Sell";
  const availabilityText = (availability: SellOutcomeAvailability) => {
    const message = sellAvailabilityMessage(availability);
    return t(message.key, message.options);
  };
  return (
    <ScrollableContainer className="space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-hide">
      {market.outcomes.map((outcome, outcomeIndex) => {
        const isSelected = tradeSelection?.outcomeId === outcome.id;
        const yesSelection = { side: "yes" as const, outcomeId: outcome.id };
        const noSelection = { side: "no" as const, outcomeId: outcome.id };
        const yesAvailability = sellOutcomeAvailability(market, sellHoldings, yesSelection);
        const noAvailability = sellOutcomeAvailability(market, sellHoldings, noSelection);
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
              <OutcomeLabel
                outcome={outcome}
                className="mr-2 min-w-0 text-sm font-medium"
                labelClassName="truncate text-slate-900 dark:text-white"
              />
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
                aria-label={isSell ? t("trade.sellYes") : t("trade.buyYes")}
                aria-describedby={isSell ? `sell-holding-yes-${outcomeIndex}` : undefined}
                disabled={disabled || (isSell && yesAvailability.status !== "available")}
                onClick={() => onTradeSelect?.(yesSelection)}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === "yes"
                    ? "bg-emerald-500 text-white"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                }`}
              >
                <span>{isSell ? t("trade.sellYes") : t("trade.buyYes")}</span>
                {isSell && (
                  <span
                    id={`sell-holding-yes-${outcomeIndex}`}
                    data-testid={`sell-holding-yes-${outcome.id}`}
                    className="ml-1 block text-[10px] font-normal"
                  >
                    {availabilityText(yesAvailability)}
                  </span>
                )}
              </button>
              <button
                data-testid={`buy-no-${outcome.label}`}
                aria-label={isSell ? t("trade.sellNo") : t("trade.buyNo")}
                aria-describedby={isSell ? `sell-holding-no-${outcomeIndex}` : undefined}
                disabled={disabled || (isSell && noAvailability.status !== "available")}
                onClick={() => onTradeSelect?.(noSelection)}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
                  isSelected && tradeSelection?.side === "no"
                    ? "bg-red-500 text-white"
                    : "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                }`}
              >
                <span>{isSell ? t("trade.sellNo") : t("trade.buyNo")}</span>
                {isSell && (
                  <span
                    id={`sell-holding-no-${outcomeIndex}`}
                    data-testid={`sell-holding-no-${outcome.id}`}
                    className="ml-1 block text-[10px] font-normal"
                  >
                    {availabilityText(noAvailability)}
                  </span>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </ScrollableContainer>
  );
}

function LimitPriceInput({
  limitPrice,
  baseAsset,
  divisibility,
  isSell,
  onLimitPriceChange,
  disabled = false,
}: {
  limitPrice: number;
  baseAsset: MarketBaseAsset;
  divisibility: number;
  isSell: boolean;
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
        {t(isSell ? "trade.minimumSellPrice" : "trade.maximumBuyPrice")}
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

function PriceProtectionSection({
  enabled,
  isSell,
  limitPrice,
  automaticLimitPrice,
  baseAsset,
  divisibility,
  onEnabledChange,
  onLimitPriceChange,
  disabled = false,
}: {
  enabled: boolean;
  isSell: boolean;
  limitPrice: number;
  automaticLimitPrice: number | null;
  baseAsset: MarketBaseAsset;
  divisibility: number;
  onEnabledChange?: (enabled: boolean) => void;
  onLimitPriceChange?: (price: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const protectedPrice = enabled ? limitPrice : automaticLimitPrice;
  const priceLabel = isSell ? t("trade.minimumSellPrice") : t("trade.maximumBuyPrice");

  return (
    <div
      data-testid="trade-price-protection"
      className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {t("trade.priceProtectionMode", { mode: t(enabled ? "trade.custom" : "trade.auto") })}
        </p>
        {enabled ? (
          <button
            type="button"
            data-testid="trade-use-auto"
            disabled={disabled}
            onClick={() => onEnabledChange?.(false)}
            className="text-sm text-blue-600 underline disabled:opacity-50 dark:text-blue-400"
          >
            {t("trade.useAuto")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="trade-price-protection-toggle"
            disabled={disabled || automaticLimitPrice === null}
            onClick={() => onEnabledChange?.(true)}
            className="text-sm text-blue-600 underline disabled:opacity-50 dark:text-blue-400"
          >
            {t("trade.changePriceLimit")}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t("trade.autoPriceRule")}</p>
      {enabled ? (
        <div className="mt-3">
          <div data-testid="trade-protected-price" data-price-numerator={String(limitPrice)}>
            <LimitPriceInput
              limitPrice={limitPrice}
              baseAsset={baseAsset}
              divisibility={divisibility}
              isSell={isSell}
              onLimitPriceChange={onLimitPriceChange}
              disabled={disabled}
            />
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400">{priceLabel}</span>
          <span
            data-testid="trade-protected-price"
            data-price-numerator={protectedPrice == null ? undefined : String(protectedPrice)}
            className="font-semibold text-slate-700 dark:text-slate-200"
          >
            {protectedPrice == null
              ? t("trade.priceLimitPending")
              : formatPriceWithProbability(protectedPrice, divisibility, baseAsset)}
          </span>
        </div>
      )}
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

function formatMsatSubunits(value: string | number | bigint): string {
  try {
    const amount = BigInt(value);
    const sign = amount < 0n ? "-" : "";
    const absolute = amount < 0n ? -amount : amount;
    const whole = absolute / 1_000n;
    const remainder = (absolute % 1_000n).toString().padStart(3, "0");
    return `${sign}${whole.toLocaleString()}.${remainder} sats`;
  } catch {
    return "—";
  }
}

function feeAssetLabel(asset: TradeFeeFacts["settlementAsset"]): string {
  return asset.kind === "regular" ? "sats" : "conditional tokens";
}

function formatFeeAmount(
  value: string | number | bigint,
  asset: TradeFeeFacts["settlementAsset"],
): string {
  const amount = formatMsatSubunits(value);
  return asset.kind === "regular" ? amount : `${amount} (${feeAssetLabel(asset)})`;
}

function previewReasonKey(reason: string, isSell: boolean): string {
  if (reason === "insufficient_liquidity") {
    return isSell
      ? "trade.previewReason.sellInsufficientLiquidity"
      : "trade.previewReason.buyInsufficientLiquidity";
  }
  if (reason === "price_limit") {
    return isSell ? "trade.previewReason.sellPriceLimit" : "trade.previewReason.buyPriceLimit";
  }
  return `trade.previewReason.${reason}`;
}

function displayedSelectedTokenPrice(
  price: number | null,
  priceDenominator: number,
  isComplement: boolean,
): number | null {
  if (price === null || !isComplement) return price;
  return priceDenominator - price;
}

function cashFeeSubunits(value: string, asset: TradeFeeFacts["settlementAsset"]): bigint {
  switch (asset.kind) {
    case "regular":
      return BigInt(value);
    case "conditional":
      return 0n;
    default:
      throw new Error("Unsupported fee asset");
  }
}

function FokOrderPreviewSection({
  preview,
  capacityPreview,
  divisibility,
  baseAsset,
  feeFacts,
  feeConsentCurrent,
  feeCheckFailed,
  isSell,
  isComplement,
}: {
  preview: FokOrderPreviewState | null;
  capacityPreview: UseFokOrderCapacityPreviewResult | null;
  divisibility: number;
  baseAsset: MarketBaseAsset;
  feeFacts: TradeFeeFacts | null | undefined;
  feeConsentCurrent: boolean;
  feeCheckFailed: boolean;
  isSell: boolean;
  isComplement: boolean;
}) {
  const { t } = useTranslation();
  if (preview == null || preview.status === "idle") return null;
  if (preview.status === "loading") {
    return (
      <div
        data-testid="fok-preview-loading"
        className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400"
      >
        {t("trade.previewLoading")}
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <div
        data-testid="fok-preview-error"
        className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300"
      >
        <p>{preview.error ?? t("trade.previewUnavailable")}</p>
        {preview.retryAfterSeconds != null && (
          <p className="mt-1">
            {t("trade.previewRetryAfter", { seconds: preview.retryAfterSeconds })}
          </p>
        )}
        <button
          type="button"
          data-testid="fok-preview-retry"
          className="mt-3 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/40"
          onClick={preview.refresh}
        >
          {t("trade.previewRetry")}
        </button>
      </div>
    );
  }

  const response = preview.response;
  if (response == null) return null;
  const capacityResponse = capacityPreview?.status === "ready" ? capacityPreview.response : null;
  const priceLimitFacts =
    response.reason === "price_limit" &&
    response.previewRevision !== null &&
    capacityResponse?.status === "ready" &&
    capacityResponse.previewRevision === response.previewRevision &&
    capacityResponse.referencePrice !== null &&
    capacityResponse.effectiveLimitPrice !== null
      ? {
          referencePrice: capacityResponse.referencePrice,
          effectiveLimitPrice: capacityResponse.effectiveLimitPrice,
          priceDenominator:
            capacityResponse.priceDenominator ?? response.priceDenominator ?? divisibility,
        }
      : null;
  if (!response.fullFillAvailable) {
    return (
      <div
        data-testid="fok-preview-nonfillable"
        className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
      >
        <p>
          {t(previewReasonKey(response.reason, isSell), {
            defaultValue: t("trade.previewNotFillable"),
          })}
        </p>
        {priceLimitFacts !== null && (
          <div data-testid="fok-preview-price-limit-details" className="mt-2 space-y-1">
            <p data-testid="fok-preview-current-executable-price">
              {t("trade.previewCurrentExecutablePrice", {
                price: formatPricePercentage(
                  priceLimitFacts.referencePrice,
                  priceLimitFacts.priceDenominator,
                ),
              })}
            </p>
            <p data-testid="fok-preview-selected-price-limit">
              {t(isSell ? "trade.minimumSellPrice" : "trade.maximumBuyPrice")}:{" "}
              {formatPricePercentage(
                priceLimitFacts.effectiveLimitPrice,
                priceLimitFacts.priceDenominator,
              )}
            </p>
          </div>
        )}
        {response.reason === "insufficient_liquidity" && response.subsidyMayHelp === true && (
          <p data-testid="fok-preview-subsidy" className="mt-2">
            {t("trade.previewSubsidyMayHelp")}
          </p>
        )}
        {response.reason === "temporarily_unavailable" && (
          <button
            type="button"
            data-testid="fok-preview-response-retry"
            className="mt-3 underline"
            onClick={preview.refresh}
          >
            {t("trade.previewRetry")}
          </button>
        )}
      </div>
    );
  }

  const previewDenominator = response.priceDenominator ?? divisibility;
  const currentSelectedTokenPrice = displayedSelectedTokenPrice(
    response.currentLatestTradePrice,
    previewDenominator,
    isComplement,
  );
  const projectedSelectedTokenPrice = displayedSelectedTokenPrice(
    response.projectedFinalPrice,
    previewDenominator,
    isComplement,
  );
  const hasRegularSettlementAsset = feeFacts?.settlementAsset.kind === "regular";
  const hasRegularPreparationAsset = feeFacts?.sourcePreparationAsset.kind === "regular";
  const hasRegularConsolidationAsset = feeFacts?.consolidationAsset.kind === "regular";
  const preparationCashCost =
    feeFacts == null
      ? null
      : cashFeeSubunits(feeFacts.sourcePreparationFeeSubunits, feeFacts.sourcePreparationAsset) +
        cashFeeSubunits(feeFacts.consolidationFeeSubunits, feeFacts.consolidationAsset);
  const quotePayment = response.quotePaymentSubunits;
  const settlementFee = feeFacts?.settlementInputFeeSubunits;
  const buyTotal =
    !isSell &&
    quotePayment != null &&
    feeFacts != null &&
    hasRegularSettlementAsset &&
    hasRegularPreparationAsset &&
    hasRegularConsolidationAsset
      ? BigInt(quotePayment) +
        BigInt(feeFacts.settlementInputFeeSubunits) +
        BigInt(feeFacts.sourcePreparationFeeSubunits) +
        BigInt(feeFacts.consolidationFeeSubunits)
      : null;
  const sellNetProceeds =
    isSell &&
    quotePayment != null &&
    settlementFee != null &&
    hasRegularSettlementAsset &&
    preparationCashCost != null
      ? BigInt(quotePayment) - BigInt(settlementFee) - preparationCashCost
      : null;

  return (
    <div
      data-testid="fok-preview-ready"
      className="rounded-xl bg-slate-50 p-4 space-y-2 mb-4 dark:bg-slate-900"
    >
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">
          {t("trade.selectedAveragePrice")}
        </span>
        <span
          data-testid="trade-average-execution-price"
          className="font-medium text-slate-600 dark:text-slate-300"
        >
          {response.averagePrice == null
            ? "—"
            : formatPriceWithProbability(response.averagePrice, previewDenominator, baseAsset)}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t("trade.selectedWorstPrice")}</span>
        <span
          data-testid="trade-worst-price"
          className="font-medium text-slate-600 dark:text-slate-300"
        >
          {response.worstPrice == null
            ? "—"
            : formatPriceWithProbability(response.worstPrice, previewDenominator, baseAsset)}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">
          {t("trade.confirmedSelectedTokenPrice")}
        </span>
        <span
          data-testid="trade-current-latest-price"
          className="font-medium text-slate-600 dark:text-slate-300"
        >
          {currentSelectedTokenPrice == null
            ? t("trade.noTrades")
            : formatPricePercentage(currentSelectedTokenPrice, previewDenominator)}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t("trade.projectedFinalPrice")}</span>
        <span
          data-testid="trade-projected-final-price"
          className="font-medium text-slate-600 dark:text-slate-300"
        >
          {projectedSelectedTokenPrice == null
            ? "—"
            : formatPricePercentage(projectedSelectedTokenPrice, previewDenominator)}
        </span>
      </div>
      <div className="border-t border-slate-200 pt-2 dark:border-slate-700">
        <div className="flex justify-between font-medium">
          <span className="text-slate-700 dark:text-slate-300">
            {isSell ? t("trade.quoteProceeds") : t("trade.quotePayment")}
          </span>
          <span
            data-testid="trade-quote-payment"
            className="font-bold text-blue-600 dark:text-blue-400"
          >
            {response.quotePaymentSubunits == null
              ? "—"
              : formatMsatSubunits(String(response.quotePaymentSubunits))}
          </span>
        </div>
        {feeFacts != null ? (
          <>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                {t("trade.settlementInputFee")}
              </span>
              <span
                data-testid="trade-settlement-input-fee"
                className="text-slate-600 dark:text-slate-300"
              >
                {formatFeeAmount(feeFacts.settlementInputFeeSubunits, feeFacts.settlementAsset)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                {t("trade.sourcePreparationFee")}
              </span>
              <span
                data-testid="trade-source-preparation-fee"
                className="text-slate-600 dark:text-slate-300"
              >
                {formatFeeAmount(
                  feeFacts.sourcePreparationFeeSubunits,
                  feeFacts.sourcePreparationAsset,
                )}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                {t("trade.consolidationFee")}
              </span>
              <span
                data-testid="trade-consolidation-fee"
                className="text-slate-600 dark:text-slate-300"
              >
                {formatFeeAmount(feeFacts.consolidationFeeSubunits, feeFacts.consolidationAsset)}
              </span>
            </div>
            {buyTotal != null && (
              <div className="mt-2 flex justify-between font-medium">
                <span className="text-slate-700 dark:text-slate-300">
                  {t("trade.totalWithFee")}
                </span>
                <span
                  data-testid="trade-grand-total"
                  className="font-bold text-blue-600 dark:text-blue-400"
                >
                  {formatMsatSubunits(buyTotal)}
                </span>
              </div>
            )}
            {sellNetProceeds != null && (
              <div className="mt-2 flex justify-between font-medium">
                <span className="text-slate-700 dark:text-slate-300">{t("trade.netProceeds")}</span>
                <span
                  data-testid="trade-net-proceeds"
                  className="font-bold text-blue-600 dark:text-blue-400"
                >
                  {formatMsatSubunits(sellNetProceeds)}
                </span>
              </div>
            )}
            {!feeConsentCurrent && (
              <p
                data-testid="trade-fee-consent-required"
                className="pt-2 text-xs text-amber-700 dark:text-amber-300"
              >
                {t("trade.feeConsentRequired")}
              </p>
            )}
          </>
        ) : !feeCheckFailed ? (
          <p
            data-testid="trade-fees-loading"
            className="pt-2 text-xs text-slate-500 dark:text-slate-400"
          >
            {t("trade.feesLoading")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function TradingPanel({
  market,
  tradeSelection,
  tradeAmount,
  tradePreview,
  tradeFeeFacts,
  feeConsentCurrent = false,
  tradeSide,
  orderType,
  limitOrderPreview,
  limitPrice = 50,
  tradeCapacityPreview = null,
  automaticLimitPrice = null,
  onTradeSelect,
  onTradeClear,
  onAmountChange,
  onTradeConfirm,
  onCommentPost,
  sellHoldings,
  tradeSubmitStatus,
  onTradeSubmitStatusDismiss,
  tradeFeasibility,
  onTradeFeasibilityRetry,
  isTradeSubmitting = false,
  onTradeSideChange,
  tradeTab: controlledTradeTab,
  onTradeTabChange,
  onOrderTypeChange,
  onLimitPriceChange,
  walletReady = true,
  onWalletRequired,
  onTopUpRequired,
  onFundingCredited,
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
  const shareCountLabel = (shares: number) =>
    t("trade.shareCount", {
      count: shares,
      formattedCount: shares.toLocaleString(),
    });
  const [tradeAmountText, setTradeAmountText] = useState(
    tradeAmount > 0 ? String(tradeAmount) : "",
  );
  const [isTradeAmountFocused, setIsTradeAmountFocused] = useState(false);
  const selectedSellAvailability =
    isSell && tradeSelection !== null
      ? sellOutcomeAvailability(market, sellHoldings, tradeSelection)
      : null;
  const userHoldingShares =
    selectedSellAvailability?.status === "available" || selectedSellAvailability?.status === "zero"
      ? selectedSellAvailability.ownedShares
      : null;
  const sellShareLimit =
    selectedSellAvailability?.status === "available" ? selectedSellAvailability.shares : null;
  const selectedSellAmountUnavailable =
    isSell &&
    tradeSelection !== null &&
    (selectedSellAvailability?.status !== "available" ||
      sellShareLimit === null ||
      (tradeAmount > 0 && tradeAmount > sellShareLimit));
  const selectedSellStatusMessage = (() => {
    if (!isSell || selectedSellAvailability === null) return null;
    if (
      selectedSellAvailability.status === "available" &&
      tradeAmount > 0 &&
      sellShareLimit !== null &&
      tradeAmount > sellShareLimit
    ) {
      return t("trade.sellHoldingsInsufficient");
    }
    if (selectedSellAvailability.status === "available") return null;
    const message = sellAvailabilityMessage(selectedSellAvailability);
    return t(message.key, message.options);
  })();
  const tradingDisabled = disabled;
  const previewResponse = (isLimit ? limitOrderPreview : tradePreview)?.response ?? null;
  const selectedTokenIsComplement =
    tradeSelection !== null &&
    resolveOutcomeSets(market, tradeSelection)?.tokenSide === "Complement";
  const previewIsFillable =
    (isLimit ? limitOrderPreview : tradePreview)?.status === "ready" &&
    previewResponse?.fullFillAvailable === true &&
    feeConsentCurrent;
  const previewNeedsAttention = !!tradeSelection && tradeAmount > 0 && !previewIsFillable;
  const backingBlocked = walletReady && tradeFeasibility?.canBack === false;
  const backingBlockReason = tradeFeasibility?.reason ?? (isSell ? "outcome-tokens" : "funds");
  const backingBlockMessage = t(tradeFeasibilityMessageKey(backingBlockReason));
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

  const outcomeCount =
    market.type === "categorical"
      ? market.outcomes.length
      : market.type === "yesno"
        ? (market.outcomes?.length ?? market.registeredPrimitiveOutcomeIds?.length ?? 2)
        : (market.registeredPrimitiveOutcomeIds?.length ?? 2);

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
    if (isSell && selectedSellAmountUnavailable) {
      return selectedSellStatusMessage ?? t("trade.sellHoldingsUnavailable");
    }
    if (buyNeedsTopUp) return t("trade.topUpWalletUnit", { unit: unitLabel });
    if (backingBlocked) return backingBlockMessage;
    if (previewNeedsAttention && previewResponse?.fullFillAvailable === false) {
      return t("trade.previewNotFillable");
    }
    if (previewNeedsAttention && !buyNeedsTopUp) return t("trade.previewLoading");
    const sideLabel = tradeSelection?.side.toUpperCase() ?? "";
    const amountLabel = shareCountLabel(tradeAmount);

    if (isSell) return t("trade.confirmSell", { side: sideLabel, amount: amountLabel });
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
            onRequireWallet={walletReady ? undefined : () => onWalletRequired?.()}
            onCredited={onFundingCredited}
          />
        ) : (
          <div data-testid="empty-trade-liquidity" className="space-y-3 py-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("trade.emptyBookDescription")}
            </p>
          </div>
        )
      ) : (
        <>
          {/* Outcomes based on market type */}
          {market.type === "yesno" && (
            <YesNoOutcomes
              market={market}
              tradeSelection={tradeSelection}
              tradeSide={activeTradeSide}
              sellHoldings={sellHoldings}
              onTradeSelect={onTradeSelect}
              disabled={tradingDisabled}
            />
          )}
          {market.type === "categorical" && (
            <CategoricalOutcomes
              market={market}
              tradeSelection={tradeSelection}
              tradeSide={activeTradeSide}
              sellHoldings={sellHoldings}
              onTradeSelect={onTradeSelect}
              disabled={tradingDisabled}
            />
          )}
        </>
      )}

      {/* Trade Form (shown when outcome selected) */}
      {!tradingDisabled && activeTab !== "Liquidity" && tradeSelection && (
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
          {isSell && selectedSellStatusMessage !== null && (
            <p
              role="status"
              data-testid="sell-holding-status"
              className={`mb-2 text-xs ${
                selectedSellAmountUnavailable
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {selectedSellStatusMessage}
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
                  const calculatedAmount =
                    sellShareLimit === null ? 0 : Math.floor((sellShareLimit * pct) / 100);
                  return (
                    <button
                      key={pct}
                      data-testid={`trade-sell-percentage-${pct}`}
                      disabled={
                        tradingDisabled || sellShareLimit === null || calculatedAmount === 0
                      }
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

          <PriceProtectionSection
            enabled={isLimit}
            isSell={isSell}
            limitPrice={limitPrice}
            automaticLimitPrice={automaticLimitPrice}
            baseAsset={baseAsset}
            divisibility={divisibility}
            onEnabledChange={(enabled) => onOrderTypeChange?.(enabled ? "limit" : "market")}
            onLimitPriceChange={onLimitPriceChange}
            disabled={tradingDisabled}
          />

          {/* The engine preview is authoritative for both market and limit FOK. */}
          {tradeAmount > 0 && (
            <FokOrderPreviewSection
              preview={isLimit ? (limitOrderPreview ?? null) : tradePreview}
              capacityPreview={tradeCapacityPreview}
              divisibility={divisibility}
              baseAsset={baseAsset}
              feeFacts={tradeFeeFacts}
              feeConsentCurrent={feeConsentCurrent}
              feeCheckFailed={tradeFeasibility?.canBack === false}
              isSell={isSell}
              isComplement={selectedTokenIsComplement}
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
                {backingBlockReason === "unavailable" && onTradeFeasibilityRetry && (
                  <button type="button" onClick={onTradeFeasibilityRetry}>
                    {t("common.retry")}
                  </button>
                )}
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
              selectedSellAmountUnavailable ||
              (buyNeedsTopUp ? !onTopUpRequired : backingBlocked) ||
              (walletReady && !buyNeedsTopUp && previewNeedsAttention) ||
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
