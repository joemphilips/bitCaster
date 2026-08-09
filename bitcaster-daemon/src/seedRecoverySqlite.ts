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
  type EmergencySeedRecoveryLeaseAuthority,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeId,
} from '@bitcaster-market/client-sdk/durableCustody'
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
  admitRecoveredWalletProofFromDatabase,
  advanceDaemonKeysetCounterFromDatabase,
  readExactBoundCounter,
} from './state.ts'

export interface SeedRecoveryObservedProof {
  readonly proofY: string
  readonly mintState: unknown
  readonly proof: CustodyProofSqliteRow
}

export interface SeedRecoveryJobFinalization {
  readonly recoveryId: string
  readonly walletScopeId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly disclosureAcknowledged: true
  readonly discoveryCompleted: true
  readonly authority: EmergencySeedRecoveryLeaseAuthority
}

export interface SeedRecoveryRosterInitialization {
  readonly recoveryId: string
  readonly walletScopeId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly disclosureAcknowledged: true
  readonly keysetIds: readonly string[]
  readonly authority: EmergencySeedRecoveryLeaseAuthority
}

export interface SeedRecoveryRoster {
  readonly keysetIds: readonly string[]
  readonly state: 'absent' | 'active' | 'completed'
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

  async readRecoveryRoster(input: {
    readonly recoveryId: string
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
  }): Promise<SeedRecoveryRoster> {
    const binding = { ...input }
    if (binding.walletScopeId !== this.#fence.scopeId) {
      throw new Error('seed recovery roster scope is foreign')
    }
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => {
        assertNoRecoveryOwnerBlocker(database, binding.walletScopeId)
        const job = readRecoveryJob(database, binding.recoveryId)
        assertRecoveryJobBinding(job, binding)
        return {
          keysetIds: readRecoveryKeysetIds(database, binding.recoveryId),
          state: job === undefined ? 'absent' : job.state === 'completed' ? 'completed' : 'active',
        }
      },
    )
  }

  async initializeRecoveryRoster(raw: SeedRecoveryRosterInitialization): Promise<void> {
    const input = validateRecoveryRosterInitialization(raw)
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => this.#initializeRecoveryRosterInTransaction(database, input),
      { injectFault: this.#injectFault },
    )
  }

  async claimRecoveryScanStart(raw: SeedRecoveryRosterInitialization): Promise<number> {
    const input = validateRecoveryRosterInitialization(raw)
    if (input.keysetIds.length === 0) return 0
    return withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => this.#claimRecoveryScanStartInTransaction(database, input),
      { injectFault: this.#injectFault },
    )
  }

  async finalizeRecoveryJob(raw: SeedRecoveryJobFinalization): Promise<void> {
    const input = validateRecoveryJobFinalization(raw)
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => this.#finalizeRecoveryJobInTransaction(database, input),
      { injectFault: this.#injectFault },
    )
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
        assertRecoveryChildAccess(job, row)
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

  async readRecoveryCounterHighWaterMarks(input: {
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
  }): Promise<ReadonlyMap<string, number>> {
    const { walletScopeId, mintUrl, unit } = input
    if (walletScopeId !== this.#fence.scopeId) {
      throw new Error('seed recovery counter scope is foreign')
    }
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#fence,
      this.#observedAtMs,
      (database) => {
        assertNoRecoveryOwnerBlocker(database, walletScopeId)
        const rows = database
          .prepare(
            `SELECT keyset_id AS keysetId FROM target_keyset_counters
             WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
             UNION
             SELECT keyset_id AS keysetId FROM custody_keyset_counters
             WHERE scope_id = ? AND normalized_mint = ? AND unit = ?`,
          )
          .all(walletScopeId, mintUrl, unit, walletScopeId, mintUrl, unit) as Array<{
          keysetId: string
        }>
        return new Map(
          rows.map(({ keysetId }) => [
            keysetId,
            readExactBoundCounter(database, walletScopeId, keysetId, {
              normalizedMint: mintUrl,
              unit,
            }),
          ]),
        )
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

  #initializeRecoveryRosterInTransaction(
    database: DatabaseSync,
    input: SeedRecoveryRosterInitialization,
  ): void {
    assertRecoveryAuthority(input, this.#fence, this.#observedAtMs)
    assertNoRecoveryOwnerBlocker(database, input.walletScopeId)
    const existing = readRecoveryJob(database, input.recoveryId)
    assertRecoveryJobBinding(existing, input)
    if (existing?.state === 'completed') {
      assertExactRecoveryRoster(database, input)
      return
    }
    if (existing === undefined) insertActiveRecoveryJob(database, input, this.#invocationId)
    let inserted = 0
    for (const keysetId of input.keysetIds) {
      inserted += Number(
        database
          .prepare(
            `INSERT OR IGNORE INTO seed_recovery_keysets (
               recovery_id, keyset_id, next_counter,
               trailing_empty_counters, revision, state
             ) VALUES (?, ?, 0, 0, 0, 'active')`,
          )
          .run(input.recoveryId, keysetId).changes,
      )
    }
    if (existing !== undefined && inserted > 0) {
      database
        .prepare(
          `UPDATE seed_recovery_jobs SET revision = revision + 1, updated_at_ms = ?
           WHERE recovery_id = ? AND state = 'active'`,
        )
        .run(this.#observedAtMs, input.recoveryId)
    }
    assertExactRecoveryRoster(database, input)
  }

  #claimRecoveryScanStartInTransaction(
    database: DatabaseSync,
    input: SeedRecoveryRosterInitialization,
  ): number {
    assertRecoveryAuthority(input, this.#fence, this.#observedAtMs)
    assertNoRecoveryOwnerBlocker(database, input.walletScopeId)
    const job = readRecoveryJob(database, input.recoveryId)
    assertRecoveryJobBinding(job, input)
    if (job === undefined) throw new Error('seed recovery roster is absent')
    assertExactRecoveryRoster(database, input)
    const start = job.scanOffset % input.keysetIds.length
    if (job.state === 'completed') return start
    const next = (start + 4) % input.keysetIds.length
    const result = database
      .prepare(
        `UPDATE seed_recovery_jobs SET scan_offset = ?, revision = revision + 1,
           updated_at_ms = ? WHERE recovery_id = ? AND state = 'active' AND revision = ?`,
      )
      .run(next, this.#observedAtMs, input.recoveryId, job.revision)
    if (result.changes !== 1) throw new Error('seed recovery scan claim CAS lost')
    return start
  }

  #finalizeRecoveryJobInTransaction(
    database: DatabaseSync,
    input: SeedRecoveryJobFinalization,
  ): void {
    assertRecoveryAuthority(input, this.#fence, this.#observedAtMs)
    assertNoRecoveryOwnerBlocker(database, input.walletScopeId)
    const job = readRecoveryJob(database, input.recoveryId)
    assertRecoveryJobBinding(job, input)
    if (job === undefined) {
      insertEmptyCompletedRecoveryJob(database, input, this.#invocationId, this.#observedAtMs)
      return
    }
    assertRecoveryJobCanFinalize(database, job, input)
    if (job.state === 'completed') return
    const result = database
      .prepare(
        `UPDATE seed_recovery_jobs SET state = 'completed', revision = revision + 1,
           updated_at_ms = ? WHERE recovery_id = ? AND state = 'active' AND revision = ?`,
      )
      .run(this.#observedAtMs, input.recoveryId, job.revision)
    if (result.changes !== 1) throw new Error('seed recovery job finalization CAS lost')
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
  readonly disclosureAcknowledged: number
  readonly state: string
  readonly scanOffset: number
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
  input: { readonly authority: EmergencySeedRecoveryLeaseAuthority },
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
  if (cursor !== undefined && job === undefined) {
    throw new Error('seed recovery cursor has no job binding')
  }
  if (job?.state === 'completed') {
    throw new Error('seed recovery job is already completed')
  }
  return { job, cursor }
}

function readRecoveryJob(database: DatabaseSync, recoveryId: string): RecoveryJobRow | undefined {
  return database
    .prepare(
      `SELECT scope_id AS scopeId, normalized_mint AS mintUrl, unit,
          disclosure_acknowledged AS disclosureAcknowledged, state,
          scan_offset AS scanOffset, revision
       FROM seed_recovery_jobs WHERE recovery_id = ?`,
    )
    .get(recoveryId) as RecoveryJobRow | undefined
}

function readRecoveryKeysetIds(database: DatabaseSync, recoveryId: string): readonly string[] {
  return (
    database
      .prepare(
        `SELECT keyset_id AS keysetId FROM seed_recovery_keysets
         WHERE recovery_id = ? ORDER BY keyset_id`,
      )
      .all(recoveryId) as Array<{ keysetId: string }>
  ).map(({ keysetId }) => keysetId)
}

function assertExactRecoveryRoster(
  database: DatabaseSync,
  input: SeedRecoveryRosterInitialization,
): void {
  const actual = readRecoveryKeysetIds(database, input.recoveryId)
  if (!isDeepStrictEqual(actual, input.keysetIds)) {
    throw new Error('seed recovery roster is inconsistent')
  }
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
  },
): void {
  if (
    job !== undefined &&
    (job.scopeId !== input.walletScopeId ||
      job.mintUrl !== input.mintUrl ||
      job.unit !== input.unit ||
      job.disclosureAcknowledged !== 1)
  ) {
    throw new Error('seed recovery job binding is foreign')
  }
}

function assertRecoveryChildAccess(
  job: RecoveryJobRow | undefined,
  cursor: RecoveryCursorRow | undefined,
): void {
  if (job?.state !== 'completed') return
  if (cursor?.state === 'completed') return
  throw new Error('completed seed recovery job cannot acquire a keyset')
}

function validateRecoveryJobFinalization(
  input: SeedRecoveryJobFinalization,
): SeedRecoveryJobFinalization {
  const value = input as unknown as Record<string, unknown>
  const fields = [
    'recoveryId',
    'walletScopeId',
    'mintUrl',
    'unit',
    'disclosureAcknowledged',
    'discoveryCompleted',
    'authority',
  ]
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof input.recoveryId !== 'string' ||
    input.recoveryId.length === 0 ||
    input.recoveryId.length > 1024 ||
    input.disclosureAcknowledged !== true ||
    input.discoveryCompleted !== true ||
    (input.unit !== 'sat' && input.unit !== 'msat')
  ) {
    throw new Error('seed recovery finalization input is invalid')
  }
  const authority = input.authority as unknown as Record<string, unknown>
  const authorityFields = [
    'walletScopeId',
    'incarnationId',
    'fencingEpoch',
    'observedAtMs',
    'leaseExpiresAtMs',
    'effectiveClockHighWaterMarkMs',
  ]
  if (
    typeof authority !== 'object' ||
    authority === null ||
    Array.isArray(authority) ||
    Object.getPrototypeOf(authority) !== Object.prototype ||
    Object.keys(authority).length !== authorityFields.length ||
    Object.keys(authority).some((key) => !authorityFields.includes(key))
  ) {
    throw new Error('seed recovery finalization authority is invalid')
  }
  decodeDurableCustodyScopeId(input.walletScopeId)
  decodeCanonicalMintOrigin(input.mintUrl)
  return Object.freeze({
    recoveryId: input.recoveryId,
    walletScopeId: input.walletScopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    disclosureAcknowledged: true,
    discoveryCompleted: true,
    authority: Object.freeze({ ...input.authority }),
  })
}

function validateRecoveryRosterInitialization(
  input: SeedRecoveryRosterInitialization,
): SeedRecoveryRosterInitialization {
  const value = input as unknown as Record<string, unknown>
  const fields = [
    'recoveryId',
    'walletScopeId',
    'mintUrl',
    'unit',
    'disclosureAcknowledged',
    'keysetIds',
    'authority',
  ]
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !Array.isArray(input.keysetIds) ||
    input.keysetIds.length > 2_048
  ) {
    throw new Error('seed recovery roster input is invalid')
  }
  const keysetIds = [...input.keysetIds].sort()
  if (
    new Set(keysetIds).size !== keysetIds.length ||
    keysetIds.some((keysetId) => !/^01[0-9a-f]{64}$/.test(keysetId))
  ) {
    throw new Error('seed recovery roster keysets are invalid')
  }
  const base = validateRecoveryJobFinalization({
    recoveryId: input.recoveryId,
    walletScopeId: input.walletScopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    disclosureAcknowledged: input.disclosureAcknowledged,
    discoveryCompleted: true,
    authority: input.authority,
  })
  return Object.freeze({
    recoveryId: base.recoveryId,
    walletScopeId: base.walletScopeId,
    mintUrl: base.mintUrl,
    unit: base.unit,
    disclosureAcknowledged: true,
    keysetIds: Object.freeze(keysetIds),
    authority: base.authority,
  })
}

function assertRecoveryJobCanFinalize(
  database: DatabaseSync,
  job: RecoveryJobRow,
  input: SeedRecoveryJobFinalization,
): void {
  const active = database
    .prepare(
      `SELECT 1 FROM seed_recovery_keysets
       WHERE recovery_id = ? AND state = 'active' LIMIT 1`,
    )
    .get(input.recoveryId)
  if (active !== undefined) throw new Error('seed recovery job has active keysets')
  if (job.disclosureAcknowledged !== 1) {
    throw new Error('seed recovery disclosure acknowledgement is foreign')
  }
}

function insertEmptyCompletedRecoveryJob(
  database: DatabaseSync,
  input: SeedRecoveryJobFinalization,
  invocationId: string,
  observedAtMs: number,
): void {
  database
    .prepare(
      `INSERT INTO seed_recovery_jobs (
         recovery_id, scope_id, invocation_id, disclosure_acknowledged,
         normalized_mint, unit, state, scan_offset, revision, imported_proofs,
         ignored_spent_proofs, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, 'completed', 0, 1, 0, 0, ?, ?)`,
    )
    .run(
      input.recoveryId,
      input.walletScopeId,
      invocationId,
      input.mintUrl,
      input.unit,
      observedAtMs,
      observedAtMs,
    )
}

function insertActiveRecoveryJob(
  database: DatabaseSync,
  input: SeedRecoveryRosterInitialization,
  invocationId: string,
): void {
  database
    .prepare(
      `INSERT INTO seed_recovery_jobs (
         recovery_id, scope_id, invocation_id, disclosure_acknowledged,
         normalized_mint, unit, state, scan_offset, revision, imported_proofs,
         ignored_spent_proofs, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, 'active', 0, 0, 0, 0, ?, ?)`,
    )
    .run(
      input.recoveryId,
      input.walletScopeId,
      invocationId,
      input.mintUrl,
      input.unit,
      input.authority.observedAtMs,
      input.authority.observedAtMs,
    )
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
    admitRecoveredProofWhenTargetIsMissing(
      database,
      existing ?? observed.proof,
      input.expectedCursor.mintUrl,
      input,
    )
  }
  return imported
}

function admitRecoveredProofWhenTargetIsMissing(
  database: DatabaseSync,
  proof: CustodyProofSqliteRow,
  mintUrl: string,
  input: EmergencySeedRecoveryCoCommit,
): void {
  if (
    proof.productBinding !== null ||
    proof.nut07State !== 'UNSPENT' ||
    proof.selectability !== 'selectable'
  ) {
    return
  }
  const decoded = decodeCustodyProofSqliteRow(proof).proof
  admitRecoveredWalletProofFromDatabase(database, {
    mintUrl,
    proof: decoded,
    asset: recoveredStoredProofAsset(proof),
    nowMs: input.authority.observedAtMs,
  })
}

function recoveredStoredProofAsset(proof: CustodyProofSqliteRow) {
  if (proof.conditionId === null && proof.outcomeSetId === null) {
    return { kind: 'sats' as const, baseAsset: 'sat' as const, unit: proof.unit }
  }
  if (proof.conditionId === null || proof.outcomeSetId === null || proof.unit !== 'msat') {
    throw new Error('seed recovery conditional proof metadata is invalid')
  }
  return {
    kind: 'Outcome' as const,
    conditionId: proof.conditionId,
    outcomeSetId: proof.outcomeSetId,
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
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
         recovery_id, scope_id, invocation_id, disclosure_acknowledged,
         normalized_mint, unit, state, scan_offset, revision, imported_proofs,
         ignored_spent_proofs, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, 'active', 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      input.recoveryJobId,
      input.walletScopeId,
      context.invocationId,
      input.expectedCursor.mintUrl,
      input.expectedCursor.unit,
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
      'active',
      existing.job.revision + 1,
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
