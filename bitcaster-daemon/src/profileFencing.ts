import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeDurableCustodyScopeId } from '@bitcaster-market/client-sdk'
import {
  DAEMON_PROFILE_DATABASE,
  validateDaemonProfileSchema,
} from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'

export const CUSTODY_SCOPE_LEASE_DURATION_MS = 60_000
export const CUSTODY_SCOPE_RENEW_INTERVAL_MS = 20_000

export type ScopeLeaseRefusalReason =
  | 'scope-missing'
  | 'already-owned'
  | 'clock-rollback'
  | 'stale-fence'
  | 'lease-expired'
  | 'invalid-input'

const leaseMessages: Readonly<Record<ScopeLeaseRefusalReason, string>> = {
  'scope-missing': 'custody scope is missing',
  'already-owned': 'custody scope is already owned',
  'clock-rollback': 'custody scope clock moved backwards',
  'stale-fence': 'custody scope fence is stale',
  'lease-expired': 'custody scope lease expired',
  'invalid-input': 'custody scope lease input is invalid',
}

export class ScopeLeaseRefusalError extends Error {
  readonly reason: ScopeLeaseRefusalReason

  constructor(reason: ScopeLeaseRefusalReason) {
    super(leaseMessages[reason])
    this.name = 'ScopeLeaseRefusalError'
    this.reason = reason
  }
}

export interface CustodyScopeFence {
  readonly scopeId: string
  readonly incarnationId: string
  readonly fencingEpoch: number
  readonly leaseExpiresAtMs: number
}

export async function claimCustodyScopeLease(
  directory: string,
  input: {
    readonly scopeId: string
    readonly incarnationId: string
    readonly observedAtMs: number
  },
): Promise<CustodyScopeFence> {
  validateLeaseIdentity(input)
  return withFencingTransaction(directory, (database) => {
    const state = readScopeState(database, input.scopeId)
    assertMonotonicClock(input.observedAtMs, state.highWaterMarkMs)
    if (
      state.ownerIncarnationId !== null &&
      state.leaseExpiresAtMs !== null &&
      state.leaseExpiresAtMs > input.observedAtMs
    ) {
      if (state.ownerIncarnationId === input.incarnationId) {
        return fenceFromState(input.scopeId, state)
      }
      throw new ScopeLeaseRefusalError('already-owned')
    }
    if (state.fencingEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new ScopeLeaseRefusalError('invalid-input')
    }
    const fencingEpoch = state.fencingEpoch + 1
    const leaseExpiresAtMs = checkedLeaseExpiry(input.observedAtMs)
    const result = database
      .prepare(
        `UPDATE custody_scope_state
         SET fencing_epoch = ?, owner_incarnation_id = ?,
             lease_expires_at_ms = ?, high_water_mark_ms = ?
         WHERE scope_id = ? AND fencing_epoch = ?`,
      )
      .run(
        fencingEpoch,
        input.incarnationId,
        leaseExpiresAtMs,
        input.observedAtMs,
        input.scopeId,
        state.fencingEpoch,
      )
    if (result.changes !== 1) throw new ScopeLeaseRefusalError('stale-fence')
    return {
      scopeId: input.scopeId,
      incarnationId: input.incarnationId,
      fencingEpoch,
      leaseExpiresAtMs,
    }
  })
}

export async function renewCustodyScopeLease(
  directory: string,
  fence: CustodyScopeFence,
  observedAtMs: number,
): Promise<CustodyScopeFence> {
  validateLeaseIdentity({ ...fence, observedAtMs })
  return withFencingTransaction(directory, (database) => {
    const state = readScopeState(database, fence.scopeId)
    assertMonotonicClock(observedAtMs, state.highWaterMarkMs)
    assertCurrentFence(state, fence)
    if (
      state.leaseExpiresAtMs === null ||
      state.leaseExpiresAtMs <= observedAtMs
    ) {
      throw new ScopeLeaseRefusalError('lease-expired')
    }
    const leaseExpiresAtMs = checkedLeaseExpiry(observedAtMs)
    const result = database
      .prepare(
        `UPDATE custody_scope_state
         SET lease_expires_at_ms = ?, high_water_mark_ms = ?
         WHERE scope_id = ? AND owner_incarnation_id = ? AND fencing_epoch = ?`,
      )
      .run(
        leaseExpiresAtMs,
        observedAtMs,
        fence.scopeId,
        fence.incarnationId,
        fence.fencingEpoch,
      )
    if (result.changes !== 1) throw new ScopeLeaseRefusalError('stale-fence')
    return { ...fence, leaseExpiresAtMs }
  })
}

export async function releaseCustodyScopeLease(
  directory: string,
  fence: CustodyScopeFence,
  observedAtMs: number,
): Promise<void> {
  validateLeaseIdentity({ ...fence, observedAtMs })
  await withFencingTransaction(directory, (database) => {
    const state = readScopeState(database, fence.scopeId)
    assertMonotonicClock(observedAtMs, state.highWaterMarkMs)
    assertCurrentFence(state, fence)
    if (
      state.leaseExpiresAtMs === null ||
      state.leaseExpiresAtMs <= observedAtMs
    ) {
      throw new ScopeLeaseRefusalError('lease-expired')
    }
    const result = database
      .prepare(
        `UPDATE custody_scope_state
         SET owner_incarnation_id = NULL, lease_expires_at_ms = NULL,
             high_water_mark_ms = ?
         WHERE scope_id = ? AND owner_incarnation_id = ? AND fencing_epoch = ?`,
      )
      .run(
        observedAtMs,
        fence.scopeId,
        fence.incarnationId,
        fence.fencingEpoch,
      )
    if (result.changes !== 1) throw new ScopeLeaseRefusalError('stale-fence')
  })
}

async function withFencingTransaction<T>(
  directory: string,
  action: (database: DatabaseSync) => T,
): Promise<T> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
    `)
    try {
      const result = action(database)
      database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // BEGIN or COMMIT may not have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

interface ScopeStateRow {
  readonly fencingEpoch: number
  readonly ownerIncarnationId: string | null
  readonly leaseExpiresAtMs: number | null
  readonly highWaterMarkMs: number
}

function readScopeState(
  database: DatabaseSync,
  scopeId: string,
): ScopeStateRow {
  const row = database
    .prepare(
      `SELECT fencing_epoch AS fencingEpoch,
        owner_incarnation_id AS ownerIncarnationId,
        lease_expires_at_ms AS leaseExpiresAtMs,
        high_water_mark_ms AS highWaterMarkMs
       FROM custody_scope_state WHERE scope_id = ?`,
    )
    .get(scopeId) as ScopeStateRow | undefined
  if (row === undefined) throw new ScopeLeaseRefusalError('scope-missing')
  return row
}

function assertCurrentFence(
  state: ScopeStateRow,
  fence: CustodyScopeFence,
): void {
  if (
    state.ownerIncarnationId !== fence.incarnationId ||
    state.fencingEpoch !== fence.fencingEpoch
  ) {
    throw new ScopeLeaseRefusalError('stale-fence')
  }
}

function assertMonotonicClock(observedAtMs: number, highWaterMarkMs: number): void {
  if (observedAtMs < highWaterMarkMs) {
    throw new ScopeLeaseRefusalError('clock-rollback')
  }
}

function fenceFromState(
  scopeId: string,
  state: ScopeStateRow,
): CustodyScopeFence {
  if (state.ownerIncarnationId === null || state.leaseExpiresAtMs === null) {
    throw new ScopeLeaseRefusalError('stale-fence')
  }
  return {
    scopeId,
    incarnationId: state.ownerIncarnationId,
    fencingEpoch: state.fencingEpoch,
    leaseExpiresAtMs: state.leaseExpiresAtMs,
  }
}

function checkedLeaseExpiry(observedAtMs: number): number {
  const expiresAt = observedAtMs + CUSTODY_SCOPE_LEASE_DURATION_MS
  if (!Number.isSafeInteger(expiresAt)) {
    throw new ScopeLeaseRefusalError('invalid-input')
  }
  return expiresAt
}

function validateLeaseIdentity(input: {
  readonly scopeId: string
  readonly incarnationId: string
  readonly observedAtMs: number
  readonly fencingEpoch?: number
}): void {
  let scopeIsCanonicalWallet = false
  try {
    scopeIsCanonicalWallet =
      input.scopeId.startsWith('custody:wallet:') &&
      decodeDurableCustodyScopeId(input.scopeId) === input.scopeId
  } catch {
    scopeIsCanonicalWallet = false
  }
  if (
    !scopeIsCanonicalWallet ||
    input.incarnationId.length < 16 ||
    input.incarnationId.length > 256 ||
    !Number.isSafeInteger(input.observedAtMs) ||
    input.observedAtMs < 0 ||
    (input.fencingEpoch !== undefined &&
      (!Number.isSafeInteger(input.fencingEpoch) || input.fencingEpoch < 1))
  ) {
    throw new ScopeLeaseRefusalError('invalid-input')
  }
}
