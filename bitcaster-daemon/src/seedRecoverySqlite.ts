// Ported-From: da98db6
// Reauthored-Fix: b683120
import type { DatabaseSync } from 'node:sqlite'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  classifyEmergencySeedRecoveryProof,
  validateEmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryCasStore,
  type EmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryCursor,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { decodeCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'
import { advanceDaemonKeysetCounterFromDatabase } from './state.ts'

export interface SeedRecoveryObservedProof {
  readonly proofY: string
  readonly mintState: unknown
  readonly proof: CustodyProofSqliteRow
}

export class SeedRecoverySqliteStore implements EmergencySeedRecoveryCasStore {
  readonly #directory: string
  readonly #fence: CustodyScopeFence
  readonly #invocationId: string
  readonly #observedAtMs: number
  readonly #staged = new Map<string, readonly SeedRecoveryObservedProof[]>()

  constructor(input: {
    directory: string
    fence: CustodyScopeFence
    invocationId: string
    observedAtMs: number
  }) {
    this.#directory = input.directory
    this.#fence = input.fence
    this.#invocationId = input.invocationId
    this.#observedAtMs = input.observedAtMs
  }

  stageBatch(
    recoveryId: string,
    keysetId: string,
    proofs: readonly SeedRecoveryObservedProof[],
  ): void {
    const key = batchKey(recoveryId, keysetId)
    if (this.#staged.has(key) || proofs.length > 300) {
      throw new Error('seed recovery proof batch is duplicated or oversized')
    }
    this.#staged.set(
      key,
      proofs.map((proof) => ({
        ...structuredClone(proof),
        proof: decodeCustodyProofSqliteRow(proof.proof).row,
      })),
    )
  }

  async commitRecoveryBatch(raw: EmergencySeedRecoveryCoCommit): Promise<void> {
    const input = validateEmergencySeedRecoveryCoCommit(raw)
    const staged = this.#staged.get(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
    if (staged === undefined) {
      throw new Error('seed recovery proof batch was not staged')
    }
    const classified = classifyStagedProofs(staged, input.recoveredProofIds)
    await withDurableCustodyUnitOfWork(
      this.#directory,
      this.#fence,
      this.#observedAtMs,
      (database) => this.#commitRecoveryBatchInTransaction(database, input, classified),
    )
    this.#staged.delete(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
  }

  #commitRecoveryBatchInTransaction(
    database: DatabaseSync,
    input: EmergencySeedRecoveryCoCommit,
    classified: readonly ClassifiedObservedProof[],
  ): void {
    assertRecoveryAuthority(input, this.#fence, this.#observedAtMs)
    const existing = readRecoveryRows(database, input)
    assertRecoveryCursorCas(input.expectedCursor, existing.cursor)
    assertRecoveryCounterLimit(input.nextCursor)
    advanceDaemonKeysetCounterFromDatabase(
      database,
      this.#fence.scopeId,
      input.nextCursor.keysetId,
      input.nextCursor.nextCounter,
      this.#observedAtMs,
    )
    const imported = importSelectableProofs(database, input, classified)
    retainPendingProofs(database, input, classified, this.#observedAtMs)
    writeRecoveryProgress(database, input, existing.job, imported, countIgnoredProofs(classified), {
      invocationId: this.#invocationId,
      observedAtMs: this.#observedAtMs,
    })
  }
}

type ClassifiedObservedProof = {
  readonly observed: SeedRecoveryObservedProof
  readonly disposition: ReturnType<typeof classifyEmergencySeedRecoveryProof>
}

type RecoveryJobRow = { readonly revision: number; readonly state: string }

type RecoveryCursorRow = {
  readonly nextCounter: number
  readonly trailingEmptyCounters: number
  readonly revision: number
  readonly state: string
}

function classifyStagedProofs(
  staged: readonly SeedRecoveryObservedProof[],
  recoveredProofIds: readonly string[],
): readonly ClassifiedObservedProof[] {
  const classified = staged.map((observed) => ({
    observed,
    disposition: classifyEmergencySeedRecoveryProof(observed.mintState),
  }))
  if (classified.some(({ disposition }) => disposition === 'fail-closed')) {
    throw new Error('seed recovery proof state is unknown')
  }
  const selectable = classified
    .filter(({ disposition }) => disposition === 'import-selectable')
    .map(({ observed }) => observed.proof.proofId)
  if (
    selectable.length !== recoveredProofIds.length ||
    selectable.some((proofId, index) => proofId !== recoveredProofIds[index])
  ) {
    throw new Error('seed recovery selectable proof authority is foreign')
  }
  return classified
}

function assertRecoveryAuthority(
  input: EmergencySeedRecoveryCoCommit,
  fence: CustodyScopeFence,
  observedAtMs: number,
): void {
  const authority = input.authority
  if (
    authority.walletScopeId !== fence.scopeId ||
    authority.incarnationId !== fence.incarnationId ||
    authority.fencingEpoch !== fence.fencingEpoch ||
    authority.leaseExpiresAtMs !== fence.leaseExpiresAtMs ||
    authority.observedAtMs !== observedAtMs
  ) {
    throw new Error('seed recovery fencing authority is foreign')
  }
}

function readRecoveryRows(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
): { readonly job: RecoveryJobRow | undefined; readonly cursor: RecoveryCursorRow | undefined } {
  const job = database
    .prepare(
      `SELECT revision, state FROM seed_recovery_jobs
       WHERE recovery_id = ? AND scope_id = ?`,
    )
    .get(input.recoveryJobId, input.walletScopeId) as RecoveryJobRow | undefined
  const cursor = database
    .prepare(
      `SELECT next_counter AS nextCounter,
         trailing_empty_counters AS trailingEmptyCounters,
         revision, state
       FROM seed_recovery_keysets
       WHERE recovery_id = ? AND keyset_id = ?`,
    )
    .get(input.recoveryJobId, input.expectedCursor.keysetId) as RecoveryCursorRow | undefined
  return { job, cursor }
}

function assertRecoveryCursorCas(
  expected: EmergencySeedRecoveryCursor,
  existing: RecoveryCursorRow | undefined,
): void {
  if (
    (existing === undefined && expected.revision !== 0) ||
    (existing !== undefined &&
      (existing.revision !== expected.revision ||
        existing.nextCounter !== expected.nextCounter ||
        existing.trailingEmptyCounters !== expected.trailingEmptyCounters ||
        existing.state !== expected.state))
  ) {
    throw new Error('seed recovery cursor CAS is stale')
  }
}

function assertRecoveryCounterLimit(cursor: EmergencySeedRecoveryCursor): void {
  if (cursor.nextCounter > 4 * 300) {
    throw new Error('seed recovery invocation counter limit exceeded')
  }
}

function importSelectableProofs(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  classified: readonly ClassifiedObservedProof[],
): number {
  const store = new DurableCustodySqliteStore(database)
  const selectable = classified.filter(({ disposition }) => disposition === 'import-selectable')
  for (const { observed } of selectable) {
    assertSelectableProof(observed.proof, input)
    store.putProofCas(observed.proof, null)
  }
  return selectable.length
}

function assertSelectableProof(
  proof: CustodyProofSqliteRow,
  input: EmergencySeedRecoveryCoCommit,
): void {
  if (
    proof.scopeId !== input.walletScopeId ||
    proof.normalizedMint !== input.expectedCursor.mintUrl ||
    proof.unit !== input.expectedCursor.unit ||
    proof.keysetId !== input.expectedCursor.keysetId ||
    proof.nut07State !== 'UNSPENT' ||
    proof.selectability !== 'selectable'
  ) {
    throw new Error('seed recovery selectable proof is foreign')
  }
}

function retainPendingProofs(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  classified: readonly ClassifiedObservedProof[],
  observedAtMs: number,
): void {
  const pending = classified.filter(({ disposition }) => disposition === 'retain-nonselectable')
  const count = database
    .prepare(
      `SELECT COUNT(*) AS count FROM seed_recovery_pending_proofs
       WHERE recovery_id = ? AND keyset_id = ?`,
    )
    .get(input.recoveryJobId, input.expectedCursor.keysetId) as { count: number }
  if (count.count + pending.length > 300)
    throw new Error('seed recovery pending proof limit exceeded')
  pending.forEach(({ observed }, position) =>
    insertPendingProof(database, input, observed, count.count + position, observedAtMs),
  )
}

function insertPendingProof(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  observed: SeedRecoveryObservedProof,
  position: number,
  observedAtMs: number,
): void {
  const proof = observed.proof
  if (
    proof.scopeId !== input.walletScopeId ||
    proof.normalizedMint !== input.expectedCursor.mintUrl ||
    proof.unit !== input.expectedCursor.unit ||
    proof.keysetId !== input.expectedCursor.keysetId ||
    proof.nut07State !== 'PENDING' ||
    proof.selectability === 'selectable'
  ) {
    throw new Error('seed recovery pending proof is selectable or foreign')
  }
  database
    .prepare(
      `INSERT INTO seed_recovery_pending_proofs (
         recovery_id, keyset_id, proof_y, proof_position, scope_id,
         normalized_mint, unit, curve, proof_body, retained_reason, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    )
    .run(
      input.recoveryJobId,
      input.expectedCursor.keysetId,
      observed.proofY,
      position,
      input.walletScopeId,
      input.expectedCursor.mintUrl,
      input.expectedCursor.unit,
      proof.curve,
      proof.proofBody,
      observedAtMs,
    )
}

function countIgnoredProofs(classified: readonly ClassifiedObservedProof[]): number {
  return classified.filter(({ disposition }) => disposition === 'ignore-spent').length
}

function writeRecoveryProgress(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  existingJob: RecoveryJobRow | undefined,
  imported: number,
  ignored: number,
  context: { readonly invocationId: string; readonly observedAtMs: number },
): void {
  if (existingJob === undefined) {
    insertRecoveryProgress(database, input, imported, ignored, context)
    return
  }
  updateRecoveryProgress(database, input, imported, ignored, context)
}

function insertRecoveryProgress(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  imported: number,
  ignored: number,
  context: { readonly invocationId: string; readonly observedAtMs: number },
): void {
  database
    .prepare(
      `INSERT INTO seed_recovery_jobs (
         recovery_id, scope_id, invocation_id, disclosure_acknowledged,
         normalized_mint, unit, state, revision, imported_proofs,
         ignored_spent_proofs, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.recoveryJobId,
      input.walletScopeId,
      context.invocationId,
      input.expectedCursor.mintUrl,
      input.expectedCursor.unit,
      input.nextCursor.state,
      input.nextCursor.revision,
      imported,
      ignored,
      context.observedAtMs,
      context.observedAtMs,
    )
  database
    .prepare(
      `INSERT INTO seed_recovery_keysets (
         recovery_id, keyset_id, ordinal, next_counter,
         trailing_empty_counters, revision, state
       ) VALUES (?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      input.recoveryJobId,
      input.expectedCursor.keysetId,
      input.nextCursor.nextCounter,
      input.nextCursor.trailingEmptyCounters,
      input.nextCursor.revision,
      input.nextCursor.state,
    )
}

function updateRecoveryProgress(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  imported: number,
  ignored: number,
  context: { readonly observedAtMs: number },
): void {
  const job = database
    .prepare(
      `UPDATE seed_recovery_jobs SET state = ?, revision = ?,
         imported_proofs = imported_proofs + ?, ignored_spent_proofs = ignored_spent_proofs + ?,
         updated_at_ms = ? WHERE recovery_id = ? AND scope_id = ? AND revision = ?`,
    )
    .run(
      input.nextCursor.state,
      input.nextCursor.revision,
      imported,
      ignored,
      context.observedAtMs,
      input.recoveryJobId,
      input.walletScopeId,
      input.expectedCursor.revision,
    )
  const cursor = database
    .prepare(
      `UPDATE seed_recovery_keysets SET next_counter = ?, trailing_empty_counters = ?,
         revision = ?, state = ? WHERE recovery_id = ? AND keyset_id = ? AND revision = ?`,
    )
    .run(
      input.nextCursor.nextCounter,
      input.nextCursor.trailingEmptyCounters,
      input.nextCursor.revision,
      input.nextCursor.state,
      input.recoveryJobId,
      input.expectedCursor.keysetId,
      input.expectedCursor.revision,
    )
  if (job.changes !== 1 || cursor.changes !== 1) {
    throw new Error('seed recovery job/cursor CAS lost')
  }
}

function batchKey(recoveryId: string, keysetId: string): string {
  return `${recoveryId}\u0000${keysetId}`
}
