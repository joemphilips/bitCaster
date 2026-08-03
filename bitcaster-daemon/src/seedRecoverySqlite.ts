// Ported-From: da98db6
// Reauthored-Fix: b683120
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  classifyEmergencySeedRecoveryProof,
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCoCommit,
  validateEmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryCasStore,
  type EmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryCursor,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { decodeCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import {
  createDaemonStateSqliteSession,
  type DaemonStateSqliteSession,
  type StateSqliteFaultPhase,
} from './stateSqlite.ts'
import {
  admitRecoveredRegularWalletProofFromDatabase,
  advanceDaemonKeysetCounterFromDatabase,
  readExactBoundCounter,
} from './state.ts'

export interface SeedRecoveryObservedProof {
  readonly proofY: string
  readonly mintState: unknown
  readonly proof: CustodyProofSqliteRow
}

export class SeedRecoverySqliteStore implements EmergencySeedRecoveryCasStore {
  #fence: CustodyScopeFence
  readonly #invocationId: string
  #observedAtMs: number
  readonly #storage: DaemonStateSqliteSession
  readonly #injectFault: ((phase: StateSqliteFaultPhase) => void) | undefined
  readonly #staged = new Map<string, readonly SeedRecoveryObservedProof[]>()

  constructor(input: {
    directory: string
    fence: CustodyScopeFence
    invocationId: string
    observedAtMs: number
    storage?: DaemonStateSqliteSession
    injectFault?: (phase: StateSqliteFaultPhase) => void
  }) {
    this.#fence = input.fence
    this.#invocationId = input.invocationId
    this.#observedAtMs = input.observedAtMs
    this.#storage = input.storage ?? createDaemonStateSqliteSession(input.directory)
    this.#injectFault = input.injectFault
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

  setAuthority(fence: CustodyScopeFence, observedAtMs: number): void {
    this.#fence = fence
    this.#observedAtMs = observedAtMs
  }

  async readRecoveryStart(input: {
    recoveryId: string
    walletScopeId: string
    mintUrl: string
    unit: 'sat' | 'msat'
    keysetId: string
  }): Promise<{
    readonly cursor: EmergencySeedRecoveryCursor
    readonly counterHighWaterMark: number
  }> {
    if (input.walletScopeId !== this.#fence.scopeId) {
      throw new Error('seed recovery cursor scope is foreign')
    }
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => {
        assertNoRecoveryOwnerBlocker(database, input.walletScopeId)
        const job = readRecoveryJob(database, input.recoveryId)
        assertRecoveryJobBinding(job, input)
        const row = database
          .prepare(
            `SELECT next_counter AS nextCounter,
                trailing_empty_counters AS trailingEmptyCounters,
                revision, state
             FROM seed_recovery_keysets WHERE recovery_id = ? AND keyset_id = ?`,
          )
          .get(input.recoveryId, input.keysetId) as RecoveryCursorRow | undefined
        if (row !== undefined && job === undefined) {
          throw new Error('seed recovery cursor has no job binding')
        }
        const cursor =
          row === undefined
            ? createEmergencySeedRecoveryCursor(input)
            : validateEmergencySeedRecoveryCursor({
                schemaVersion: 1,
                ...input,
                ...row,
              })
        return {
          cursor,
          counterHighWaterMark: readExactBoundCounter(
            database,
            input.walletScopeId,
            input.keysetId,
            {
              normalizedMint: input.mintUrl,
              unit: input.unit,
            },
          ),
        }
      },
    )
  }

  async commitRecoveryBatch(raw: EmergencySeedRecoveryCoCommit): Promise<void> {
    const input = validateEmergencySeedRecoveryCoCommit(raw)
    const staged = this.#staged.get(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
    if (staged === undefined) {
      throw new Error('seed recovery proof batch was not staged')
    }
    const classified = classifyStagedProofs(staged, input.recoveredProofIds)
    if (classified.some(({ disposition }) => disposition === 'retain-nonselectable')) {
      this.#staged.delete(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
      throw new Error('seed recovery cannot commit a nonselectable proof')
    }
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => this.#commitRecoveryBatchInTransaction(database, input, classified),
      { injectFault: this.#injectFault },
    )
    this.#staged.delete(batchKey(input.recoveryJobId, input.expectedCursor.keysetId))
  }

  #commitRecoveryBatchInTransaction(
    database: DatabaseSync,
    input: EmergencySeedRecoveryCoCommit,
    classified: readonly ClassifiedObservedProof[],
  ): void {
    assertRecoveryAuthority(input, this.#fence, this.#observedAtMs)
    assertNoRecoveryOwnerBlocker(database, input.walletScopeId)
    const existing = readRecoveryRows(database, input)
    assertRecoveryCursorCas(input.expectedCursor, existing.cursor)
    advanceDaemonKeysetCounterFromDatabase(
      database,
      this.#fence.scopeId,
      input.nextCursor.keysetId,
      input.nextCursor.nextCounter,
      this.#observedAtMs,
      {
        normalizedMint: input.expectedCursor.mintUrl,
        unit: recoveryUnit(input.expectedCursor.unit),
      },
    )
    const imported = importSelectableProofs(database, input, classified)
    writeRecoveryProgress(database, input, existing, imported, countIgnoredProofs(classified), {
      invocationId: this.#invocationId,
      observedAtMs: this.#observedAtMs,
    })
  }
}

function recoveryUnit(unit: string): 'sat' | 'msat' {
  if (unit === 'sat' || unit === 'msat') return unit
  throw new Error('seed recovery unit is invalid')
}

type ClassifiedObservedProof = {
  readonly observed: SeedRecoveryObservedProof
  readonly disposition: ReturnType<typeof classifyEmergencySeedRecoveryProof>
}

type RecoveryJobRow = {
  readonly scopeId: string
  readonly mintUrl: string
  readonly unit: string
  readonly keysetId: string
  readonly revision: number
}

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
  const job = readRecoveryJob(database, input.recoveryJobId)
  assertRecoveryJobBinding(job, {
    walletScopeId: input.walletScopeId,
    mintUrl: input.expectedCursor.mintUrl,
    unit: input.expectedCursor.unit,
    keysetId: input.expectedCursor.keysetId,
  })
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

function readRecoveryJob(database: DatabaseSync, recoveryId: string): RecoveryJobRow | undefined {
  return database
    .prepare(
      `SELECT scope_id AS scopeId, normalized_mint AS mintUrl, unit, keyset_id AS keysetId,
          revision
       FROM seed_recovery_jobs WHERE recovery_id = ?`,
    )
    .get(recoveryId) as RecoveryJobRow | undefined
}

const RECOVERY_OWNER_BLOCKERS = [
  {
    className: 'target-wallet-proof-reserved',
    sql: `SELECT 1 FROM target_wallet_proofs
          WHERE scope_id = ? AND state IN ('reserved', 'locked') LIMIT 1`,
  },
  {
    className: 'custody-operation-nonterminal',
    sql: `SELECT 1 FROM custody_operations
          WHERE scope_id = ? AND operation_state NOT IN ('reconciled', 'aborted') LIMIT 1`,
  },
  {
    className: 'custody-proof-reservation',
    sql: `SELECT 1 FROM custody_proof_reservations WHERE scope_id = ? LIMIT 1`,
  },
  {
    className: 'order-collateral-pin-active',
    sql: `SELECT 1 FROM order_collateral_pins
          WHERE scope_id = ? AND pin_state = 'active' LIMIT 1`,
  },
  {
    className: 'target-proof-operation-prepared',
    sql: `SELECT 1 FROM target_proof_operations
          WHERE scope_id = ? AND state = 'prepared' LIMIT 1`,
  },
  {
    className: 'custody-active-work',
    sql: `SELECT 1 FROM custody_active_work WHERE scope_id = ? LIMIT 1`,
  },
  {
    className: 'daemon-complete-set-recovery-root',
    sql: `SELECT 1 FROM daemon_complete_set_recovery_roots WHERE scope_id = ? LIMIT 1`,
  },
  {
    className: 'daemon-ctf-range-nonterminal',
    sql: `SELECT 1 FROM daemon_ctf_range_preparations
          WHERE scope_id = ? AND lifecycle_state <> 'terminal' LIMIT 1`,
  },
  {
    className: 'daemon-managed-condition-retiring',
    sql: `SELECT 1 FROM daemon_managed_condition_inventory
          WHERE scope_id = ? AND state = 'retiring' LIMIT 1`,
  },
  {
    className: 'daemon-swap-nonterminal',
    sql: `SELECT 1 FROM daemon_swaps
          WHERE scope_id = ? AND step NOT IN ('confirmed', 'refunded', 'failed') LIMIT 1`,
  },
  {
    className: 'custody-delivery-pending',
    sql: `SELECT 1 FROM custody_deliveries
          WHERE scope_id = ? AND state = 'pending' LIMIT 1`,
  },
] as const

function assertNoRecoveryOwnerBlocker(database: DatabaseSync, scopeId: string): void {
  for (const blocker of RECOVERY_OWNER_BLOCKERS) {
    if (database.prepare(blocker.sql).get(scopeId) !== undefined) {
      throw new Error(`seed recovery refused: durable owner blocker ${blocker.className}`)
    }
  }
}

function assertRecoveryJobBinding(
  job: RecoveryJobRow | undefined,
  input: {
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: string
    readonly keysetId: string
  },
): void {
  if (
    job !== undefined &&
    (job.scopeId !== input.walletScopeId ||
      job.mintUrl !== input.mintUrl ||
      job.unit !== input.unit ||
      job.keysetId !== input.keysetId)
  ) {
    throw new Error('seed recovery job binding is foreign')
  }
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

function importSelectableProofs(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  classified: readonly ClassifiedObservedProof[],
): number {
  const store = new DurableCustodySqliteStore(database)
  const selectable = classified.filter(({ disposition }) => disposition === 'import-selectable')
  let imported = 0
  for (const { observed } of selectable) {
    assertSelectableProof(observed.proof, input)
    const existing = store.getProof(observed.proof.scopeId, observed.proof.proofId)
    if (existing === null) {
      store.putProofCas(observed.proof, null)
      imported += 1
    } else if (!sameRecoveredProofAuthority(existing, observed.proof)) {
      throw new Error('seed recovery proof authority mismatch')
    }
    admitRecoveredRegularProofWhenTargetIsMissing(
      database,
      existing ?? observed.proof,
      input.expectedCursor.mintUrl,
      input,
    )
  }
  return imported
}

function admitRecoveredRegularProofWhenTargetIsMissing(
  database: DatabaseSync,
  proof: CustodyProofSqliteRow,
  mintUrl: string,
  input: EmergencySeedRecoveryCoCommit,
): void {
  if (
    proof.conditionId !== null ||
    proof.outcomeSetId !== null ||
    proof.productBinding !== null ||
    proof.nut07State !== 'UNSPENT' ||
    proof.selectability !== 'selectable'
  ) {
    return
  }
  const decoded = decodeCustodyProofSqliteRow(proof).proof
  admitRecoveredRegularWalletProofFromDatabase(database, {
    mintUrl,
    proof: decoded,
    asset: { kind: 'sats', baseAsset: 'sat', unit: proof.unit },
    nowMs: input.authority.observedAtMs,
  })
}

function sameRecoveredProofAuthority(
  existing: CustodyProofSqliteRow,
  recovered: CustodyProofSqliteRow,
): boolean {
  return (
    existing.proofId === recovered.proofId &&
    existing.scopeId === recovered.scopeId &&
    existing.normalizedMint === recovered.normalizedMint &&
    existing.unit === recovered.unit &&
    existing.keysetId === recovered.keysetId &&
    existing.amount === recovered.amount &&
    existing.baseAsset === recovered.baseAsset &&
    existing.conditionId === recovered.conditionId &&
    existing.outcomeSetId === recovered.outcomeSetId &&
    existing.productBinding === recovered.productBinding &&
    existing.proofFingerprint === recovered.proofFingerprint &&
    existing.curve === recovered.curve &&
    existing.signatureVerified === recovered.signatureVerified &&
    existing.dleqState === recovered.dleqState &&
    isDeepStrictEqual(existing.proofBody, recovered.proofBody)
  )
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

function countIgnoredProofs(classified: readonly ClassifiedObservedProof[]): number {
  return classified.filter(({ disposition }) => disposition === 'ignore-spent').length
}

function writeRecoveryProgress(
  database: DatabaseSync,
  input: EmergencySeedRecoveryCoCommit,
  existing: {
    readonly job: RecoveryJobRow | undefined
    readonly cursor: RecoveryCursorRow | undefined
  },
  imported: number,
  ignored: number,
  context: { readonly invocationId: string; readonly observedAtMs: number },
): void {
  const job = existing.job
  if (job === undefined) {
    insertRecoveryProgress(database, input, imported, ignored, context)
    return
  }
  updateRecoveryProgress(
    database,
    input,
    { job, cursor: existing.cursor },
    imported,
    ignored,
    context,
  )
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
         recovery_id, scope_id, keyset_id, invocation_id, disclosure_acknowledged,
         normalized_mint, unit, state, revision, imported_proofs,
         ignored_spent_proofs, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.recoveryJobId,
      input.walletScopeId,
      input.expectedCursor.keysetId,
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
         recovery_id, keyset_id, next_counter,
         trailing_empty_counters, revision, state
       ) VALUES (?, ?, ?, ?, ?, ?)`,
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
  existing: { readonly job: RecoveryJobRow; readonly cursor: RecoveryCursorRow | undefined },
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
      existing.job.revision,
    )
  const cursor =
    existing.cursor === undefined
      ? database
          .prepare(
            `INSERT INTO seed_recovery_keysets (
               recovery_id, keyset_id, next_counter,
               trailing_empty_counters, revision, state
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.recoveryJobId,
            input.expectedCursor.keysetId,
            input.nextCursor.nextCounter,
            input.nextCursor.trailingEmptyCounters,
            input.nextCursor.revision,
            input.nextCursor.state,
          )
      : database
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
