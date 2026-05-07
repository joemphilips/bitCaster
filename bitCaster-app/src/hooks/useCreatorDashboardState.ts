import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchCreatorMarkets,
  type CreatorMarketEntry,
} from '@/lib/markets'
import { deriveNostrKeyPair } from '@/lib/nip17'
import {
  useCreatorMarketsStore,
  type StoredCreatorMarket,
} from '@/stores/creatorMarkets'
import { useWalletStore } from '@/stores/wallet'
import type { CreatedMarket } from '@/types/portfolio'
import type { DashboardStats } from '@/types/market-management'

interface UseCreatorDashboardStateResult {
  /** The creator pubkey the dashboard is scoped to, or `null` if none configured. */
  pubkey: string | null
  /** Aggregated stats rendered at the top of the dashboard. */
  stats: DashboardStats
  /** Merged client + backend view used by the `MyMarkets` row list. */
  markets: CreatedMarket[]
  /** True on initial mount while the first backend fetch is in-flight. */
  isLoading: boolean
  /** Non-null if the backend fetch failed. Markets still render from the local store. */
  error: string | null
  /** Manually re-fetch backend volume data (e.g. on a retry button). */
  refresh: () => void
}

/**
 * Derive the CreatedMarket view used by the portfolio `MyMarkets` / `CreatedMarketRow`
 * components. Each market combines:
 *
 *  - Local wizard record (title, thumbnail, createdAt, creator fee %) — always present.
 *  - Backend volume lookup by conditionId — falls back to `0` when catalogue
 *    volume is not available yet.
 *
 * Fees are stubbed to `0` for v1 since the matching engine does not accrue
 * them. Status is always `active` until the public API exposes resolution
 * state; a local oracle attestation is metadata only, not lifecycle truth.
 */
function buildCreatedMarket(
  stored: StoredCreatorMarket,
  volumeByConditionId: Map<string, number>,
): CreatedMarket {
  return {
    id: stored.conditionId,
    title: stored.title,
    imageUrl: stored.thumbnailUrl ?? '',
    status: 'active',
    createdDate: stored.createdAt,
    volume: volumeByConditionId.get(stored.conditionId) ?? 0,
    creatorFeesEarned: 0,
    creatorFeePercent: stored.creatorFeePercent,
    oracle: stored.oracle,
  }
}

function emptyStats(): DashboardStats {
  return {
    activeMarketsCount: 0,
    resolvedMarketsCount: 0,
    refundedMarketsCount: 0,
    totalVolumeSats: 0,
    totalFeesEarnedSats: 0,
    totalFeesClaimedSats: 0,
    totalFeesUnclaimedSats: 0,
  }
}

/**
 * Powers the creator dashboard. Pulls markets from the client-side store
 * (authoritative source of "what I have created") and enriches them with
 * backend volume data. Safe to call when the user has no wallet — returns an
 * empty state instead of throwing.
 */
export function useCreatorDashboardState(): UseCreatorDashboardStateResult {
  const mnemonic = useWalletStore((s) => s.mnemonic)
  const storedMarkets = useCreatorMarketsStore((s) => s.markets)

  const pubkey = useMemo(() => {
    if (!mnemonic) return null
    try {
      return deriveNostrKeyPair(mnemonic).publicKey
    } catch {
      return null
    }
  }, [mnemonic])

  const [backendMarkets, setBackendMarkets] = useState<CreatorMarketEntry[]>([])
  // Initial state is `false` unconditionally. The effect below flips this to
  // `true` as soon as a pubkey is available — initializing from `pubkey` here
  // would race against Zustand's persist hydration, which is async on mount
  // and would briefly flash the empty state before the loading skeleton.
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!pubkey) {
      setBackendMarkets([])
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)
    void (async () => {
      try {
        const response = await fetchCreatorMarkets(pubkey)
        if (cancelled) return
        setBackendMarkets(response.markets)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load creator markets')
        setBackendMarkets([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pubkey, refreshTick])

  const refresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1)
  }, [])

  const markets = useMemo<CreatedMarket[]>(() => {
    const volumeByConditionId = new Map<string, number>()
    for (const entry of backendMarkets) {
      volumeByConditionId.set(entry.conditionId, entry.totalVolumeSats)
    }
    return storedMarkets.map((m) => buildCreatedMarket(m, volumeByConditionId))
  }, [storedMarkets, backendMarkets])

  const stats = useMemo<DashboardStats>(() => {
    const base = emptyStats()
    for (const market of markets) {
      switch (market.status) {
        case 'active':
          base.activeMarketsCount += 1
          break
        case 'resolved':
          base.resolvedMarketsCount += 1
          break
        case 'refunded':
          base.refundedMarketsCount += 1
          break
      }
      base.totalVolumeSats += market.volume
      base.totalFeesEarnedSats += market.creatorFeesEarned
    }
    return base
  }, [markets])

  return {
    pubkey,
    stats,
    markets,
    isLoading,
    error,
    refresh,
  }
}
