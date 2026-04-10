import { useEffect, useRef, useState } from 'react'
import { deriveNostrKeyPair } from '@/lib/nip17'
import { fetchBookmarks, publishBookmarks } from '@/lib/nip78Bookmarks'
import { bookmarkSetsEqual, useBookmarkStore } from './bookmarks'
import { useWalletStore } from './wallet'

const PUBLISH_DEBOUNCE_MS = 800

/**
 * Keep the local bookmark store in sync with the user's NIP-78 bookmark
 * event on Nostr relays. Only active while a mnemonic is configured.
 *
 *  - On mount: fetch the remote bookmark set and union it with the local
 *    set. Publish back if the local set had entries missing from the
 *    remote (so the relay picks up any offline-added bookmarks).
 *  - On any subsequent local change: publish the updated set, debounced so
 *    rapid toggles collapse into a single relay round-trip.
 *
 * Mount this once at the application root.
 */
export function useBookmarkSync(): void {
  const mnemonic = useWalletStore((s) => s.mnemonic)
  const markets = useBookmarkStore((s) => s.markets)
  const replace = useBookmarkStore((s) => s.replace)
  const [initialSyncDone, setInitialSyncDone] = useState(false)
  const lastPublished = useRef<string[] | null>(null)
  // deriveNostrKeyPair runs BIP-39 PBKDF2, so derive once per mnemonic and
  // reuse the cached keys for every subsequent publish.
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(
    null,
  )

  // Initial fetch + merge whenever the mnemonic changes.
  useEffect(() => {
    setInitialSyncDone(false)
    lastPublished.current = null
    keysRef.current = null
    if (!mnemonic) return

    const keys = deriveNostrKeyPair(mnemonic)
    keysRef.current = keys

    let cancelled = false
    void (async () => {
      const remote = await fetchBookmarks(keys.publicKey).catch(() => null)
      if (cancelled) return

      const local = useBookmarkStore.getState().markets
      if (remote === null) {
        // No remote state — seed the relay with whatever we have locally.
        // Flip the flag before the async publish so any toggle that lands
        // during the publish await is caught by the publish effect.
        lastPublished.current = [...local]
        setInitialSyncDone(true)
        if (local.length > 0) {
          await publishBookmarks(keys.privateKeyHex, local).catch(() => {})
        }
        return
      }

      const merged = Array.from(new Set([...local, ...remote]))
      lastPublished.current = merged
      replace(merged)
      setInitialSyncDone(true)

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
    if (!mnemonic || !initialSyncDone) return
    const keys = keysRef.current
    if (!keys) return
    if (
      lastPublished.current &&
      bookmarkSetsEqual(lastPublished.current, markets)
    )
      return

    const snapshot = [...markets]
    const handle = setTimeout(() => {
      lastPublished.current = snapshot
      publishBookmarks(keys.privateKeyHex, snapshot).catch(() => {})
    }, PUBLISH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [mnemonic, markets, initialSyncDone])
}
