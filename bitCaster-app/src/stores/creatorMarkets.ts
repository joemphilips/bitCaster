import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Client-side record of a market the user has created via the wizard.
 *
 * The matching engine is deliberately ignorant of who created a market (see
 * "User-specific state must handled by client-side" in AGENTS.md), so the
 * dashboard builds its market list from this store and enriches each entry
 * with live volume data pulled from `GET /api/v1/creators/{pubkey}/markets`.
 */
export interface StoredCreatorMarket {
  /** Condition ID the market was registered under. Stable, primary key. */
  conditionId: string
  /** Human-readable title (echoed so the dashboard can render before the mint is reachable). */
  title: string
  /** Thumbnail URL returned by the matching engine, or `null` when the user skipped the upload. */
  thumbnailUrl: string | null
  /** ISO-8601 timestamp recorded when the wizard reported a successful submission. */
  createdAt: string
  /**
   * Percentage fee (0.0-1.0 scale matching `CreatedMarket.creatorFeePercent`)
   * the user chose at wizard step 5. Kept client-side because fee accrual is
   * stubbed for v1 and not tracked by the engine.
   */
  creatorFeePercent: number
}

interface CreatorMarketsState {
  markets: StoredCreatorMarket[]
  /** Insert a market created via the wizard. Deduplicates on `conditionId`. */
  addCreatedMarket: (market: StoredCreatorMarket) => void
  /** Remove a market from the local record (e.g. after a user hides it). */
  removeCreatedMarket: (conditionId: string) => void
  /** Replace the entire set wholesale — used by `useCreatorSync` after a NIP-78 fetch. */
  replace: (markets: StoredCreatorMarket[]) => void
  /** Clear all entries. Exposed primarily for tests and logout flows. */
  clear: () => void
}

/** Stable equality check used by the NIP-78 sync hook to skip no-op publishes. */
export function creatorMarketsEqual(
  a: readonly StoredCreatorMarket[],
  b: readonly StoredCreatorMarket[],
): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(a.map((m) => [m.conditionId, m] as const))
  for (const m of b) {
    const other = byId.get(m.conditionId)
    if (!other) return false
    if (
      other.title !== m.title ||
      other.thumbnailUrl !== m.thumbnailUrl ||
      other.createdAt !== m.createdAt ||
      other.creatorFeePercent !== m.creatorFeePercent
    ) {
      return false
    }
  }
  return true
}

/**
 * Local store of markets the user has created. Persists to localStorage under
 * `bitcaster-creator-markets`. When a mnemonic is available, `useCreatorSync`
 * mirrors the set to a NIP-78 replaceable event so it survives a device swap.
 *
 * This module intentionally has no Nostr or Cashu imports so it is cheap to
 * pull into component tests.
 */
export const useCreatorMarketsStore = create<CreatorMarketsState>()(
  persist(
    (set, get) => ({
      markets: [],
      addCreatedMarket: (market) => {
        set((state) => {
          const without = state.markets.filter(
            (m) => m.conditionId !== market.conditionId,
          )
          // Newest first so the dashboard's most-recent rows match the user's
          // expectation immediately after the wizard completes.
          return { markets: [market, ...without] }
        })
      },
      removeCreatedMarket: (conditionId) => {
        set((state) => ({
          markets: state.markets.filter((m) => m.conditionId !== conditionId),
        }))
      },
      replace: (markets) => {
        if (creatorMarketsEqual(get().markets, markets)) return
        set({ markets: [...markets] })
      },
      clear: () => set({ markets: [] }),
    }),
    { name: 'bitcaster-creator-markets' },
  ),
)
