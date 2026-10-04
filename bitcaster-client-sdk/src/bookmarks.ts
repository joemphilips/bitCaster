import type { EventTemplate } from 'nostr-tools/pure'

export const BOOKMARK_KIND = 30078
export const BOOKMARK_D_TAG = 'bitcaster:bookmarks'

/** Keep the existing public bookmark payload compatible with browser storage. */
export function normalizeBookmarkMarkets(markets: readonly string[]): string[] {
  if (!Array.isArray(markets) || !markets.every((id) => typeof id === 'string'))
    throw new Error('Bookmark markets must be an array of strings.')
  return [...new Set(markets)]
}

export function parseBookmarkPayload(content: string): string[] | null {
  try {
    const value: unknown = JSON.parse(content)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const markets = (value as { markets?: unknown }).markets
    if (!Array.isArray(markets) || !markets.every((id) => typeof id === 'string')) return null
    return normalizeBookmarkMarkets(markets)
  } catch {
    return null
  }
}

export function bookmarkSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(normalizeBookmarkMarkets(left))
  const b = new Set(normalizeBookmarkMarkets(right))
  return a.size === b.size && [...a].every((id) => b.has(id))
}

export function unionBookmarkMarkets(
  local: readonly string[],
  remote: readonly string[],
): string[] {
  return normalizeBookmarkMarkets([...local, ...remote])
}

export function setMarketBookmark(
  markets: readonly string[],
  marketId: string,
  liked: boolean,
): string[] {
  if (typeof marketId !== 'string') throw new Error('Bookmark market ID must be a string.')
  const current = normalizeBookmarkMarkets(markets)
  return liked ? unionBookmarkMarkets(current, [marketId]) : current.filter((id) => id !== marketId)
}

export function bookmarkEventTemplate(
  markets: readonly string[],
  createdAt: number,
): EventTemplate {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new Error('Invalid bookmark event time.')
  return {
    kind: BOOKMARK_KIND,
    created_at: createdAt,
    tags: [['d', BOOKMARK_D_TAG]],
    content: JSON.stringify({ markets: normalizeBookmarkMarkets(markets) }),
  }
}
