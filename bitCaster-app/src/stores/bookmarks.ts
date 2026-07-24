import { create } from "zustand";
import { persist } from "zustand/middleware";

interface BookmarkState {
  markets: string[];
  toggle: (marketId: string) => void;
  /** Replace the bookmark set wholesale (used by the Nostr sync hook). */
  replace: (marketIds: string[]) => void;
}

/** Order-insensitive equality for bookmark lists. */
export function bookmarkSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) {
    if (!setA.has(x)) return false;
  }
  return true;
}

/**
 * Local bookmark store. Persists to localStorage under `bitcaster-bookmarks`.
 * When an nsec-backed Nostr identity is available, `useBookmarkSync` keeps
 * this in sync with a NIP-78 replaceable event on the configured bitCaster relay.
 *
 * This module deliberately has no Nostr or Cashu imports so it is cheap to
 * pull into tests that render a `MarketCard` or `MarketHeader`.
 *
 * ## Hydration race (P7 §`/markets/{id}` "doesn't fill on click")
 *
 * Zustand's persist middleware rehydrates asynchronously. On the first render
 * `markets` is the in-memory default `[]` even for a returning user with a
 * persisted set. If the user clicks the bookmark button before hydration
 * completes, the toggle runs against the empty default; then the persisted
 * payload lands and the default `merge` strategy REPLACES the in-memory
 * state with the disk state — silently overwriting the click.
 *
 * Symptom: "the bookmark icon doesn't fill on click" — the icon flips for a
 * frame, then the persisted (older) state lands and the icon flips back.
 *
 * Fix: override `merge` so the rehydration combines disk + memory rather
 * than replacing memory with disk. A click made pre-hydration is preserved
 * in `state.markets`; the union below dedupes any overlap. This eliminates
 * the race without forcing every consumer to gate on `hasHydrated()`.
 */
export const useBookmarkStore = create<BookmarkState>()(
  persist(
    (set, get) => ({
      markets: [],
      toggle: (marketId) => {
        set((state) => {
          const has = state.markets.includes(marketId);
          return {
            markets: has
              ? state.markets.filter((id) => id !== marketId)
              : [...state.markets, marketId],
          };
        });
      },
      replace: (marketIds) => {
        const deduped = Array.from(new Set(marketIds));
        if (bookmarkSetsEqual(get().markets, deduped)) return;
        set({ markets: deduped });
      },
    }),
    {
      name: "bitcaster-bookmarks",
      // Union-merge persisted disk state with in-memory state on rehydrate.
      // Default behaviour replaces memory with disk and drops any pre-hydrate
      // clicks; the union preserves them and dedupes.
      merge: (persisted, current) => {
        const disk = (persisted as Partial<BookmarkState> | undefined)?.markets ?? [];
        const memory = current.markets;
        return {
          ...current,
          markets: Array.from(new Set([...memory, ...disk])),
        };
      },
    },
  ),
);
