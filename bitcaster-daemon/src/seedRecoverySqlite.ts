import type { DatabaseSync } from 'node:sqlite'
import {
  EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION,
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryCursor,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'

export interface DaemonSeedRecoveryJob {
  recoveryId: string
  mintUrl: string
  unit: string
  state: 'active' | 'completed'
}

interface EnsureSeedRecoveryJobInput {
  proposedRecoveryId: string
  mintUrl: string
  unit: string
  keysetIds: readonly string[]
  disclosureAcknowledged: boolean
  nowMs: number
}

interface AdvanceSeedRecoveryCursorInput {
  expected: EmergencySeedRecoveryCursor
  next: EmergencySeedRecoveryCursor
  importedProofs: number
  ignoredSpentProofs: number
  nowMs: number
}

export function ensureDaemonSeedRecoveryJob(
  database: DatabaseSync,
  input: EnsureSeedRecoveryJobInput,
): DaemonSeedRecoveryJob {
  const keysetIds = validateSeedRecoveryJobInput(input)
  insertSeedRecoveryJob(database, input)
  const job = readJobByScope(database, input.mintUrl, input.unit)
  if (job === null) throw new Error('seed recovery job was not persisted')
  insertMissingKeysets(database, job, keysetIds)
  activateSeedRecoveryJob(database, job.recoveryId, input.nowMs)
  return readJob(database, job.recoveryId)
}

function validateSeedRecoveryJobInput(
  input: EnsureSeedRecoveryJobInput,
): string[] {
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires history-disclosure acknowledgement')
  }
  requireIdentifier(input.proposedRecoveryId, 'recovery id')
  requireIdentifier(input.mintUrl, 'mint URL')
  requireIdentifier(input.unit, 'mint unit')
  requireNonNegativeInteger(input.nowMs, 'recovery timestamp')
  const keysetIds = [...new Set(input.keysetIds)].sort()
  if (keysetIds.length === 0) {
    throw new Error('seed recovery mint has no restorable keysets')
  }
  for (const keysetId of keysetIds) requireIdentifier(keysetId, 'keyset id')
  return keysetIds
}

function insertSeedRecoveryJob(
  database: DatabaseSync,
  input: EnsureSeedRecoveryJobInput,
): void {
  database.prepare(
    `INSERT INTO daemon_seed_recovery_jobs (
       recovery_id, schema_version, mint_url, unit,
       disclosure_acknowledged, state, imported_proofs,
       ignored_spent_proofs, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'active', 0, 0, ?, ?)
     ON CONFLICT (mint_url, unit) DO NOTHING`,
  ).run(
    input.proposedRecoveryId,
    EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION,
    input.mintUrl,
    input.unit,
    input.nowMs,
    input.nowMs,
  )
}

function activateSeedRecoveryJob(
  database: DatabaseSync,
  recoveryId: string,
  nowMs: number,
): void {
  database.prepare(
    `UPDATE daemon_seed_recovery_jobs
        SET state = 'active', updated_at = ?
      WHERE recovery_id = ?
        AND EXISTS (
          SELECT 1 FROM daemon_seed_recovery_keysets
           WHERE recovery_id = ? AND state = 'active'
        )`,
  ).run(nowMs, recoveryId, recoveryId)
}

export function readNextDaemonSeedRecoveryCursor(
  database: DatabaseSync,
  recoveryId: string,
): EmergencySeedRecoveryCursor | null {
  const job = readJob(database, recoveryId)
  const row = database.prepare(
    `SELECT keyset_id, next_counter, trailing_empty_counters, revision, state
       FROM daemon_seed_recovery_keysets
            INDEXED BY daemon_seed_recovery_active_keyset_idx
      WHERE recovery_id = ? AND state = 'active'
      ORDER BY ordinal
      LIMIT 1`,
  ).get(recoveryId) as Record<string, unknown> | undefined
  if (row === undefined) return null
  return validateEmergencySeedRecoveryCursor({
    ...createEmergencySeedRecoveryCursor({
      recoveryId: job.recoveryId,
      mintUrl: job.mintUrl,
      unit: job.unit,
      keysetId: requireText(row.keyset_id, 'seed recovery keyset id'),
    }),
    nextCounter: requireNonNegativeInteger(
      row.next_counter,
      'seed recovery next counter',
    ),
    trailingEmptyCounters: requireNonNegativeInteger(
      row.trailing_empty_counters,
      'seed recovery trailing empty counters',
    ),
    revision: requireNonNegativeInteger(
      row.revision,
      'seed recovery cursor revision',
    ),
    state: requireState(row.state),
  })
}

export function advanceDaemonSeedRecoveryCursor(
  database: DatabaseSync,
  input: AdvanceSeedRecoveryCursorInput,
): void {
  const expected = validateEmergencySeedRecoveryCursor(input.expected)
  const next = validateEmergencySeedRecoveryCursor(input.next)
  if (
    expected.recoveryId !== next.recoveryId
    || expected.keysetId !== next.keysetId
    || expected.mintUrl !== next.mintUrl
    || expected.unit !== next.unit
    || next.revision !== expected.revision + 1
  ) {
    throw new Error('seed recovery cursor transition is foreign')
  }
  requireNonNegativeInteger(input.nowMs, 'recovery timestamp')
  requireNonNegativeInteger(input.importedProofs, 'imported proof count')
  requireNonNegativeInteger(input.ignoredSpentProofs, 'spent proof count')
  compareAndSwapSeedRecoveryKeyset(database, expected, next)
  updateSeedRecoveryJobProgress(database, expected.recoveryId, input)
}

function compareAndSwapSeedRecoveryKeyset(
  database: DatabaseSync,
  expected: EmergencySeedRecoveryCursor,
  next: EmergencySeedRecoveryCursor,
): void {
  const result = database.prepare(
    `UPDATE daemon_seed_recovery_keysets
        SET next_counter = ?, trailing_empty_counters = ?,
            revision = ?, state = ?
      WHERE recovery_id = ? AND keyset_id = ?
        AND next_counter = ? AND trailing_empty_counters = ?
        AND revision = ? AND state = ?`,
  ).run(
    next.nextCounter,
    next.trailingEmptyCounters,
    next.revision,
    next.state,
    expected.recoveryId,
    expected.keysetId,
    expected.nextCounter,
    expected.trailingEmptyCounters,
    expected.revision,
    expected.state,
  )
  if (Number(result.changes) !== 1) {
    throw new Error('seed recovery cursor compare-and-swap failed')
  }
}

function updateSeedRecoveryJobProgress(
  database: DatabaseSync,
  recoveryId: string,
  input: AdvanceSeedRecoveryCursorInput,
): void {
  const result = database.prepare(
    `UPDATE daemon_seed_recovery_jobs
        SET state = CASE WHEN EXISTS (
          SELECT 1 FROM daemon_seed_recovery_keysets
           WHERE recovery_id = ? AND state = 'active'
        ) THEN 'active' ELSE 'completed' END,
            imported_proofs = imported_proofs + ?,
            ignored_spent_proofs = ignored_spent_proofs + ?,
            updated_at = ?
      WHERE recovery_id = ?`,
  ).run(
    recoveryId,
    input.importedProofs,
    input.ignoredSpentProofs,
    input.nowMs,
    recoveryId,
  )
  if (Number(result.changes) !== 1) {
    throw new Error('seed recovery job progress update failed')
  }
}

export function readDaemonSeedRecoveryProgress(
  database: DatabaseSync,
  recoveryId: string,
): {
  recoveryId: string
  state: 'active' | 'completed'
  completedKeysets: number
  totalKeysets: number
  importedProofs: number
  ignoredSpentProofs: number
} {
  const job = readJob(database, recoveryId)
  const row = database.prepare(
    `SELECT COUNT(*) AS total_keysets,
            COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0)
              AS completed_keysets,
            (SELECT imported_proofs FROM daemon_seed_recovery_jobs
              WHERE recovery_id = ?) AS imported_proofs,
            (SELECT ignored_spent_proofs FROM daemon_seed_recovery_jobs
              WHERE recovery_id = ?) AS ignored_spent_proofs
       FROM daemon_seed_recovery_keysets
      WHERE recovery_id = ?`,
  ).get(recoveryId, recoveryId, recoveryId) as Record<string, unknown>
  return {
    recoveryId,
    state: job.state,
    completedKeysets: requireNonNegativeInteger(
      row.completed_keysets,
      'completed seed recovery keyset count',
    ),
    totalKeysets: requireNonNegativeInteger(
      row.total_keysets,
      'seed recovery keyset count',
    ),
    importedProofs: requireNonNegativeInteger(
      row.imported_proofs,
      'seed recovery imported proof count',
    ),
    ignoredSpentProofs: requireNonNegativeInteger(
      row.ignored_spent_proofs,
      'seed recovery spent proof count',
    ),
  }
}

function insertMissingKeysets(
  database: DatabaseSync,
  job: DaemonSeedRecoveryJob,
  keysetIds: readonly string[],
): void {
  const maximum = database.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) AS maximum
       FROM daemon_seed_recovery_keysets
      WHERE recovery_id = ?`,
  ).get(job.recoveryId) as Record<string, unknown>
  let ordinal = requireInteger(maximum.maximum, 'seed recovery keyset ordinal') + 1
  const insert = database.prepare(
    `INSERT INTO daemon_seed_recovery_keysets (
       recovery_id, keyset_id, ordinal, next_counter,
       trailing_empty_counters, revision, state
     ) VALUES (?, ?, ?, 0, 0, 0, 'active')
     ON CONFLICT (recovery_id, keyset_id) DO NOTHING`,
  )
  for (const keysetId of keysetIds) {
    const result = insert.run(job.recoveryId, keysetId, ordinal)
    if (Number(result.changes) === 1) ordinal += 1
  }
}

function readJobByScope(
  database: DatabaseSync,
  mintUrl: string,
  unit: string,
): DaemonSeedRecoveryJob | null {
  const row = database.prepare(
    `SELECT recovery_id, schema_version, mint_url, unit,
            disclosure_acknowledged, state
       FROM daemon_seed_recovery_jobs
      WHERE mint_url = ? AND unit = ?`,
  ).get(mintUrl, unit) as Record<string, unknown> | undefined
  return row === undefined ? null : decodeJob(row)
}

function readJob(
  database: DatabaseSync,
  recoveryId: string,
): DaemonSeedRecoveryJob {
  const row = database.prepare(
    `SELECT recovery_id, schema_version, mint_url, unit,
            disclosure_acknowledged, state
       FROM daemon_seed_recovery_jobs
      WHERE recovery_id = ?`,
  ).get(recoveryId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error('seed recovery job is missing')
  return decodeJob(row)
}

function decodeJob(row: Record<string, unknown>): DaemonSeedRecoveryJob {
  if (
    requireNonNegativeInteger(row.schema_version, 'seed recovery schema')
      !== EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION
  ) {
    throw new Error('seed recovery schema is unsupported')
  }
  if (row.disclosure_acknowledged !== 1) {
    throw new Error('seed recovery disclosure acknowledgement is missing')
  }
  return {
    recoveryId: requireText(row.recovery_id, 'seed recovery id'),
    mintUrl: requireText(row.mint_url, 'seed recovery mint URL'),
    unit: requireText(row.unit, 'seed recovery mint unit'),
    state: requireState(row.state),
  }
}

function requireState(value: unknown): 'active' | 'completed' {
  if (value !== 'active' && value !== 'completed') {
    throw new Error('seed recovery state is invalid')
  }
  return value
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid`)
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requireInteger(value, label)
  if (parsed < 0) throw new Error(`${label} is invalid`)
  return parsed
}
