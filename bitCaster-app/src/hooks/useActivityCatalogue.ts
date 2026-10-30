import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem, ActivityDisplayItem } from "@/types/portfolio";
import type { MarketCatalogueEntry, MarketCatalogueResponse } from "@/lib/markets";

export function activityConditionId(marketId: string | undefined): string | null {
  return marketId?.match(/^([0-9a-f]{64})(?:-.+)?$/)?.[1] ?? null;
}

type DisplayMarket = NonNullable<ActivityDisplayItem["activityMarket"]>;

async function loadActivityCatalogueBatch(
  batch: string[],
  signal: AbortSignal,
): Promise<Map<string, DisplayMarket>> {
  const search = new URLSearchParams({
    ids: batch.join(","),
    state: "All",
    page_size: String(batch.length),
  });
  const response = await fetch(`/api/v1/markets/query?${search}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  const markets = new Map<string, DisplayMarket>();
  if (!response.ok) return markets;
  const body = (await response.json()) as MarketCatalogueResponse;
  for (const market of body.markets ?? []) {
    if (
      batch.includes(market.conditionId) &&
      Array.isArray(market.outcomes) &&
      market.outcomes.every((outcome) => typeof outcome === "string")
    ) {
      markets.set(market.conditionId, {
        title: typeof market.title === "string" ? market.title : null,
        outcomes: market.outcomes,
      });
    }
  }
  return markets;
}

/** Catalogue enrichment cannot delay recorded activity or change custody facts. */
export function useActivityCatalogue(
  activity: ActivityItem[],
  walletId: string | null,
  available: ReadonlyMap<string, MarketCatalogueEntry>,
): ActivityDisplayItem[] {
  const conditionKey = useMemo(() => {
    const ids = new Set<string>();
    for (const item of activity) {
      const id = activityConditionId(item.marketId);
      if (id !== null) ids.add(id);
      if (ids.size === 500) break;
    }
    return JSON.stringify([...ids]);
  }, [activity]);
  const availableRef = useRef(available);
  availableRef.current = available;
  const [cache, setCache] = useState<{
    walletId: string;
    markets: Map<string, DisplayMarket>;
  } | null>(null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  useEffect(() => {
    if (walletId === null) return;
    const controller = new AbortController();
    let obsolete = false;
    const selectedIds = JSON.parse(conditionKey) as string[];
    const markets = new Map(
      cacheRef.current?.walletId === walletId
        ? [...cacheRef.current.markets].filter(([id]) => selectedIds.includes(id))
        : [],
    );
    const ids = selectedIds.filter((id) => !markets.has(id));
    void (async () => {
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50).filter((id) => !availableRef.current.has(id));
        if (obsolete || controller.signal.aborted) return;
        if (batch.length === 0) continue;
        try {
          const batchMarkets = await loadActivityCatalogueBatch(batch, controller.signal);
          if (obsolete || controller.signal.aborted) return;
          for (const [id, market] of batchMarkets) markets.set(id, market);
          setCache({ walletId, markets: new Map(markets) });
        } catch {
          // Missing catalogue metadata leaves the recorded row readable.
        }
      }
    })();
    return () => {
      obsolete = true;
      controller.abort();
    };
  }, [walletId, conditionKey]);

  return useMemo(
    () =>
      activity.map((item) => {
        const conditionId = activityConditionId(item.marketId);
        const entry = conditionId === null ? undefined : available.get(conditionId);
        const metadata = entry
          ? { title: entry.title ?? null, outcomes: entry.outcomes }
          : conditionId !== null && cache?.walletId === walletId
            ? cache.markets.get(conditionId)
            : undefined;
        return metadata ? { ...item, activityMarket: metadata } : item;
      }),
    [activity, available, cache, walletId],
  );
}
