import React, { useState, useRef, useEffect } from "react";
import { Droplet, TrendingUp, ChevronUp, ChevronDown, Heart, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getMarketThumbnail } from "@/lib/markets";
import { useBookmarkStore } from "@/stores/bookmarks";
import { useMarketState } from "@/hooks/useMarketState";
import { formatMarketSubunits, formatPricePercentage } from "@bitcaster/client-sdk/marketUnits";
import type {
  Market,
  YesNoMarket,
  CategoricalMarket,
  Outcome,
  ProductMarketDivisibility,
} from "@/types/market";

interface SecondaryMarketInfo {
  id: string;
  title: string;
}

interface MarketCardProps {
  market: Market;
  secondaryMarketInfos?: SecondaryMarketInfo[];
  onViewMarket?: (marketId: string) => void;
  onViewSecondaryMarket?: (baseMarketId: string, secondaryMarketId: string) => void;
  walletReady?: boolean;
}

/**
 * Renders the market's thumbnail. Falls back to a placeholder when the
 * matching engine has no stored thumbnail rather than emitting an empty
 * `url()` background-image — the empty-string variant fired a broken-asset
 * GET against `<base>/` and showed the slate gradient regardless (P6 P4.3).
 */
function MarketThumbnail({ market }: { market: { id: string; title: string; imageUrl: string } }) {
  const src = getMarketThumbnail(market);
  return (
    <div
      className="relative w-12 h-12 flex-shrink-0 rounded-lg overflow-hidden bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-700"
      data-testid="market-thumbnail"
    >
      {src ? (
        <img
          src={src}
          alt={market.title}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
          loading="lazy"
        />
      ) : (
        <div
          aria-hidden="true"
          data-testid="market-thumbnail-placeholder"
          className="absolute inset-0 flex items-center justify-center text-slate-500 dark:text-slate-400 text-sm font-bold uppercase"
        >
          {market.title.slice(0, 1)}
        </div>
      )}
    </div>
  );
}

function CategoricalOutcomes({
  outcomes,
  divisibility,
  priceAuthorityUnavailable,
  onYesClick,
  onNoClick,
}: {
  outcomes: Outcome[];
  divisibility: ProductMarketDivisibility;
  priceAuthorityUnavailable: boolean;
  onYesClick: (outcomeId: string, label: string) => void;
  onNoClick: (outcomeId: string, label: string) => void;
}) {
  const { t } = useTranslation();
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
  }, [outcomes]);

  const scroll = (direction: "up" | "down", e: React.MouseEvent) => {
    e.stopPropagation();
    if (scrollRef.current) {
      const scrollAmount = 100;
      scrollRef.current.scrollBy({
        top: direction === "up" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className="relative group/outcomes flex-1 flex flex-col min-h-0">
      {canScrollUp && (
        <button
          onClick={(e) => scroll("up", e)}
          className="absolute left-1/2 -translate-x-1/2 -top-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className="flex flex-col gap-2 overflow-y-auto flex-1 scrollbar-hide -mx-1 px-1 py-1"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {outcomes.map((outcome) => (
          <div
            key={outcome.id}
            className="flex-shrink-0 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2.5 border border-slate-200 dark:border-slate-700"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-400 truncate">
                {outcome.label}
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 ml-2">
                <span
                  aria-label={
                    outcome.odds == null
                      ? t(
                            priceAuthorityUnavailable
                            ? "market.priceUnavailable"
                            : "trade.noTrades",
                        )
                      : undefined
                  }
                >
                  {formatNullablePrice(outcome.odds, divisibility)}
                </span>
              </div>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onYesClick(outcome.id, outcome.label);
                }}
                className="flex-1 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 rounded text-emerald-600 dark:text-emerald-400 font-bold text-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                Yes
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onNoClick(outcome.id, outcome.label);
                }}
                className="flex-1 py-1.5 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 rounded text-rose-600 dark:text-rose-400 font-bold text-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                No
              </button>
            </div>
          </div>
        ))}
      </div>

      {canScrollDown && (
        <button
          onClick={(e) => scroll("down", e)}
          className="absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function SecondaryMarketsExpander({
  secondaryMarketInfos,
  isExpanded,
  onToggle,
  onViewSecondary,
}: {
  secondaryMarketInfos: SecondaryMarketInfo[];
  isExpanded: boolean;
  onToggle: (e: React.MouseEvent) => void;
  onViewSecondary: (secondaryId: string, e: React.MouseEvent) => void;
}) {
  if (!secondaryMarketInfos || secondaryMarketInfos.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        onClick={onToggle}
        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
      >
        <span>and...</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-1 animate-in fade-in-0 slide-in-from-top-2 duration-200">
          {secondaryMarketInfos.map((info) => (
            <button
              key={info.id}
              onClick={(e) => onViewSecondary(info.id, e)}
              className="w-full text-left px-3 py-2 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg border border-blue-200 dark:border-blue-800 transition-colors group/item"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-700 dark:text-slate-300 line-clamp-1 flex-1">
                  {info.title}
                </span>
                <ChevronRight className="w-3 h-3 text-blue-500 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function normalizeResolvedOutcome(outcome: string | undefined): string | undefined {
  const trimmed = outcome?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "yes") return "YES";
  if (trimmed.toLowerCase() === "no") return "NO";
  return trimmed;
}

function formatNullablePrice(price: number | null, divisibility: number): string {
  return price == null ? "—" : formatPricePercentage(price, divisibility);
}

export function MarketCard({
  market,
  secondaryMarketInfos,
  onViewMarket,
  onViewSecondaryMarket,
}: MarketCardProps) {
  const { t } = useTranslation();
  const [isSecondaryExpanded, setIsSecondaryExpanded] = useState(false);
  const isBookmarked = useBookmarkStore((s) => s.markets.includes(market.id));
  const toggleBookmark = useBookmarkStore((s) => s.toggle);
  const marketState = useMarketState(market.state);

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) return;
    if ((e.target as HTMLElement).closest("button")) return;
    if ((e.target as HTMLElement).closest("input")) return;
    onViewMarket?.(market.id);
  };

  const handleTitleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onViewMarket) return;
    e.preventDefault();
    onViewMarket(market.id);
  };

  const handleBuyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No local wallet gate here: the detail-page trade flow lazily creates
    // origin-local wallet material and prompts for backup before funding.
    onViewMarket?.(market.id);
  };

  const handleToggleSecondary = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSecondaryExpanded(!isSecondaryExpanded);
  };

  const handleViewSecondary = (secondaryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onViewSecondaryMarket?.(market.id, secondaryId);
  };

  const handleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleBookmark(market.id);
  };

  const renderClosedView = () => {
    const resolvedOutcome = normalizeResolvedOutcome(market.finalOutcome) ?? "Closed";
    const isYes = resolvedOutcome === "YES";
    const isNo = resolvedOutcome === "NO";
    const outcomeColor = isYes
      ? "text-emerald-600 dark:text-emerald-400"
      : isNo
        ? "text-rose-600 dark:text-rose-400"
        : "text-slate-900 dark:text-slate-100";

    return (
      <div className="flex-1 flex flex-col items-center justify-center py-6 text-center">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400 mb-2">
          Resolved
        </div>
        <div className={`text-4xl font-black tracking-tight ${outcomeColor}`}>
          {resolvedOutcome}
        </div>
      </div>
    );
  };

  const renderNormalView = () => {
    if (marketState === "Closed") return renderClosedView();

    if (market.type === "yesno") {
      const yesNoMarket = market as YesNoMarket;
      return (
        <div className="flex-1 flex flex-col justify-end">
          <div className="flex items-center justify-center gap-2 py-2 flex-1">
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
              {t("market.chance")}
            </span>
            <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              <span
                aria-label={
                  yesNoMarket.currentOdds.yes == null
                    ? t(
                        yesNoMarket.latestConfirmedTradesValid === false
                          ? "market.priceUnavailable"
                          : "trade.noTrades",
                      )
                    : undefined
                }
              >
                {formatNullablePrice(yesNoMarket.currentOdds.yes, yesNoMarket.divisibility)}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 flex-shrink-0">
            <button
              onClick={handleBuyClick}
              className="py-2.5 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white rounded-lg font-semibold text-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md"
            >
              {t("trade.buyYes")}
            </button>
            <button
              onClick={handleBuyClick}
              className="py-2.5 bg-rose-600 hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600 text-white rounded-lg font-semibold text-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md"
            >
              {t("trade.buyNo")}
            </button>
          </div>
        </div>
      );
    } else if (market.type === "categorical") {
      const categoricalMarket = market as CategoricalMarket;
      return (
        <CategoricalOutcomes
          outcomes={categoricalMarket.outcomes}
          divisibility={categoricalMarket.divisibility}
          priceAuthorityUnavailable={categoricalMarket.latestConfirmedTradesValid === false}
          onYesClick={() => onViewMarket?.(market.id)}
          onNoClick={() => onViewMarket?.(market.id)}
        />
      );
    }
  };

  const secondaryCount = secondaryMarketInfos?.length || 0;
  const expandedHeight = isSecondaryExpanded ? 280 + secondaryCount * 44 : 280;

  return (
    <div
      onClick={handleCardClick}
      data-testid={`market-card-${market.id}`}
      style={{ height: `${expandedHeight}px` }}
      className="group relative bg-white dark:bg-slate-900 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 transition-all duration-300 flex flex-col shadow-md hover:shadow-xl hover:scale-[1.01] cursor-pointer"
    >
      <div className="flex items-start gap-3 p-4 pb-2 flex-shrink-0">
        <MarketThumbnail market={market} />
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 line-clamp-2">
            <a
              href={`/markets/${market.id}`}
              onClick={handleTitleLinkClick}
              className="hover:text-blue-600 dark:hover:text-blue-400"
            >
              {market.title}
            </a>
          </h3>
          {secondaryMarketInfos && secondaryMarketInfos.length > 0 && (
            <SecondaryMarketsExpander
              secondaryMarketInfos={secondaryMarketInfos}
              isExpanded={isSecondaryExpanded}
              onToggle={handleToggleSecondary}
              onViewSecondary={handleViewSecondary}
            />
          )}
        </div>
      </div>

      <div className="px-4 pb-4 flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col justify-between mt-3 min-h-0">
          {renderNormalView()}
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400 pt-2 mt-auto border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div
            className="flex min-w-0 items-center gap-1 font-mono font-semibold text-amber-600 dark:text-amber-400"
            title={t("market.volume")}
            aria-label={t("market.volume")}
          >
            <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">
              {formatMarketSubunits(market.volumeLifetimeSubunits, market.baseAsset)}
            </span>
          </div>
          <div
            className="flex items-center gap-1"
            title={t("market.botBudgetLabel")}
            aria-label={t("market.botBudgetLabel")}
            data-testid="market-bot-budget"
          >
            <Droplet className="w-3.5 h-3.5" />
            <span className="font-mono font-medium">
              {formatMarketSubunits(market.ammBotBudgetSubunits, market.baseAsset)}
            </span>
          </div>
          <button
            onClick={handleBookmark}
            className={`flex items-center cursor-pointer transition-colors ${
              isBookmarked ? "text-rose-500" : "hover:text-rose-500"
            }`}
            title={isBookmarked ? "Remove bookmark" : "Bookmark"}
            aria-pressed={isBookmarked}
          >
            <Heart className="w-3.5 h-3.5" fill={isBookmarked ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
    </div>
  );
}
