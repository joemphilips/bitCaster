import { useEffect, useRef } from 'react'
import { deriveNostrKeyPair } from '@/lib/nip17'
import { fetchBookmarks, publishBookmarks } from '@/lib/nip78Bookmarks'
import { useBookmarkStore } from './bookmarks'
import { useWalletStore } from './wallet'

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Keep the local bookmark store in sync with the user's NIP-78 bookmark
 * event on Nostr relays. Only active while a mnemonic is configured.
 *
 *  - On mount: fetch the remote bookmark set and union it with the local
 *    set. Publish back if the local set had entries missing from the
 *    remote (so the relay picks up any offline-added bookmarks).
 *  - On any subsequent local change: publish the updated set.
 *
 * Mount this once at the application root.
 */
export function useBookmarkSync(): void {
  const mnemonic = useWalletStore((s) => s.mnemonic)
  const markets = useBookmarkStore((s) => s.markets)
  const replace = useBookmarkStore((s) => s.replace)
  const initialSyncDone = useRef(false)
  const lastPublished = useRef<string[] | null>(null)

  // Initial fetch + merge whenever the mnemonic changes.
  useEffect(() => {
    initialSyncDone.current = false
    lastPublished.current = null
    if (!mnemonic) return

    let cancelled = false
    void (async () => {
      const keys = deriveNostrKeyPair(mnemonic)
      const remote = await fetchBookmarks(keys.publicKey).catch(() => null)
      if (cancelled) return

      const local = useBookmarkStore.getState().markets
      if (remote === null) {
        // No remote state — seed the relay with whatever we have locally.
        if (local.length > 0) {
          await publishBookmarks(keys.privateKeyHex, local).catch(() => {})
          lastPublished.current = [...local]
        }
        initialSyncDone.current = true
        return
      }

      const merged = Array.from(new Set([...local, ...remote]))
      replace(merged)
      lastPublished.current = [...merged]
      initialSyncDone.current = true

      const remoteHasAll = local.every((id) => remote.includes(id))
      if (!remoteHasAll) {
        await publishBookmarks(keys.privateKeyHex, merged).catch(() => {})
      }
    })()

    return () => {
      cancelled = true
    }
  }, [mnemonic, replace])

  // Publish to relays whenever the local set changes after the initial sync.
  useEffect(() => {
    if (!mnemonic || !initialSyncDone.current) return
    if (lastPublished.current && sameList(lastPublished.current, markets)) return
    lastPublished.current = [...markets]
    const keys = deriveNostrKeyPair(mnemonic)
    publishBookmarks(keys.privateKeyHex, markets).catch(() => {})
  }, [mnemonic, markets])
}
