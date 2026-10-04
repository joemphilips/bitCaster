import {
  awaitAbortable,
  type BitcasterEngineClient,
} from '@bitcaster-market/client-sdk/engineClient'
import type { DaemonWatchEvent } from './protocol.ts'
import type { SignalRMarketHubConnection } from './marketHubConnection.ts'

type WatchHub = Pick<
  SignalRMarketHubConnection,
  'start' | 'setMarkets' | 'releaseMarkets' | 'isConnected'
>
type WatchEngine = Pick<
  BitcasterEngineClient,
  'getMarketRegistration' | 'getMarket' | 'getOrderBook'
>

interface Observer {
  readonly conditions: Set<string>
  readonly dirty: Set<string>
  wake: () => void
}

/** Market events invalidate reads. They do not become price or settlement authority. */
export function createMarketWatch(input: { hub: WatchHub; engine: WatchEngine }) {
  const observers = new Set<Observer>()
  let connected = false
  let connectionRevision = 0

  const setConnected = (value: boolean, force = false) => {
    if (connected === value && !force) return
    connected = value
    connectionRevision += 1
    for (const observer of observers) {
      if (connected) for (const id of observer.conditions) observer.dirty.add(id)
      observer.wake()
    }
  }

  return {
    invalidate(conditionId: string): void {
      for (const observer of observers) {
        if (!observer.conditions.has(conditionId)) continue
        observer.dirty.add(conditionId)
        observer.wake()
      }
    },
    disconnected: () => setConnected(false),
    reconnected(): void {
      // A reconnect can follow an unobserved disconnect. Always refresh its snapshot.
      setConnected(true, true)
    },
    async *watch(
      conditionIds: readonly string[],
      signal: AbortSignal,
    ): AsyncGenerator<DaemonWatchEvent, void> {
      const conditions = new Set(conditionIds)
      if (
        conditions.size === 0 ||
        conditionIds.length > 200 ||
        conditions.size !== conditionIds.length ||
        [...conditions].some((id) => !/^[0-9a-f]{64}$/.test(id))
      )
        throw new Error('invalid market watch selection')
      const observer: Observer = { conditions, dirty: new Set(conditions), wake: () => {} }
      const routes = new Map<string, string[]>()
      let seenConnectionRevision = -1
      observers.add(observer)
      try {
        for (const conditionId of conditions) {
          signal.throwIfAborted()
          const registration = await awaitAbortable(
            input.engine.getMarketRegistration(conditionId, signal),
            signal,
          )
          if (
            registration === null ||
            registration.conditionId !== conditionId ||
            registration.outcomes.length < 2 ||
            registration.outcomes.length > 8 ||
            new Set(registration.outcomes).size !== registration.outcomes.length ||
            registration.outcomes.some((outcome) => !/^[a-zA-Z0-9]+$/.test(outcome))
          )
            throw new Error('market watch registration is unavailable')
          routes.set(
            conditionId,
            registration.outcomes.map((outcome) => `${conditionId}-${outcome}`),
          )
        }
        await awaitAbortable(input.hub.setMarkets(observer, [...routes.values()].flat()), signal)
        await awaitAbortable(input.hub.start(), signal)
        setConnected(input.hub.isConnected())
        while (!signal.aborted) {
          if (seenConnectionRevision !== connectionRevision) {
            seenConnectionRevision = connectionRevision
            yield {
              type: 'event',
              event: 'market.connection',
              data: { state: connected ? 'connected' : 'reconnecting' },
            }
            continue
          }
          const conditionId = connected ? observer.dirty.values().next().value : undefined
          if (conditionId !== undefined) {
            observer.dirty.delete(conditionId)
            const revision = connectionRevision
            const market = await awaitAbortable(input.engine.getMarket(conditionId, signal), signal)
            const orderBooks = []
            for (const route of routes.get(conditionId)!)
              orderBooks.push(
                await awaitAbortable(input.engine.getOrderBook(route, signal), signal),
              )
            signal.throwIfAborted()
            if (revision !== connectionRevision || !connected) {
              observer.dirty.add(conditionId)
              continue
            }
            yield {
              type: 'event',
              event: 'market.snapshot',
              data: { conditionId, market, orderBooks },
            }
            continue
          }
          await awaitAbortable(
            new Promise<void>((resolve) => {
              observer.wake = resolve
            }),
            signal,
          )
          observer.wake = () => {}
        }
      } finally {
        observers.delete(observer)
        observer.wake = () => {}
        const released = input.hub.releaseMarkets(observer)
        // Releasing the owner is immediate. A pending hub invocation must not delay cancellation.
        if (signal.aborted) void released.catch(() => undefined)
        else await released
      }
    },
  }
}
