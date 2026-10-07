import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import {
  ASSET_MONITORING_CONDITIONS_MAX,
  type AssetMonitoringPortfolioResponse,
} from '@bitcaster-market/client-sdk'
import type { DaemonWatchEvent } from './protocol.ts'
import type { WalletBalance } from './state.ts'

export interface WalletWatchLocalSnapshot {
  localHoldings: WalletBalance
  monitoringEnabled: boolean
}

export interface WalletWatchSnapshot {
  localHoldings: WalletBalance
  monitoring:
    | { status: 'disabled' }
    | { status: 'unavailable' }
    | { status: 'available'; portfolio: AssetMonitoringPortfolioResponse }
}

export interface WalletWatchDependencies {
  readLocal(signal: AbortSignal): Promise<WalletWatchLocalSnapshot>
  /** The caller binds this read to the selected wallet ID and its authorization. */
  readPortfolio(signal: AbortSignal): Promise<AssetMonitoringPortfolioResponse>
  subscribeToLocalChanges(callback: () => void): () => void
  hub: {
    start(): Promise<void>
    isConnected(): boolean
    setPortfolioValuationConditions(owner: object, conditionIds: readonly string[]): Promise<void>
    releasePortfolioValuationConditions(owner: object): Promise<void>
  }
}

interface Observer {
  conditions: Set<string>
  monitoringEnabled: boolean
  dirty: boolean
  subscribed: boolean
  wake(): void
}

/** This view passes through local holdings and display estimates. It does not authorize custody. */
export function createWalletWatch(input: WalletWatchDependencies) {
  const observers = new Set<Observer>()
  let connected = false
  let connectionRevision = 0
  const setConnected = (value: boolean, force = false, reading?: Observer) => {
    if (connected === value && !force) return
    connected = value
    connectionRevision++
    for (const observer of observers) {
      if (!observer.monitoringEnabled) continue
      if (observer !== reading) observer.dirty = true
      observer.wake()
    }
  }
  const invalidate = (observer: Observer) => {
    if (!observers.has(observer)) return
    observer.dirty = true
    observer.wake()
  }

  return {
    /** Refresh display estimates after a current-profile report is accepted. */
    refreshPortfolio(): void {
      for (const observer of observers) if (observer.monitoringEnabled) invalidate(observer)
    },
    invalidate(conditionId: string): void {
      for (const observer of observers)
        if (observer.monitoringEnabled && observer.conditions.has(conditionId)) invalidate(observer)
    },
    disconnected: () => setConnected(false),
    reconnected: () => setConnected(true, true),
    async *watch(signal: AbortSignal): AsyncGenerator<DaemonWatchEvent, void> {
      signal.throwIfAborted()
      const observer: Observer = {
        conditions: new Set(),
        monitoringEnabled: false,
        dirty: true,
        subscribed: false,
        wake: () => {},
      }
      let unsubscribe: (() => void) | undefined
      let seenConnectionRevision = -1
      observers.add(observer)
      try {
        unsubscribe = input.subscribeToLocalChanges(() => invalidate(observer))
        while (!signal.aborted) {
          if (observer.dirty) {
            observer.dirty = false
            const local = await awaitAbortable(input.readLocal(signal), signal)
            observer.monitoringEnabled = local.monitoringEnabled
            if (!local.monitoringEnabled) {
              observer.conditions.clear()
              if (observer.subscribed) {
                observer.subscribed = false
                try {
                  await awaitAbortable(
                    input.hub.releasePortfolioValuationConditions(observer),
                    signal,
                  )
                } catch {
                  signal.throwIfAborted()
                }
              }
              yield snapshotEvent({
                localHoldings: local.localHoldings,
                monitoring: { status: 'disabled' },
              })
              continue
            }
            try {
              await awaitAbortable(input.hub.start(), signal)
              setConnected(input.hub.isConnected(), false, observer)
            } catch {
              signal.throwIfAborted()
              setConnected(false, false, observer)
            }
            const revision = connectionRevision
            const snapshot = await readMonitoringSnapshot(
              input,
              local.localHoldings,
              connected,
              signal,
            )
            signal.throwIfAborted()
            if (revision !== connectionRevision) {
              observer.dirty = true
              continue
            }
            const conditions = valuationConditions(snapshot)
            try {
              const changed =
                conditions !== null &&
                (conditions.length !== observer.conditions.size ||
                  conditions.some((id) => !observer.conditions.has(id)))
              observer.subscribed = true
              await awaitAbortable(
                input.hub.setPortfolioValuationConditions(observer, conditions ?? []),
                signal,
              )
              observer.conditions = new Set(conditions ?? [])
              // A new membership can miss a change between the read and the hub acknowledgement.
              if (changed) observer.dirty = true
            } catch {
              signal.throwIfAborted()
              snapshot.monitoring = { status: 'unavailable' }
            }
            if (conditions === null) snapshot.monitoring = { status: 'unavailable' }
            signal.throwIfAborted()
            if (revision !== connectionRevision) {
              observer.dirty = true
              continue
            }
            yield snapshotEvent(snapshot)
            continue
          }
          // A fresh snapshot precedes the connection message after every reconnect.
          if (observer.monitoringEnabled && seenConnectionRevision !== connectionRevision) {
            seenConnectionRevision = connectionRevision
            yield {
              type: 'event',
              event: 'wallet.connection',
              data: { state: connected ? 'connected' : 'reconnecting' },
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
        unsubscribe?.()
        observer.wake = () => {}
        if (observer.subscribed) {
          const released = input.hub.releasePortfolioValuationConditions(observer)
          if (signal.aborted) void released.catch(() => undefined)
          else await released
        }
      }
    },
  }
}

async function readMonitoringSnapshot(
  input: WalletWatchDependencies,
  localHoldings: WalletBalance,
  connected: boolean,
  signal: AbortSignal,
): Promise<WalletWatchSnapshot> {
  if (connected) {
    try {
      const portfolio = await awaitAbortable(input.readPortfolio(signal), signal)
      return { localHoldings, monitoring: { status: 'available', portfolio } }
    } catch {
      signal.throwIfAborted()
    }
  }
  return { localHoldings, monitoring: { status: 'unavailable' } }
}

function valuationConditions(snapshot: WalletWatchSnapshot): string[] | null {
  const ids = new Set(
    snapshot.localHoldings.outcomePositions.map((position) => position.conditionId),
  )
  switch (snapshot.monitoring.status) {
    case 'available':
      for (const { asset } of snapshot.monitoring.portfolio.assets.assets) {
        switch (asset.kind) {
          case 'collateral':
            break
          case 'conditional':
            ids.add(asset.conditionId)
            break
          default:
            assertNever(asset)
        }
      }
      break
    case 'disabled':
    case 'unavailable':
      break
    default:
      assertNever(snapshot.monitoring)
  }
  // The hub refuses overflow. An arbitrary subset must not appear to be a current portfolio.
  if (
    ids.size > ASSET_MONITORING_CONDITIONS_MAX ||
    [...ids].some((id) => !/^[0-9a-fA-F]{1,128}$/.test(id))
  )
    return null
  return [...ids].sort()
}

function snapshotEvent(snapshot: WalletWatchSnapshot): DaemonWatchEvent<WalletWatchSnapshot> {
  const event = { type: 'event' as const, event: 'wallet.snapshot', data: snapshot }
  switch (snapshot.monitoring.status) {
    case 'available':
      return { ...event, sourceRevision: snapshot.monitoring.portfolio.summary.valuationRevision }
    case 'disabled':
    case 'unavailable':
      return event
    default:
      return assertNever(snapshot.monitoring)
  }
}

function assertNever(_value: never): never {
  throw new Error('wallet watch variant is unsupported')
}
