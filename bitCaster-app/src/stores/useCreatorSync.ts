import { useEffect, useRef, useState } from 'react'
import {
  fetchNip78CreatorMarkets,
  publishNip78CreatorMarkets,
} from '@/lib/nip78CreatorMarkets'
import { resolveNsecIdentity } from '@/lib/identityOps'
import {
  creatorMarketsEqual,
  useCreatorMarketsStore,
  type StoredCreatorMarket,
} from './creatorMarkets'
import { useSettingsStore } from './settings'

const PUBLISH_DEBOUNCE_MS = 800

/**
 * Merge two creator-market sets, keeping the most recently created copy of
 * any duplicates. Newest-first ordering matches the store's in-wizard insert
 * so the dashboard stays deterministic.
 */
function mergeCreatorMarkets(
  a: readonly StoredCreatorMarket[],
  b: readonly StoredCreatorMarket[],
): StoredCreatorMarket[] {
  const byId = new Map<string, StoredCreatorMarket>()
  for (const m of [...a, ...b]) {
    const existing = byId.get(m.conditionId)
    if (!existing || existing.createdAt < m.createdAt) {
      byId.set(m.conditionId, m)
    }
  }
  return Array.from(byId.values()).sort((x, y) =>
    x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0,
  )
}

/**
 * Keep the local creator-markets store in sync with the user's NIP-78
 * `creator-markets` event on Nostr relays. Only active while an nsec-backed
 * Nostr identity is configured.
 *
 *  - On mount: fetch the remote set and merge it with the local set (most
 *    recent `createdAt` wins for duplicates). Publish back if the local set
 *    had entries missing from the remote.
 *  - On any subsequent local change: publish the updated set, debounced so
 *    rapid wizard completions collapse into a single relay round-trip.
 *
 * Mount this once at the application root, alongside `useBookmarkSync`.
 */
export function useCreatorSync(): void {
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode)
  const nsecSecret = useSettingsStore((s) => s.nsecSecret)
  const markets = useCreatorMarketsStore((s) => s.markets)
  const replace = useCreatorMarketsStore((s) => s.replace)
  const [initialSyncDone, setInitialSyncDone] = useState(false)
  const lastPublished = useRef<StoredCreatorMarket[] | null>(null)
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(
    null,
  )

  // Initial fetch + merge whenever the active nsec identity changes.
  useEffect(() => {
    setInitialSyncDone(false)
    lastPublished.current = null
    keysRef.current = null
    if (nostrSignerMode !== 'nsec') return

    const keys = resolveNsecIdentity(nsecSecret)
    if (!keys) return
    keysRef.current = keys

    let cancelled = false
    void (async () => {
      const remote = await fetchNip78CreatorMarkets(keys.publicKey).catch(() => null)
      if (cancelled) return

      const local = useCreatorMarketsStore.getState().markets
      if (remote === null) {
        // No remote state — seed the relay with whatever we have locally.
        lastPublished.current = [...local]
        setInitialSyncDone(true)
        if (local.length > 0) {
          await publishNip78CreatorMarkets(keys.privateKeyHex, local).catch(() => {})
        }
        return
      }

      const merged = mergeCreatorMarkets(local, remote)
      lastPublished.current = merged
      replace(merged)
      setInitialSyncDone(true)

      const remoteIds = new Set(remote.map((m) => m.conditionId))
      const remoteHasAll = local.every((m) => remoteIds.has(m.conditionId))
      if (!remoteHasAll || !creatorMarketsEqual(remote, merged)) {
        await publishNip78CreatorMarkets(keys.privateKeyHex, merged).catch(() => {})
      }
    })()

    return () => {
      cancelled = true
    }
  }, [nostrSignerMode, nsecSecret, replace])

  // Publish to relays whenever the local set changes after the initial sync.
  useEffect(() => {
    if (nostrSignerMode !== 'nsec' || !initialSyncDone) return
    const keys = keysRef.current
    if (!keys) return
    if (
      lastPublished.current &&
      creatorMarketsEqual(lastPublished.current, markets)
    )
      return

    const snapshot = [...markets]
    const handle = setTimeout(() => {
      lastPublished.current = snapshot
      publishNip78CreatorMarkets(keys.privateKeyHex, snapshot).catch(() => {})
    }, PUBLISH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [nostrSignerMode, markets, initialSyncDone])
}
