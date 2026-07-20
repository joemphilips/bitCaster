import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { decodeKeysetCurve } from '@cashu/cashu-ts'
import {
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryCursor,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import { CONDITIONAL_RECOVERY_MAX_KEYSETS } from '@bitcaster-market/client-sdk/emergencyConditionalSeedRecovery'

const DAEMON_SEED_RECOVERY_SCHEMA_VERSION = 2

export interface DaemonSeedRecoveryJob {
  walletScopeId: string
  recoveryId: string
  mintUrl: string
  unit: string
  state: 'active' | 'completed'
}

interface EnsureSeedRecoveryJobInput {
  walletScopeId: string
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

export interface DaemonSeedRecoveryRetainedProof {
  keysetId: string
  walletProofId: string
  proofDigest: string
  proofY: string
}

export function ensureDaemonSeedRecoveryJob(
  database: DatabaseSync,
  input: EnsureSeedRecoveryJobInput,
): DaemonSeedRecoveryJob {
  const keysetIds = validateSeedRecoveryJobInput(input)
  insertSeedRecoveryJob(database, input, keysetIds.length)
  const job = readJobByScope(
    database,
    input.walletScopeId,
    input.mintUrl,
    input.unit,
  )
  if (job === null) throw new Error('seed recovery job was not persisted')
  insertMissingKeysets(database, job, keysetIds)
  synchronizeSeedRecoveryJob(database, job, input.nowMs)
  return readJob(database, job.recoveryId)
}

function validateSeedRecoveryJobInput(
  input: EnsureSeedRecoveryJobInput,
): string[] {
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires history-disclosure acknowledgement')
  }
  requireIdentifier(input.proposedRecoveryId, 'recovery id')
  requireIdentifier(input.walletScopeId, 'wallet scope id')
  requireIdentifier(input.mintUrl, 'mint URL')
  requireIdentifier(input.unit, 'mint unit')
  requireNonNegativeInteger(input.nowMs, 'recovery timestamp')
  const keysetIds = [...new Set(input.keysetIds)].sort()
  if (keysetIds.length === 0) {
    throw new Error('seed recovery mint has no restorable keysets')
  }
  if (keysetIds.length > CONDITIONAL_RECOVERY_MAX_KEYSETS) {
    throw new Error('seed recovery keyset bound was exceeded')
  }
  for (const keysetId of keysetIds) {
    requireBoundedIdentifier(keysetId, 256, 'keyset id')
  }
  return keysetIds
}

function insertSeedRecoveryJob(
  database: DatabaseSync,
  input: EnsureSeedRecoveryJobInput,
  keysetCount: number,
): void {
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_jobs (
       wallet_scope_id, mint_url, unit, recovery_id, schema_version,
       disclosure_acknowledged, state, phase, revision,
       current_cursor, current_cursor_digest,
       capability_version, capability_max_page_size,
       page_count, keyset_count, transport_bytes, serialized_bytes,
       work_units, proof_count, imported_proofs, ignored_spent_proofs,
       retained_pending_proofs, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'active', 'restore', 0,
       NULL, NULL, NULL, NULL, 0, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)
     ON CONFLICT (wallet_scope_id, mint_url, unit) DO NOTHING`,
    )
    .run(
      input.walletScopeId,
      input.mintUrl,
      input.unit,
      input.proposedRecoveryId,
      DAEMON_SEED_RECOVERY_SCHEMA_VERSION,
      keysetCount,
      input.nowMs,
      input.nowMs,
    )
}

function synchronizeSeedRecoveryJob(
  database: DatabaseSync,
  job: DaemonSeedRecoveryJob,
  nowMs: number,
): void {
  const row = database
    .prepare(
      `SELECT keyset_id, next_counter, trailing_empty_counters, revision, state
       FROM daemon_seed_recovery_keysets
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND state = 'active'
      ORDER BY ordinal
      LIMIT 1`,
    )
    .get(job.walletScopeId, job.mintUrl, job.unit, job.recoveryId) as
    | Record<string, unknown>
    | undefined
  const cursor = row === undefined ? null : createPersistedCursor(job, row)
  const serialized = cursor === null ? null : JSON.stringify(cursor)
  const digest =
    serialized === null
      ? null
      : createHash('sha256').update(serialized).digest('hex')
  const result = database
    .prepare(
      `UPDATE daemon_seed_recovery_jobs
        SET state = ?, phase = ?, current_cursor = ?,
            current_cursor_digest = ?,
            keyset_count = (
              SELECT COUNT(*) FROM daemon_seed_recovery_keysets
               WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
                 AND recovery_id = ?
            ),
            updated_at = ?
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ?`,
    )
    .run(
      cursor === null ? 'completed' : 'active',
      cursor === null ? 'completed' : 'restore',
      serialized,
      digest,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      nowMs,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
    )
  if (Number(result.changes) !== 1) {
    throw new Error('seed recovery job synchronization failed')
  }
}

export function readNextDaemonSeedRecoveryCursor(
  database: DatabaseSync,
  recoveryId: string,
): EmergencySeedRecoveryCursor | null {
  const job = readJob(database, recoveryId)
  const row = database
    .prepare(
      `SELECT keyset_id, next_counter, trailing_empty_counters, revision, state
       FROM daemon_seed_recovery_keysets
            INDEXED BY daemon_seed_recovery_active_keyset_idx
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND state = 'active'
      ORDER BY ordinal
      LIMIT 1`,
    )
    .get(job.walletScopeId, job.mintUrl, job.unit, recoveryId) as
    | Record<string, unknown>
    | undefined
  if (row === undefined) {
    if (job.state !== 'completed') {
      throw new Error('seed recovery job cursor is missing')
    }
    return null
  }
  const cursor = createPersistedCursor(job, row)
  const serialized = JSON.stringify(cursor)
  const persisted = database
    .prepare(
      `SELECT current_cursor, current_cursor_digest
       FROM daemon_seed_recovery_jobs
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ?`,
    )
    .get(job.walletScopeId, job.mintUrl, job.unit, recoveryId) as Record<
    string,
    unknown
  >
  if (
    persisted.current_cursor !== serialized ||
    persisted.current_cursor_digest !==
      createHash('sha256').update(serialized).digest('hex')
  ) {
    throw new Error('seed recovery job cursor authority is corrupt')
  }
  return cursor
}

function createPersistedCursor(
  job: DaemonSeedRecoveryJob,
  row: Record<string, unknown>,
): EmergencySeedRecoveryCursor {
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
    expected.recoveryId !== next.recoveryId ||
    expected.keysetId !== next.keysetId ||
    expected.mintUrl !== next.mintUrl ||
    expected.unit !== next.unit ||
    next.revision !== expected.revision + 1
  ) {
    throw new Error('seed recovery cursor transition is foreign')
  }
  requireNonNegativeInteger(input.nowMs, 'recovery timestamp')
  requireNonNegativeInteger(input.importedProofs, 'imported proof count')
  requireNonNegativeInteger(input.ignoredSpentProofs, 'spent proof count')
  const job = readJob(database, expected.recoveryId)
  if (job.mintUrl !== expected.mintUrl || job.unit !== expected.unit) {
    throw new Error('seed recovery cursor belongs to a foreign job scope')
  }
  compareAndSwapSeedRecoveryKeyset(database, job, expected, next, input)
  updateSeedRecoveryJobProgress(database, job, input)
  synchronizeSeedRecoveryJob(database, job, input.nowMs)
}

export function retainPendingDaemonSeedRecoveryProofs(
  database: DatabaseSync,
  recoveryId: string,
  proofs: readonly DaemonSeedRecoveryRetainedProof[],
  observedAt: number,
): void {
  requireNonNegativeInteger(observedAt, 'retained proof observation time')
  const job = readJob(database, recoveryId)
  const insert = database.prepare(
    `INSERT INTO daemon_seed_recovery_proof_retention (
       wallet_scope_id, mint_url, unit, recovery_id, keyset_id,
       retention_id, wallet_proof_id, proof_digest, proof_y, mint_state,
       reason, asset_kind, condition_id, outcome_collection,
       outcome_collection_id, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING',
       'pending-mint-state', 'ordinary', NULL, NULL, NULL, ?)
     ON CONFLICT (wallet_scope_id, mint_url, unit, recovery_id, retention_id)
     DO NOTHING`,
  )
  const select = database.prepare(
    `SELECT keyset_id, wallet_proof_id, proof_digest, proof_y, mint_state,
            reason, asset_kind
       FROM daemon_seed_recovery_proof_retention
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND retention_id = ?`,
  )
  let insertedProofs = 0
  let keysetId: string | undefined
  for (const proof of proofs) {
    requireBoundedIdentifier(proof.keysetId, 256, 'retained proof keyset id')
    requireBoundedIdentifier(proof.walletProofId, 64, 'retained wallet proof id')
    requireBoundedIdentifier(proof.proofDigest, 64, 'retained proof digest')
    requireBoundedIdentifier(proof.proofY, 256, 'retained proof Y')
    if (keysetId !== undefined && keysetId !== proof.keysetId) {
      throw new Error('seed recovery pending batch spans multiple keysets')
    }
    keysetId = proof.keysetId
    const result = insert.run(
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      proof.keysetId,
      proof.walletProofId,
      proof.walletProofId,
      proof.proofDigest,
      proof.proofY,
      observedAt,
    )
    insertedProofs += Number(result.changes)
    const row = select.get(
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      proof.walletProofId,
    ) as Record<string, unknown> | undefined
    if (
      row?.keyset_id !== proof.keysetId ||
      row.wallet_proof_id !== proof.walletProofId ||
      row.proof_digest !== proof.proofDigest ||
      row.proof_y !== proof.proofY ||
      row.mint_state !== 'PENDING' ||
      row.reason !== 'pending-mint-state' ||
      row.asset_kind !== 'ordinary'
    ) {
      throw new Error('seed recovery retained proof authority conflicts')
    }
  }
  if (keysetId === undefined) {
    throw new Error('seed recovery pending batch is empty')
  }
  const keysetUpdate = database
    .prepare(
      `UPDATE daemon_seed_recovery_keysets
          SET revision = revision + 1,
              batch_count = batch_count + 1,
              retained_pending_proofs = retained_pending_proofs + ?
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND keyset_id = ? AND state = 'active'`,
    )
    .run(
      insertedProofs,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      keysetId,
    )
  if (Number(keysetUpdate.changes) !== 1) {
    throw new Error('seed recovery pending keyset progress update failed')
  }
  const jobUpdate = database
    .prepare(
      `UPDATE daemon_seed_recovery_jobs
          SET revision = revision + 1,
              work_units = work_units + 1,
              proof_count = proof_count + ?,
              retained_pending_proofs = retained_pending_proofs + ?,
              updated_at = ?
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ?`,
    )
    .run(
      proofs.length,
      insertedProofs,
      observedAt,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
    )
  if (Number(jobUpdate.changes) !== 1) {
    throw new Error('seed recovery pending job progress update failed')
  }
  synchronizeSeedRecoveryJob(database, job, observedAt)
}

export function reconcileDaemonSeedRecoveryRetainedProofs(
  database: DatabaseSync,
  recoveryId: string,
  input: {
    unspentProofIds: readonly string[]
    spentProofIds: readonly string[]
    observedAt: number
  },
): void {
  requireNonNegativeInteger(input.observedAt, 'retained proof observation time')
  const job = readJob(database, recoveryId)
  const release = database.prepare(
    `DELETE FROM daemon_seed_recovery_proof_retention
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND wallet_proof_id = ?
        AND reason = 'pending-mint-state' AND mint_state = 'PENDING'`,
  )
  const markSpent = database.prepare(
    `UPDATE daemon_seed_recovery_proof_retention
        SET wallet_proof_id = NULL, mint_state = 'SPENT',
            reason = 'spent-audit', observed_at = ?
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND wallet_proof_id = ?
        AND reason = 'pending-mint-state' AND mint_state = 'PENDING'`,
  )
  for (const proofId of new Set(input.unspentProofIds)) {
    release.run(
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      proofId,
    )
  }
  for (const proofId of new Set(input.spentProofIds)) {
    markSpent.run(
      input.observedAt,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      proofId,
    )
  }
}

function compareAndSwapSeedRecoveryKeyset(
  database: DatabaseSync,
  job: DaemonSeedRecoveryJob,
  expected: EmergencySeedRecoveryCursor,
  next: EmergencySeedRecoveryCursor,
  input: AdvanceSeedRecoveryCursorInput,
): void {
  const result = database
    .prepare(
      `UPDATE daemon_seed_recovery_keysets
        SET next_counter = ?, trailing_empty_counters = ?,
            revision = ?, state = ?, batch_count = batch_count + 1,
            imported_proofs = imported_proofs + ?,
            ignored_spent_proofs = ignored_spent_proofs + ?
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ? AND keyset_id = ?
        AND next_counter = ? AND trailing_empty_counters = ?
        AND revision = ? AND state = ?`,
    )
    .run(
      next.nextCounter,
      next.trailingEmptyCounters,
      next.revision,
      next.state,
      input.importedProofs,
      input.ignoredSpentProofs,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
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
  job: DaemonSeedRecoveryJob,
  input: AdvanceSeedRecoveryCursorInput,
): void {
  const result = database
    .prepare(
      `UPDATE daemon_seed_recovery_jobs
        SET revision = revision + 1,
            work_units = work_units + 1,
            proof_count = proof_count + ? + ?,
            imported_proofs = imported_proofs + ?,
            ignored_spent_proofs = ignored_spent_proofs + ?,
            updated_at = ?
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ?`,
    )
    .run(
      input.importedProofs,
      input.ignoredSpentProofs,
      input.importedProofs,
      input.ignoredSpentProofs,
      input.nowMs,
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
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
  const row = database
    .prepare(
      `SELECT COUNT(*) AS total_keysets,
            COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0)
              AS completed_keysets,
            (SELECT imported_proofs FROM daemon_seed_recovery_jobs
              WHERE recovery_id = ?) AS imported_proofs,
            (SELECT ignored_spent_proofs FROM daemon_seed_recovery_jobs
              WHERE recovery_id = ?) AS ignored_spent_proofs
       FROM daemon_seed_recovery_keysets
      WHERE recovery_id = ?`,
    )
    .get(recoveryId, recoveryId, recoveryId) as Record<string, unknown>
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
  const maximum = database
    .prepare(
      `SELECT COALESCE(MAX(ordinal), -1) AS maximum
       FROM daemon_seed_recovery_keysets
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
        AND recovery_id = ?`,
    )
    .get(job.walletScopeId, job.mintUrl, job.unit, job.recoveryId) as Record<
    string,
    unknown
  >
  let ordinal =
    requireInteger(maximum.maximum, 'seed recovery keyset ordinal') + 1
  const insert = database.prepare(
    `INSERT INTO daemon_seed_recovery_keysets (
       wallet_scope_id, mint_url, unit, recovery_id, keyset_id, ordinal,
       keyset_kind, curve, catalogue_ordinal, state, next_counter,
       trailing_empty_counters, revision, batch_count, imported_proofs,
       ignored_spent_proofs, retained_pending_proofs, key_count,
       keys_json, keys_digest
     ) VALUES (?, ?, ?, ?, ?, ?, 'ordinary', ?, NULL, 'active',
       0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL)
     ON CONFLICT (wallet_scope_id, mint_url, unit, recovery_id, keyset_id)
     DO NOTHING`,
  )
  for (const keysetId of keysetIds) {
    const result = insert.run(
      job.walletScopeId,
      job.mintUrl,
      job.unit,
      job.recoveryId,
      keysetId,
      ordinal,
      decodeKeysetCurve(keysetId),
    )
    if (Number(result.changes) === 1) ordinal += 1
  }
}

function readJobByScope(
  database: DatabaseSync,
  walletScopeId: string,
  mintUrl: string,
  unit: string,
): DaemonSeedRecoveryJob | null {
  const row = database
    .prepare(
      `SELECT wallet_scope_id, recovery_id, schema_version, mint_url, unit,
            disclosure_acknowledged, state
       FROM daemon_seed_recovery_jobs
      WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?`,
    )
    .get(walletScopeId, mintUrl, unit) as Record<string, unknown> | undefined
  return row === undefined ? null : decodeJob(row)
}

function readJob(
  database: DatabaseSync,
  recoveryId: string,
): DaemonSeedRecoveryJob {
  const row = database
    .prepare(
      `SELECT wallet_scope_id, recovery_id, schema_version, mint_url, unit,
            disclosure_acknowledged, state
       FROM daemon_seed_recovery_jobs
      WHERE recovery_id = ?`,
    )
    .get(recoveryId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error('seed recovery job is missing')
  return decodeJob(row)
}

function decodeJob(row: Record<string, unknown>): DaemonSeedRecoveryJob {
  if (
    requireNonNegativeInteger(row.schema_version, 'seed recovery schema') !==
    DAEMON_SEED_RECOVERY_SCHEMA_VERSION
  ) {
    throw new Error('seed recovery schema is unsupported')
  }
  if (row.disclosure_acknowledged !== 1) {
    throw new Error('seed recovery disclosure acknowledgement is missing')
  }
  return {
    walletScopeId: requireText(
      row.wallet_scope_id,
      'seed recovery wallet scope',
    ),
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

function requireBoundedIdentifier(
  value: string,
  maxBytes: number,
  label: string,
): void {
  requireIdentifier(value, label)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
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
