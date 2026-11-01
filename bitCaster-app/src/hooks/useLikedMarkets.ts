import { useCallback, useEffect, useMemo, useState } from "react";
import { useBookmarkStore } from "@/stores/bookmarks";
import { getMarkets } from "@/lib/markets";
import { marketCatalogueIdBatches } from "@bitcaster/client-sdk/marketCatalogueBatches";
import type { Market } from "@/types/market";

interface UseLikedMarketsResult {
  markets: Market[];
  loading: boolean;
  error: string | null;
  /**
   * Re-run the bulk-fetch against the engine. Used by the liked-market close
   * reconcile (P22 Link G2) so a `visibilitychange` can refresh the catalogue
   * `state` of the user's bookmarks without a full reload.
   */
  refetch: () => void;
}

/**
 * Resolve the user's bookmarked / "liked" markets (P5.1).
 *
 * The user-facing "heart icon" is wired to `useBookmarkStore.toggle` (see
 * `MarketCard.tsx`); the persisted Nostr-mirrored set lives there. This
 * hook joins that set with the engine's market catalogue using the
 * `GET /api/v1/markets/query?ids=` bulk-fetch surface defined in ADR-009 —
 * one round-trip per catalogue page of IDs, intersected client-side, ordered by the
 * user's bookmark order so the most recently liked sits at the leading edge
 * of the horizontal list.
 *
 * A bookmark ID with no matching engine entry is silently dropped: the
 * market may have been retracted on the mint side and the engine catalogue
 * is the authoritative join target. Bookmark IDs deduplicate on insert (see
 * `useBookmarkStore.toggle`); the defensive `Set` here matches the test
 * contract (T5.1.d) and survives stale Nostr syncs that landed two of the
 * same `e`-tag.
 */
export function useLikedMarkets(): UseLikedMarketsResult {
  const bookmarks = useBookmarkStore((s) => s.markets);
  const [allMarkets, setAllMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refetchNonce, setRefetchNonce] = useState(0);

  const refetch = useCallback(() => setRefetchNonce((n) => n + 1), []);

  const uniqueIds = useMemo(() => Array.from(new Set(bookmarks)), [bookmarks]);

  useEffect(() => {
    let cancelled = false;

    if (uniqueIds.length === 0) {
      setAllMarkets([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);
    fetchBookmarkedMarkets(uniqueIds)
      .then((markets) => {
        if (!cancelled) setAllMarkets(markets);
      })
      .catch(() => {
        if (!cancelled) {
          setAllMarkets(null);
          setError("Failed to load markets");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uniqueIds, refetchNonce]);

  const markets = useMemo(() => {
    if (!allMarkets) return [];
    if (uniqueIds.length === 0) return [];
    const byId = new Map(allMarkets.map((m) => [m.id, m]));
    // Preserve the order in which the user bookmarked the markets so the
    // most recently liked sits on the right edge of the horizontal list.
    return uniqueIds.map((id) => byId.get(id)).filter((m): m is Market => m != null);
  }, [allMarkets, uniqueIds]);

  return { markets, loading, error, refetch };
}

/**
 * Read the given IDs from the engine's bulk-fetch surface, one catalogue page
 * per batch. The user's bookmark set can grow without bound. This read uses
 * only the first page of each query, so each batch sets `page_size` to its
 * length. A failed batch fails the whole load: the close reconcile must not
 * record a partial set of last-seen states.
 */
async function fetchBookmarkedMarkets(ids: string[]): Promise<Market[]> {
  const collected: Market[] = [];
  for (const batch of marketCatalogueIdBatches(ids)) {
    const result = await getMarkets({ ids: batch, state: "All", pageSize: batch.length });
    collected.push(...result.markets);
  }
  return collected;
}
