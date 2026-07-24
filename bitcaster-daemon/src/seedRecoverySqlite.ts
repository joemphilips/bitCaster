// Ported-From: da98db6
// Reauthored-Fix: b683120
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  classifyEmergencySeedRecoveryProof,
  validateEmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryCasStore,
  type EmergencySeedRecoveryCoCommit,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'

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
      proofs.map((proof) => structuredClone(proof)),
    )
  }

  async commitRecoveryBatch(raw: EmergencySeedRecoveryCoCommit): Promise<void> {
    const input = validateEmergencySeedRecoveryCoCommit(raw)
    const staged = this.#staged.get(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
    if (staged === undefined) {
      throw new Error('seed recovery proof batch was not staged')
    }
    const classified = staged.map((observed) => ({
      observed,
      disposition: classifyEmergencySeedRecoveryProof(observed.mintState),
    }))
    if (classified.some(({ disposition }) => disposition === 'fail-closed')) {
      throw new Error('seed recovery proof state is unknown')
    }
    const selectable = classified
      .filter(({ disposition }) => disposition === 'import-selectable')
      .map(({ observed }) => observed.proof)
    if (
      selectable.length !== input.recoveredProofIds.length ||
      selectable.some(({ proofId }, index) => proofId !== input.recoveredProofIds[index])
    ) {
      throw new Error('seed recovery selectable proof authority is foreign')
    }
    await withDurableCustodyUnitOfWork(
      this.#directory,
      this.#fence,
      this.#observedAtMs,
      (database) => {
        const authority = input.authority
        if (
          authority.walletScopeId !== this.#fence.scopeId ||
          authority.incarnationId !== this.#fence.incarnationId ||
          authority.fencingEpoch !== this.#fence.fencingEpoch ||
          authority.leaseExpiresAtMs !== this.#fence.leaseExpiresAtMs ||
          authority.observedAtMs !== this.#observedAtMs
        ) {
          throw new Error('seed recovery fencing authority is foreign')
        }
        const existingJob = database
          .prepare(
            `SELECT revision, state FROM seed_recovery_jobs
             WHERE recovery_id = ? AND scope_id = ?`,
          )
          .get(input.recoveryJobId, input.walletScopeId) as
          | { revision: number; state: string }
          | undefined
        const existingCursor = database
          .prepare(
            `SELECT next_counter AS nextCounter,
               trailing_empty_counters AS trailingEmptyCounters,
               revision, state
             FROM seed_recovery_keysets
             WHERE recovery_id = ? AND keyset_id = ?`,
          )
          .get(input.recoveryJobId, input.expectedCursor.keysetId) as
          | {
              nextCounter: number
              trailingEmptyCounters: number
              revision: number
              state: string
            }
          | undefined
        if (
          (existingCursor === undefined && input.expectedCursor.revision !== 0) ||
          (existingCursor !== undefined &&
            (existingCursor.revision !== input.expectedCursor.revision ||
              existingCursor.nextCounter !== input.expectedCursor.nextCounter ||
              existingCursor.trailingEmptyCounters !== input.expectedCursor.trailingEmptyCounters ||
              existingCursor.state !== input.expectedCursor.state))
        ) {
          throw new Error('seed recovery cursor CAS is stale')
        }
        if (input.nextCursor.nextCounter > 4 * 300) {
          throw new Error('seed recovery invocation counter limit exceeded')
        }
        const store = new DurableCustodySqliteStore(database)
        for (const proof of selectable) {
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
          store.putProofCas(proof, null)
        }
        const pending = classified.filter(
          ({ disposition }) => disposition === 'retain-nonselectable',
        )
        const existingPending = database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM seed_recovery_pending_proofs
             WHERE recovery_id = ? AND keyset_id = ?`,
          )
          .get(input.recoveryJobId, input.expectedCursor.keysetId) as {
          count: number
        }
        if (existingPending.count + pending.length > 300) {
          throw new Error('seed recovery pending proof limit exceeded')
        }
        pending.forEach(({ observed }, position) => {
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
                 normalized_mint, unit, curve, proof_body, retained_reason,
                 created_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
            )
            .run(
              input.recoveryJobId,
              input.expectedCursor.keysetId,
              observed.proofY,
              existingPending.count + position,
              input.walletScopeId,
              input.expectedCursor.mintUrl,
              input.expectedCursor.unit,
              proof.curve,
              proof.proofBody,
              this.#observedAtMs,
            )
        })
        const ignored = classified.filter(
          ({ disposition }) => disposition === 'ignore-spent',
        ).length
        if (existingJob === undefined) {
          database
            .prepare(
              `INSERT INTO seed_recovery_jobs (
                 recovery_id, scope_id, invocation_id,
                 disclosure_acknowledged, normalized_mint, unit, state,
                 revision, imported_proofs, ignored_spent_proofs,
                 created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.recoveryJobId,
              input.walletScopeId,
              this.#invocationId,
              input.expectedCursor.mintUrl,
              input.expectedCursor.unit,
              input.nextCursor.state,
              input.nextCursor.revision,
              selectable.length,
              ignored,
              this.#observedAtMs,
              this.#observedAtMs,
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
        } else {
          const updatedJob = database
            .prepare(
              `UPDATE seed_recovery_jobs SET state = ?, revision = ?,
                 imported_proofs = imported_proofs + ?,
                 ignored_spent_proofs = ignored_spent_proofs + ?,
                 updated_at_ms = ?
               WHERE recovery_id = ? AND scope_id = ? AND revision = ?`,
            )
            .run(
              input.nextCursor.state,
              input.nextCursor.revision,
              selectable.length,
              ignored,
              this.#observedAtMs,
              input.recoveryJobId,
              input.walletScopeId,
              input.expectedCursor.revision,
            )
          const updatedCursor = database
            .prepare(
              `UPDATE seed_recovery_keysets SET next_counter = ?,
                 trailing_empty_counters = ?, revision = ?, state = ?
               WHERE recovery_id = ? AND keyset_id = ? AND revision = ?`,
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
          if (updatedJob.changes !== 1 || updatedCursor.changes !== 1) {
            throw new Error('seed recovery job/cursor CAS lost')
          }
        }
      },
    )
    this.#staged.delete(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
  }
}

function batchKey(recoveryId: string, keysetId: string): string {
  return `${recoveryId}\u0000${keysetId}`
}
