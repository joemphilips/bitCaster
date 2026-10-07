import { normalizeBookmarkMarkets } from '@bitcaster-market/client-sdk/bookmarks'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import {
  didMarketTransitionToClosed,
  parseObservedMarketState,
  type ObservedMarketState,
} from '@bitcaster-market/client-sdk/likedMarketClose'
import { readLocalNativeBookmarks } from './nativeBookmarks.ts'
import type { createMarketWatch } from './marketWatch.ts'
import {
  DAEMON_MARKET_WATCH_CONDITIONS_MAX,
  validateDaemonWatchCommand,
  type DaemonWatchEvent,
} from './protocol.ts'

/** Adds liked selection and closure observations to the existing authenticated market stream. */
export function createLikedMarketWatch(input: {
  readonly marketWatch: Pick<ReturnType<typeof createMarketWatch>, 'watch'>
  readonly readBookmarks?: () => Promise<string[]>
  readonly assertCanWatch?: () => void
}) {
  return {
    async *watch(signal: AbortSignal): AsyncGenerator<DaemonWatchEvent, void> {
      signal.throwIfAborted()
      const ids = normalizeBookmarkMarkets(
        await awaitAbortable((input.readBookmarks ?? readLocalNativeBookmarks)(), signal),
      )
      if (ids.length > DAEMON_MARKET_WATCH_CONDITIONS_MAX)
        throw new Error(
          'Liked market watch supports at most 200 saved condition IDs. The saved set is unchanged.',
        )
      if (ids.length > 0)
        validateDaemonWatchCommand({ method: 'market.watch', params: { conditionIds: ids } })
      if (ids.length > 0) input.assertCanWatch?.()
      signal.throwIfAborted()
      yield {
        type: 'event',
        event: 'market.liked.selection',
        data: {
          conditionIds: ids,
          state: ids.length === 0 ? 'empty' : 'selected',
          selection: 'captured-at-start',
          restartAfterBookmarkEdit: true,
        },
      }
      if (ids.length === 0) return
      const selected = new Set(ids)
      const lastSeen = new Map<string, ObservedMarketState>()
      for await (const frame of input.marketWatch.watch(ids, signal)) {
        let closedId: string | undefined
        if (frame.event === 'market.snapshot') {
          const observed = snapshotState(frame.data, selected)
          if (observed) {
            if (didMarketTransitionToClosed(lastSeen.get(observed.conditionId), observed.state))
              closedId = observed.conditionId
            lastSeen.set(observed.conditionId, observed.state)
          }
        }
        yield frame
        if (closedId !== undefined) {
          signal.throwIfAborted()
          yield {
            type: 'event',
            event: 'market.closed',
            ...(frame.sourceRevision === undefined ? {} : { sourceRevision: frame.sourceRevision }),
            data: { conditionId: closedId, previousState: 'open', state: 'closed' },
          }
        }
      }
    },
  }
}

function snapshotState(
  value: unknown,
  selected: ReadonlySet<string>,
): {
  conditionId: string
  state: ObservedMarketState
} | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('conditionId' in value) ||
    typeof value.conditionId !== 'string' ||
    !selected.has(value.conditionId) ||
    !('market' in value)
  )
    throw new Error('Liked market snapshot is invalid.')
  if (value.market === null) return null
  if (
    !value.market ||
    typeof value.market !== 'object' ||
    !('conditionId' in value.market) ||
    value.market.conditionId !== value.conditionId ||
    !('state' in value.market)
  )
    throw new Error('Liked market snapshot is invalid.')
  return { conditionId: value.conditionId, state: parseObservedMarketState(value.market.state) }
}
