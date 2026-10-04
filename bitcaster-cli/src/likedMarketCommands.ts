import type { Command } from 'commander'
import { BitcasterEngineClient } from '@bitcaster-market/client-sdk/engineClient'
import {
  listNativeBookmarks,
  readLocalNativeBookmarks,
  setNativeMarketBookmark,
} from '@bitcaster-market/daemon/nativeBookmarks'

interface LikedMarketCommandContext {
  readonly isDryRun: () => boolean
  readonly engineUrl: () => string | undefined
}

export function registerLikedMarketCommands(
  market: Command,
  context: LikedMarketCommandContext,
): void {
  market
    .command('liked')
    .description('List all saved liked condition IDs and available market metadata.')
    .option('--local', 'Read saved condition IDs without relay or engine requests')
    .action(async (options: { local?: boolean }) => {
      if (context.isDryRun()) return print({ action: 'liked', dryRun: true })
      if (options.local)
        return print({
          conditionIds: await readLocalNativeBookmarks(),
          metadataStatus: 'not-requested',
        })
      const bookmarks = await listNativeBookmarks()
      const metadata = await likedMarketMetadata(bookmarks.markets, context.engineUrl())
      print({
        conditionIds: bookmarks.markets,
        revision: bookmarks.revision,
        sync: bookmarks.sync,
        ...metadata,
      })
    })
  for (const action of ['like', 'unlike'] as const) {
    market
      .command(`${action} <conditionId>`)
      .description(
        `${action === 'like' ? 'Save' : 'Remove'} one liked condition ID. Relay failure keeps the local edit.`,
      )
      .action(async (conditionId: string) => {
        if (!conditionId.length) throw new Error('Condition ID must not be empty.')
        if (context.isDryRun()) return print({ action, conditionId, dryRun: true })
        const result = await setNativeMarketBookmark(conditionId, action === 'like')
        print({
          ok: true,
          result: { conditionIds: result.markets, revision: result.revision, sync: result.sync },
        })
      })
  }
}

async function likedMarketMetadata(
  conditionIds: string[],
  engineUrl: string | undefined,
): Promise<{
  markets: unknown[]
  metadataStatus: 'available' | 'unavailable' | 'not-configured'
}> {
  if (!conditionIds.length) return { markets: [], metadataStatus: 'available' }
  if (engineUrl === undefined) return { markets: [], metadataStatus: 'not-configured' }
  const client = new BitcasterEngineClient({ baseUrl: engineUrl })
  const byId = new Map<string, unknown>()
  try {
    // The engine uses comma-separated IDs. Retain unsupported saved strings locally.
    if (conditionIds.some((id) => id.includes(',')))
      return { markets: [], metadataStatus: 'unavailable' }
    // Keep the complete local set. Only each engine request has the API's 100-ID bound.
    for (let offset = 0; offset < conditionIds.length; offset += 100) {
      const ids = conditionIds.slice(offset, offset + 100)
      const response = await client.queryMarkets(
        { ids, state: 'All', pageSize: 100 },
        AbortSignal.timeout(5_000),
      )
      for (const value of response.markets) {
        if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
          byId.set(value.id, value)
      }
    }
    return {
      markets: conditionIds.flatMap((id) => (byId.has(id) ? [byId.get(id)] : [])),
      metadataStatus: 'available',
    }
  } catch {
    return { markets: [], metadataStatus: 'unavailable' }
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
