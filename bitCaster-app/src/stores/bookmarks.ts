import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BookmarkState {
  markets: string[]
  toggle: (marketId: string) => void
  /** Replace the bookmark set wholesale (used by the Nostr sync hook). */
  replace: (marketIds: string[]) => void
}

/** Order-insensitive equality for bookmark lists. */
export function bookmarkSetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const x of b) {
    if (!setA.has(x)) return false
  }
  return true
}

/**
 * Local bookmark store. Persists to localStorage under `bitcaster-bookmarks`.
 * When a mnemonic is available, `useBookmarkSync` keeps this in sync with a
 * NIP-78 replaceable event on public relays.
 *
 * This module deliberately has no Nostr or Cashu imports so it is cheap to
 * pull into tests that render a `MarketCard` or `MarketHeader`.
 */
export const useBookmarkStore = create<BookmarkState>()(
  persist(
    (set, get) => ({
      markets: [],
      toggle: (marketId) => {
        set((state) => {
          const has = state.markets.includes(marketId)
          return {
            markets: has
              ? state.markets.filter((id) => id !== marketId)
              : [...state.markets, marketId],
          }
        })
      },
      replace: (marketIds) => {
        const deduped = Array.from(new Set(marketIds))
        if (bookmarkSetsEqual(get().markets, deduped)) return
        set({ markets: deduped })
      },
    }),
    { name: 'bitcaster-bookmarks' },
  ),
)
