import { useMemo, useState } from 'react'
import type { Market } from '@/types/market'

/**
 * Sort dimensions per ADR-009 — the engine-side query proxy will accept
 * `?sort=trending|popular|new` and return rolling 24h / 30d volumes; the
 * frontend treats the dimensions as opaque tokens. Until engine PR #26
 * lands, this hook performs a client-side sort against the existing
 * volume / createdDate fields. The dimension semantics match what the
 * engine will eventually expose:
 *
 *   - `trending` — total trading volume in the rolling 24h window, desc
 *   - `popular`  — total trading volume in the rolling 30d window, desc
 *   - `new`      — `createdAt` timestamp, desc
 *
 * Today the markets list uses `Market.volume` (lifetime) for both rolling
 * windows; that is the documented stopgap. When the proxy lands the
 * frontend should swap to the engine-supplied `volume24h` / `volume30d`
 * fields without having to re-shape the hook surface.
 */
export type MarketSort = 'trending' | 'popular' | 'new'

export const DEFAULT_MARKET_SORT: MarketSort = 'trending'

interface UseMarketSortResult {
  sort: MarketSort
  setSort: (next: MarketSort) => void
  /** Markets ordered per the active sort dimension (stable copy). */
  sorted: Market[]
}

function compareNumberDesc(a: number, b: number): number {
  return b - a
}

function compareDateDesc(a: string, b: string): number {
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  return tb - ta
}

export function sortMarkets(markets: Market[], sort: MarketSort): Market[] {
  const copy = [...markets]
  switch (sort) {
    case 'new':
      return copy.sort((a, b) => compareDateDesc(a.createdDate, b.createdDate))
    case 'popular':
    case 'trending':
      // Both lean on the same lifetime-volume column today; engine PR #26
      // splits them into 24h / 30d windows.
      return copy.sort((a, b) => compareNumberDesc(a.volume, b.volume))
  }
}

export function useMarketSort(markets: Market[]): UseMarketSortResult {
  const [sort, setSort] = useState<MarketSort>(DEFAULT_MARKET_SORT)
  const sorted = useMemo(() => sortMarkets(markets, sort), [markets, sort])
  return { sort, setSort, sorted }
}
