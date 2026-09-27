import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { TagBar } from "./TagBar";
import { SortBar } from "./SortBar";
import { FilterControls } from "./FilterControls";
import { MarketCard } from "./MarketCard";
import { useWalletStore } from "@/stores/wallet";
import { joinMarket, leaveMarket, onMarketFundingUpdated } from "@/lib/marketHub";
import { mergeMarketFundingObservation, type MarketFundingObservation } from "@/lib/marketFunding";
import type { MarketDiscoveryProps, MarketType, VolumeRange, Market } from "@/types/market";
import type { ReactNode, RefCallback } from "react";

type DiscoveryStatus = "ready" | "loading" | "refreshing" | "error" | "empty" | "no-match";

interface MarketDiscoveryExtraProps {
  status?: DiscoveryStatus;
  statusMessage?: string;
  statusAction?: ReactNode;
  onClearAll?: () => void;
}

function marketFundingObservation(market: Market): MarketFundingObservation {
  return {
    ammBotBudgetSubunits: market.ammBotBudgetSubunits,
    fundingRevision: market.fundingRevision ?? null,
  };
}

function sameFundingObservation(
  left: MarketFundingObservation,
  right: MarketFundingObservation,
): boolean {
  return (
    left.ammBotBudgetSubunits === right.ammBotBudgetSubunits &&
    left.fundingRevision === right.fundingRevision
  );
}

function MarketFundingSubscription({
  conditionId,
  routeMarketId,
  visible,
  onFundingObservation,
}: {
  conditionId: string;
  routeMarketId: string | undefined;
  visible: boolean;
  onFundingObservation: (conditionId: string, observation: MarketFundingObservation) => void;
}) {
  useEffect(() => {
    if (!visible || !routeMarketId) return;

    let active = true;
    let joinSettled = false;
    let released = false;
    const releaseJoin = () => {
      if (released) return;
      released = true;
      void leaveMarket(routeMarketId);
    };

    // Register first. JoinMarket immediately sends the current committed
    // funding pair, and it may arrive before the REST projection catches up.
    const unsubscribe = onMarketFundingUpdated(conditionId, (message) => {
      if (active && message.conditionId === conditionId) {
        onFundingObservation(conditionId, message);
      }
    });

    // joinMarket reserves its client-side refcount before its first await.
    // Delay this owner's leave until that promise settles to avoid a late join
    // after an unmount racing the hub connection startup.
    void joinMarket(routeMarketId)
      .then(() => {
        joinSettled = true;
        if (!active) releaseJoin();
      })
      .catch((error: unknown) => {
        joinSettled = true;
        console.warn("[MarketDiscovery] market funding subscription failed:", error);
        // joinMarket increments its refcount before asynchronous startup can
        // fail, so release that reservation even when the join rejects.
        releaseJoin();
      });

    return () => {
      active = false;
      unsubscribe();
      if (joinSettled) releaseJoin();
    };
  }, [conditionId, onFundingObservation, routeMarketId, visible]);

  return null;
}

export function MarketDiscovery({
  categoryTags,
  markets,
  selectedTags,
  sort,
  onSortChange,
  searchQuery = "",
  onSearch: _onSearch,
  onTagSelect,
  onClearTags,
  onMarketTypeChange,
  onVolumeRangeChange,
  onClosingDateChange,
  onIncludeClosedChange,
  onViewMarket,
  hasMore = false,
  onLoadMore,
  onViewSecondaryMarket,
  status = "ready",
  statusMessage,
  statusAction,
  onClearAll,
}: MarketDiscoveryProps & MarketDiscoveryExtraProps) {
  const { t } = useTranslation();
  const walletReady = useWalletStore((s) => s.setupComplete);
  const observerTarget = useRef<HTMLDivElement>(null);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [selectedMarketTypes, setSelectedMarketTypes] = useState<MarketType[]>([]);
  const [volumeRange, setVolumeRange] = useState<VolumeRange>({});
  const [closingInDays, setClosingInDays] = useState<number | undefined>(undefined);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [visibleFundingMarketIds, setVisibleFundingMarketIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [fundingObservations, setFundingObservations] = useState<
    Map<string, MarketFundingObservation>
  >(() => new Map());
  const fundingTargetsByIdRef = useRef(new Map<string, HTMLDivElement>());
  const fundingTargetIdsRef = useRef(new Map<Element, string>());
  const fundingObserverRef = useRef<IntersectionObserver | null>(null);
  const fundingTargetRefCallbacksRef = useRef(new Map<string, RefCallback<HTMLDivElement>>());
  const latestMarketsByIdRef = useRef(new Map<string, Market>());

  const marketMap = useMemo(() => {
    const map = new Map<string, Market>();
    markets.forEach((m) => map.set(m.id, m));
    return map;
  }, [markets]);

  useLayoutEffect(() => {
    latestMarketsByIdRef.current = marketMap;
    setFundingObservations((current) => {
      let next: Map<string, MarketFundingObservation> | null = null;
      for (const [conditionId, currentObservation] of current) {
        const market = marketMap.get(conditionId);
        if (!market) {
          next ??= new Map(current);
          next.delete(conditionId);
          continue;
        }
        const merged = mergeMarketFundingObservation(
          currentObservation,
          marketFundingObservation(market),
        );
        if (sameFundingObservation(currentObservation, merged)) continue;
        next ??= new Map(current);
        next.set(conditionId, merged);
      }
      return next ?? current;
    });
  }, [marketMap]);

  const observeFundingTarget = useCallback((conditionId: string): RefCallback<HTMLDivElement> => {
    const existing = fundingTargetRefCallbacksRef.current.get(conditionId);
    if (existing) return existing;

    const ref: RefCallback<HTMLDivElement> = (element) => {
      const previous = fundingTargetsByIdRef.current.get(conditionId);
      if (previous === element) return;
      if (previous) {
        fundingObserverRef.current?.unobserve(previous);
        fundingTargetIdsRef.current.delete(previous);
        fundingTargetsByIdRef.current.delete(conditionId);
      }
      if (element) {
        fundingTargetsByIdRef.current.set(conditionId, element);
        fundingTargetIdsRef.current.set(element, conditionId);
        fundingObserverRef.current?.observe(element);
        return;
      }

      fundingTargetRefCallbacksRef.current.delete(conditionId);
      setVisibleFundingMarketIds((current) => {
        if (!current.has(conditionId)) return current;
        const next = new Set(current);
        next.delete(conditionId);
        return next;
      });
    };
    fundingTargetRefCallbacksRef.current.set(conditionId, ref);
    return ref;
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleFundingMarketIds((current) => {
          let next: Set<string> | null = null;
          for (const entry of entries) {
            const conditionId = fundingTargetIdsRef.current.get(entry.target);
            if (!conditionId) continue;
            const shouldBeVisible = entry.isIntersecting;
            const isVisible = current.has(conditionId);
            if (shouldBeVisible === isVisible) continue;
            next ??= new Set(current);
            if (shouldBeVisible) next.add(conditionId);
            else next.delete(conditionId);
          }
          return next ?? current;
        });
      },
      { threshold: 0 },
    );
    fundingObserverRef.current = observer;
    for (const element of fundingTargetsByIdRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      fundingObserverRef.current = null;
    };
  }, []);

  const applyFundingObservation = useCallback(
    (conditionId: string, observation: MarketFundingObservation) => {
      const market = latestMarketsByIdRef.current.get(conditionId);
      if (!market) return;
      setFundingObservations((current) => {
        const currentObservation = current.get(conditionId) ?? marketFundingObservation(market);
        const merged = mergeMarketFundingObservation(currentObservation, observation);
        if (sameFundingObservation(currentObservation, merged)) return current;
        const next = new Map(current);
        next.set(conditionId, merged);
        return next;
      });
    },
    [],
  );

  const displayMarkets = useMemo(
    () =>
      markets.map((market) => {
        const currentObservation = fundingObservations.get(market.id);
        if (!currentObservation) return market;
        const restObservation = marketFundingObservation(market);
        const merged = mergeMarketFundingObservation(currentObservation, restObservation);
        return sameFundingObservation(restObservation, merged) ? market : { ...market, ...merged };
      }),
    [fundingObservations, markets],
  );

  const getSecondaryMarketInfos = (market: Market) => {
    if (!market.secondaryMarkets || market.secondaryMarkets.length === 0) {
      return undefined;
    }
    return market.secondaryMarkets
      .map((id) => {
        const secondaryMarket = marketMap.get(id);
        if (!secondaryMarket) return null;
        return {
          id: secondaryMarket.id,
          title: secondaryMarket.title,
        };
      })
      .filter((info): info is { id: string; title: string } => info !== null);
  };

  const activeFilterCount = [
    selectedMarketTypes.length > 0 ? 1 : 0,
    volumeRange.min !== undefined ? 1 : 0,
    closingInDays !== undefined ? 1 : 0,
    includeClosed ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const hasActiveFilters =
    searchQuery.trim().length > 0 || selectedTags.length > 0 || activeFilterCount > 0;

  const handleClearAll = () => {
    setSelectedMarketTypes([]);
    setVolumeRange({});
    setClosingInDays(undefined);
    setIncludeClosed(false);
    onMarketTypeChange?.([]);
    onVolumeRangeChange?.({});
    onClosingDateChange?.(undefined);
    onIncludeClosedChange?.(false);
    onClearAll?.();
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore?.();
        }
      },
      { threshold: 0.1 },
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [onLoadMore]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="sticky top-14 md:top-16 z-40 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto">
          {/* Single-row discovery bar: sort pills (left, non-scrolling)
              → vertical divider → category chips inside HorizontalPager
              (scrollable middle) → filter toggle pinned to the right.
              Mirrors `bitCaster-design/.../TagBar.tsx`. */}
          <div
            data-testid="market-discovery-bar"
            className="flex flex-col items-stretch gap-3 px-4 sm:px-6 lg:px-8 py-3 md:flex-row"
          >
            <SortBar active={sort} onSortChange={onSortChange} />
            <div className="hidden w-px bg-slate-300 dark:bg-slate-700 self-stretch md:block" />
            <TagBar
              embedded
              categoryTags={categoryTags}
              selectedTags={selectedTags}
              filtersVisible={filtersVisible}
              activeFilterCount={activeFilterCount}
              onTagSelect={onTagSelect}
              onClearTags={onClearTags}
              onToggleFilters={() => setFiltersVisible(!filtersVisible)}
            />
            {hasActiveFilters && (
              <button
                type="button"
                data-testid="market-discovery-clear-all"
                onClick={handleClearAll}
                className="shrink-0 self-center rounded-full px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {t("common.clearAll")}
              </button>
            )}
          </div>
        </div>
      </div>

      <FilterControls
        isVisible={filtersVisible}
        selectedMarketTypes={selectedMarketTypes}
        volumeRange={volumeRange}
        closingInDays={closingInDays}
        includeClosed={includeClosed}
        onMarketTypeChange={(types) => {
          setSelectedMarketTypes(types);
          onMarketTypeChange?.(types);
        }}
        onVolumeRangeChange={(range) => {
          setVolumeRange(range);
          onVolumeRangeChange?.(range);
        }}
        onClosingDateChange={(days) => {
          setClosingInDays(days);
          onClosingDateChange?.(days);
        }}
        onIncludeClosedChange={(next) => {
          setIncludeClosed(next);
          onIncludeClosedChange?.(next);
        }}
        onClearAll={handleClearAll}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {status === "loading" ||
        status === "refreshing" ||
        status === "error" ||
        status === "empty" ||
        status === "no-match" ? (
          <div
            className="flex min-h-[16rem] flex-col items-center justify-center gap-4 px-4 text-center"
            role={status === "error" ? "alert" : undefined}
          >
            {status === "error" ? (
              <div className="text-red-400">{statusMessage}</div>
            ) : status === "empty" || status === "no-match" ? (
              <>
                <div className="text-6xl" aria-hidden="true">
                  {status === "no-match" ? "🔍" : "📈"}
                </div>
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                    {statusMessage}
                  </h2>
                </div>
              </>
            ) : (
              <div className="text-slate-400 animate-pulse">{statusMessage}</div>
            )}
            {status === "no-match" ? (
              <button
                type="button"
                data-testid="market-status-clear-all"
                onClick={handleClearAll}
                className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
              >
                {t("market.clearAllFilters")}
              </button>
            ) : (
              statusAction
            )}
          </div>
        ) : markets.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">🔍</div>
            <h3 className="text-xl font-bold text-slate-700 dark:text-slate-300 mb-2">
              {t("market.noMarketsFound")}
            </h3>
            <p className="text-slate-500 dark:text-slate-400">{t("market.noMarketsFoundHint")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
            {displayMarkets.map((market) => {
              const routeOutcomeId = market.registeredPrimitiveOutcomeIds?.[0];
              const routeMarketId = routeOutcomeId ? `${market.id}-${routeOutcomeId}` : undefined;
              return (
                <Fragment key={market.id}>
                  <MarketFundingSubscription
                    conditionId={market.id}
                    routeMarketId={routeMarketId}
                    visible={visibleFundingMarketIds.has(market.id)}
                    onFundingObservation={applyFundingObservation}
                  />
                  <div
                    ref={observeFundingTarget(market.id)}
                    data-testid={`market-funding-target-${market.id}`}
                    className="min-w-0"
                  >
                    <MarketCard
                      market={market}
                      secondaryMarketInfos={getSecondaryMarketInfos(market)}
                      onViewMarket={onViewMarket}
                      onViewSecondaryMarket={onViewSecondaryMarket}
                      walletReady={walletReady}
                    />
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}

        {(categoryTags.length > 0 || activeFilterCount > 0) && (
          <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
            {t("market.discoveryScopeNotice")}
          </p>
        )}

        {/* Sentinel: only mount/show when there are more pages to load so it
            never stays visible after the last page is reached. The
            IntersectionObserver fires onLoadMore when it enters the viewport;
            hiding it also prevents spurious load-more calls on the last page. */}
        {hasMore && (
          <div ref={observerTarget} className="h-20 flex items-center justify-center">
            <div className="text-sm text-slate-500 dark:text-slate-400 animate-pulse">
              {t("market.loadingMore")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
