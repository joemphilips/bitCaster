import type { DatabaseSync } from 'node:sqlite'
import { decodeActivityItem, type ActivityItem } from '@bitcaster-market/client-sdk/activityLog'

const ACTIVITY_BYTES_MAX = 16 * 1_024
const CURSOR_BYTES_MAX = 512
const PAGE_SIZE_MAX = 50
const WALLET_ID = /^[0-9a-f]{64}$/
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const NATIVE_ACTIVITY_SCHEMA_SQL = [
  `CREATE TABLE daemon_activity_feed_meta (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    instance_id TEXT NOT NULL CHECK (
      length(instance_id) = 36
      AND substr(instance_id, 9, 1) = '-'
      AND substr(instance_id, 14, 1) = '-'
      AND substr(instance_id, 19, 1) = '-'
      AND substr(instance_id, 24, 1) = '-'
      AND replace(instance_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT`,
  `CREATE TABLE daemon_activity_feed (
    sequence INTEGER PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    activity_id TEXT NOT NULL CHECK (length(CAST(activity_id AS BLOB)) BETWEEN 1 AND 1024),
    origin TEXT NOT NULL CHECK (origin IN ('native', 'relay')),
    source_id TEXT NOT NULL CHECK (length(CAST(source_id AS BLOB)) BETWEEN 1 AND 1024),
    item_json TEXT NOT NULL CHECK (
      length(CAST(item_json AS BLOB)) BETWEEN 1 AND ${ACTIVITY_BYTES_MAX}
      AND json_valid(item_json)
      AND json_type(item_json) = 'object'
    ),
    UNIQUE (scope_id, activity_id)
  ) STRICT`,
  `CREATE INDEX daemon_activity_feed_page_idx
    ON daemon_activity_feed (scope_id, sequence DESC)`,
  `CREATE TRIGGER daemon_activity_feed_no_delete
    BEFORE DELETE ON daemon_activity_feed
    BEGIN SELECT RAISE(ABORT, 'native Activity display rows cannot be deleted'); END`,
  `CREATE TRIGGER daemon_activity_feed_identity_immutable
    BEFORE UPDATE ON daemon_activity_feed
    WHEN NEW.sequence <> OLD.sequence
      OR NEW.scope_id <> OLD.scope_id
      OR NEW.activity_id <> OLD.activity_id
    BEGIN SELECT RAISE(ABORT, 'native Activity display identity is immutable'); END`,
  `CREATE TRIGGER daemon_activity_feed_meta_immutable
    BEFORE UPDATE ON daemon_activity_feed_meta
    BEGIN SELECT RAISE(ABORT, 'native Activity feed identity is immutable'); END`,
  `CREATE TRIGGER daemon_activity_feed_meta_no_delete
    BEFORE DELETE ON daemon_activity_feed_meta
    BEGIN SELECT RAISE(ABORT, 'native Activity feed identity cannot be deleted'); END`,
] as const

export interface NativeActivityPage {
  readonly items: readonly ActivityItem[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface NativeActivityPageInput {
  readonly walletId: string
  readonly cursor?: string | null
  readonly pageSize?: number
}

interface ActivityCursor {
  readonly version: 1
  readonly walletId: string
  readonly instanceId: string
  readonly maximumSequence: number
  readonly lastSequence: number
}

interface ActivityRow {
  readonly sequence: number
  readonly itemJson: string
}

/** The caller owns the transaction for writes and the validated profile read for pages. */
export class NativeActivitySqlite {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  initialize(instanceId: string): void {
    if (!INSTANCE_ID.test(instanceId)) throw new Error('native Activity instance ID is invalid')
    this.#database
      .prepare('INSERT INTO daemon_activity_feed_meta (singleton, instance_id) VALUES (1, ?)')
      .run(instanceId)
  }

  upsert(input: {
    readonly walletId: string
    readonly item: ActivityItem
    readonly origin: 'native' | 'relay'
    readonly sourceId: string
  }): void {
    const item = decodeActivityItem(input.item)
    if (
      item === null ||
      item.walletId === undefined ||
      !WALLET_ID.test(item.walletId) ||
      item.walletId !== input.walletId ||
      item.id.length === 0 ||
      Buffer.byteLength(item.id) > 1024 ||
      !Number.isSafeInteger(item.amountSubunits) ||
      item.amountSubunits < 0 ||
      !Number.isFinite(Date.parse(item.date)) ||
      input.sourceId.length === 0 ||
      Buffer.byteLength(input.sourceId) > 1024
    ) {
      throw new Error('native Activity item is invalid')
    }
    const body = JSON.stringify(item)
    if (Buffer.byteLength(body) > ACTIVITY_BYTES_MAX) {
      throw new Error('native Activity item exceeds the byte limit')
    }
    const scopeId = `custody:wallet:${input.walletId}`
    const previous = this.#database
      .prepare(
        `SELECT origin, source_id AS sourceId
         FROM daemon_activity_feed WHERE scope_id = ? AND activity_id = ?`,
      )
      .get(scopeId, item.id) as
      | { readonly origin: 'native' | 'relay'; readonly sourceId: string }
      | undefined
    if (previous?.origin === 'native' && input.origin === 'relay') return
    if (
      previous?.origin === 'native' &&
      input.origin === 'native' &&
      previous.sourceId !== input.sourceId
    ) {
      throw new Error('native Activity source identity conflicts')
    }
    this.#database
      .prepare(
        `INSERT INTO daemon_activity_feed
           (scope_id, activity_id, origin, source_id, item_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, activity_id) DO UPDATE SET
           origin = excluded.origin,
           source_id = excluded.source_id,
           item_json = excluded.item_json`,
      )
      .run(scopeId, item.id, input.origin, input.sourceId, body)
  }

  page(input: NativeActivityPageInput): NativeActivityPage {
    if (!WALLET_ID.test(input.walletId)) throw new Error('native Activity wallet ID is invalid')
    const pageSize = input.pageSize ?? 25
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
      throw new Error('native Activity page size is invalid')
    }
    const instanceId = this.#instanceId()
    const scopeId = `custody:wallet:${input.walletId}`
    const cursor = input.cursor == null ? null : decodeCursor(input.cursor)
    if (
      cursor !== null &&
      (cursor.walletId !== input.walletId || cursor.instanceId !== instanceId)
    ) {
      throw new Error('native Activity cursor is foreign or stale')
    }
    const maximumSequence = cursor?.maximumSequence ?? this.#maximumSequence(scopeId)
    const rows = this.#database
      .prepare(
        `SELECT sequence, item_json AS itemJson
         FROM daemon_activity_feed
         WHERE scope_id = ? AND sequence <= ? AND sequence < ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        scopeId,
        maximumSequence,
        cursor?.lastSequence ?? Number.MAX_SAFE_INTEGER,
        pageSize + 1,
      ) as unknown as ActivityRow[]
    const visible = rows.slice(0, pageSize)
    const items = visible.map((row) => {
      const item: unknown = JSON.parse(row.itemJson)
      const decoded = decodeActivityItem(item)
      if (decoded === null || decoded.walletId !== input.walletId) {
        throw new Error('native Activity display row is invalid')
      }
      return decoded
    })
    const hasMore = rows.length > pageSize
    const lastSequence = visible.at(-1)?.sequence
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && lastSequence !== undefined
          ? encodeCursor({
              version: 1,
              walletId: input.walletId,
              instanceId,
              maximumSequence,
              lastSequence,
            })
          : null,
    }
  }

  #instanceId(): string {
    const row = this.#database
      .prepare(
        'SELECT instance_id AS instanceId FROM daemon_activity_feed_meta WHERE singleton = 1',
      )
      .get() as { readonly instanceId?: unknown } | undefined
    if (typeof row?.instanceId !== 'string' || !INSTANCE_ID.test(row.instanceId)) {
      throw new Error('native Activity feed identity is missing')
    }
    return row.instanceId
  }

  #maximumSequence(scopeId: string): number {
    const row = this.#database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS maximum FROM daemon_activity_feed WHERE scope_id = ?',
      )
      .get(scopeId) as { readonly maximum?: unknown } | undefined
    if (typeof row?.maximum !== 'number' || !Number.isSafeInteger(row.maximum)) {
      throw new Error('native Activity sequence is invalid')
    }
    return row.maximum
  }
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string): ActivityCursor {
  if (value.length === 0 || Buffer.byteLength(value) > CURSOR_BYTES_MAX) {
    throw new Error('native Activity cursor is invalid')
  }
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8')
    if (Buffer.from(json).toString('base64url') !== value) {
      throw new Error('native Activity cursor is invalid')
    }
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('native Activity cursor is invalid')
    }
    const cursor = parsed as Record<string, unknown>
    if (
      Object.keys(cursor).length !== 5 ||
      cursor.version !== 1 ||
      typeof cursor.walletId !== 'string' ||
      !WALLET_ID.test(cursor.walletId) ||
      typeof cursor.instanceId !== 'string' ||
      !INSTANCE_ID.test(cursor.instanceId) ||
      typeof cursor.maximumSequence !== 'number' ||
      !Number.isSafeInteger(cursor.maximumSequence) ||
      cursor.maximumSequence < 1 ||
      typeof cursor.lastSequence !== 'number' ||
      !Number.isSafeInteger(cursor.lastSequence) ||
      cursor.lastSequence < 1 ||
      cursor.lastSequence > cursor.maximumSequence
    ) {
      throw new Error('native Activity cursor is invalid')
    }
    return cursor as unknown as ActivityCursor
  } catch {
    throw new Error('native Activity cursor is invalid')
  }
}
