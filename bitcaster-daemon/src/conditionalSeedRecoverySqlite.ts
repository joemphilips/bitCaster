import { createHash } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { hashToCurve } from '@cashu/cashu-ts'
import {
  CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
  CONDITIONAL_RECOVERY_MAX_KEYSETS,
  CONDITIONAL_RECOVERY_MAX_PROOFS,
  CONDITIONAL_RECOVERY_MAX_SESSION_BYTES,
  CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  CONDITIONAL_RECOVERY_MAX_WORK_UNITS,
  decodeConditionalRecoverySession,
  encodeConditionalRecoverySession,
  validateConditionalRecoverySessionSuccessor,
  type CanonicalConditionalRecoveryProof,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryFreshExpiryEvidence,
  type ConditionalRecoveryNut07AuditPayload,
  type ConditionalRecoveryProofDispositionRow,
  type ConditionalRecoverySession,
  type ConditionalRecoverySessionCasPort,
  type ConditionalRecoveryWalletScope,
} from '@bitcaster-market/client-sdk/emergencyConditionalSeedRecovery'
import { deriveDaemonWalletProofIdFromProof } from './stateSqlite.ts'

const RECOVERY_SCHEMA_VERSION = 3
const OUTER_ENVELOPE_VERSION = 1
const HEX_DIGEST = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()

export type ConditionalSeedRecoverySqliteFaultStage =
  | 'after-anchor'
  | 'after-batch'
  | 'after-staged-proof'
  | 'after-disposition'
  | 'after-current-session'
  | 'after-request-commit'
  | 'after-response-commit'

export interface ConditionalSeedRecoverySqliteOptions {
  database: DatabaseSync
  recoveryId: string
  faultHook?: (stage: ConditionalSeedRecoverySqliteFaultStage) => void
}

export interface PersistedConditionalRecoveryEvidence {
  session: ConditionalRecoverySession
  requestBytes: Uint8Array | null
  responseBytes: Uint8Array | null
  keysResponse: unknown | null
  stagedProofRows: readonly CanonicalConditionalRecoveryProof[]
}

interface BoundJob {
  walletScope: ConditionalRecoveryWalletScope
  recoveryId: string
  revision: number
  baselineKeysets: number
  baselineProofs: number
  baselineTransportBytes: number
  state: 'active' | 'completed' | 'failed-closed'
}

interface CurrentSessionRow {
  session: ConditionalRecoverySession
  jobRevision: number
  outerDigest: string
}

interface ConditionalBinding {
  conditionId: string
  outcomeCollection: string
  outcomeCollectionId: string
}

interface PreparedDisposition {
  row: ConditionalRecoveryProofDispositionRow
  proofY: string
  walletProofId: string | null
  binding: ConditionalBinding
}

export function createConditionalSeedRecoverySqlitePort(
  options: ConditionalSeedRecoverySqliteOptions,
): ConditionalRecoverySessionCasPort {
  requireBoundedText(options.recoveryId, 512, 'conditional recovery id')
  const { database } = options
  return {
    readCurrentDigest(walletScope) {
      const job = readBoundJob(database, options.recoveryId, walletScope)
      return readCurrentSession(database, job)?.session.digest ?? null
    },
    compareAndSwap(input) {
      const job = readBoundJob(database, options.recoveryId, input.walletScope)
      const successor = canonicalSession(input.successor, job.walletScope)
      if (
        successor.transition === 'nut09-request' ||
        successor.transition === 'nut09-response'
      ) {
        throw new Error('conditional recovery staged transition requires its atomic CAS')
      }
      return runTransaction(database, () => {
        const current = readCurrentSession(database, job)
        if ((current?.session.digest ?? null) !== input.expectedDigest) return false
        assertSuccessor(current?.session ?? null, successor)
        writeSuccessor(database, job, current, successor, options.faultHook)
        return true
      })
    },
    async compareAndSwapStageNut09Request(input) {
      const job = readBoundJob(database, options.recoveryId, input.walletScope)
      const successor = canonicalSession(input.successor, job.walletScope)
      const requestBytes = copyBoundedBytes(
        input.requestBytes,
        CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
        'conditional recovery NUT-09 request',
      )
      return runTransactionWithPostCommitFault(
        database,
        () => {
          const current = readCurrentSession(database, job)
          if (current?.session.digest !== input.expectedDigest) return false
          assertSuccessor(current.session, successor)
          if (successor.transition !== 'nut09-request') {
            throw new Error('conditional recovery staged request successor is invalid')
          }
          insertAnchor(database, job, successor)
          options.faultHook?.('after-anchor')
          insertRequest(database, job, successor, requestBytes)
          options.faultHook?.('after-batch')
          writeCurrentOnly(database, job, current, successor)
          options.faultHook?.('after-current-session')
          return true
        },
        () => options.faultHook?.('after-request-commit'),
      )
    },
    async compareAndSwapStageNut09Response(input) {
      const job = readBoundJob(
        database,
        options.recoveryId,
        input.successor.walletScope,
      )
      const successor = canonicalSession(input.successor, job.walletScope)
      const requestBytes = copyBoundedBytes(
        input.requestBytes,
        CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
        'conditional recovery NUT-09 request',
      )
      const responseBytes = copyBoundedBytes(
        input.responseBytes,
        CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
        'conditional recovery NUT-09 response',
      )
      const proofs = canonicalProofRows(input.rows)
      return runTransactionWithPostCommitFault(
        database,
        () => {
          const current = readCurrentSession(database, job)
          if (current?.session.digest !== input.expectedSessionDigest) return false
          assertSuccessor(current.session, successor)
          if (successor.transition !== 'nut09-response') {
            throw new Error('conditional recovery staged response successor is invalid')
          }
          assertPersistedRequest(
            database,
            job,
            current.session,
            requestBytes,
          )
          insertAnchor(database, job, successor)
          insertBatch(
            database,
            job,
            successor,
            input.stagedBatchId,
            requestBytes,
            responseBytes,
            proofs,
          )
          options.faultHook?.('after-batch')
          insertStagedProofs(database, job, input.stagedBatchId, proofs, options.faultHook)
          writeCurrentOnly(database, job, current, successor)
          options.faultHook?.('after-current-session')
          return true
        },
        () => options.faultHook?.('after-response-commit'),
      )
    },
    compareAndSwapInsertUnique(input) {
      return commitNut07Disposition(database, options, input, false)
    },
    compareAndSwapRetainExpiredKeyset(input) {
      return commitNut07Disposition(database, options, input, true)
    },
  }
}

export function createConditionalSeedRecoveryHandoffPort(input: {
  database: DatabaseSync
  recoveryId: string
  expectedJobRevision: number
  catalogue: CompletedConditionalRecoveryCatalogue
  registeredAt: number
}): ConditionalRecoverySessionCasPort {
  const unsupported = (): never => {
    throw new Error('conditional recovery handoff port cannot advance work')
  }
  return {
    readCurrentDigest(walletScope) {
      assertScope(walletScope, input.catalogue.walletScope)
      return null
    },
    compareAndSwap(candidate) {
      if (candidate.expectedDigest !== null) {
        throw new Error('conditional recovery handoff expected digest is invalid')
      }
      return compareAndSwapHandoffToConditionalRecovery({
        ...input,
        successor: candidate.successor,
      })
    },
    compareAndSwapStageNut09Request: unsupported,
    compareAndSwapStageNut09Response: unsupported,
    compareAndSwapInsertUnique: unsupported,
    compareAndSwapRetainExpiredKeyset: unsupported,
  }
}

export function compareAndSwapHandoffToConditionalRecovery(input: {
  database: DatabaseSync
  recoveryId: string
  expectedJobRevision: number
  catalogue: CompletedConditionalRecoveryCatalogue
  successor: ConditionalRecoverySession
  registeredAt: number
}): boolean {
  const job = readBoundJob(
    input.database,
    input.recoveryId,
    input.catalogue.walletScope,
    'ordinary',
  )
  const successor = canonicalSession(input.successor, job.walletScope)
  if (
    successor.sequence !== 0 ||
    successor.predecessorDigest !== null ||
    successor.transition !== 'completed-catalogue'
  ) {
    throw new Error('conditional recovery handoff successor is invalid')
  }
  if (input.catalogue.keysets.length > CONDITIONAL_RECOVERY_MAX_KEYSETS) {
    throw new Error('conditional recovery catalogue exceeds storage capacity')
  }
  return runTransaction(input.database, () => {
    const authority = input.database
      .prepare(
        `SELECT state, cursor_kind, revision,
                (SELECT COUNT(*) FROM daemon_seed_recovery_keysets AS keyset
                  WHERE keyset.wallet_scope_id = job.wallet_scope_id
                    AND keyset.mint_url = job.mint_url AND keyset.unit = job.unit
                    AND keyset.recovery_id = job.recovery_id
                    AND keyset.keyset_kind = 'ordinary'
                    AND keyset.state <> 'completed') AS nonterminal,
                (SELECT COUNT(*) FROM daemon_seed_recovery_proof_retention AS retained
                  WHERE retained.wallet_scope_id = job.wallet_scope_id
                    AND retained.mint_url = job.mint_url AND retained.unit = job.unit
                    AND retained.recovery_id = job.recovery_id
                    AND retained.asset_kind = 'ordinary'
                    AND retained.mint_state = 'PENDING') AS pending
           FROM daemon_seed_recovery_jobs AS job
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ?`,
      )
      .get(
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
      ) as Record<string, unknown> | undefined
    if (
      authority?.state !== 'completed' ||
      authority.cursor_kind !== 'ordinary' ||
      authority.revision !== input.expectedJobRevision ||
      authority.nonterminal !== 0 ||
      authority.pending !== 0
    ) {
      return false
    }
    persistCatalogue(input.database, job, input.catalogue, input.registeredAt)
    const nextRevision = input.expectedJobRevision + 1
    const outerDigest = computeOuterDigest(job, nextRevision, successor)
    const updated = input.database
      .prepare(
        `UPDATE daemon_seed_recovery_jobs
            SET cursor_kind = 'conditional', state = 'active', phase = 'catalogue',
                revision = ?, ordinary_baseline_keysets = keyset_count,
                ordinary_baseline_proofs = proof_count,
                ordinary_baseline_transport_bytes = transport_bytes,
                current_cursor = NULL, current_cursor_digest = NULL,
                capability_version = ?, capability_max_page_size = ?,
                keyset_count = keyset_count + ?, updated_at = MAX(updated_at, ?)
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ? AND revision = ? AND cursor_kind = 'ordinary'`,
      )
      .run(
        nextRevision,
        input.catalogue.capability.version,
        input.catalogue.capability.maxPageSize,
        input.catalogue.keysets.length,
        input.registeredAt,
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        input.expectedJobRevision,
      )
    if (Number(updated.changes) !== 1) return false
    insertCurrentRow(input.database, job, nextRevision, successor, outerDigest)
    return true
  })
}

export function persistConditionalRecoveryKeysResponse(input: {
  database: DatabaseSync
  recoveryId: string
  walletScope: ConditionalRecoveryWalletScope
  keysetId: string
  response: unknown
}): void {
  const job = readBoundJob(
    input.database,
    input.recoveryId,
    input.walletScope,
  )
  const encoded = JSON.stringify(input.response)
  if (
    Buffer.byteLength(encoded) < 2 ||
    Buffer.byteLength(encoded) > CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES
  ) {
    throw new Error('conditional recovery keys response exceeds storage capacity')
  }
  const canonical = JSON.stringify(JSON.parse(encoded))
  if (canonical !== encoded) {
    throw new Error('conditional recovery keys response is not canonical')
  }
  const result = input.database
    .prepare(
      `UPDATE daemon_seed_recovery_keysets
          SET keys_json = ?, keys_digest = ?, key_count = 1
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND keyset_id = ?
          AND keyset_kind = 'conditional' AND keys_json IS NULL`,
    )
    .run(
      encoded,
      digestJson(input.response),
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      input.keysetId,
    )
  if (Number(result.changes) !== 1) {
    const existing = input.database
      .prepare(
        `SELECT keys_json, keys_digest FROM daemon_seed_recovery_keysets
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ? AND keyset_id = ?
            AND keyset_kind = 'conditional'`,
      )
      .get(
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        input.keysetId,
      ) as Record<string, unknown> | undefined
    if (
      existing?.keys_json !== encoded ||
      existing.keys_digest !== digestJson(input.response)
    ) {
      throw new Error('conditional recovery keys response authority conflicts')
    }
  }
}

export function readCurrentConditionalRecoveryEvidence(
  database: DatabaseSync,
  recoveryId: string,
  walletScope: ConditionalRecoveryWalletScope,
): PersistedConditionalRecoveryEvidence | null {
  const job = readBoundJob(database, recoveryId, walletScope)
  const current = readCurrentSession(database, job)
  if (current === null) return null
  const keys = current.session.activeKeysetId === null
    ? undefined
    : database
        .prepare(
          `SELECT keys_json, keys_digest
             FROM daemon_seed_recovery_keysets
            WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
              AND recovery_id = ? AND keyset_id = ?
              AND keyset_kind = 'conditional'`,
        )
        .get(
          job.walletScope.scopeId,
          job.walletScope.mintUrl,
          job.walletScope.unit,
          job.recoveryId,
          current.session.activeKeysetId,
        ) as Record<string, unknown> | undefined
  const keysResponse =
    keys?.keys_json === null || keys?.keys_json === undefined
      ? null
      : JSON.parse(requireText(keys.keys_json, 'conditional recovery keys response'))
  if (
    keysResponse !== null &&
    keys?.keys_digest !== digestJson(keysResponse)
  ) {
    throw new Error('conditional recovery keys response authority is corrupt')
  }
  const batch = database
    .prepare(
      `SELECT request_bytes, response_bytes, staged_batch_id
         FROM daemon_seed_recovery_batches
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND session_sequence <= ?
        ORDER BY session_sequence DESC LIMIT 1`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      current.session.sequence,
    ) as Record<string, unknown> | undefined
  if (batch === undefined) {
    const request = database
      .prepare(
        `SELECT request_bytes
           FROM daemon_seed_recovery_requests
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ? AND session_sequence <= ?
          ORDER BY session_sequence DESC LIMIT 1`,
      )
      .get(
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        current.session.sequence,
      ) as Record<string, unknown> | undefined
    return {
      session: current.session,
      requestBytes:
        request === undefined
          ? null
          : requireBlob(request.request_bytes, 'conditional recovery request'),
      responseBytes: null,
      keysResponse,
      stagedProofRows: [],
    }
  }
  const batchId = requireText(batch.staged_batch_id, 'conditional recovery batch id')
  const rows = database
    .prepare(
      `SELECT keyset_id, amount, secret, signature, dleq_e, dleq_s, dleq_r,
              p2pk_e, witness_json
         FROM daemon_seed_recovery_staged_proofs
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND staged_batch_id = ?
        ORDER BY proof_ordinal`,
    )
    .all(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      batchId,
    ) as Array<Record<string, unknown>>
  return {
    session: current.session,
    requestBytes: requireBlob(batch.request_bytes, 'conditional recovery request'),
    responseBytes: requireBlob(batch.response_bytes, 'conditional recovery response'),
    keysResponse,
    stagedProofRows: rows.map(decodeStagedProof),
  }
}

function commitNut07Disposition(
  database: DatabaseSync,
  options: ConditionalSeedRecoverySqliteOptions,
  input: {
    readonly walletScope: ConditionalRecoveryWalletScope
    readonly expectedSessionDigest: string
    readonly successorSession: ConditionalRecoverySession
    readonly stagedBatchId: string
    readonly rows: readonly ConditionalRecoveryProofDispositionRow[]
    readonly nut07Authority: { readonly consumeForCommit: () => Readonly<{ authorityDigest: string; monotonicAgeMs: number }> }
    readonly nut07Audit: ConditionalRecoveryNut07AuditPayload
    readonly expiryAuthority?: ConditionalRecoveryFreshExpiryEvidence
  },
  expired: boolean,
): boolean {
  const job = readBoundJob(database, options.recoveryId, input.walletScope)
  const successor = canonicalSession(input.successorSession, job.walletScope)
  const expectedTransition = expired
    ? 'expired-keyset-retention'
    : 'atomic-admission'
  if (successor.transition !== expectedTransition) {
    throw new Error('conditional recovery disposition successor is invalid')
  }
  validateNut07Audit(input, job, successor)
  const prepared = prepareDispositions(database, job, input.rows, expired)
  const auditInsert = prepareFinalAuditInsert(database)
  database.exec('BEGIN IMMEDIATE')
  try {
    const current = readCurrentSession(database, job)
    if (current?.session.digest !== input.expectedSessionDigest) {
      database.exec('ROLLBACK')
      return false
    }
    assertSuccessor(current.session, successor)
    validateBatchAndAudit(database, job, input.stagedBatchId, input.nut07Audit, prepared)
    if (expired) {
      validateExpiryAuthority(database, job, current.session, input.expiryAuthority)
    }
    insertAnchor(database, job, current.session)
    insertAnchor(database, job, successor)
    options.faultHook?.('after-anchor')
    applyDispositions(database, job, input.stagedBatchId, prepared, expired)
    options.faultHook?.('after-disposition')
    writeCurrentOnly(database, job, current, successor)
    options.faultHook?.('after-current-session')
    const consumed = input.nut07Authority.consumeForCommit()
    auditInsert.run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      input.stagedBatchId,
      current.session.sequence,
      current.session.transition,
      current.session.digest,
      successor.sequence,
      successor.transition,
      successor.digest,
      input.nut07Audit.requestBytes,
      input.nut07Audit.responseBytes,
      input.nut07Audit.requestDigest,
      input.nut07Audit.responseDigest,
      consumed.authorityDigest,
      input.nut07Audit.authorityDigest,
      input.nut07Audit.issuedAt,
      input.nut07Audit.deadline,
      consumed.monotonicAgeMs,
    )
    database.exec('COMMIT')
    return true
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the authority or SQLite failure.
    }
    throw error
  }
}

function validateNut07Audit(
  input: {
    readonly expectedSessionDigest: string
    readonly stagedBatchId: string
    readonly nut07Audit: ConditionalRecoveryNut07AuditPayload
  },
  job: BoundJob,
  successor: ConditionalRecoverySession,
): void {
  const audit = input.nut07Audit
  assertScope(audit.walletScope, job.walletScope)
  if (
    audit.expectedSessionDigest !== input.expectedSessionDigest ||
    audit.stagedBatchId !== input.stagedBatchId ||
    audit.results.length === 0 ||
    audit.results.length > CONDITIONAL_RECOVERY_MAX_PROOFS ||
    !HEX_DIGEST.test(audit.requestDigest) ||
    !HEX_DIGEST.test(audit.responseDigest) ||
    !HEX_DIGEST.test(audit.authorityDigest) ||
    !Number.isFinite(audit.issuedAt) ||
    !Number.isFinite(audit.deadline) ||
    audit.deadline < audit.issuedAt ||
    successor.predecessorDigest !== input.expectedSessionDigest
  ) {
    throw new Error('conditional recovery NUT-07 audit is invalid')
  }
  copyBoundedBytes(audit.requestBytes, CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES, 'NUT-07 request')
  copyBoundedBytes(audit.responseBytes, CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES, 'NUT-07 response')
}

function validateBatchAndAudit(
  database: DatabaseSync,
  job: BoundJob,
  batchId: string,
  audit: ConditionalRecoveryNut07AuditPayload,
  rows: readonly PreparedDisposition[],
): void {
  const batch = database
    .prepare(
      `SELECT keyset_id, returned_count, proof_y_digest
         FROM daemon_seed_recovery_batches
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND staged_batch_id = ?`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      batchId,
    ) as Record<string, unknown> | undefined
  if (
    batch === undefined ||
    batch.keyset_id !== audit.keysetId ||
    batch.returned_count !== rows.length ||
    batch.proof_y_digest !== audit.proofYDigest ||
    audit.proofYs.length !== rows.length ||
    audit.results.length !== rows.length
  ) {
    throw new Error('conditional recovery NUT-07 batch authority is corrupt')
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (
      audit.proofYs[index] !== rows[index]?.proofY ||
      audit.results[index]?.proofIndex !== index ||
      audit.results[index]?.state !== rows[index]?.row.state
    ) {
      throw new Error('conditional recovery NUT-07 vector is inconsistent')
    }
  }
}

function prepareDispositions(
  database: DatabaseSync,
  job: BoundJob,
  rows: readonly ConditionalRecoveryProofDispositionRow[],
  expired: boolean,
): PreparedDisposition[] {
  if (rows.length === 0 || rows.length > CONDITIONAL_RECOVERY_MAX_PROOFS) {
    throw new Error('conditional recovery disposition row count is invalid')
  }
  const identities = new Set<string>()
  return rows.map((row) => {
    if (!HEX_DIGEST.test(row.proofIdentity) || identities.has(row.proofIdentity)) {
      throw new Error('conditional recovery proof identity is invalid')
    }
    identities.add(row.proofIdentity)
    const proof = canonicalProof(row.proof)
    const expectedDisposition = expired
      ? row.state === 'SPENT'
        ? 'spent-audit'
        : 'expired-keyset'
      : row.state === 'UNSPENT'
        ? 'selectable-wallet-custody'
        : row.state === 'PENDING'
          ? 'pending-mint-state'
          : 'spent-audit'
    if (row.disposition !== expectedDisposition) {
      throw new Error('conditional recovery proof disposition is invalid')
    }
    const binding = readConditionalBinding(database, job, proof.id)
    const proofY = hashToCurve(encoder.encode(proof.secret)).toHex(true)
    const walletProofId =
      row.state === 'SPENT'
        ? null
        : deriveDaemonWalletProofIdFromProof(job.walletScope.mintUrl, job.walletScope.unit, {
            id: proof.id,
            secret: proof.secret,
          })
    return { row: { ...row, proof }, proofY, walletProofId, binding }
  })
}

function applyDispositions(
  database: DatabaseSync,
  job: BoundJob,
  batchId: string,
  rows: readonly PreparedDisposition[],
  expired: boolean,
): void {
  for (let index = 0; index < rows.length; index += 1) {
    const prepared = rows[index]!
    const updated = database
      .prepare(
        `UPDATE daemon_seed_recovery_staged_proofs
            SET nut07_state = ?, verification_state = 'verified'
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ? AND staged_batch_id = ? AND proof_ordinal = ?
            AND nut07_state IS NULL`,
      )
      .run(
        prepared.row.state,
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        batchId,
        index,
      )
    if (Number(updated.changes) !== 1) {
      throw new Error('conditional recovery staged proof is missing or reused')
    }
    if (prepared.row.state !== 'SPENT') {
      insertWalletProof(database, job, prepared, expired)
    }
    if (prepared.row.state !== 'UNSPENT' || expired) {
      insertRetention(database, job, prepared, expired)
    }
  }
}

function insertWalletProof(
  database: DatabaseSync,
  job: BoundJob,
  prepared: PreparedDisposition,
  expired: boolean,
): void {
  const proof = prepared.row.proof
  const locked = expired || prepared.row.state === 'PENDING'
  database
    .prepare(
      `INSERT INTO daemon_wallet_proofs (
        proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
        witness_present, witness_json, dleq_present, dleq_json, p2pk_e,
        proof_condition_id, proof_outcome_collection, state, reserved_by,
        asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?,
        'Outcome', ?, ?, ?, ?, ?)`,
    )
    .run(
      prepared.walletProofId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      proof.secret,
      proof.id,
      Number(proof.amount),
      proof.C,
      proof.witness === null ? 0 : 1,
      proof.witness === null ? null : JSON.stringify(proof.witness),
      JSON.stringify(proof.dleq),
      proof.p2pk_e,
      prepared.binding.conditionId,
      prepared.binding.outcomeCollection,
      locked ? 'locked' : 'available',
      locked ? `seed-recovery:${job.recoveryId}` : null,
      prepared.binding.conditionId,
      prepared.binding.outcomeCollectionId,
      job.walletScope.unit,
      new Date().toISOString(),
      new Date().toISOString(),
    )
}

function insertRetention(
  database: DatabaseSync,
  job: BoundJob,
  prepared: PreparedDisposition,
  expired: boolean,
): void {
  const reason =
    prepared.row.state === 'SPENT'
      ? 'spent-audit'
      : expired
        ? 'expired-keyset'
        : 'pending-mint-state'
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_proof_retention (
        wallet_scope_id, mint_url, unit, recovery_id, keyset_id,
        retention_id, wallet_proof_id, proof_digest, proof_y, mint_state,
        reason, asset_kind, condition_id, outcome_collection,
        outcome_collection_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Outcome', ?, ?, ?, ?)`,
    )
    .run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      prepared.row.proof.id,
      prepared.row.proofIdentity,
      prepared.walletProofId,
      prepared.row.proofIdentity,
      prepared.proofY,
      prepared.row.state,
      reason,
      prepared.binding.conditionId,
      prepared.binding.outcomeCollection,
      prepared.binding.outcomeCollectionId,
      Date.now(),
    )
}

function validateExpiryAuthority(
  database: DatabaseSync,
  job: BoundJob,
  current: ConditionalRecoverySession,
  evidence: ConditionalRecoveryFreshExpiryEvidence | undefined,
): void {
  if (
    evidence === undefined ||
    current.catalogueOrdinal !== evidence.catalogueOrdinal ||
    current.activeKeysetId !== evidence.keysetId ||
    current.keysetMetadataDigest !== evidence.keysetMetadataDigest
  ) {
    throw new Error('conditional recovery expiry authority is invalid')
  }
  const row = database
    .prepare(
      `SELECT catalogue.condition_id, catalogue.final_expiry
         FROM daemon_seed_recovery_keysets AS keyset
         JOIN daemon_seed_recovery_catalogue AS catalogue
           ON catalogue.wallet_scope_id = keyset.wallet_scope_id
          AND catalogue.mint_url = keyset.mint_url
          AND catalogue.unit = keyset.unit
          AND catalogue.recovery_id = keyset.recovery_id
          AND catalogue.ordinal = keyset.catalogue_ordinal
          AND catalogue.keyset_id = keyset.keyset_id
        WHERE keyset.wallet_scope_id = ? AND keyset.mint_url = ?
          AND keyset.unit = ? AND keyset.recovery_id = ?
          AND keyset.keyset_id = ? AND keyset.keyset_kind = 'conditional'`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      evidence.keysetId,
    ) as Record<string, unknown> | undefined
  if (
    row?.condition_id !== evidence.conditionId ||
    row.final_expiry !== evidence.finalExpiry
  ) {
    throw new Error('conditional recovery expiry authority does not match storage')
  }
}

function writeSuccessor(
  database: DatabaseSync,
  job: BoundJob,
  current: CurrentSessionRow | null,
  successor: ConditionalRecoverySession,
  faultHook?: (stage: ConditionalSeedRecoverySqliteFaultStage) => void,
): void {
  if (
    successor.transition === 'nut09-request' ||
    successor.transition === 'proof-verification' ||
    successor.transition === 'atomic-admission' ||
    successor.transition === 'expired-keyset-retention'
  ) {
    insertAnchor(database, job, successor)
    faultHook?.('after-anchor')
  }
  writeCurrentOnly(database, job, current, successor)
  faultHook?.('after-current-session')
}

function writeCurrentOnly(
  database: DatabaseSync,
  job: BoundJob,
  current: CurrentSessionRow | null,
  successor: ConditionalRecoverySession,
): void {
  const nextRevision = job.revision + 1
  const outerDigest = computeOuterDigest(job, nextRevision, successor)
  const update = database
    .prepare(
      `UPDATE daemon_seed_recovery_current_sessions
          SET job_revision = ?, session_sequence = ?, transition = ?,
              session_bytes = ?, inner_digest = ?, outer_digest = ?
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND job_revision = ? AND outer_digest = ?`,
    )
    .run(
      nextRevision,
      successor.sequence,
      successor.transition,
      encodeConditionalRecoverySession(successor, job.walletScope),
      successor.digest,
      outerDigest,
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      current?.jobRevision ?? -1,
      current?.outerDigest ?? '',
    )
  if (Number(update.changes) !== 1) {
    throw new Error('conditional recovery current-session CAS failed')
  }
  const terminal = successor.transition === 'recovery-completed'
    ? ['completed', 'completed'] as const
    : successor.transition === 'recovery-failed-closed'
      ? ['failed-closed', 'failed-closed'] as const
      : ['active', phaseForTransition(successor.transition)] as const
  const jobUpdate = database
    .prepare(
      `UPDATE daemon_seed_recovery_jobs
          SET revision = ?, state = ?, phase = ?, transport_bytes = ?,
              serialized_bytes = ?, work_units = ?, proof_count = ?
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND revision = ? AND cursor_kind = 'conditional'`,
    )
    .run(
      nextRevision,
      terminal[0],
      terminal[1],
      job.baselineTransportBytes + successor.budget.transportBytes,
      successor.budget.serializedBytes,
      successor.budget.workUnits,
      job.baselineProofs + successor.budget.proofCount,
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      job.revision,
    )
  if (Number(jobUpdate.changes) !== 1) {
    throw new Error('conditional recovery job projection CAS failed')
  }
  if (terminal[0] !== 'active') {
    database
      .prepare(
        `INSERT INTO daemon_seed_recovery_terminal_evidence (
          wallet_scope_id, mint_url, unit, recovery_id, session_sequence,
          terminal_kind, session_digest, evidence_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        successor.sequence,
        terminal[0] === 'completed' ? 'completed' : 'failed-closed',
        successor.digest,
        encodeConditionalRecoverySession(successor, job.walletScope),
      )
  }
}

function insertCurrentRow(
  database: DatabaseSync,
  job: BoundJob,
  revision: number,
  session: ConditionalRecoverySession,
  outerDigest: string,
): void {
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_current_sessions (
        wallet_scope_id, mint_url, unit, recovery_id, envelope_version,
        cursor_kind, job_revision, session_sequence, transition,
        session_bytes, inner_digest, outer_digest
      ) VALUES (?, ?, ?, ?, 1, 'conditional', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      revision,
      session.sequence,
      session.transition,
      encodeConditionalRecoverySession(session, job.walletScope),
      session.digest,
      outerDigest,
    )
}

function insertAnchor(
  database: DatabaseSync,
  job: BoundJob,
  session: ConditionalRecoverySession,
): void {
  const result = database
    .prepare(
      `INSERT INTO daemon_seed_recovery_session_anchors (
        wallet_scope_id, mint_url, unit, recovery_id, session_sequence,
        transition, session_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
    )
    .run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      session.sequence,
      session.transition,
      session.digest,
    )
  if (Number(result.changes) === 0) {
    const existing = database
      .prepare(
        `SELECT transition, session_digest
           FROM daemon_seed_recovery_session_anchors
          WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
            AND recovery_id = ? AND session_sequence = ?`,
      )
      .get(
        job.walletScope.scopeId,
        job.walletScope.mintUrl,
        job.walletScope.unit,
        job.recoveryId,
        session.sequence,
      ) as Record<string, unknown> | undefined
    if (
      existing?.transition !== session.transition ||
      existing.session_digest !== session.digest
    ) {
      throw new Error('conditional recovery immutable session anchor conflicts')
    }
  }
}

function insertRequest(
  database: DatabaseSync,
  job: BoundJob,
  session: ConditionalRecoverySession,
  requestBytes: Uint8Array,
): void {
  const binding = session.currentBatch
  if (
    session.activeKeysetId === null ||
    binding === null ||
    binding.requestDigest === null
  ) {
    throw new Error('conditional recovery request binding is missing')
  }
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_requests (
        wallet_scope_id, mint_url, unit, recovery_id, session_sequence,
        anchor_transition, anchor_digest, keyset_id, request_digest,
        request_bytes
      ) VALUES (?, ?, ?, ?, ?, 'nut09-request', ?, ?, ?, ?)`,
    )
    .run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      session.sequence,
      session.digest,
      session.activeKeysetId,
      binding.requestDigest,
      requestBytes,
    )
}

function assertPersistedRequest(
  database: DatabaseSync,
  job: BoundJob,
  requestSession: ConditionalRecoverySession,
  requestBytes: Uint8Array,
): void {
  const row = database
    .prepare(
      `SELECT request_bytes, request_digest
         FROM daemon_seed_recovery_requests
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ? AND session_sequence = ?`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      requestSession.sequence,
    ) as Record<string, unknown> | undefined
  const expectedDigest = requestSession.currentBatch?.requestDigest
  const persistedBytes =
    row === undefined
      ? null
      : requireBlob(row.request_bytes, 'conditional recovery persisted request')
  if (
    expectedDigest === null ||
    expectedDigest === undefined ||
    row?.request_digest !== expectedDigest ||
    persistedBytes === null ||
    !Buffer.from(persistedBytes).equals(Buffer.from(requestBytes))
  ) {
    throw new Error('conditional recovery response request artifact is corrupt')
  }
}

function insertBatch(
  database: DatabaseSync,
  job: BoundJob,
  session: ConditionalRecoverySession,
  batchId: string,
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  proofs: readonly CanonicalConditionalRecoveryProof[],
): void {
  requireBoundedText(batchId, 512, 'conditional recovery batch id')
  const binding = session.currentBatch
  const responseDigest = digestTaggedRawBytes(
    'conditional-recovery-nut09-response-v3',
    responseBytes,
  )
  if (
    binding === null ||
    session.activeKeysetId === null ||
    binding.requestDigest === null ||
    binding.batchDigest !== responseDigest ||
    binding.returnedCount !== proofs.length ||
    (proofs.length === 0
      ? binding.stagedBatchId !== null
      : binding.stagedBatchId !== batchId)
  ) {
    throw new Error('conditional recovery staged batch does not match the session')
  }
  const proofBodyDigest = digestJson(proofs)
  const proofYs = proofs.map((proof) => hashToCurve(encoder.encode(proof.secret)).toHex(true))
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_batches (
        wallet_scope_id, mint_url, unit, recovery_id, session_sequence,
        anchor_transition, anchor_digest, staged_batch_id, keyset_id,
        plan_digest, request_digest, response_digest, request_bytes,
        response_bytes, returned_count, proof_body_digest, proof_y_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      session.sequence,
      session.transition,
      session.digest,
      batchId,
      session.activeKeysetId,
      binding.planDigest,
      binding.requestDigest,
      responseDigest,
      requestBytes,
      responseBytes,
      proofs.length,
      proofBodyDigest,
      digestJson(proofs.map((proof, index) => [proof.id, proofYs[index]])),
    )
}

function insertStagedProofs(
  database: DatabaseSync,
  job: BoundJob,
  batchId: string,
  proofs: readonly CanonicalConditionalRecoveryProof[],
  faultHook?: (stage: ConditionalSeedRecoverySqliteFaultStage) => void,
): void {
  const insert = database.prepare(
    `INSERT INTO daemon_seed_recovery_staged_proofs (
      wallet_scope_id, mint_url, unit, recovery_id, staged_batch_id,
      proof_ordinal, proof_identity, keyset_id, amount, secret, signature,
      dleq_e, dleq_s, dleq_r, p2pk_e, witness_json, proof_y,
      verification_state, nut07_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL)`,
  )
  proofs.forEach((proof, index) => {
    const proofY = hashToCurve(encoder.encode(proof.secret)).toHex(true)
    insert.run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      batchId,
      index,
      digestJson([job.walletScope.mintUrl, job.walletScope.unit, proof.id, proofY]),
      proof.id,
      proof.amount,
      proof.secret,
      proof.C,
      proof.dleq.e,
      proof.dleq.s,
      proof.dleq.r,
      proof.p2pk_e,
      proof.witness === null ? null : JSON.stringify(proof.witness),
      proofY,
    )
    faultHook?.('after-staged-proof')
  })
}

function persistCatalogue(
  database: DatabaseSync,
  job: BoundJob,
  catalogue: CompletedConditionalRecoveryCatalogue,
  registeredAt: number,
): void {
  const catalogueInsert = database.prepare(
    `INSERT INTO daemon_seed_recovery_catalogue (
      wallet_scope_id, mint_url, unit, recovery_id, ordinal, keyset_id,
      active, input_fee_ppk, final_expiry, condition_id,
      outcome_collection, outcome_collection_id, registered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const keysetInsert = database.prepare(
    `INSERT INTO daemon_seed_recovery_keysets (
      wallet_scope_id, mint_url, unit, recovery_id, keyset_id, ordinal,
      keyset_kind, curve, catalogue_ordinal, state, next_counter,
      trailing_empty_counters, revision, batch_count, imported_proofs,
      ignored_spent_proofs, retained_pending_proofs, key_count,
      keys_json, keys_digest
    ) VALUES (?, ?, ?, ?, ?, ?, 'conditional', 'secp256k1', ?, 'pending-keys',
      0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL)`,
  )
  catalogue.keysets.forEach((keyset, ordinal) => {
    if (
      keyset.conditionId === null ||
      keyset.outcomeCollection === null ||
      keyset.outcomeCollectionId === null
    ) {
      throw new Error('conditional recovery catalogue row is incomplete')
    }
    catalogueInsert.run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      ordinal,
      keyset.id,
      keyset.active ? 1 : 0,
      keyset.inputFeePpk,
      keyset.finalExpiry,
      keyset.conditionId,
      keyset.outcomeCollection,
      keyset.outcomeCollectionId,
      registeredAt,
    )
    keysetInsert.run(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      keyset.id,
      job.baselineKeysets + ordinal,
      ordinal,
    )
  })
}

function readBoundJob(
  database: DatabaseSync,
  recoveryId: string,
  scope: ConditionalRecoveryWalletScope,
  expectedKind: 'ordinary' | 'conditional' = 'conditional',
): BoundJob {
  const row = database
    .prepare(
      `SELECT wallet_scope_id, mint_url, unit, recovery_id, schema_version,
              disclosure_acknowledged, state, revision, cursor_kind,
              ordinary_baseline_keysets, ordinary_baseline_proofs,
              ordinary_baseline_transport_bytes
         FROM daemon_seed_recovery_jobs
        WHERE recovery_id = ? AND cursor_kind = ?`,
    )
    .get(recoveryId, expectedKind) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error('conditional recovery job is missing')
  if (row.schema_version !== RECOVERY_SCHEMA_VERSION || row.disclosure_acknowledged !== 1) {
    throw new Error('conditional recovery job schema is unsupported')
  }
  const storedScope = Object.freeze({
    schemaVersion: 1 as const,
    scopeId: requireText(row.wallet_scope_id, 'conditional recovery scope'),
    mintUrl: requireText(row.mint_url, 'conditional recovery mint URL'),
    unit: requireText(row.unit, 'conditional recovery unit'),
  })
  assertScope(storedScope, scope)
  const state = row.state
  if (state !== 'active' && state !== 'completed' && state !== 'failed-closed') {
    throw new Error('conditional recovery job state is invalid')
  }
  return {
    walletScope: storedScope,
    recoveryId,
    revision: requireBoundedInteger(row.revision, CONDITIONAL_RECOVERY_MAX_WORK_UNITS, 'job revision'),
    baselineKeysets: requireBoundedInteger(row.ordinary_baseline_keysets, CONDITIONAL_RECOVERY_MAX_KEYSETS, 'keyset baseline'),
    baselineProofs: requireBoundedInteger(row.ordinary_baseline_proofs, CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS, 'proof baseline'),
    baselineTransportBytes: requireBoundedInteger(row.ordinary_baseline_transport_bytes, CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES, 'transport baseline'),
    state,
  }
}

function readCurrentSession(
  database: DatabaseSync,
  job: BoundJob,
): CurrentSessionRow | null {
  const row = database
    .prepare(
      `SELECT envelope_version, cursor_kind, job_revision, session_sequence,
              transition, session_bytes, inner_digest, outer_digest
         FROM daemon_seed_recovery_current_sessions
        WHERE wallet_scope_id = ? AND mint_url = ? AND unit = ?
          AND recovery_id = ?`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
    ) as Record<string, unknown> | undefined
  if (row === undefined) return null
  if (
    row.envelope_version !== OUTER_ENVELOPE_VERSION ||
    row.cursor_kind !== 'conditional' ||
    row.job_revision !== job.revision
  ) {
    throw new Error('conditional recovery current-session envelope is corrupt')
  }
  const session = decodeConditionalRecoverySession(
    requireBlob(row.session_bytes, 'conditional recovery session'),
    job.walletScope,
  )
  if (
    session.sequence !== row.session_sequence ||
    session.transition !== row.transition ||
    session.digest !== row.inner_digest ||
    row.outer_digest !== computeOuterDigest(job, job.revision, session)
  ) {
    throw new Error('conditional recovery current-session authority is corrupt')
  }
  return {
    session,
    jobRevision: job.revision,
    outerDigest: requireDigest(row.outer_digest, 'outer digest'),
  }
}

function canonicalSession(
  session: ConditionalRecoverySession,
  scope: ConditionalRecoveryWalletScope,
): ConditionalRecoverySession {
  const bytes = encodeConditionalRecoverySession(session, scope)
  if (bytes.byteLength > CONDITIONAL_RECOVERY_MAX_SESSION_BYTES) {
    throw new Error('conditional recovery session exceeds storage capacity')
  }
  return decodeConditionalRecoverySession(bytes, scope)
}

function assertSuccessor(
  current: ConditionalRecoverySession | null,
  successor: ConditionalRecoverySession,
): void {
  if (current === null) {
    if (
      successor.sequence !== 0 ||
      successor.predecessorDigest !== null ||
      successor.transition !== 'completed-catalogue'
    ) {
      throw new Error('conditional recovery initial session is invalid')
    }
    return
  }
  validateConditionalRecoverySessionSuccessor(current, successor)
}

function computeOuterDigest(
  job: BoundJob,
  revision: number,
  session: ConditionalRecoverySession,
): string {
  return digestJson([
    'daemon-conditional-recovery-outer-v1',
    RECOVERY_SCHEMA_VERSION,
    OUTER_ENVELOPE_VERSION,
    'conditional',
    job.walletScope.scopeId,
    job.walletScope.mintUrl,
    job.walletScope.unit,
    job.recoveryId,
    revision,
    job.baselineKeysets,
    job.baselineProofs,
    job.baselineTransportBytes,
    session.digest,
  ])
}

function prepareFinalAuditInsert(database: DatabaseSync): StatementSync {
  return database.prepare(
    `INSERT INTO daemon_seed_recovery_nut07_audits (
      wallet_scope_id, mint_url, unit, recovery_id, staged_batch_id,
      predecessor_sequence, predecessor_transition, predecessor_digest,
      successor_sequence, successor_transition, successor_digest,
      request_bytes, response_bytes, request_digest, response_digest,
      authority_digest, bound_authority_digest, issued_at, deadline, monotonic_age_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
}


function runTransactionWithPostCommitFault<T>(
  database: DatabaseSync,
  work: () => T,
  afterCommit: () => void,
): T {
  database.exec('BEGIN IMMEDIATE')
  let committed = false
  try {
    const result = work()
    database.exec('COMMIT')
    committed = true
    afterCommit()
    return result
  } catch (error) {
    if (!committed) {
      try { database.exec('ROLLBACK') } catch { /* preserve original error */ }
    }
    throw error
  }
}

function readConditionalBinding(
  database: DatabaseSync,
  job: BoundJob,
  keysetId: string,
): ConditionalBinding {
  const row = database

    .prepare(
      `SELECT catalogue.condition_id, catalogue.outcome_collection,
              catalogue.outcome_collection_id
         FROM daemon_seed_recovery_keysets AS keyset
         JOIN daemon_seed_recovery_catalogue AS catalogue
           ON catalogue.wallet_scope_id = keyset.wallet_scope_id
          AND catalogue.mint_url = keyset.mint_url
          AND catalogue.unit = keyset.unit
          AND catalogue.recovery_id = keyset.recovery_id
          AND catalogue.ordinal = keyset.catalogue_ordinal
          AND catalogue.keyset_id = keyset.keyset_id
        WHERE keyset.wallet_scope_id = ? AND keyset.mint_url = ?
          AND keyset.unit = ? AND keyset.recovery_id = ?
          AND keyset.keyset_id = ? AND keyset.keyset_kind = 'conditional'`,
    )
    .get(
      job.walletScope.scopeId,
      job.walletScope.mintUrl,
      job.walletScope.unit,
      job.recoveryId,
      keysetId,
    ) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error('conditional recovery keyset binding is missing')
  return {
    conditionId: requireText(row.condition_id, 'condition id'),
    outcomeCollection: requireText(row.outcome_collection, 'outcome collection'),
    outcomeCollectionId: requireText(row.outcome_collection_id, 'outcome collection id'),
  }
}

function canonicalProofRows(
  rows: readonly CanonicalConditionalRecoveryProof[],
): CanonicalConditionalRecoveryProof[] {
  if (rows.length > CONDITIONAL_RECOVERY_MAX_PROOFS) {
    throw new Error('conditional recovery staged proof count is invalid')
  }
  return rows.map(canonicalProof)
}

function canonicalProof(proof: CanonicalConditionalRecoveryProof): CanonicalConditionalRecoveryProof {
  const encoded = JSON.stringify(proof)
  const parsed = JSON.parse(encoded) as CanonicalConditionalRecoveryProof
  if (JSON.stringify(parsed) !== encoded) {
    throw new Error('conditional recovery proof is not canonical')
  }
  requireBoundedText(parsed.id, 256, 'proof keyset id')
  requireBoundedText(parsed.amount, 32, 'proof amount')
  requireBoundedText(parsed.secret, 65_536, 'proof secret')
  requireBoundedText(parsed.C, 512, 'proof signature')
  requireBoundedText(parsed.dleq.e, 512, 'proof DLEQ e')
  requireBoundedText(parsed.dleq.s, 512, 'proof DLEQ s')
  requireBoundedText(parsed.dleq.r, 512, 'proof DLEQ r')
  return Object.freeze(parsed)
}

function decodeStagedProof(row: Record<string, unknown>): CanonicalConditionalRecoveryProof {
  const witness = row.witness_json === null
    ? null
    : JSON.parse(requireText(row.witness_json, 'proof witness')) as unknown
  return canonicalProof({
    id: requireText(row.keyset_id, 'proof keyset id'),

    amount: requireText(row.amount, 'proof amount'),
    secret: requireText(row.secret, 'proof secret'),
    C: requireText(row.signature, 'proof signature'),
    dleq: {
      e: requireText(row.dleq_e, 'proof DLEQ e'),
      s: requireText(row.dleq_s, 'proof DLEQ s'),
      r: requireText(row.dleq_r, 'proof DLEQ r'),
    },
    p2pk_e: row.p2pk_e === null ? null : requireText(row.p2pk_e, 'proof P2PK e'),
    witness: witness as CanonicalConditionalRecoveryProof['witness'],
  })
}

function digestTaggedRawBytes(tag: string, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(tag)
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex')
}

function phaseForTransition(
  transition: ConditionalRecoverySession['transition'],
): 'catalogue' | 'keys' | 'restore' | 'finalize' {
  switch (transition) {
    case 'completed-catalogue': return 'catalogue'
    case 'conditional-keys': return 'keys'
    case 'nut13-plan':
    case 'nut09-request':
    case 'nut09-response':
    case 'proof-verification':
    case 'atomic-admission': return 'restore'
    case 'keyset-completed':
    case 'keyset-skipped':
    case 'expired-keyset-retention': return 'finalize'
    case 'recovery-completed':
    case 'recovery-failed-closed':
      throw new Error('terminal conditional recovery transition has no active phase')
  }
}

function runTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  }
}

function copyBoundedBytes(value: Uint8Array, maximum: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new Error(`${label} bytes are invalid`)
  }
  return Uint8Array.from(value)
}

function requireBlob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new Error(`${label} bytes are invalid`)
  }
  return Uint8Array.from(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`)
  return value
}

function requireBoundedText(value: unknown, maximum: number, label: string): string {
  const text = requireText(value, label)
  if (Buffer.byteLength(text) > maximum) throw new Error(`${label} is too large`)
  return text
}

function requireDigest(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!HEX_DIGEST.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function requireBoundedInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function assertScope(
  actual: ConditionalRecoveryWalletScope,
  expected: ConditionalRecoveryWalletScope,
): void {
  if (
    actual.schemaVersion !== expected.schemaVersion ||
    actual.scopeId !== expected.scopeId ||
    actual.mintUrl !== expected.mintUrl ||
    actual.unit !== expected.unit
  ) {
    throw new Error('conditional recovery wallet scope is foreign')
  }
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
