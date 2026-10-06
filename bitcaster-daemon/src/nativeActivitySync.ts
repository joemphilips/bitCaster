import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { finalizeEvent, validateEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import {
  ACTIVITY_LOG_D_TAG,
  activityItemIdentityKey,
  decodeActivityLogPayload,
  encodeActivityLogPayload,
  mergeActivityLogs,
  type ActivityItem,
} from '@bitcaster-market/client-sdk/activityLog'
import {
  BITCASTER_PRIVATE_STATE_KIND,
  createPrivateNip78Content,
  decryptSelfNip44,
} from '@bitcaster-market/client-sdk/privateNip78'
import { deriveDurableCustodyWalletId } from '@bitcaster-market/client-sdk/durableCustody'
import { readNativeConfig } from './nativeConfig.ts'
import { NativeActivitySqlite } from './nativeActivitySqlite.ts'
import { readProfileSecretAuthority } from './profileBootstrap.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { withDurableCustodyFencedRead } from './durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession, type DaemonStateSqliteSession } from './stateSqlite.ts'
import {
  DAEMON_ACTIVITY_SYNC_ROWS_MAX,
  type WalletActivitySyncParams,
  type WalletActivitySyncResult,
} from './protocol.ts'
import {
  queryNativeActivityRelay,
  publishNativeActivityRelay,
  type NativeActivityRelayOptions,
} from './nativeActivityRelay.ts'

const PLAINTEXT_BYTES_MAX = 65535
const RELAYS_MAX = 16
const RELAY_CONCURRENCY = 4
const DEFAULT_LOCAL_ROWS = 100

interface Selection {
  readonly walletId: string
  readonly publicKey: string
  readonly privateKey: string
  readonly signerRevision: number
  readonly configRevision: string | null
  readonly relays: readonly string[]
}
interface RemoteSnapshot {
  readonly event: Event | null
  readonly items: readonly ActivityItem[]
  readonly complete: boolean
  readonly safeToPublish: boolean
  readonly invalidRows: number
}

export interface NativeActivitySyncOptions extends NativeActivityRelayOptions {
  readonly now?: () => number
}

/** Explicit display sync. The offline Activity reader never calls this adapter. */
export async function syncNativeActivity(
  directory: string,
  getFence: () => CustodyScopeFence,
  request: WalletActivitySyncParams,
  options: NativeActivitySyncOptions = {},
): Promise<WalletActivitySyncResult> {
  const storage = createDaemonStateSqliteSession(directory)
  const now = options.now ?? Date.now
  const fence = getFence()
  const selection = await captureSelection(storage, directory, fence, now())
  if (request.walletId !== undefined && request.walletId !== selection.walletId)
    throw new Error('Activity sync wallet selection changed')
  if (selection.relays.length > RELAYS_MAX)
    throw new Error('Activity sync relay selection exceeds its bound')
  assertNotCancelled(options.signal)
  const remote = await readSnapshots(selection, options)
  const mergedRemote = mergeRemoteSnapshots(remote)
  const imported = await activityTransaction(storage, fence, now(), (database) => {
    assertSelection(database, directory, selection, options.signal)
    const counts = importRows(
      database,
      selection.walletId,
      mergedRemote.items,
      mergedRemote.sources,
    )
    const window = readLocalWindow(
      database,
      selection.walletId,
      request.limit ?? DEFAULT_LOCAL_ROWS,
    )
    return { counts, window }
  })
  const result: WalletActivitySyncResult = {
    walletId: selection.walletId,
    ...imported.counts,
    ignoredRows:
      imported.counts.ignoredRows + remote.reduce((sum, snapshot) => sum + snapshot.invalidRows, 0),
    invalidEnvelopes: remote.filter((snapshot) => !snapshot.safeToPublish).length,
    remoteEventId: newestEvent(remote)?.id ?? null,
    queryComplete: selection.relays.length > 0 && remote.every((snapshot) => snapshot.complete),
    completedRelayCount: remote.filter((snapshot) => snapshot.complete).length,
    selectedRelayCount: selection.relays.length,
    completeHistory: false,
    window: {
      localLimit: request.limit ?? DEFAULT_LOCAL_ROWS,
      localRows: imported.window.items.length,
      localTruncated: imported.window.truncated,
      remoteRowsPerEnvelopeMax: DAEMON_ACTIVITY_SYNC_ROWS_MAX,
      remoteObservedRows: mergedRemote.items.length,
      relaySnapshotsMax: RELAYS_MAX,
    },
    publication: {
      requested: request.publish === true,
      status: 'not-requested',
      reason: null,
      eventId: null,
      plaintextBytes: null,
      acknowledgedRelayCount: 0,
      bestEffort: true,
      remainingReadPublishRace: false,
    },
  }
  if (request.publish !== true) return result
  return publishWindow(
    directory,
    storage,
    fence,
    selection,
    remote,
    imported.window.items,
    result,
    now,
    options,
  )
}

async function captureSelection(
  storage: DaemonStateSqliteSession,
  directory: string,
  fence: CustodyScopeFence,
  nowMs: number,
): Promise<Selection> {
  return withDurableCustodyFencedRead(storage, fence, nowMs, (database) => {
    const config = readNativeConfig(false, directory)
    const signer = readSigner(database)
    if (!signer.enabled) throw new Error('Activity sync signer is disconnected')
    const secrets = readProfileSecretAuthority(
      database,
      process.env.BITCASTER_DAEMON_PASSPHRASE || undefined,
    )
    const walletId = deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex'))
    if (
      fence.scopeId !== `custody:wallet:${walletId}` ||
      secrets.nostrPublicKeyHex !== signer.publicKey
    )
      throw new Error('Activity sync profile binding changed')
    return {
      walletId,
      publicKey: signer.publicKey,
      privateKey: secrets.nostrSecretKeyHex,
      signerRevision: signer.revision,
      configRevision: config.revision,
      relays: config.config.daemon.nostrRelays,
    }
  })
}

function readSigner(database: DatabaseSync) {
  const row = database
    .prepare(
      'SELECT nostr_public_key_hex AS publicKey, signer_enabled AS enabled, signer_revision AS revision FROM daemon_profile WHERE singleton = 1',
    )
    .get() as { readonly publicKey: string; readonly enabled: number; readonly revision: number }
  return { ...row, enabled: row.enabled === 1 }
}

function assertSelection(
  database: DatabaseSync,
  directory: string,
  selection: Selection,
  signal?: AbortSignal,
) {
  assertNotCancelled(signal)
  const current = readSigner(database)
  if (
    !current.enabled ||
    current.publicKey !== selection.publicKey ||
    current.revision !== selection.signerRevision ||
    readNativeConfig(false, directory).revision !== selection.configRevision
  )
    throw new Error('Activity sync signer or relay settings changed')
}

function activityTransaction<T>(
  storage: DaemonStateSqliteSession,
  fence: CustodyScopeFence,
  nowMs: number,
  action: (database: DatabaseSync) => T,
): Promise<T> {
  // Custody fence validation and display writes share one transaction without changing custody state.
  return withDurableCustodyFencedRead(
    { read: (callback) => storage.transaction(callback), transaction: storage.transaction },
    fence,
    nowMs,
    action,
  )
}

async function readSnapshots(
  selection: Selection,
  options: NativeActivitySyncOptions,
): Promise<RemoteSnapshot[]> {
  return boundedMap(selection.relays, async (url) => {
    const query = await queryNativeActivityRelay(
      url,
      {
        kinds: [BITCASTER_PRIVATE_STATE_KIND],
        authors: [selection.publicKey],
        '#d': [ACTIVITY_LOG_D_TAG],
        limit: 1,
      },
      options,
    )
    const event = query.events.reduce<Event | null>((latest, raw) => {
      const candidate = signedActivityEvent(raw, selection.publicKey)
      return candidate !== null && (latest === null || compareEvents(candidate, latest) < 0)
        ? candidate
        : latest
    }, null)
    return readPayload(event, query.complete, selection)
  })
}

function signedActivityEvent(value: unknown, publicKey: string): Event | null {
  try {
    if (!validateEvent(value)) return null
    const event = value as Event
    if (
      event.kind !== BITCASTER_PRIVATE_STATE_KIND ||
      event.pubkey !== publicKey ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      event.tags.filter((tag) => tag[0] === 'd').length !== 1 ||
      !event.tags.some((tag) => tag[0] === 'd' && tag[1] === ACTIVITY_LOG_D_TAG)
    )
      return null
    const signed = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    }
    return verifyEvent(signed) ? signed : null
  } catch {
    return null
  }
}

function readPayload(event: Event | null, complete: boolean, selection: Selection): RemoteSnapshot {
  if (event === null) return { event, items: [], complete, safeToPublish: true, invalidRows: 0 }
  try {
    if (
      event.tags.filter((tag) => tag[0] === 'encrypted').length !== 1 ||
      !event.tags.some((tag) => tag[0] === 'encrypted' && tag[1] === 'nip44')
    )
      throw new Error()
    const plaintext = decryptSelfNip44(selection.privateKey, selection.publicKey, event.content)
    if (Buffer.byteLength(plaintext) > PLAINTEXT_BYTES_MAX) throw new Error()
    const raw: unknown = JSON.parse(plaintext)
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !Array.isArray((raw as { items?: unknown }).items)
    )
      throw new Error()
    const rawItems = (raw as { items: unknown[] }).items
    if (rawItems.length > DAEMON_ACTIVITY_SYNC_ROWS_MAX) throw new Error()
    const items = decodeActivityLogPayload(plaintext)
    if (items === null) throw new Error()
    const safeToPublish = isDeepStrictEqual(raw, JSON.parse(encodeActivityLogPayload(items)))
    return { event, items, complete, safeToPublish, invalidRows: rawItems.length - items.length }
  } catch {
    return { event, items: [], complete, safeToPublish: false, invalidRows: 0 }
  }
}

function compareEvents(a: Event, b: Event): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function newestEvent(remote: readonly RemoteSnapshot[]): Event | null {
  return (
    remote
      .flatMap((snapshot) => (snapshot.event === null ? [] : [snapshot.event]))
      .sort(compareEvents)[0] ?? null
  )
}

function mergeRemoteSnapshots(remote: readonly RemoteSnapshot[]) {
  const ordered = [...remote].sort((a, b) =>
    a.event === null ? -1 : b.event === null ? 1 : -compareEvents(a.event, b.event),
  )
  const sources = new Map<string, string>()
  for (const snapshot of ordered) {
    if (snapshot.event === null) continue
    for (const item of snapshot.items) sources.set(activityItemIdentityKey(item), snapshot.event.id)
  }
  const items = ordered.reduce<ActivityItem[]>(
    (rows, snapshot) => mergeActivityLogs(snapshot.items, rows),
    [],
  )
  return { items, sources }
}

function importRows(
  database: DatabaseSync,
  walletId: string,
  items: readonly ActivityItem[],
  sources: ReadonlyMap<string, string>,
) {
  let importedRows = 0,
    unchangedRows = 0,
    nativeRowsKept = 0,
    ignoredRows = 0
  const store = new NativeActivitySqlite(database)
  for (const item of items) {
    if (
      item.walletId !== walletId ||
      item.id.length === 0 ||
      Buffer.byteLength(item.id) > 1024 ||
      item.amountSubunits < 0 ||
      !Number.isFinite(Date.parse(item.date)) ||
      Buffer.byteLength(JSON.stringify(item)) > 16 * 1024
    ) {
      ignoredRows += 1
      continue
    }
    const existing = database
      .prepare(
        'SELECT origin, item_json AS itemJson FROM daemon_activity_feed WHERE scope_id = ? AND activity_id = ?',
      )
      .get(`custody:wallet:${walletId}`, item.id) as
      | { readonly origin: 'native' | 'relay'; readonly itemJson: string }
      | undefined
    if (existing?.origin === 'native') {
      nativeRowsKept += 1
      continue
    }
    if (existing?.itemJson === JSON.stringify(item)) {
      unchangedRows += 1
      continue
    }
    const eventId = sources.get(activityItemIdentityKey(item))
    if (eventId === undefined) throw new Error('Activity sync source event is missing')
    store.upsert({ walletId, item, origin: 'relay', sourceId: `nip78:${eventId}` })
    importedRows += 1
  }
  return { importedRows, unchangedRows, nativeRowsKept, ignoredRows }
}

function readLocalWindow(database: DatabaseSync, walletId: string, limit: number) {
  const store = new NativeActivitySqlite(database)
  const items: ActivityItem[] = []
  let cursor: string | null = null,
    truncated = false
  do {
    const page = store.page({ walletId, cursor, pageSize: Math.min(50, limit - items.length) })
    items.push(...page.items)
    cursor = page.nextCursor
    truncated = page.hasMore
  } while (cursor !== null && items.length < limit)
  return { items, truncated }
}

async function publishWindow(
  directory: string,
  storage: DaemonStateSqliteSession,
  fence: CustodyScopeFence,
  selection: Selection,
  remote: readonly RemoteSnapshot[],
  local: readonly ActivityItem[],
  result: WalletActivitySyncResult,
  now: () => number,
  options: NativeActivitySyncOptions,
): Promise<WalletActivitySyncResult> {
  const refuse = (
    reason: string,
    plaintextBytes: number | null = null,
  ): WalletActivitySyncResult => ({
    ...result,
    publication: { ...result.publication, status: 'refused', reason, plaintextBytes },
  })
  if (!result.queryComplete) return refuse('relay-query-incomplete')
  if (remote.some((snapshot) => !snapshot.safeToPublish))
    return refuse('remote-envelope-cannot-be-preserved')
  const items = mergeActivityLogs(local, mergeRemoteSnapshots(remote).items)
  const plaintext = encodeActivityLogPayload(items)
  const plaintextBytes = Buffer.byteLength(plaintext)
  if (plaintextBytes > PLAINTEXT_BYTES_MAX || items.length > DAEMON_ACTIVITY_SYNC_ROWS_MAX)
    return refuse('preserved-snapshot-exceeds-sync-bound', plaintextBytes)
  const createdAt = Math.floor(now() / 1000)
  if ((newestEvent(remote)?.created_at ?? -1) >= createdAt)
    return refuse('remote-event-is-not-older-than-publication', plaintextBytes)
  const fresh = await readSnapshots(selection, options)
  if (!fresh.every((snapshot) => snapshot.complete))
    return refuse('final-relay-query-incomplete', plaintextBytes)
  if (fresh.some((snapshot, index) => snapshot.event?.id !== remote[index]?.event?.id))
    return refuse('remote-event-changed', plaintextBytes)
  await withDurableCustodyFencedRead(storage, fence, now(), (database) =>
    assertSelection(database, directory, selection, options.signal),
  )
  const event = finalizeEvent(
    {
      ...createPrivateNip78Content(selection.privateKey, ACTIVITY_LOG_D_TAG, plaintext),
      created_at: createdAt,
    },
    hexToBytes(selection.privateKey),
  )
  const acknowledgements = await boundedMap(selection.relays, async (url) => {
    await withDurableCustodyFencedRead(storage, fence, now(), (database) =>
      assertSelection(database, directory, selection, options.signal),
    )
    return publishNativeActivityRelay(url, event, options, async () => {
      await withDurableCustodyFencedRead(storage, fence, now(), (database) =>
        assertSelection(database, directory, selection, options.signal),
      )
    })
  })
  await withDurableCustodyFencedRead(storage, fence, now(), (database) =>
    assertSelection(database, directory, selection, options.signal),
  )
  const acknowledgedRelayCount = acknowledgements.filter(Boolean).length
  return {
    ...result,
    publication: {
      ...result.publication,
      status:
        acknowledgedRelayCount === selection.relays.length
          ? 'acknowledged'
          : acknowledgedRelayCount === 0
            ? 'failed'
            : 'partial',
      reason: null,
      eventId: event.id,
      plaintextBytes,
      acknowledgedRelayCount,
      remainingReadPublishRace: true,
    },
  }
}

async function boundedMap<T, R>(
  values: readonly T[],
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  let next = 0
  let failed = false
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(RELAY_CONCURRENCY, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++
        try {
          results[index] = await action(values[index]!)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  const rejection = settled.find((result) => result.status === 'rejected')
  if (rejection?.status === 'rejected') throw rejection.reason
  return results
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Activity sync was cancelled')
}
