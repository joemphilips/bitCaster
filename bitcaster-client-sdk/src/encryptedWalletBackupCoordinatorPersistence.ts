import {
  decodeEncryptedWalletBackupUploadCursor,
  encodeEncryptedWalletBackupUploadCursor,
  type PersistedEncryptedWalletBackupUploadCursor,
} from './encryptedWalletBackupUploadPlanningPersistence.ts'
import type { EncryptedWalletBackupSyncAttemptRecord } from './encryptedWalletBackup.ts'
import type {
  EncryptedWalletBackupActiveUploadAttemptRecord,
  EncryptedWalletBackupBoundedUploadBatchCommit,
  EncryptedWalletBackupCoordinatorStore,
  EncryptedWalletBackupUploadAttemptCursorStore,
  EncryptedWalletBackupUploadBatchRecord,
  EncryptedWalletBackupUploadAttemptCursorReservation,
  EncryptedWalletBackupUploadBatchReservation,
} from './encryptedWalletBackupSync.ts'

interface CoordinatorRecordKernel {
  readonly decodeActiveUploadAttemptRecord: (
    value: unknown,
  ) => EncryptedWalletBackupActiveUploadAttemptRecord
  readonly decodeCoordinatorCasRecord: (value: unknown) => EncryptedWalletBackupSyncAttemptRecord
  readonly decodeExactLinkedCasAttempt: (
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
    rows: unknown,
  ) => EncryptedWalletBackupSyncAttemptRecord
  readonly decodeUploadBatchRecord: (value: unknown) => EncryptedWalletBackupUploadBatchRecord
  readonly equalActiveUploadAttempt: (
    left: EncryptedWalletBackupActiveUploadAttemptRecord,
    right: EncryptedWalletBackupActiveUploadAttemptRecord,
  ) => boolean
  readonly equalCoordinatorCasIdentity: (
    left: EncryptedWalletBackupSyncAttemptRecord,
    right: EncryptedWalletBackupSyncAttemptRecord,
  ) => boolean
  readonly equalCoordinatorCasRecord: (
    left: EncryptedWalletBackupSyncAttemptRecord,
    right: EncryptedWalletBackupSyncAttemptRecord,
  ) => boolean
  readonly equalUploadBatch: (
    left: EncryptedWalletBackupUploadBatchRecord,
    right: EncryptedWalletBackupUploadBatchRecord,
  ) => boolean
  readonly freezeUploadBatch: (
    value: EncryptedWalletBackupUploadBatchRecord,
  ) => EncryptedWalletBackupUploadBatchRecord
  readonly validateAggregatePartition: (
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
    rows: readonly EncryptedWalletBackupUploadBatchRecord[],
    state: 'abort-uncertain' | 'abandoned' | 'finalized',
  ) => void
  readonly validateFinalizedTargetDelta: (
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
    rows: readonly EncryptedWalletBackupUploadBatchRecord[],
  ) => void
  readonly validateUploadBatchTransition: (
    expected: EncryptedWalletBackupUploadBatchRecord,
    next: EncryptedWalletBackupUploadBatchRecord,
  ) => void
}

const TRANSACTION_KERNELS = new WeakMap<object, CoordinatorRecordKernel>()
type KernelTransaction = EncryptedWalletBackupCoordinatorPersistenceTransaction

async function run<T>(
  port: EncryptedWalletBackupCoordinatorPersistencePort,
  records: CoordinatorRecordKernel,
  reservation: EncryptedWalletBackupCoordinatorPersistenceReservation,
  operation: (transaction: KernelTransaction) => Promise<T>,
): Promise<T> {
  return port.transaction(reservation, async (transaction) => {
    TRANSACTION_KERNELS.set(transaction, records)
    try {
      return await operation(transaction)
    } finally {
      TRANSACTION_KERNELS.delete(transaction)
    }
  })
}

function kernel(
  transaction: EncryptedWalletBackupCoordinatorPersistenceTransaction,
): CoordinatorRecordKernel {
  const records = TRANSACTION_KERNELS.get(transaction)
  if (records === undefined) throw new Error('backup coordinator transaction kernel is absent')
  return records
}

/**
 * Storage-only transaction port for the upload coordinator.
 *
 * The adapter must supply one timestamp for each transaction. A Dexie adapter
 * may use browser wall-clock time. It must bound attempt scope reads to two,
 * batch reads to 64, and linked CAS reads to two. It must roll back when the
 * transaction callback throws. The SDK owns every lifecycle decision.
 */
export interface EncryptedWalletBackupCoordinatorPersistencePort {
  transaction<T>(
    reservation: EncryptedWalletBackupCoordinatorPersistenceReservation,
    operation: (transaction: EncryptedWalletBackupCoordinatorPersistenceTransaction) => Promise<T>,
  ): Promise<T>
}

export interface EncryptedWalletBackupCoordinatorPersistenceReservation {
  readonly readRows: number
  readonly writeRows: number
  readonly readBytes: number
  readonly writeBytes: number
}

export interface EncryptedWalletBackupCoordinatorPersistenceTransaction {
  readonly nowUnixMilliseconds: number
  readAttempt(attemptId: string): Promise<unknown | null>
  readAttemptsForScope(
    input: Readonly<{ realm: string; vaultId: string; maximumRows: 2 }>,
  ): Promise<readonly unknown[]>
  readCursor(attemptId: string): Promise<Uint8Array | null>
  readBatch(batchId: string): Promise<unknown | null>
  readBatchesForAttempt(
    input: Readonly<{ attemptId: string; maximumRows: 64 }>,
  ): Promise<readonly unknown[]>
  readCasAttempt(attemptId: string): Promise<unknown | null>
  readCasAttemptsForUploadAttempt(
    input: Readonly<{ uploadAttemptId: string; maximumRows: 2 }>,
  ): Promise<readonly unknown[]>
  insertAttempt(record: EncryptedWalletBackupActiveUploadAttemptRecord): Promise<void>
  replaceAttempt(
    expected: EncryptedWalletBackupActiveUploadAttemptRecord,
    next: EncryptedWalletBackupActiveUploadAttemptRecord,
  ): Promise<void>
  deleteAttempt(expected: EncryptedWalletBackupActiveUploadAttemptRecord): Promise<void>
  insertCursor(input: Readonly<{ attemptId: string; canonicalCursor: Uint8Array }>): Promise<void>
  replaceCursor(
    input: Readonly<{
      attemptId: string
      expectedCanonicalCursor: Uint8Array
      nextCanonicalCursor: Uint8Array
    }>,
  ): Promise<void>
  deleteCursor(
    input: Readonly<{ attemptId: string; expectedCanonicalCursor: Uint8Array }>,
  ): Promise<void>
  insertBatch(record: EncryptedWalletBackupUploadBatchRecord): Promise<void>
  replaceBatch(
    expected: EncryptedWalletBackupUploadBatchRecord,
    next: EncryptedWalletBackupUploadBatchRecord,
  ): Promise<void>
  deleteBatch(expected: EncryptedWalletBackupUploadBatchRecord): Promise<void>
  insertCasAttempt(record: EncryptedWalletBackupSyncAttemptRecord): Promise<void>
  replaceCasAttempt(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
  ): Promise<void>
  deleteCasAttempt(expected: EncryptedWalletBackupSyncAttemptRecord): Promise<void>
}

export function createEncryptedWalletBackupCoordinatorStoreInternal(
  rawPort: EncryptedWalletBackupCoordinatorPersistencePort,
  records: CoordinatorRecordKernel,
): EncryptedWalletBackupUploadAttemptCursorStore & EncryptedWalletBackupCoordinatorStore {
  return new EncryptedWalletBackupCoordinatorStoreKernel(rawPort, records)
}

class EncryptedWalletBackupCoordinatorStoreKernel
  implements EncryptedWalletBackupUploadAttemptCursorStore, EncryptedWalletBackupCoordinatorStore
{
  readonly #rawPort: EncryptedWalletBackupCoordinatorPersistencePort
  readonly #records: CoordinatorRecordKernel

  constructor(
    rawPort: EncryptedWalletBackupCoordinatorPersistencePort,
    records: CoordinatorRecordKernel,
  ) {
    this.#rawPort = rawPort
    this.#records = records
  }

  validateUploadAttemptClaim<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (current: EncryptedWalletBackupActiveUploadAttemptRecord) => T,
  ): Promise<T> {
    return this.#control(async (tx) =>
      invoke(read, cloneClaim(await claimCurrent(tx, claim, LIVE_LIFECYCLES))),
    )
  }

  readUploadBatch<T>(
    batchId: string,
    read: (committed: EncryptedWalletBackupUploadBatchRecord) => T,
  ): Promise<T> {
    return this.#control(async (tx) => invoke(read, cloneBatch(await readBatch(tx, batchId))))
  }

  claimUploadBatchExecution<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    batch: EncryptedWalletBackupUploadBatchRecord,
    leaseDurationMilliseconds: number,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batch: EncryptedWalletBackupUploadBatchRecord
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['active'])
      const current = await exactBatch(tx, batch)
      if (!isExecutableBatch(current, tx.nowUnixMilliseconds))
        throw new Error('backup upload batch is not executable')
      const next = this.#records.freezeUploadBatch({
        ...current,
        state: 'put-uncertain',
        executionEpoch: current.executionEpoch + 1,
        executionLeaseExpiresAtUnixMilliseconds: tx.nowUnixMilliseconds + leaseDurationMilliseconds,
      })
      await tx.replaceBatch(current, next)
      return invoke(commit, { attempt: cloneClaim(attempt), batch: cloneBatch(next) })
    })
  }

  validateUploadBatchExecution<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    batch: EncryptedWalletBackupUploadBatchRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batch: EncryptedWalletBackupUploadBatchRecord
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['active'])
      const current = await exactBatch(tx, batch)
      if (!hasActiveExecutionLease(current, tx.nowUnixMilliseconds))
        throw new Error('backup upload execution lease expired')
      return invoke(read, { attempt: cloneClaim(attempt), batch: cloneBatch(current) })
    })
  }

  transitionUploadBatch<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupUploadBatchRecord,
    next: EncryptedWalletBackupUploadBatchRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batch: EncryptedWalletBackupUploadBatchRecord
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const lifecycles =
        next.state === 'abandoned' ? (['abort-uncertain'] as const) : (['active'] as const)
      const attempt = await claimCurrent(tx, claim, lifecycles)
      const current = await exactBatch(tx, expected)
      const committed = this.#records.decodeUploadBatchRecord(next)
      this.#records.validateUploadBatchTransition(current, committed)
      const aggregate =
        committed.state === 'acknowledged'
          ? cloneClaim({ ...attempt, activeBatchId: null })
          : attempt
      await tx.replaceBatch(current, committed)
      if (!this.#records.equalActiveUploadAttempt(attempt, aggregate))
        await tx.replaceAttempt(attempt, aggregate)
      return invoke(commit, { attempt: cloneClaim(aggregate), batch: cloneBatch(committed) })
    })
  }

  fenceUploadAttemptForAbort<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['active'])
      const rows = await partition(tx, attempt)
      if (rows.some((row) => row.state === 'finalized'))
        throw new Error('backup upload attempt is finalized')
      const nextRows = rows.map(abortUncertainBatch)
      const aggregate = cloneClaim({
        ...attempt,
        lifecycle: 'abort-uncertain',
        activeBatchId: null,
      })
      await replaceBatches(tx, rows, nextRows)
      await tx.replaceAttempt(attempt, aggregate)
      return invoke(commit, { attempt: cloneClaim(aggregate), batches: nextRows.map(cloneBatch) })
    })
  }

  completeUploadAttemptAbort<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['abort-uncertain'])
      const cursor = await cursorForAttempt(tx, attempt.attemptId)
      const rows = await partition(tx, attempt)
      const nextRows = rows.map(abandonedBatch)
      const aggregate = cloneClaim({ ...attempt, lifecycle: 'abandoned', activeBatchId: null })
      const value = invoke(commit, {
        attempt: cloneClaim(aggregate),
        batches: nextRows.map(cloneBatch),
      })
      await deletePartition(tx, attempt, cursor, rows, [])
      return value
    })
  }

  sealActiveUploadAttemptAndCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
    seal: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
        cursor: Uint8Array | null
      }>,
    ) => T,
  ): Promise<T> {
    return this.#attempt(input.reservation, async (tx) => this.#sealAttempt(tx, input, seal))
  }

  claimActiveUploadAttemptAndCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[0],
    claim: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
        cursor: Uint8Array | null
      }>,
    ) => T,
  ): Promise<T> {
    return this.#attempt(input.reservation, async (tx) => this.#claimAttempt(tx, input, claim))
  }

  sealUploadBatchAndAdvanceCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealUploadBatchAndAdvanceCursor']
    >[0],
    seal: (committed: EncryptedWalletBackupBoundedUploadBatchCommit) => T,
  ): Promise<T> {
    return this.#batch(input.reservation, async (tx) => sealBatchAndCursor(tx, input, seal))
  }

  sealOrReadLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    candidate: EncryptedWalletBackupSyncAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => sealLinkedCas(tx, claim, candidate, commit))
  }

  readLinkedCasAttempts<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['cas-journaled', 'fork-cleanup-uncertain'])
      return invoke(read, {
        attempt: cloneClaim(attempt),
        casAttempts: (await linkedCas(tx, attempt)).map(cloneCas),
      })
    })
  }

  validateLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => {
      const attempt = await claimCurrent(tx, claim, ['cas-journaled'])
      await exactLinkedCas(tx, attempt, expected)
      return invoke(read, {
        attempt: cloneClaim(attempt),
        casAttempts: (await linkedCas(tx, attempt)).map(cloneCas),
      })
    })
  }

  transitionLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    lifecycle: 'cas-journaled' | 'fork-cleanup-uncertain',
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) =>
      transitionLinkedCas(tx, claim, expected, next, lifecycle, commit),
    )
  }

  completeLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) => completeLinkedCas(tx, claim, expected, next, commit))
  }

  exhaustLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    delayMilliseconds: number,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) =>
      transitionLinkedCas(
        tx,
        claim,
        expected,
        this.#records.decodeCoordinatorCasRecord({
          ...next,
          retryNotBeforeUnixMilliseconds: tx.nowUnixMilliseconds + delayMilliseconds,
        }),
        'cas-journaled',
        commit,
      ),
    )
  }

  resumeLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<Readonly<{ state: 'not-ready' }> | Readonly<{ state: 'committed'; value: T }>> {
    return this.#control(async (tx) => {
      if (
        expected.retryNotBeforeUnixMilliseconds === null ||
        tx.nowUnixMilliseconds < expected.retryNotBeforeUnixMilliseconds
      )
        return Object.freeze({ state: 'not-ready' as const })
      return Object.freeze({
        state: 'committed' as const,
        value: await transitionLinkedCas(tx, claim, expected, next, 'cas-journaled', commit),
      })
    })
  }

  completeForkCleanup<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expectedCasAttempt: EncryptedWalletBackupSyncAttemptRecord,
    outcome: 'abandoned' | 'already-finalized',
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T> {
    return this.#control(async (tx) =>
      completeForkCleanup(tx, claim, expectedCasAttempt, outcome, commit),
    )
  }

  #control<T>(operation: (transaction: KernelTransaction) => Promise<T>): Promise<T> {
    return run(this.#rawPort, this.#records, CONTROL_RESERVATION, operation)
  }
  #attempt<T>(
    reservation: EncryptedWalletBackupUploadAttemptCursorReservation,
    operation: (transaction: KernelTransaction) => Promise<T>,
  ): Promise<T> {
    return run(this.#rawPort, this.#records, attemptReservation(reservation), operation)
  }
  #batch<T>(
    reservation: EncryptedWalletBackupUploadBatchReservation,
    operation: (transaction: KernelTransaction) => Promise<T>,
  ): Promise<T> {
    return run(this.#rawPort, this.#records, batchReservation(reservation), operation)
  }

  async #sealAttempt<T>(
    tx: KernelTransaction,
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
    seal: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
        cursor: Uint8Array | null
      }>,
    ) => T,
  ): Promise<T> {
    const existingRaw = await tx.readAttempt(input.candidate.attemptId)
    if (existingRaw !== null)
      return sealInitialRetry(
        tx,
        input,
        seal,
        this.#records.decodeActiveUploadAttemptRecord(existingRaw),
      )
    const scoped = await scopeAttempts(tx, input.candidate.realm, input.candidate.vaultId)
    if (scoped.some(isLiveAttempt)) throw new Error('live backup upload attempt already exists')
    const attempt = this.#records.decodeActiveUploadAttemptRecord({
      ...input.candidate,
      ownerEpoch: 1,
      leaseExpiresAtUnixMilliseconds: tx.nowUnixMilliseconds + input.leaseDurationMilliseconds,
      batchIds: [],
      activeBatchId: null,
      casAttemptId: null,
      lifecycle: 'active',
    })
    const cursor = strictCursor(input.initialCursor)
    await tx.insertAttempt(attempt)
    await tx.insertCursor({
      attemptId: attempt.attemptId,
      canonicalCursor: input.initialCursor.slice(),
    })
    return invoke(seal, {
      attempt: cloneClaim(attempt),
      cursor: encodeEncryptedWalletBackupUploadCursor(cursor),
    })
  }

  async #claimAttempt<T>(
    tx: KernelTransaction,
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[0],
    claim: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
        cursor: Uint8Array | null
      }>,
    ) => T,
  ): Promise<T> {
    const matches = (await scopeAttempts(tx, input.realm, input.vaultId)).filter(isLiveAttempt)
    if (matches.length > 1) throw new Error('multiple live backup upload attempts')
    const prior = matches[0]
    if (
      prior === undefined ||
      (prior.ownerId !== input.ownerId &&
        tx.nowUnixMilliseconds < prior.leaseExpiresAtUnixMilliseconds)
    )
      return invoke(claim, { attempt: null, cursor: null })
    const cursor = await cursorForAttempt(tx, prior.attemptId)
    const next = this.#records.decodeActiveUploadAttemptRecord({
      ...prior,
      ownerId: input.ownerId,
      ownerEpoch: prior.ownerEpoch + 1,
      leaseExpiresAtUnixMilliseconds: tx.nowUnixMilliseconds + input.leaseDurationMilliseconds,
    })
    await tx.replaceAttempt(prior, next)
    return invoke(claim, { attempt: cloneClaim(next), cursor })
  }
}

const LIVE_LIFECYCLES = [
  'active',
  'abort-uncertain',
  'cas-journaled',
  'fork-cleanup-uncertain',
] as const

/**
 * Control paths may scan the complete 64-row batch partition and delete it in
 * the same transaction. One unacknowledged batch can retain its 1 MiB page.
 * Dexie stores batch authorities once on the aggregate, not per row.
 */
const CONTROL_RESERVATION = Object.freeze({
  readRows: 68,
  writeRows: 67,
  readBytes: 1_048_576,
  writeBytes: 1_048_576,
})

function attemptReservation(
  value: EncryptedWalletBackupUploadAttemptCursorReservation,
): EncryptedWalletBackupCoordinatorPersistenceReservation {
  if (
    value.readRows !== 2 ||
    value.writeRows !== 2 ||
    value.readBytes !== 1_048_576 ||
    value.writeBytes !== 1_048_576
  )
    throw new Error('bounded upload attempt reservation is invalid')
  return value
}

function batchReservation(
  value: EncryptedWalletBackupUploadBatchReservation,
): EncryptedWalletBackupCoordinatorPersistenceReservation {
  if (
    value.readRows !== 3 ||
    value.writeRows !== 3 ||
    value.readBytes !== 1_048_576 ||
    value.writeBytes !== 1_048_576
  )
    throw new Error('bounded upload batch reservation is invalid')
  return value
}

function isLiveAttempt(record: EncryptedWalletBackupActiveUploadAttemptRecord): boolean {
  return LIVE_LIFECYCLES.includes(record.lifecycle as (typeof LIVE_LIFECYCLES)[number])
}

function isExecutableBatch(
  batch: EncryptedWalletBackupUploadBatchRecord,
  nowUnixMilliseconds: number,
): boolean {
  return (
    (batch.state === 'sealed' || batch.state === 'put-uncertain') &&
    (batch.executionLeaseExpiresAtUnixMilliseconds === null ||
      nowUnixMilliseconds >= batch.executionLeaseExpiresAtUnixMilliseconds)
  )
}

function hasActiveExecutionLease(
  batch: EncryptedWalletBackupUploadBatchRecord,
  nowUnixMilliseconds: number,
): boolean {
  return (
    batch.state === 'put-uncertain' &&
    batch.executionLeaseExpiresAtUnixMilliseconds !== null &&
    nowUnixMilliseconds < batch.executionLeaseExpiresAtUnixMilliseconds
  )
}
function invoke<T, TValue>(callback: (value: TValue) => T, value: TValue): T {
  const result = callback(value)
  if (isThenable(result)) throw new Error('backup coordinator callback must be synchronous')
  return result
}
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
function cloneClaim(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
): EncryptedWalletBackupActiveUploadAttemptRecord {
  return structuredClone(record)
}
function cloneBatch(
  record: EncryptedWalletBackupUploadBatchRecord,
): EncryptedWalletBackupUploadBatchRecord {
  return structuredClone(record)
}
function cloneCas(
  record: EncryptedWalletBackupSyncAttemptRecord,
): EncryptedWalletBackupSyncAttemptRecord {
  return structuredClone(record)
}
function strictCursor(value: Uint8Array): PersistedEncryptedWalletBackupUploadCursor {
  const decoded = decodeEncryptedWalletBackupUploadCursor(value)
  const encoded = encodeEncryptedWalletBackupUploadCursor(decoded)
  if (!equalBytes(encoded, value)) throw new Error('bounded upload cursor is not canonical')
  return decoded
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

async function scopeAttempts(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  realm: string,
  vaultId: string,
): Promise<EncryptedWalletBackupActiveUploadAttemptRecord[]> {
  const rows = await tx.readAttemptsForScope({ realm, vaultId, maximumRows: 2 })
  if (rows.length > 2) throw new Error('backup upload attempt scope exceeds its bound')
  return rows.map(kernel(tx).decodeActiveUploadAttemptRecord)
}
async function readBatch(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  batchId: string,
): Promise<EncryptedWalletBackupUploadBatchRecord> {
  const raw = await tx.readBatch(batchId)
  if (raw === null) throw new Error('missing upload batch')
  return kernel(tx).decodeUploadBatchRecord(raw)
}
async function exactBatch(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  expected: EncryptedWalletBackupUploadBatchRecord,
): Promise<EncryptedWalletBackupUploadBatchRecord> {
  const current = await readBatch(tx, expected.batchId)
  if (!kernel(tx).equalUploadBatch(current, expected))
    throw new Error('backup upload batch is stale')
  return current
}
async function cursorForAttempt(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  attemptId: string,
): Promise<Uint8Array> {
  const row = await tx.readCursor(attemptId)
  if (row === null) throw new Error('bounded upload cursor is absent')
  strictCursor(row)
  return row.slice()
}
async function partition(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
): Promise<EncryptedWalletBackupUploadBatchRecord[]> {
  const rows = await tx.readBatchesForAttempt({ attemptId: attempt.attemptId, maximumRows: 64 })
  if (rows.length > 64) throw new Error('backup upload partition exceeds its bound')
  const decoded = rows.map(kernel(tx).decodeUploadBatchRecord)
  if (
    decoded.some(
      (row) =>
        row.attemptId !== attempt.attemptId ||
        row.targetManifestDigest !== attempt.targetManifestDigest,
    )
  )
    throw new Error('backup upload partition is foreign')
  return decoded
}
async function linkedCas(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
): Promise<EncryptedWalletBackupSyncAttemptRecord[]> {
  const rows = await tx.readCasAttemptsForUploadAttempt({
    uploadAttemptId: attempt.attemptId,
    maximumRows: 2,
  })
  if (rows.length > 2) throw new Error('linked CAS partition exceeds its bound')
  return rows.map(kernel(tx).decodeCoordinatorCasRecord)
}
async function exactLinkedCas(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  expected: EncryptedWalletBackupSyncAttemptRecord,
): Promise<EncryptedWalletBackupSyncAttemptRecord> {
  const rows = await linkedCas(tx, attempt)
  const current = kernel(tx).decodeExactLinkedCasAttempt(attempt, rows)
  if (!kernel(tx).equalCoordinatorCasRecord(current, expected))
    throw new Error('linked CAS attempt is stale')
  return current
}
async function claimCurrent(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  lifecycles: readonly EncryptedWalletBackupActiveUploadAttemptRecord['lifecycle'][],
): Promise<EncryptedWalletBackupActiveUploadAttemptRecord> {
  const raw = await tx.readAttempt(claim.attemptId)
  if (raw === null) throw new Error('stale backup upload owner claim')
  const current = kernel(tx).decodeActiveUploadAttemptRecord(raw)
  if (
    !kernel(tx).equalActiveUploadAttempt(current, claim) ||
    tx.nowUnixMilliseconds >= current.leaseExpiresAtUnixMilliseconds ||
    !lifecycles.includes(current.lifecycle)
  )
    throw new Error('stale backup upload owner claim')
  return current
}
async function replaceBatches(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  before: readonly EncryptedWalletBackupUploadBatchRecord[],
  after: readonly EncryptedWalletBackupUploadBatchRecord[],
): Promise<void> {
  for (let index = 0; index < before.length; index += 1)
    await tx.replaceBatch(before[index]!, after[index]!)
}
function abortUncertainBatch(
  row: EncryptedWalletBackupUploadBatchRecord,
): EncryptedWalletBackupUploadBatchRecord {
  return structuredClone({
    ...row,
    state: 'abort-uncertain',
    executionLeaseExpiresAtUnixMilliseconds: null,
  })
}
function abandonedBatch(
  row: EncryptedWalletBackupUploadBatchRecord,
): EncryptedWalletBackupUploadBatchRecord {
  return structuredClone({
    ...row,
    state: 'abandoned',
    executionLeaseExpiresAtUnixMilliseconds: null,
    items: row.items.map((item) => ({ ...item, canonicalPutPayload: null })),
  })
}
async function deletePartition(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  cursor: Uint8Array,
  batches: readonly EncryptedWalletBackupUploadBatchRecord[],
  cas: readonly EncryptedWalletBackupSyncAttemptRecord[],
): Promise<void> {
  for (const row of batches) await tx.deleteBatch(row)
  for (const row of cas) await tx.deleteCasAttempt(row)
  await tx.deleteCursor({ attemptId: attempt.attemptId, expectedCanonicalCursor: cursor })
  await tx.deleteAttempt(attempt)
}

async function sealInitialRetry<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  input: Parameters<
    EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
  >[0],
  seal: (value: {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
    cursor: Uint8Array | null
  }) => T,
  existing: EncryptedWalletBackupActiveUploadAttemptRecord,
): Promise<T> {
  const records = kernel(tx)
  const cursor = await cursorForAttempt(tx, existing.attemptId)
  const expected = records.decodeActiveUploadAttemptRecord({
    ...input.candidate,
    ownerEpoch: existing.ownerEpoch,
    leaseExpiresAtUnixMilliseconds: existing.leaseExpiresAtUnixMilliseconds,
    batchIds: existing.batchIds,
    activeBatchId: existing.activeBatchId,
    casAttemptId: existing.casAttemptId,
    lifecycle: existing.lifecycle,
  })
  if (
    existing.ownerEpoch !== 1 ||
    existing.lifecycle !== 'active' ||
    existing.activeBatchId !== null ||
    existing.batchIds.length !== 0 ||
    existing.casAttemptId !== null ||
    !records.equalActiveUploadAttempt(existing, expected) ||
    !equalBytes(cursor, input.initialCursor)
  )
    throw new Error('backup upload attempt conflicts with different content')
  return invoke(seal, { attempt: cloneClaim(existing), cursor })
}

async function sealBatchAndCursor<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  input: Parameters<
    EncryptedWalletBackupUploadAttemptCursorStore['sealUploadBatchAndAdvanceCursor']
  >[0],
  seal: (value: EncryptedWalletBackupBoundedUploadBatchCommit) => T,
): Promise<T> {
  const records = kernel(tx)
  const attempt = await claimCurrent(tx, input.claim, ['active'])
  const cursor = await cursorForAttempt(tx, attempt.attemptId)
  const existingRaw = await tx.readBatch(input.batch.batchId)
  if (existingRaw !== null) {
    const existing = records.decodeUploadBatchRecord(existingRaw)
    if (
      attempt.activeBatchId === existing.batchId &&
      attempt.batchIds.includes(existing.batchId) &&
      records.equalUploadBatch(existing, input.batch) &&
      equalBytes(cursor, input.nextCursor)
    )
      return invoke(seal, { attempt: cloneClaim(attempt), cursor, batch: cloneBatch(existing) })
  }
  if (!equalBytes(cursor, input.expectedCursor)) throw new Error('bounded upload cursor is stale')
  if (existingRaw !== null)
    throw new Error('backup upload batch id conflicts with different content')
  if (attempt.activeBatchId !== null) throw new Error('backup upload foreground batch is active')
  const batch = records.decodeUploadBatchRecord(input.batch)
  const nextAttempt = records.decodeActiveUploadAttemptRecord({
    ...attempt,
    batchIds: [...attempt.batchIds, batch.batchId],
    activeBatchId: batch.batchId,
  })
  strictCursor(input.nextCursor)
  await tx.insertBatch(batch)
  await tx.replaceAttempt(attempt, nextAttempt)
  await tx.replaceCursor({
    attemptId: attempt.attemptId,
    expectedCanonicalCursor: cursor,
    nextCanonicalCursor: input.nextCursor.slice(),
  })
  return invoke(seal, {
    attempt: cloneClaim(nextAttempt),
    cursor: input.nextCursor.slice(),
    batch: cloneBatch(batch),
  })
}

async function sealLinkedCas<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  candidate: EncryptedWalletBackupSyncAttemptRecord,
  commit: (value: {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord
    batches: readonly EncryptedWalletBackupUploadBatchRecord[]
    casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
  }) => T,
): Promise<T> {
  const records = kernel(tx)
  candidate = records.decodeCoordinatorCasRecord(candidate)
  const attempt = await claimCurrent(tx, claim, ['active', 'cas-journaled'])
  const rows = await partition(tx, attempt)
  const rehydrate = attempt.lifecycle === 'cas-journaled'
  if (
    attempt.activeBatchId !== null ||
    (rehydrate && attempt.casAttemptId !== candidate.attemptId) ||
    rows.some((row) => row.state !== (rehydrate ? 'finalized' : 'acknowledged'))
  )
    throw new Error('backup upload partition is incomplete')
  const linked = await linkedCas(tx, attempt)
  if (linked.length !== (rehydrate ? 1 : 0))
    throw new Error('backup upload attempt has invalid linked CAS rows')
  const existingRaw = await tx.readCasAttempt(candidate.attemptId)
  if (existingRaw !== null) {
    const existing = records.decodeCoordinatorCasRecord(existingRaw)
    const immutable = records.decodeCoordinatorCasRecord({
      ...existing,
      casAttempts: 0,
      retryStreak: 0,
      retryNotBeforeUnixMilliseconds: null,
      state: 'sealed',
    })
    if (!records.equalCoordinatorCasIdentity(immutable, candidate))
      throw new Error('deterministic backup CAS id collision')
  } else await tx.insertCasAttempt(cloneCas(candidate))
  const finalized = rows.map((row) =>
    records.freezeUploadBatch({
      ...row,
      state: 'finalized',
      executionLeaseExpiresAtUnixMilliseconds: null,
    }),
  )
  await replaceBatches(tx, rows, finalized)
  const aggregate = rehydrate
    ? attempt
    : records.decodeActiveUploadAttemptRecord({
        ...attempt,
        activeBatchId: null,
        casAttemptId: candidate.attemptId,
        lifecycle: 'cas-journaled',
      })
  if (!rehydrate) await tx.replaceAttempt(attempt, aggregate)
  return invoke(commit, {
    attempt: cloneClaim(aggregate),
    batches: finalized.map(cloneBatch),
    casAttempts: (await linkedCas(tx, aggregate)).map(cloneCas),
  })
}

async function transitionLinkedCas<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  expected: EncryptedWalletBackupSyncAttemptRecord,
  next: EncryptedWalletBackupSyncAttemptRecord,
  lifecycle: 'cas-journaled' | 'fork-cleanup-uncertain',
  commit: (value: {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord
    casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
  }) => T,
): Promise<T> {
  const records = kernel(tx)
  next = records.decodeCoordinatorCasRecord(next)
  const attempt = await claimCurrent(tx, claim, ['cas-journaled'])
  const current = await exactLinkedCas(tx, attempt, expected)
  const aggregate = records.decodeActiveUploadAttemptRecord({ ...attempt, lifecycle })
  await tx.replaceCasAttempt(current, cloneCas(next))
  if (!records.equalActiveUploadAttempt(attempt, aggregate))
    await tx.replaceAttempt(attempt, aggregate)
  return invoke(commit, {
    attempt: cloneClaim(aggregate),
    casAttempts: (await linkedCas(tx, aggregate)).map(cloneCas),
  })
}

async function completeLinkedCas<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  expected: EncryptedWalletBackupSyncAttemptRecord,
  next: EncryptedWalletBackupSyncAttemptRecord,
  commit: (value: {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord
    batches: readonly EncryptedWalletBackupUploadBatchRecord[]
    casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
  }) => T,
): Promise<T> {
  const records = kernel(tx)
  next = records.decodeCoordinatorCasRecord(next)
  const attempt = await claimCurrent(tx, claim, ['cas-journaled'])
  const current = await exactLinkedCas(tx, attempt, expected)
  const rows = await partition(tx, attempt)
  const aggregate = records.decodeActiveUploadAttemptRecord({ ...attempt, lifecycle: 'complete' })
  records.validateAggregatePartition(aggregate, rows, 'finalized')
  records.validateFinalizedTargetDelta(aggregate, rows)
  const value = invoke(commit, {
    attempt: cloneClaim(aggregate),
    batches: rows.map(cloneBatch),
    casAttempts: [cloneCas(next)],
  })
  await deletePartition(tx, attempt, await cursorForAttempt(tx, attempt.attemptId), rows, [current])
  return value
}

async function completeForkCleanup<T>(
  tx: EncryptedWalletBackupCoordinatorPersistenceTransaction,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  expectedCasAttempt: EncryptedWalletBackupSyncAttemptRecord,
  outcome: 'abandoned' | 'already-finalized',
  commit: (value: {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord
    batches: readonly EncryptedWalletBackupUploadBatchRecord[]
    casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
  }) => T,
): Promise<T> {
  const records = kernel(tx)
  const attempt = await claimCurrent(tx, claim, ['fork-cleanup-uncertain'])
  const current = await exactLinkedCas(tx, attempt, expectedCasAttempt)
  const rows = await partition(tx, attempt)
  const nextRows = outcome === 'already-finalized' ? rows : rows.map(abandonedBatch)
  const aggregate = records.decodeActiveUploadAttemptRecord({
    ...attempt,
    lifecycle: outcome === 'already-finalized' ? 'complete' : 'abandoned',
  })
  const value = invoke(commit, {
    attempt: cloneClaim(aggregate),
    batches: nextRows.map(cloneBatch),
    casAttempts: [cloneCas(current)],
  })
  await deletePartition(tx, attempt, await cursorForAttempt(tx, attempt.attemptId), rows, [current])
  return value
}
