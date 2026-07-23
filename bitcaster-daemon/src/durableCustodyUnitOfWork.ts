import type { DatabaseSync } from 'node:sqlite'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
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
  directory: string,
  fence: CustodyScopeFence,
  observedAtMs: number,
  action: (database: DatabaseSync) => T,
  options: StateSqliteTransactionOptions = {},
): Promise<T> {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new DurableCustodyFenceError('custody observation time is invalid')
  }
  return withDaemonStateSqliteTransaction(
    directory,
    (database) => {
      const row = database
        .prepare(
          `SELECT fencing_epoch AS fencingEpoch,
             owner_incarnation_id AS ownerIncarnationId,
             lease_expires_at_ms AS leaseExpiresAtMs,
             high_water_mark_ms AS highWaterMarkMs
           FROM custody_scope_state WHERE scope_id = ?`,
        )
        .get(fence.scopeId) as ScopeStateRow | undefined
      if (
        row === undefined ||
        row.ownerIncarnationId !== fence.incarnationId ||
        row.fencingEpoch !== fence.fencingEpoch ||
        row.leaseExpiresAtMs === null ||
        row.leaseExpiresAtMs !== fence.leaseExpiresAtMs ||
        observedAtMs < row.highWaterMarkMs ||
        observedAtMs >= row.leaseExpiresAtMs
      ) {
        throw new DurableCustodyFenceError(
          'custody unit of work has stale or expired authority',
        )
      }
      const updated = database
        .prepare(
          `UPDATE custody_scope_state SET high_water_mark_ms = ?
           WHERE scope_id = ? AND owner_incarnation_id = ?
             AND fencing_epoch = ? AND lease_expires_at_ms = ?
             AND high_water_mark_ms = ?`,
        )
        .run(
          observedAtMs,
          fence.scopeId,
          fence.incarnationId,
          fence.fencingEpoch,
          fence.leaseExpiresAtMs,
          row.highWaterMarkMs,
        )
      if (updated.changes !== 1) {
        throw new DurableCustodyFenceError('custody unit of work fence CAS failed')
      }
      return action(database)
    },
    options,
  )
}
