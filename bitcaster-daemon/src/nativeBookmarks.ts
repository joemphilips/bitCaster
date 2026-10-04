import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import {
  BOOKMARK_D_TAG,
  BOOKMARK_KIND,
  bookmarkEventTemplate,
  bookmarkSetsEqual,
  normalizeBookmarkMarkets,
  parseBookmarkPayload,
  setMarketBookmark,
  unionBookmarkMarkets,
} from '@bitcaster-market/client-sdk/bookmarks'
import { readNativeConfig } from './nativeConfig.ts'
import { profileDir } from './profile.ts'
import { readSecrets, readSelectedDaemonSigner } from './secrets.ts'
import { createDaemonStateSqliteSession, type DaemonStateSqliteSession } from './stateSqlite.ts'
import { createNativeNostrRelays, type NativeNostrRelayOptions } from './nativeNostrRelay.ts'
import type { DatabaseSync } from 'node:sqlite'

interface BookmarkSelection {
  readonly publicKeyHex: string
  readonly enabled: boolean
  readonly revision: number
  readonly relays: readonly string[]
}

export interface NativeBookmarkOptions {
  readonly directory?: string
  readonly signal?: AbortSignal
  readonly relayOptions?: Omit<NativeNostrRelayOptions, 'signal'>
  /** Test seams replace authority reads, never Nostr validation or the relay owner. */
  readonly readSelection?: () => Promise<BookmarkSelection>
  readonly readSecretKey?: () => Promise<string>
  readonly now?: () => number
}

interface BookmarkRow {
  markets: string[]
  context: string | null
  pending: boolean
  revision: number
  lastEventTime: number
}

export interface NativeBookmarkResult {
  readonly markets: string[]
  readonly revision: number
  readonly sync: {
    readonly status:
      | 'synced'
      | 'pending'
      | 'disabled'
      | 'no-relays'
      | 'selection-changed'
      | 'local-changed'
    readonly remote: 'merged' | 'unavailable' | 'unchanged' | 'not-read'
    readonly publishedRelays: string[]
    readonly failedRelays: string[]
  }
}

export async function readLocalNativeBookmarks(
  options: NativeBookmarkOptions = {},
): Promise<string[]> {
  return createDaemonStateSqliteSession(options.directory ?? profileDir()).read(
    (db) => readRow(db).markets,
  )
}

export function listNativeBookmarks(
  options: NativeBookmarkOptions = {},
): Promise<NativeBookmarkResult> {
  return runBookmarkOperation(undefined, options)
}

export function setNativeMarketBookmark(
  marketId: string,
  liked: boolean,
  options: NativeBookmarkOptions = {},
): Promise<NativeBookmarkResult> {
  if (typeof marketId !== 'string' || marketId.length === 0)
    throw new Error('Bookmark market ID must not be empty.')
  return runBookmarkOperation({ marketId, liked }, options)
}

async function runBookmarkOperation(
  edit: { marketId: string; liked: boolean } | undefined,
  options: NativeBookmarkOptions,
): Promise<NativeBookmarkResult> {
  const directory = options.directory ?? profileDir()
  const store = createDaemonStateSqliteSession(directory)
  const readSelection = options.readSelection ?? (() => selectedApplicationSigner(directory))
  const selected = await readSelection()
  const context = JSON.stringify([selected.publicKeyHex, selected.relays])
  let row = await store.read(readRow)
  let remoteStatus: NativeBookmarkResult['sync']['remote'] = 'not-read'
  let remoteEvent: Event | null = null
  const relayOwners = selected.enabled
    ? createNativeNostrRelays(selected.relays, {
        ...options.relayOptions,
        signal: options.signal,
      })
    : []
  const failed = new Set<string>()
  const published: string[] = []
  try {
    // Initial union runs once for each selected application identity and exact relay list.
    // A pending local edit must not be replaced by an old remote set on process reopen.
    if (relayOwners.length > 0 && row.context !== context) {
      const reads = await Promise.all(
        relayOwners.map(async (relay) => {
          try {
            await relay.connect()
            return await fetchCurrentBookmarks(relay, selected.publicKeyHex, options.signal)
          } catch {
            failed.add(relay.url)
            return undefined
          }
        }),
      )
      remoteStatus = reads.some((event) => event !== undefined) ? 'unchanged' : 'unavailable'
      for (const event of reads) {
        if (event && (!remoteEvent || newerEvent(event, remoteEvent))) remoteEvent = event
      }
    }
    const applied = await store.transaction((db) =>
      applyBookmarkSnapshot(db, {
        context,
        remoteEvent,
        remoteStatus,
        edit,
        canSync: relayOwners.length > 0,
      }),
    )
    row = applied.row
    remoteStatus = applied.remoteStatus
    const result = (status: NativeBookmarkResult['sync']['status']): NativeBookmarkResult => ({
      markets: row.markets,
      revision: row.revision,
      sync: { status, remote: remoteStatus, publishedRelays: published, failedRelays: [...failed] },
    })
    if (!selected.enabled) return result('disabled')
    if (relayOwners.length === 0) return result('no-relays')
    if (!row.pending) return result(failed.size > 0 ? 'pending' : 'synced')
    return result(
      await publishBookmarkSnapshot({
        store,
        row,
        selected,
        readSelection,
        relayOwners,
        failed,
        published,
        options,
      }),
    )
  } finally {
    relayOwners.forEach((relay) => relay.close())
  }
}

function applyBookmarkSnapshot(
  db: DatabaseSync,
  input: {
    context: string
    remoteEvent: Event | null
    remoteStatus: NativeBookmarkResult['sync']['remote']
    edit: { marketId: string; liked: boolean } | undefined
    canSync: boolean
  },
): { row: BookmarkRow; remoteStatus: NativeBookmarkResult['sync']['remote'] } {
  const current = readRow(db)
  let { markets, pending, context } = current
  let { remoteStatus } = input
  if (input.canSync && current.context !== input.context) {
    const remote = input.remoteEvent ? parseBookmarkPayload(input.remoteEvent.content)! : null
    if (remote !== null) {
      markets = unionBookmarkMarkets(markets, remote)
      pending = !bookmarkSetsEqual(markets, remote)
      remoteStatus = bookmarkSetsEqual(markets, current.markets) ? 'unchanged' : 'merged'
    } else pending = pending || markets.length > 0
    // A failed read with no local intent remains retryable. Local edits take precedence.
    if (remoteStatus !== 'unavailable' || pending || input.edit) context = input.context
  }
  if (input.edit) {
    const next = setMarketBookmark(markets, input.edit.marketId, input.edit.liked)
    pending ||= !bookmarkSetsEqual(markets, next) || remoteStatus === 'unavailable'
    markets = next
  }
  const changed =
    !bookmarkSetsEqual(markets, current.markets) ||
    pending !== current.pending ||
    context !== current.context
  const row = {
    ...current,
    markets,
    pending,
    context,
    revision: changed ? increment(current.revision) : current.revision,
    lastEventTime: Math.max(current.lastEventTime, input.remoteEvent?.created_at ?? 0),
  }
  writeRow(db, row)
  return { row, remoteStatus }
}

async function publishBookmarkSnapshot(input: {
  store: DaemonStateSqliteSession
  row: BookmarkRow
  selected: BookmarkSelection
  readSelection: () => Promise<BookmarkSelection>
  relayOwners: ReturnType<typeof createNativeNostrRelays>
  failed: Set<string>
  published: string[]
  options: NativeBookmarkOptions
}): Promise<NativeBookmarkResult['sync']['status']> {
  const { store, row, selected, readSelection, relayOwners, failed, published, options } = input
  let key: string
  try {
    key = await (options.readSecretKey ?? selectedApplicationSecret)()
  } catch {
    return 'pending'
  }
  const secret = Uint8Array.from(Buffer.from(key, 'hex'))
  if (getPublicKey(secret) !== selected.publicKeyHex) return 'selection-changed'
  if (row.lastEventTime >= Number.MAX_SAFE_INTEGER) return 'pending'
  const createdAt = Math.max(
    Math.floor((options.now ?? Date.now)() / 1000),
    increment(row.lastEventTime),
  )
  // Reserve a newer event time even if a relay stores the event but loses its acknowledgement.
  await store.transaction((db) => {
    const current = readRow(db)
    if (current.revision === row.revision && current.context === row.context)
      writeRow(db, { ...current, lastEventTime: Math.max(current.lastEventTime, createdAt) })
  })
  const event = finalizeEvent(bookmarkEventTemplate(row.markets, createdAt), secret)
  let stale: 'selection-changed' | 'local-changed' | undefined
  for (const relay of relayOwners) {
    try {
      await relay.connect()
      const current = await readSelection()
      const latest = await store.read(readRow)
      if (!sameSelection(selected, current)) {
        stale = 'selection-changed'
        break
      }
      if (latest.revision !== row.revision || latest.context !== row.context) {
        stale = 'local-changed'
        break
      }
      await relay.publish(event)
      published.push(relay.url)
    } catch {
      failed.add(relay.url)
    }
  }
  if (published.length > 0) {
    await store.transaction((db) => {
      const current = readRow(db)
      if (current.revision !== row.revision || current.context !== row.context) return
      writeRow(db, {
        ...current,
        lastEventTime: createdAt,
        pending: stale !== undefined || published.length !== relayOwners.length,
      })
    })
  }
  return stale ?? (published.length === relayOwners.length ? 'synced' : 'pending')
}

async function selectedApplicationSigner(directory: string): Promise<BookmarkSelection> {
  const signer = await readSelectedDaemonSigner()
  return { ...signer, relays: readNativeConfig(false, directory).config.daemon.nostrRelays }
}

async function selectedApplicationSecret(): Promise<string> {
  const secrets = await readSecrets()
  if (!secrets) throw new Error('Application signer is not initialized.')
  return secrets.nostrSecretKeyHex
}

function sameSelection(left: BookmarkSelection, right: BookmarkSelection): boolean {
  return (
    left.publicKeyHex === right.publicKeyHex &&
    left.enabled === right.enabled &&
    left.revision === right.revision &&
    JSON.stringify(left.relays) === JSON.stringify(right.relays)
  )
}

function fetchCurrentBookmarks(
  relay: ReturnType<typeof createNativeNostrRelays>[number],
  author: string,
  signal?: AbortSignal,
): Promise<Event | null> {
  return new Promise((resolve, reject) => {
    let newest: Event | null = null
    let subscription: { close(): void } | undefined
    const finish = (failed = false) => {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      subscription?.close()
      if (failed) reject(new Error('Bookmark relay read failed.'))
      else resolve(newest)
    }
    const abort = () => finish(true)
    const deadline = setTimeout(() => finish(true), 5_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return finish(true)
    subscription = relay.subscribe(
      [{ kinds: [BOOKMARK_KIND], authors: [author], '#d': [BOOKMARK_D_TAG] }],
      {
        onevent: (event) => {
          if (
            event.kind !== BOOKMARK_KIND ||
            event.pubkey !== author ||
            event.tags.find((tag) => tag[0] === 'd')?.[1] !== BOOKMARK_D_TAG ||
            !Number.isSafeInteger(event.created_at) ||
            event.created_at < 0 ||
            !verifyEvent(event) ||
            parseBookmarkPayload(event.content) === null
          )
            return
          if (!newest || newerEvent(event, newest)) newest = event
        },
        oneose: () => finish(),
        onclose: () => finish(true),
        eoseTimeoutMs: 5_000,
      },
    )
  })
}

function newerEvent(candidate: Event, previous: Event): boolean {
  return (
    candidate.created_at > previous.created_at ||
    (candidate.created_at === previous.created_at && candidate.id < previous.id)
  )
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER)
    throw new Error('Bookmark preference revision is exhausted.')
  return value + 1
}

function readRow(db: DatabaseSync): BookmarkRow {
  const row = db
    .prepare(
      `SELECT markets_json AS marketsJson, sync_context AS context,
    pending_local_edit AS pending, revision, last_event_time AS lastEventTime
    FROM daemon_bookmark_preferences WHERE singleton=1`,
    )
    .get() as
    | {
        marketsJson: string
        context: string | null
        pending: number
        revision: number
        lastEventTime: number
      }
    | undefined
  if (!row) return { markets: [], context: null, pending: false, revision: 0, lastEventTime: 0 }
  return {
    ...row,
    markets: normalizeBookmarkMarkets(JSON.parse(row.marketsJson)),
    pending: row.pending === 1,
  }
}

function writeRow(db: DatabaseSync, row: BookmarkRow): void {
  db.prepare(
    `INSERT INTO daemon_bookmark_preferences
    (singleton,markets_json,sync_context,pending_local_edit,revision,last_event_time) VALUES (1,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET markets_json=excluded.markets_json,
    sync_context=excluded.sync_context,pending_local_edit=excluded.pending_local_edit,
    revision=excluded.revision,last_event_time=excluded.last_event_time`,
  ).run(
    JSON.stringify(row.markets),
    row.context,
    Number(row.pending),
    row.revision,
    row.lastEventTime,
  )
}
