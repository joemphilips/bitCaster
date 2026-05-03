import { useEffect, useMemo, useState } from 'react'
import { useBookmarkStore } from '@/stores/bookmarks'
import { fetchMarkets } from '@/lib/markets'
import type { Market } from '@/types/market'

interface UseLikedMarketsResult {
  markets: Market[]
  loading: boolean
  error: string | null
}

/**
 * Resolve the user's bookmarked / "liked" markets (P5.1).
 *
 * The user-facing "heart icon" is wired to `useBookmarkStore.toggle` (see
 * `MarketCard.tsx`); the persisted Nostr-mirrored set lives there. This
 * hook joins that set with the live market catalogue from the mint and
 * returns the intersection in the order the user bookmarked them.
 *
 * The bulk-fetch proxy from Phase 2 of the staging-fixes plan is not yet
 * live (architect Q10 / `?ids=` is deferred). Until then we issue a single
 * `/v1/conditions` fetch and locally filter — adequate for typical liked
 * counts (<20). A bookmark ID with no matching mint condition is silently
 * dropped: the market may have been retracted on the mint side, and the
 * bookmark store is purely a client hint.
 *
 * Bookmark IDs deduplicate on insert (see `useBookmarkStore.toggle`),
 * but a defensive `Set` here matches the test contract spelled out in
 * the Phase 5 plan (T5.1.d).
 */
export function useLikedMarkets(): UseLikedMarketsResult {
  const bookmarks = useBookmarkStore((s) => s.markets)
  const [allMarkets, setAllMarkets] = useState<Market[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchMarkets()
      .then((markets) => {
        if (!cancelled) setAllMarkets(markets)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load markets')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const markets = useMemo(() => {
    if (!allMarkets) return []
    const wanted = new Set(bookmarks)
    if (wanted.size === 0) return []
    const byId = new Map(allMarkets.map((m) => [m.id, m]))
    // Preserve the order in which the user bookmarked the markets so the
    // most recently liked sits on the right edge of the horizontal list.
    return Array.from(wanted)
      .map((id) => byId.get(id))
      .filter((m): m is Market => m != null)
  }, [allMarkets, bookmarks])

  return { markets, loading, error }
}
