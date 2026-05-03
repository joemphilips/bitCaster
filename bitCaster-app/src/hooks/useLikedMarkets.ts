import { useEffect, useMemo, useState } from 'react'
import { useBookmarkStore } from '@/stores/bookmarks'
import { getMarkets } from '@/lib/markets'
import type { Market } from '@/types/market'

interface UseLikedMarketsResult {
  markets: Market[]
  loading: boolean
  error: string | null
}

/**
 * Engine bulk-fetch cap (ADR-009). The user's `useBookmarkStore` is allowed
 * to grow without bound; we batch the ID set into pages of this size to stay
 * under the cap. Mirrors the `?ids=<comma-separated>` cap on the engine.
 */
const MAX_BULK_IDS = 100

/**
 * Resolve the user's bookmarked / "liked" markets (P5.1).
 *
 * The user-facing "heart icon" is wired to `useBookmarkStore.toggle` (see
 * `MarketCard.tsx`); the persisted Nostr-mirrored set lives there. This
 * hook joins that set with the engine's market catalogue using the
 * `GET /api/v1/markets/query?ids=` bulk-fetch surface defined in ADR-009 —
 * one round-trip per up-to-100 IDs, intersected client-side, ordered by the
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
  const bookmarks = useBookmarkStore((s) => s.markets)
  const [allMarkets, setAllMarkets] = useState<Market[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const uniqueIds = useMemo(() => Array.from(new Set(bookmarks)), [bookmarks])

  useEffect(() => {
    let cancelled = false

    if (uniqueIds.length === 0) {
      setAllMarkets([])
      setError(null)
      setLoading(false)
      return () => {
        cancelled = true
      }
    }

    setLoading(true)
    setError(null)
    fetchBookmarkedMarkets(uniqueIds)
      .then((markets) => {
        if (!cancelled) setAllMarkets(markets)
      })
      .catch(() => {
        if (!cancelled) {
          setAllMarkets(null)
          setError('Failed to load markets')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uniqueIds])

  const markets = useMemo(() => {
    if (!allMarkets) return []
    if (uniqueIds.length === 0) return []
    const byId = new Map(allMarkets.map((m) => [m.id, m]))
    // Preserve the order in which the user bookmarked the markets so the
    // most recently liked sits on the right edge of the horizontal list.
    return uniqueIds
      .map((id) => byId.get(id))
      .filter((m): m is Market => m != null)
  }, [allMarkets, uniqueIds])

  return { markets, loading, error }
}

/**
 * Page through the engine's bulk-fetch surface for the given IDs. Bookmark
 * sets larger than the per-request cap split into multiple requests; a
 * partial failure aborts the whole batch (the caller treats it as a
 * one-shot load).
 */
async function fetchBookmarkedMarkets(ids: string[]): Promise<Market[]> {
  const collected: Market[] = []
  for (let i = 0; i < ids.length; i += MAX_BULK_IDS) {
    const slice = ids.slice(i, i + MAX_BULK_IDS)
    const result = await getMarkets({ ids: slice, state: 'All' })
    collected.push(...result.markets)
  }
  return collected
}
