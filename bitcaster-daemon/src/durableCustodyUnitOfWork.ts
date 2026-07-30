import type { DatabaseSync } from 'node:sqlite'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  type DaemonStateSqliteSession,
  withDaemonStateSqliteTransaction,
  type StateSqliteTransactionOptions,
} from './stateSqlite.ts'

export class DurableCustodyFenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurableCustodyFenceError'
  }
}

interface ScopeStateRow {
  readonly fencingEpoch: number
  readonly ownerIncarnationId: string | null
  readonly leaseExpiresAtMs: number | null
  readonly highWaterMarkMs: number
}

export async function withDurableCustodyUnitOfWork<T>(
  storage: string | DaemonStateSqliteSession,
  fence: CustodyScopeFence,
  observedAtMs: number,
  action: (database: DatabaseSync) => T,
  options: StateSqliteTransactionOptions = {},
): Promise<T> {
  assertObservationTime(observedAtMs)
  const transaction =
    typeof storage === 'string'
      ? (
          action: (database: DatabaseSync) => T,
          transactionOptions: StateSqliteTransactionOptions,
        ) => withDaemonStateSqliteTransaction(storage, action, transactionOptions)
      : (
          action: (database: DatabaseSync) => T,
          transactionOptions: StateSqliteTransactionOptions,
        ) => storage.transaction(action, transactionOptions)
  return transaction((database) => {
    const row = requireAuthorizedScopeState(database, fence, observedAtMs)
    const highWaterMarkMs = Math.max(observedAtMs, row.highWaterMarkMs)
    const updated = database
      .prepare(
        `UPDATE custody_scope_state SET high_water_mark_ms = ?
           WHERE scope_id = ? AND owner_incarnation_id = ?
             AND fencing_epoch = ? AND high_water_mark_ms = ?`,
      )
      .run(
        highWaterMarkMs,
        fence.scopeId,
        fence.incarnationId,
        fence.fencingEpoch,
        row.highWaterMarkMs,
      )
    if (updated.changes !== 1) {
      throw new DurableCustodyFenceError('custody unit of work fence CAS failed')
    }
    return action(database)
  }, options)
}

export async function withDurableCustodyFencedRead<T>(
  storage: DaemonStateSqliteSession,
  fence: CustodyScopeFence,
  observedAtMs: number,
  action: (database: DatabaseSync) => T,
): Promise<T> {
  assertObservationTime(observedAtMs)
  return storage.read((database) => {
    requireAuthorizedScopeState(database, fence, observedAtMs)
    return action(database)
  })
}

function requireAuthorizedScopeState(
  database: DatabaseSync,
  fence: CustodyScopeFence,
  observedAtMs: number,
): ScopeStateRow {
  assertObservationTime(observedAtMs)
  const row = database
    .prepare(
      `SELECT fencing_epoch AS fencingEpoch,
          owner_incarnation_id AS ownerIncarnationId,
          lease_expires_at_ms AS leaseExpiresAtMs,
          high_water_mark_ms AS highWaterMarkMs
        FROM custody_scope_state WHERE scope_id = ?`,
    )
    .get(fence.scopeId) as ScopeStateRow | undefined
  if (row === undefined) throw staleFence('scope is missing')
  if (row.ownerIncarnationId !== fence.incarnationId) throw staleFence('owner changed')
  if (row.fencingEpoch !== fence.fencingEpoch) throw staleFence('epoch changed')
  // Expiry permits a competing claimant to advance the epoch; it is not a
  // second fence version. Until takeover commits, this owner/epoch remains
  // linearizable, including across a same-owner lease renewal.
  if (row.leaseExpiresAtMs === null) throw staleFence('lease is missing')
  return row
}

function staleFence(reason: string): DurableCustodyFenceError {
  return new DurableCustodyFenceError(
    `custody unit of work has stale or expired authority: ${reason}`,
  )
}

function assertObservationTime(observedAtMs: number): void {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new DurableCustodyFenceError('custody observation time is invalid')
  }
}
