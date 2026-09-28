import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { MarketDiscovery } from "@/components/markets";
import { getMarkets, filterMarkets } from "@/lib/markets";
import { DEFAULT_MARKET_SORT, type MarketSort } from "@/hooks/useMarketSort";
import type { Market, MarketType, VolumeRange, FilterState, CategoryTag } from "@/types/market";

export function MarketsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get("search")?.trim() ?? "";
  const [markets, setMarkets] = useState<Market[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessfulRefreshAt, setLastSuccessfulRefreshAt] = useState<string | null>(null);
  // Selected category tags. P7 §`/markets`: chip multi-select with OR
  // semantics. The engine's `/api/v1/markets/query?tag=…` accepts repeated
  // `tag=` parameters, so the page forwards the whole set verbatim.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterState>({
    searchQuery: "",
    selectedTags: [],
    marketTypes: [],
    volumeRange: {},
    includeClosed: false,
  });

  // Sort dimension is hoisted into the engine query (`?sort=`); the page now
  // owns only the active selection, not the client-side ordering.
  const [sort, setSort] = useState<MarketSort>(DEFAULT_MARKET_SORT);
  const requestGeneration = useRef(0);

  const loadMarkets = useCallback(() => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setNextCursor(null);
    setLoadingMore(false);
    const tags = selectedTags.length > 0 ? selectedTags : undefined;
    getMarkets({
      sort,
      tags,
      search: searchQuery || undefined,
      state: filter.includeClosed ? "All" : "Open",
    })
      .then((result) => {
        if (generation !== requestGeneration.current) return;
        setMarkets(result.markets);
        setNextCursor(result.nextCursor);
        setLastSuccessfulRefreshAt(result.lastSuccessfulRefreshAt ?? null);
      })
      .catch(() => {
        if (generation !== requestGeneration.current) return;
        setError("market.catalogueLoadFailed");
      })
      .finally(() => {
        if (generation !== requestGeneration.current) return;
        setLoading(false);
      });
  }, [sort, selectedTags, searchQuery, filter.includeClosed]);

  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  const derivedCategoryTags = useMemo<CategoryTag[]>(() => {
    const counts = new Map<string, number>();
    for (const m of markets) {
      for (const tagId of m.categoryTags) {
        counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
      }
    }
    for (const id of selectedTags) {
      if (!counts.has(id)) counts.set(id, 0);
    }
    return Array.from(counts.entries()).map(([id, count]) => ({
      id,
      label: id,
      marketCount: count,
    }));
  }, [markets, selectedTags]);

  // Market-type / volume / closing-date filters stay client-side. Search and
  // tag selection are pushed up to the API call, so we strip them from the
  // client filter to avoid double-applying.
  const filteredMarkets = useMemo(
    () => filterMarkets(markets, { ...filter, searchQuery: "", selectedTags: [] }),
    [markets, filter],
  );

  const handleTagSelect = useCallback((tagId: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const handleClearTags = useCallback(() => {
    setSelectedTags([]);
  }, []);

  const handleClearAll = useCallback(() => {
    setSelectedTags([]);
    setFilter((prev) => ({
      ...prev,
      searchQuery: "",
      selectedTags: [],
      marketTypes: [],
      volumeRange: {},
      closingInDays: undefined,
      includeClosed: false,
    }));
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("search");
    navigate(
      {
        pathname: location.pathname,
        search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : "",
      },
      { replace: true },
    );
  }, [location.pathname, navigate, searchParams]);

  const handleMarketTypeChange = useCallback((types: MarketType[]) => {
    setFilter((prev) => ({ ...prev, marketTypes: types }));
  }, []);

  const handleVolumeRangeChange = useCallback((range: VolumeRange) => {
    setFilter((prev) => ({ ...prev, volumeRange: range }));
  }, []);

  const handleClosingDateChange = useCallback((days?: number) => {
    setFilter((prev) => ({ ...prev, closingInDays: days }));
  }, []);

  const handleIncludeClosedChange = useCallback((includeClosed: boolean) => {
    setFilter((prev) => ({ ...prev, includeClosed }));
  }, []);

  const handleViewMarket = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`);
    },
    [navigate],
  );

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    const tags = selectedTags.length > 0 ? selectedTags : undefined;
    getMarkets({
      sort,
      tags,
      search: searchQuery || undefined,
      state: filter.includeClosed ? "All" : "Open",
      cursor: nextCursor,
    })
      .then((result) => {
        if (generation !== requestGeneration.current) return;
        setMarkets((prev) => [...prev, ...result.markets]);
        setNextCursor(result.nextCursor);
      })
      .catch(() => {
        if (generation !== requestGeneration.current) return;
        // Pagination failure is non-fatal — leave the existing list in place
        // and surface nothing rather than blow up the page.
      })
      .finally(() => {
        if (generation !== requestGeneration.current) return;
        setLoadingMore(false);
      });
  }, [nextCursor, loadingMore, sort, selectedTags, searchQuery, filter.includeClosed]);

  const handleViewSecondaryMarket = useCallback(
    (_baseMarketId: string, secondaryMarketId: string) => {
      navigate(`/markets/${secondaryMarketId}`);
    },
    [navigate],
  );

  const catalogueHasRefreshed =
    lastSuccessfulRefreshAt !== null && !lastSuccessfulRefreshAt.startsWith("0001-01-01T00:00:00");

  const hasActiveFilters =
    searchQuery.length > 0 ||
    selectedTags.length > 0 ||
    filter.marketTypes.length > 0 ||
    filter.volumeRange.min !== undefined ||
    filter.volumeRange.max !== undefined ||
    filter.closingInDays !== undefined ||
    filter.includeClosed === true;

  const discoveryStatus = loading
    ? "loading"
    : error
      ? "error"
      : markets.length === 0 && !catalogueHasRefreshed
        ? "refreshing"
        : markets.length === 0 && hasActiveFilters
          ? "no-match"
          : markets.length === 0
            ? "empty"
            : "ready";

  return (
    <MarketDiscovery
      categoryTags={derivedCategoryTags}
      markets={filteredMarkets}
      selectedTags={selectedTags}
      sort={sort}
      searchQuery={searchQuery}
      onSortChange={setSort}
      onTagSelect={handleTagSelect}
      onClearTags={handleClearTags}
      onClearAll={handleClearAll}
      onMarketTypeChange={handleMarketTypeChange}
      onVolumeRangeChange={handleVolumeRangeChange}
      onClosingDateChange={handleClosingDateChange}
      onIncludeClosedChange={handleIncludeClosedChange}
      onViewMarket={handleViewMarket}
      hasMore={nextCursor !== null}
      onLoadMore={handleLoadMore}
      onViewSecondaryMarket={handleViewSecondaryMarket}
      status={discoveryStatus}
      statusMessage={
        discoveryStatus === "loading"
          ? t("market.loadingMarkets")
          : discoveryStatus === "refreshing"
            ? t("market.catalogueRefreshing")
            : discoveryStatus === "error"
              ? t(error ?? "market.catalogueLoadFailedFallback")
              : discoveryStatus === "no-match"
                ? t("market.noMarketsMatchFilters")
                : discoveryStatus === "empty"
                  ? t("market.noMarketsYet")
                  : undefined
      }
      statusAction={
        discoveryStatus === "error" ? (
          <button
            onClick={loadMarkets}
            className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
          >
            {t("common.retry")}
          </button>
        ) : discoveryStatus === "empty" ? (
          <>
            <p className="text-slate-500 dark:text-slate-400">{t("market.createMarketHint")}</p>
            <button
              onClick={() => navigate("/creator")}
              className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
            >
              {t("market.createMarket")}
            </button>
          </>
        ) : undefined
      }
    />
  );
}
