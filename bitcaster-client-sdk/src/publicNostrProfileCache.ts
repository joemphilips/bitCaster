import {
  readNostrProfile,
  type NostrProfileQuery,
  type NostrPublicProfile,
} from './nostrProfile.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

type AbortableProfileQuery = (
  ...args: [...Parameters<NostrProfileQuery>, AbortSignal]
) => Promise<void>

/** Optional display enrichment. The transport must settle and close sockets on abort. */
export function createPublicNostrProfileCache(query: AbortableProfileQuery, now = Date.now) {
  type Entry = {
    promise: Promise<NostrPublicProfile | null>
    resolve: (profile: NostrPublicProfile | null) => void
    expires: number
    pending: boolean
    consumers: number
    controller: AbortController
    start: () => void
  }
  const entries = new Map<string, Entry>()
  const queue = new Set<Entry>()
  let running = 0
  const pump = () => {
    while (running < 4 && queue.size) {
      const entry = queue.values().next().value!
      queue.delete(entry)
      running++
      entry.start()
    }
  }
  const lease = (key: string, entry: Entry, signal?: AbortSignal) => {
    entry.consumers++
    return new Promise<NostrPublicProfile | null>((resolve) => {
      let complete = false
      const finish = (profile: NostrPublicProfile | null) => {
        if (complete) return
        complete = true
        signal?.removeEventListener('abort', abort)
        entry.consumers--
        if (entry.pending && entry.consumers === 0) {
          if (entries.get(key) === entry) entries.delete(key)
          queue.delete(entry)
          entry.pending = false
          entry.controller.abort()
          entry.resolve(null)
        }
        resolve(profile)
      }
      const abort = () => finish(null)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      void entry.promise.then(finish)
    })
  }
  return {
    read(
      publicKey: string,
      relayUrls: readonly string[],
      signal?: AbortSignal,
    ): Promise<NostrPublicProfile | null> {
      if (signal?.aborted || !/^[0-9a-f]{64}$/.test(publicKey)) return Promise.resolve(null)
      // Four authors, each with at most three relay sockets, can be active.
      const relays = normalizeNostrRelayUrls(relayUrls).slice(0, 3)
      const key = JSON.stringify([publicKey, relays])
      const cached = entries.get(key)
      if (cached && (cached.pending || cached.expires > now())) return lease(key, cached, signal)
      if (cached) entries.delete(key)
      if (entries.size >= 128) {
        const oldest = [...entries].find(([, entry]) => !entry.pending)
        if (!oldest) return Promise.resolve(null)
        entries.delete(oldest[0])
      }
      let resolve!: (profile: NostrPublicProfile | null) => void
      const promise = new Promise<NostrPublicProfile | null>((done) => {
        resolve = done
      })
      const entry: Entry = {
        promise,
        resolve,
        expires: 0,
        pending: true,
        consumers: 0,
        controller: new AbortController(),
        start: () => {
          void readNostrProfile(publicKey, relays, (url, filter, receive) =>
            query(url, filter, receive, entry.controller.signal),
          )
            .then(
              (result) => result.profile,
              () => null,
            )
            .then((profile) => {
              if (entry.controller.signal.aborted) return
              entry.pending = false
              entry.expires = now() + (profile ? 60_000 : 10_000)
              entry.resolve(profile)
            })
            .finally(() => {
              running--
              pump()
            })
        },
      }
      entries.set(key, entry)
      queue.add(entry)
      const consumer = lease(key, entry, signal)
      pump()
      return consumer
    },
  }
}
