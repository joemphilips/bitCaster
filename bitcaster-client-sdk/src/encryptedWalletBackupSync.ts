import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
  EncryptedWalletBackupRemoteBackoffError,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRequestProof,
  type EncryptedWalletBackupRuntime,
  type EncryptedWalletBackupClock,
  type AuthenticatedEncryptedWalletBackupHeadEvidence,
  type DecryptedEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupHeadRemotePort,
  type EncryptedWalletBackupManifestHead,
  type EncryptedWalletBackupWireObject,
  type PreparedEncryptedWalletBackupManifestTarget,
  type EncryptedWalletBackupSyncAttemptRecord,
  type EncryptedWalletBackupSyncAttemptStore,
  type SealedEncryptedWalletBackupSyncAttempt,
  acknowledgeDurableWalletBackupSnapshot,
  beginEncryptedWalletBackupManifestRestore,
  decryptEncryptedWalletBackupManifestPage,
  deriveDurableWalletEncryptedBackupReceipt,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  readAuthenticatedEncryptedWalletBackupManifestPageReference,
} from './encryptedWalletBackup.ts'
import {
  decodeEncryptedWalletBackupUploadCursor,
  encodeEncryptedWalletBackupUploadCursor,
  type PersistedEncryptedWalletBackupUploadCursor,
} from './encryptedWalletBackupUploadPlanningPersistence.ts'
import { requireBoundedEncryptedWalletBackupUploadAttemptTarget } from './encryptedWalletBackupBoundedUploadAttemptAuthority.ts'
import { issueCoordinatedEncryptedWalletBackupCasAttempt } from './encryptedWalletBackupCasAuthority.ts'
import {
  ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX,
  ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
  validateEncryptedWalletBackupAggregateCasLifecycle,
  validateEncryptedWalletBackupCasState,
} from './encryptedWalletBackupCasState.ts'
import { deriveDurableWalletBackupSnapshotId } from './recoverableWalletStorage.ts'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  structurallyPreflightEncryptedBackupAttemptAbortCbor,
  preflightEncryptedBackupCasCbor,
  preflightEncryptedBackupHeadCbor,
  preflightEncryptedBackupPutCbor,
  preflightEncryptedBackupReferenceSetCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  awaitEncryptedWalletBackupCycle,
  EncryptedWalletBackupDeadlineError,
  requireEncryptedWalletBackupCycleSignal,
  throwIfEncryptedWalletBackupCycleAborted,
} from './encryptedWalletBackupDeadline.ts'
import { ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX } from './encryptedWalletBackupRetrySchedule.ts'
import { requireEncryptedWalletBackupObjectAad } from './encryptedWalletBackupObjectAad.ts'
import { encryptedWalletBackupObjectDigest } from './encryptedWalletBackupObjectDigest.ts'
import { measureEncryptedWalletBackupObjectPutPayload } from './encryptedWalletBackupObjectPutSize.ts'

export const ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX = 16 as const
export const ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX = 4 * 1_024 * 1_024
export const ENCRYPTED_WALLET_BACKUP_CYCLE_PARALLEL_MAX = 4 as const
export const ENCRYPTED_WALLET_BACKUP_CYCLE_REPACK_MAX = 4 as const
export const ENCRYPTED_WALLET_BACKUP_ATTEMPT_BATCH_MAX = 64 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_STORED_BYTES = ENCRYPTED_WALLET_BACKUP_BODY_BYTES
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_STORED_BYTES =
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_READ_ROWS_MAX = 2 as const
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_WRITE_ROWS_MAX = 2 as const
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_BYTES_MAX = 1_048_576 as const
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_READ_ROWS_MAX = 3 as const
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_WRITE_ROWS_MAX = 3 as const
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX = 5_242_880 as const

export interface EncryptedWalletBackupUploadItemRecord {
  readonly objectId: string
  readonly objectDigest: string
  readonly payloadLength: number
  readonly canonicalPutPayload: Uint8Array | null
}

export interface EncryptedWalletBackupUploadBatchRecord {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly attemptId: string
  readonly targetManifestDigest: string
  readonly canonicalTargetHead: Uint8Array
  readonly canonicalTargetReferenceSet: Uint8Array
  readonly canonicalInheritedReferenceSet: Uint8Array
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly repackedChunkCount: number
  readonly uploadedBytes: number
  readonly executionEpoch: number
  readonly executionLeaseExpiresAtUnixMilliseconds: number | null
  readonly items: readonly EncryptedWalletBackupUploadItemRecord[]
  readonly state:
    | 'sealed'
    | 'put-uncertain'
    | 'acknowledged'
    | 'abort-uncertain'
    | 'finalized'
    | 'abandoned'
}

export interface EncryptedWalletBackupUploadBatchStore {
  /**
   * Every mutation method is one database transaction. The adapter must invoke
   * its callback synchronously exactly once, return that exact callback value,
   * and roll back all writes when the callback throws or rejects its result.
   */
  validateUploadAttemptClaim<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (current: EncryptedWalletBackupActiveUploadAttemptRecord) => T,
  ): Promise<T>
  readUploadBatch<T>(
    batchId: string,
    read: (committed: EncryptedWalletBackupUploadBatchRecord) => T,
  ): Promise<T>
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
  ): Promise<T>
  validateUploadBatchExecution<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    batch: EncryptedWalletBackupUploadBatchRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batch: EncryptedWalletBackupUploadBatchRecord
      }>,
    ) => T,
  ): Promise<T>
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
  ): Promise<T>
  /** Atomically requires that no row in the attempt/target partition is finalized. */
  fenceUploadAttemptForAbort<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
      }>,
    ) => T,
  ): Promise<T>
  /**
   * One physical transaction. Invoke the SDK callback against terminal
   * abandoned snapshots, then delete the upload aggregate and every batch
   * before committing. Callback failure rolls back transition and deletion.
   */
  completeUploadAttemptAbort<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        batches: readonly EncryptedWalletBackupUploadBatchRecord[]
      }>,
    ) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupActiveUploadAttemptRecord {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly ownerId: string
  readonly ownerEpoch: number
  readonly leaseExpiresAtUnixMilliseconds: number
  readonly attemptId: string
  readonly targetManifestDigest: string
  readonly parentManifestDigest: string | null
  readonly canonicalParentHead: Uint8Array | null
  readonly canonicalTargetHead: Uint8Array
  readonly canonicalTargetReferenceSet: Uint8Array
  readonly canonicalInheritedReferenceSet: Uint8Array
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly batchIds: readonly string[]
  readonly activeBatchId: string | null
  readonly casAttemptId: string | null
  readonly lifecycle:
    | 'active'
    | 'abort-uncertain'
    | 'cas-journaled'
    | 'fork-cleanup-uncertain'
    | 'abandoned'
    | 'complete'
}

export type EncryptedWalletBackupUploadAttemptCursorReservation = Readonly<{
  readonly readRows: 2
  readonly writeRows: 2
  readonly readBytes: 1_048_576
  readonly writeBytes: 1_048_576
}>

export type EncryptedWalletBackupActiveUploadAttemptCursorCommit = Readonly<{
  readonly attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
  readonly cursor: Uint8Array | null
}>

export type EncryptedWalletBackupBoundedUploadBatchCommit = Readonly<{
  readonly attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
  readonly cursor: Uint8Array | null
  readonly batch: EncryptedWalletBackupUploadBatchRecord | null
}>

export type EncryptedWalletBackupUploadBatchReservation = Readonly<{
  readonly readRows: 3
  readonly writeRows: 3
  readonly readBytes: 5_242_880
  readonly writeBytes: 5_242_880
}>

/** Reads one persisted immutable object. It must not materialize target state. */
export interface EncryptedWalletBackupBoundedUploadObjectSource {
  readManifestPageObject(
    input: Readonly<{
      readonly realm: string
      readonly vaultId: string
      readonly generation: number
      readonly objectId: string
      readonly digest: string
      readonly maximumRows: 1
      readonly maximumBytes: 1_048_576
    }>,
  ): Promise<EncryptedWalletBackupWireObject>
  readProofChunkObject(
    input: Readonly<{
      readonly realm: string
      readonly vaultId: string
      readonly generation: number
      readonly objectId: string
      readonly digest: string
      readonly maximumRows: 1
      readonly maximumBytes: 1_048_576
    }>,
  ): Promise<EncryptedWalletBackupWireObject>
}

/** Adds paired attempt/cursor transactions to the persisted upload batch store. */
export interface EncryptedWalletBackupUploadAttemptCursorStore extends EncryptedWalletBackupUploadBatchStore {
  /**
   * Use one physical transaction. Insert both rows or read both exact rows.
   * Permit an exact retry only. Reject another active attempt in this scope.
   * Invoke the callback synchronously once. Return its exact value. Roll back
   * both rows when the callback fails.
   */
  sealActiveUploadAttemptAndCursor<T>(
    input: Readonly<{
      readonly candidate: Omit<
        EncryptedWalletBackupActiveUploadAttemptRecord,
        | 'ownerEpoch'
        | 'leaseExpiresAtUnixMilliseconds'
        | 'batchIds'
        | 'activeBatchId'
        | 'casAttemptId'
        | 'lifecycle'
      >
      readonly initialCursor: Uint8Array
      readonly leaseDurationMilliseconds: number
      readonly reservation: EncryptedWalletBackupUploadAttemptCursorReservation
    }>,
    seal: (committed: EncryptedWalletBackupActiveUploadAttemptCursorCommit) => T,
  ): Promise<T>
  claimActiveUploadAttemptAndCursor<T>(
    input: Readonly<{
      readonly realm: string
      readonly vaultId: string
      readonly ownerId: string
      readonly leaseDurationMilliseconds: number
      readonly reservation: EncryptedWalletBackupUploadAttemptCursorReservation
    }>,
    claim: (committed: EncryptedWalletBackupActiveUploadAttemptCursorCommit) => T,
  ): Promise<T>
  /**
   * Use one physical transaction. Persist the attempt, cursor, and batch
   * together. Require the persisted attempt has no active batch before a new
   * batch. An exact retry after an uncertain commit may return the same active
   * batch and its committed cursor. Reject a conflicting retry.
   */
  sealUploadBatchAndAdvanceCursor<T>(
    input: Readonly<{
      readonly claim: EncryptedWalletBackupActiveUploadAttemptRecord
      readonly expectedCursor: Uint8Array
      readonly batch: EncryptedWalletBackupUploadBatchRecord
      readonly nextCursor: Uint8Array
      readonly reservation: EncryptedWalletBackupUploadBatchReservation
    }>,
    seal: (committed: EncryptedWalletBackupBoundedUploadBatchCommit) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupCoordinatorStore extends EncryptedWalletBackupUploadBatchStore {
  /**
   * One physical database transaction. SQLite/PostgreSQL adapters enforce a
   * foreign key plus a unique uploadAttemptId. Dexie adapters enforce the same
   * relation with same-transaction existence checks and a unique index.
   * Existing rows keep their mutable retry state but must have exact immutable
   * identity. The callback receives every row linked by uploadAttemptId so the
   * SDK can reject missing or duplicate relations.
   */
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
  ): Promise<T>
  /** DB-time owner validation plus an exact read of every linked CAS row. */
  readLinkedCasAttempts<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T>
  validateLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    read: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T>
  /**
   * One physical transaction for a nonterminal CAS transition. Batch rows are
   * intentionally not loaded on this path.
   */
  transitionLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    aggregateLifecycle: 'cas-journaled' | 'fork-cleanup-uncertain',
    commit: (
      committed: Readonly<{
        attempt: EncryptedWalletBackupActiveUploadAttemptRecord
        casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
      }>,
    ) => T,
  ): Promise<T>
  /**
   * One physical transaction for an acknowledged CAS. Load the complete
   * finalized batch partition, invoke the SDK callback against the terminal
   * aggregate/CAS/partition snapshots, then delete all three record classes.
   * Callback failure rolls back the transition and deletion.
   */
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
  ): Promise<T>
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
  ): Promise<T>
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
  ): Promise<Readonly<{ state: 'not-ready' }> | Readonly<{ state: 'committed'; value: T }>>
  /**
   * One physical transaction. Validate the exact expected CAS row, invoke the
   * SDK callback against terminal snapshots, then delete the upload aggregate,
   * every batch, and linked CAS row before committing. Callback failure rolls
   * back the terminal transition and deletion.
   */
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
  ): Promise<T>
}

export interface EncryptedWalletBackupUploadAttemptClaim {
  readonly state: 'claimed'
  readonly record: EncryptedWalletBackupActiveUploadAttemptRecord
}
export interface AbandonedEncryptedWalletBackupUploadAttempt {
  readonly state: 'abandoned'
  readonly record: EncryptedWalletBackupActiveUploadAttemptRecord
}
export interface CleanedEncryptedWalletBackupFork {
  readonly state: 'abandoned' | 'complete'
  readonly receiptAuthority: 'none'
  readonly record: EncryptedWalletBackupActiveUploadAttemptRecord
}

interface UploadAttemptClaimAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly store: EncryptedWalletBackupUploadBatchStore
  readonly record: EncryptedWalletBackupActiveUploadAttemptRecord
}
const UPLOAD_ATTEMPT_CLAIMS = new WeakMap<object, UploadAttemptClaimAuthority>()
const INCOMPLETE_BOUNDED_UPLOAD_ATTEMPT_CLAIMS = new WeakSet<object>()
const BOUNDED_UPLOAD_CURSORS = new WeakMap<object, PersistedEncryptedWalletBackupUploadCursor>()

export interface SealedEncryptedWalletBackupUploadBatch {
  readonly state: 'sealed'
  readonly record: EncryptedWalletBackupUploadBatchRecord
}

interface UploadBatchAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly record: EncryptedWalletBackupUploadBatchRecord
}

const UPLOAD_BATCH_AUTHORITIES = new WeakMap<object, UploadBatchAuthority>()

export interface EncryptedWalletBackupObjectRemotePort {
  putObject(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalPutPayload: Uint8Array
    signal: AbortSignal
  }): Promise<
    Readonly<{
      status:
        | 'stored'
        | 'already-stored'
        | 'quota-exceeded'
        | 'unauthorized'
        | 'rate-limited'
        | 'overloaded'
        | 'unavailable'
      retryAfterSeconds?: number | null
    }>
  >
}

export interface EncryptedWalletBackupObjectGetInput {
  readonly requestProof: EncryptedWalletBackupRequestProof
  readonly expectedKindCode: 1 | 2
  readonly expectedObjectDigest: string
  readonly currentHeadGeneration: number
  readonly signal?: AbortSignal
}

export type EncryptedWalletBackupObjectGetResult =
  | Readonly<{
      status: 'found'
      kindCode: 1 | 2
      realm: string
      vaultId: string
      objectId: string
      generation: number
      paddedLength: 65_536 | 262_144
      objectDigest: string
      aad: Uint8Array
      encryptedBody: Uint8Array
    }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{
      status: 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
      retryAfterSeconds?: number | null
    }>

/** Typed absence is the only journal state that permits a new backup build. */
export interface EncryptedWalletBackupCompleteJournalLoss {
  readonly state: 'complete-loss'
  readonly buildJournal: null
  readonly uploadAggregate: null
  readonly uploadBatches: null
  readonly casJournal: null
}

/** Any surviving row is a restart concern. It is not cache-loss authority. */
export interface EncryptedWalletBackupSurvivingJournalState {
  readonly state: 'surviving-state'
}

export type EncryptedWalletBackupJournalRecoveryState =
  | EncryptedWalletBackupCompleteJournalLoss
  | EncryptedWalletBackupSurvivingJournalState

export interface EncryptedWalletBackupJournalRecoveryStore {
  /**
   * Read all build, aggregate, batch, and CAS rows in one transaction. The
   * adapter must report complete loss only when every typed row class is absent.
   */
  readJournalRecoveryState<T>(
    read: (state: EncryptedWalletBackupJournalRecoveryState) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupRecoveryMembership {
  readonly proofId: string
  readonly proofCommitment: string
}

export interface EncryptedWalletBackupRecoverySnapshot {
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly proofCount: number
}

export interface EncryptedWalletBackupRecoverySnapshotPage {
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly pageIndex: number
  readonly entries: readonly EncryptedWalletBackupRecoveryMembership[]
}

export interface EncryptedWalletBackupRecoverySnapshotStore {
  /** Reads one transactionally sealed local snapshot. */
  readSealedRecoverySnapshot<T>(
    read: (snapshot: EncryptedWalletBackupRecoverySnapshot) => T,
  ): Promise<T>
  /** Reads one bounded page from that exact sealed snapshot. */
  readSealedRecoverySnapshotPage<T>(
    snapshot: EncryptedWalletBackupRecoverySnapshot,
    pageIndex: number,
    read: (page: EncryptedWalletBackupRecoverySnapshotPage) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupRecoveryObjectRemotePort {
  getObject(
    input: EncryptedWalletBackupObjectGetInput,
  ): Promise<EncryptedWalletBackupObjectGetResult>
}

export interface EncryptedWalletBackupRecoveryProjectionStore {
  readRecoveryProjectionCursor<T>(
    read: (cursor: EncryptedWalletBackupRecoveryProjectionCursor | null) => T,
  ): Promise<T>
  /**
   * Atomically appends one page to the current projection. It accepts an exact
   * replay of the same checkpoint. A partial projection is not eviction authority.
   */
  commitRecoveryProjectionCheckpoint<T>(
    input: Readonly<{
      expectedCursor: EncryptedWalletBackupRecoveryProjectionCursor | null
      nextCursor: EncryptedWalletBackupRecoveryProjectionCursor
      snapshot: ReturnType<typeof acknowledgeDurableWalletBackupSnapshot>
      receipts: readonly ReturnType<typeof deriveDurableWalletEncryptedBackupReceipt>[]
    }>,
    commit: () => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupRecoveryProjectionCursor {
  readonly generation: number
  readonly manifestDigest: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly nextRemotePageIndex: number
  readonly restoredEntryCount: number
  readonly lastRemoteProofId: string | null
  readonly complete: boolean
}

const ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT = 256

export type EncryptedWalletBackupJournalRecoveryResult =
  | Readonly<{ state: 'recovery-in-progress' }>
  | Readonly<{ state: 'projection-refreshed' }>
  | Readonly<{
      state: 'rebuild-required'
      parent: 'absent' | 'authenticated'
      headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
      snapshot: EncryptedWalletBackupRecoverySnapshot
    }>

/**
 * Recovers only a completely lost backup journal. It authenticates the current
 * head before it requires a rebuild. One call handles at most one remote page.
 */
export async function recoverCompleteEncryptedWalletBackupJournal(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  enrollmentEpoch: number
  headUrl: string
  manifestObjectUrl: (objectId: string) => string
  clock: EncryptedWalletBackupClock
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
  journalStore: EncryptedWalletBackupJournalRecoveryStore
  snapshotStore: EncryptedWalletBackupRecoverySnapshotStore
  projectionStore: EncryptedWalletBackupRecoveryProjectionStore
  remote: EncryptedWalletBackupHeadRemotePort & EncryptedWalletBackupRecoveryObjectRemotePort
}): Promise<EncryptedWalletBackupJournalRecoveryResult> {
  const signal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(signal)
  await requireCompleteJournalLoss(input.journalStore)
  const snapshot = await readRecoverySnapshot(input.snapshotStore)
  const headEvidence = await readRecoveryHead(input, signal)
  if (headEvidence.head === null) {
    return rebuildRequired('absent', headEvidence, snapshot, signal)
  }
  if (snapshot.proofCount !== headEvidence.head.proofCount) {
    return rebuildRequired('authenticated', headEvidence, snapshot, signal)
  }
  const manifestCursor = beginEncryptedWalletBackupManifestRestore({ headEvidence })
  const recoveryCursor = await readRecoveryCursor(
    input.projectionStore,
    headEvidence,
    snapshot,
    manifestCursor.pageCount,
  )
  const cursor = recoveryCursor.effective
  if (cursor.complete) return Object.freeze({ state: 'projection-refreshed' as const })
  if (manifestCursor.complete) {
    await commitRecoveryCheckpoint(
      input.projectionStore,
      recoveryCursor.persisted,
      Object.freeze({ ...cursor, complete: true }),
      headEvidence,
      [],
      signal,
    )
    return Object.freeze({ state: 'projection-refreshed' as const })
  }
  const page = await readRecoveryManifestPage(
    input,
    signal,
    headEvidence,
    cursor.nextRemotePageIndex,
  )
  if (!(await recoveryPageMatches(input.snapshotStore, snapshot, cursor, page))) {
    return rebuildRequired('authenticated', headEvidence, snapshot, signal)
  }
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const next = nextRecoveryCursor(cursor, page, snapshot.proofCount)
  if (next.complete && next.restoredEntryCount !== snapshot.proofCount) {
    return rebuildRequired('authenticated', headEvidence, snapshot, signal)
  }
  const receipts = page.entries.map((entry) =>
    deriveDurableWalletEncryptedBackupReceipt({
      headEvidence,
      manifestPage: page,
      proofId: entry.proofId,
      proofCommitment: entry.commitment,
    }),
  )
  await commitRecoveryCheckpoint(
    input.projectionStore,
    recoveryCursor.persisted,
    next,
    headEvidence,
    receipts,
    signal,
  )
  return next.complete
    ? Object.freeze({ state: 'projection-refreshed' as const })
    : Object.freeze({ state: 'recovery-in-progress' as const })
}

async function requireCompleteJournalLoss(
  store: EncryptedWalletBackupJournalRecoveryStore,
): Promise<void> {
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.readJournalRecoveryState !== 'function'
  )
    throw new Error('backup journal recovery store is invalid')
  const marker = Object.freeze({})
  let calls = 0
  const returned = await store.readJournalRecoveryState((state) => {
    if (calls++ !== 0) throw new Error('backup journal recovery callback is invalid')
    if (
      typeof state !== 'object' ||
      state === null ||
      state.state !== 'complete-loss' ||
      state.buildJournal !== null ||
      state.uploadAggregate !== null ||
      state.uploadBatches !== null ||
      state.casJournal !== null
    ) {
      throw new Error('backup journal recovery requires complete typed loss')
    }
    return marker
  })
  if (calls !== 1 || returned !== marker)
    throw new Error('backup journal recovery must be synchronous and exact')
}

async function readRecoverySnapshot(
  store: EncryptedWalletBackupRecoverySnapshotStore,
): Promise<EncryptedWalletBackupRecoverySnapshot> {
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.readSealedRecoverySnapshot !== 'function'
  )
    throw new Error('backup recovery snapshot store is invalid')
  let calls = 0
  let issued: EncryptedWalletBackupRecoverySnapshot | undefined
  const returned = await store.readSealedRecoverySnapshot((snapshot) => {
    if (calls++ !== 0) throw new Error('backup recovery snapshot callback is invalid')
    if (
      typeof snapshot.snapshotId !== 'string' ||
      snapshot.snapshotId.length === 0 ||
      new TextEncoder().encode(snapshot.snapshotId).byteLength > 256 ||
      !Number.isSafeInteger(snapshot.snapshotRevision) ||
      snapshot.snapshotRevision < 0 ||
      !Number.isSafeInteger(snapshot.proofCount) ||
      snapshot.proofCount < 0 ||
      snapshot.proofCount > ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX
    ) {
      throw new Error('backup recovery snapshot is invalid')
    }
    issued = snapshot
    return issued
  })
  if (calls !== 1 || issued === undefined || returned !== issued)
    throw new Error('backup recovery snapshot read must be synchronous and exact')
  return issued
}

async function readRecoveryHead(
  input: Parameters<typeof recoverCompleteEncryptedWalletBackupJournal>[0],
  signal: AbortSignal,
): Promise<AuthenticatedEncryptedWalletBackupHeadEvidence> {
  const issuedAtUnixSeconds = requireInteger(
    input.clock.nowUnixSeconds(),
    0,
    Number.MAX_SAFE_INTEGER,
    'request issue time',
  )
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: requireInteger(
      input.enrollmentEpoch,
      1,
      Number.MAX_SAFE_INTEGER,
      'enrollment epoch',
    ),
    method: 'GET',
    url: input.headUrl,
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    payload: new Uint8Array(),
    signal,
    runtime: input.runtime,
  })
  return readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    requestProof,
    remote: input.remote,
  })
}

async function readRecoveryManifestPage(
  input: Parameters<typeof recoverCompleteEncryptedWalletBackupJournal>[0],
  signal: AbortSignal,
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  pageIndex: number,
): Promise<DecryptedEncryptedWalletBackupManifestPage> {
  if (headEvidence.head === null) throw new Error('backup recovery head is absent')
  const reference = readAuthenticatedEncryptedWalletBackupManifestPageReference({
    headEvidence,
    pageIndex,
  })
  const issuedAtUnixSeconds = requireInteger(
    input.clock.nowUnixSeconds(),
    0,
    Number.MAX_SAFE_INTEGER,
    'request issue time',
  )
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: requireInteger(
      input.enrollmentEpoch,
      1,
      Number.MAX_SAFE_INTEGER,
      'enrollment epoch',
    ),
    method: 'GET',
    url: input.manifestObjectUrl(reference.objectId),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    payload: new Uint8Array(),
    signal,
    runtime: input.runtime,
  })
  const result = await awaitEncryptedWalletBackupCycle(
    input.remote.getObject({
      requestProof,
      expectedKindCode: ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      expectedObjectDigest: reference.objectDigest,
      currentHeadGeneration: reference.generation,
      signal,
    }),
    signal,
  )
  const object = mapRecoveryManifestObject(result)
  return decryptEncryptedWalletBackupManifestPage({
    keyHandle: input.keyHandle,
    seed: input.seed,
    object,
    headEvidence,
  })
}

function mapRecoveryManifestObject(result: EncryptedWalletBackupObjectGetResult) {
  switch (result.status) {
    case 'found':
      return {
        formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
        kindCode: result.kindCode,
        realm: result.realm,
        vaultId: result.vaultId,
        objectId: result.objectId,
        generation: result.generation,
        paddedLength: result.paddedLength,
        digest: result.objectDigest,
        aad: result.aad.slice(),
        body: result.encryptedBody.slice(),
      }
    case 'not-found':
      throw new Error('authenticated backup manifest page is missing')
    case 'unauthorized':
      throw new Error('encrypted backup object read failed: unauthorized')
    case 'rate-limited':
    case 'overloaded':
    case 'unavailable':
      throw new EncryptedWalletBackupRemoteBackoffError(result.status, result.retryAfterSeconds)
    default:
      return assertNeverObjectGetStatus(result)
  }
}

function assertNeverObjectGetStatus(value: never): never {
  throw new Error(`encrypted backup object read status is invalid: ${String(value)}`)
}

async function readRecoverySnapshotPage(
  store: EncryptedWalletBackupRecoverySnapshotStore,
  snapshot: EncryptedWalletBackupRecoverySnapshot,
  pageIndex: number,
): Promise<EncryptedWalletBackupRecoverySnapshotPage> {
  if (typeof store.readSealedRecoverySnapshotPage !== 'function')
    throw new Error('backup recovery snapshot store is invalid')
  let calls = 0
  let issued: EncryptedWalletBackupRecoverySnapshotPage | undefined
  const returned = await store.readSealedRecoverySnapshotPage(snapshot, pageIndex, (page) => {
    if (calls++ !== 0) throw new Error('backup recovery snapshot page callback is invalid')
    if (
      page.snapshotId !== snapshot.snapshotId ||
      page.snapshotRevision !== snapshot.snapshotRevision ||
      page.pageIndex !== pageIndex ||
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= recoverySnapshotPageCount(snapshot) ||
      page.entries.length !==
        Math.min(
          ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT,
          snapshot.proofCount -
            pageIndex * ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT,
        ) ||
      page.entries.some(
        (entry, index) =>
          !/^[0-9a-f]{64}$/.test(entry.proofId) ||
          !/^[0-9a-f]{64}$/.test(entry.proofCommitment) ||
          (index > 0 && page.entries[index - 1]!.proofId >= entry.proofId),
      )
    ) {
      throw new Error('backup recovery snapshot page is invalid')
    }
    issued = page
    return issued
  })
  if (calls !== 1 || issued === undefined || returned !== issued)
    throw new Error('backup recovery snapshot page read must be synchronous and exact')
  return issued
}

async function readRecoveryCursor(
  store: EncryptedWalletBackupRecoveryProjectionStore,
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  snapshot: EncryptedWalletBackupRecoverySnapshot,
  remotePageCount: number,
): Promise<
  Readonly<{
    persisted: EncryptedWalletBackupRecoveryProjectionCursor | null
    effective: EncryptedWalletBackupRecoveryProjectionCursor
  }>
> {
  const head = headEvidence.head!
  const initial = Object.freeze({
    generation: head.generation,
    manifestDigest: head.manifestDigest,
    snapshotId: snapshot.snapshotId,
    snapshotRevision: snapshot.snapshotRevision,
    nextRemotePageIndex: 0,
    restoredEntryCount: 0,
    lastRemoteProofId: null,
    complete: false,
  })
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.readRecoveryProjectionCursor !== 'function'
  )
    throw new Error('backup recovery projection store is invalid')
  const marker = Object.freeze({})
  let calls = 0
  let persisted: EncryptedWalletBackupRecoveryProjectionCursor | null = null
  const returned = await store.readRecoveryProjectionCursor((value) => {
    if (calls++ !== 0) throw new Error('backup recovery cursor callback is invalid')
    persisted = value
    return marker
  })
  if (calls !== 1 || returned !== marker)
    throw new Error('backup recovery cursor read must be synchronous and exact')
  const effective =
    persisted !== null &&
    validRecoveryCursor(persisted, initial, remotePageCount, snapshot.proofCount)
      ? persisted
      : initial
  return Object.freeze({ persisted, effective })
}

async function recoveryPageMatches(
  store: EncryptedWalletBackupRecoverySnapshotStore,
  snapshot: EncryptedWalletBackupRecoverySnapshot,
  cursor: EncryptedWalletBackupRecoveryProjectionCursor,
  page: DecryptedEncryptedWalletBackupManifestPage,
): Promise<boolean> {
  if (page.pageIndex !== cursor.nextRemotePageIndex || page.entries.length === 0) return false
  const position = recoveryLocalPosition(snapshot.proofCount, cursor.restoredEntryCount)
  let localPageIndex = position.pageIndex
  let localEntryIndex = position.entryIndex
  let local = await readRecoverySnapshotPage(store, snapshot, localPageIndex)
  for (const entry of page.entries) {
    while (localEntryIndex === local.entries.length) {
      localPageIndex += 1
      if (localPageIndex >= recoverySnapshotPageCount(snapshot)) return false
      local = await readRecoverySnapshotPage(store, snapshot, localPageIndex)
      localEntryIndex = 0
    }
    const current = local.entries[localEntryIndex++]!
    if (
      current.proofId !== entry.proofId ||
      current.proofCommitment !== entry.commitment ||
      (cursor.lastRemoteProofId !== null && cursor.lastRemoteProofId >= entry.proofId)
    ) {
      return false
    }
  }
  return true
}

function nextRecoveryCursor(
  cursor: EncryptedWalletBackupRecoveryProjectionCursor,
  page: DecryptedEncryptedWalletBackupManifestPage,
  snapshotProofCount: number,
): EncryptedWalletBackupRecoveryProjectionCursor {
  const restoredEntryCount = cursor.restoredEntryCount + page.entries.length
  const complete = page.pageIndex + 1 === page.pageCount
  if (
    restoredEntryCount > snapshotProofCount ||
    (complete && restoredEntryCount !== snapshotProofCount) ||
    (!complete && restoredEntryCount >= snapshotProofCount)
  ) {
    throw new Error('backup recovery cursor is invalid')
  }
  return Object.freeze({
    ...cursor,
    nextRemotePageIndex: page.pageIndex + 1,
    restoredEntryCount,
    lastRemoteProofId: page.entries.at(-1)!.proofId,
    complete,
  })
}

async function commitRecoveryCheckpoint(
  store: EncryptedWalletBackupRecoveryProjectionStore,
  expectedCursor: EncryptedWalletBackupRecoveryProjectionCursor | null,
  nextCursor: EncryptedWalletBackupRecoveryProjectionCursor,
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  receipts: readonly ReturnType<typeof deriveDurableWalletEncryptedBackupReceipt>[],
  signal: AbortSignal,
): Promise<void> {
  if (typeof store.commitRecoveryProjectionCheckpoint !== 'function')
    throw new Error('backup recovery projection store is invalid')
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const marker = Object.freeze({})
  let calls = 0
  let open = true
  let returned: unknown
  try {
    returned = await awaitEncryptedWalletBackupCycle(
      store.commitRecoveryProjectionCheckpoint(
        Object.freeze({
          expectedCursor,
          nextCursor,
          snapshot: acknowledgeDurableWalletBackupSnapshot({ headEvidence }),
          receipts: Object.freeze([...receipts]),
        }),
        () => {
          if (!open || calls++ !== 0)
            throw new Error('backup recovery checkpoint callback is invalid')
          return marker
        },
      ),
      signal,
    )
  } finally {
    open = false
  }
  if (calls !== 1 || returned !== marker)
    throw new Error('backup recovery checkpoint must be synchronous and exact')
}

function sameRecoveryCursorScope(
  left: EncryptedWalletBackupRecoveryProjectionCursor,
  right: EncryptedWalletBackupRecoveryProjectionCursor,
): boolean {
  return (
    left.generation === right.generation &&
    left.manifestDigest === right.manifestDigest &&
    left.snapshotId === right.snapshotId &&
    left.snapshotRevision === right.snapshotRevision
  )
}

function validRecoveryCursor(
  cursor: EncryptedWalletBackupRecoveryProjectionCursor,
  initial: EncryptedWalletBackupRecoveryProjectionCursor,
  remotePageCount: number,
  snapshotProofCount: number,
): boolean {
  if (
    !sameRecoveryCursorScope(cursor, initial) ||
    !Number.isSafeInteger(cursor.nextRemotePageIndex) ||
    cursor.nextRemotePageIndex < 0 ||
    cursor.nextRemotePageIndex > remotePageCount ||
    !Number.isSafeInteger(cursor.restoredEntryCount) ||
    cursor.restoredEntryCount < 0 ||
    cursor.restoredEntryCount > snapshotProofCount ||
    typeof cursor.complete !== 'boolean' ||
    (cursor.lastRemoteProofId !== null && !/^[0-9a-f]{64}$/.test(cursor.lastRemoteProofId))
  ) {
    return false
  }
  return (
    (cursor.restoredEntryCount === 0) === (cursor.lastRemoteProofId === null) &&
    cursor.complete ===
      (cursor.nextRemotePageIndex === remotePageCount &&
        cursor.restoredEntryCount === snapshotProofCount)
  )
}

function recoverySnapshotPageCount(snapshot: EncryptedWalletBackupRecoverySnapshot): number {
  return Math.ceil(snapshot.proofCount / ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT)
}

function recoveryLocalPosition(
  snapshotProofCount: number,
  restoredEntryCount: number,
): Readonly<{ pageIndex: number; entryIndex: number }> {
  if (snapshotProofCount === 0) return Object.freeze({ pageIndex: 0, entryIndex: 0 })
  if (
    restoredEntryCount === snapshotProofCount &&
    restoredEntryCount % ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT === 0
  ) {
    return Object.freeze({
      pageIndex:
        restoredEntryCount / ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT - 1,
      entryIndex: ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT,
    })
  }
  return Object.freeze({
    pageIndex: Math.floor(
      restoredEntryCount / ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT,
    ),
    entryIndex: restoredEntryCount % ENCRYPTED_WALLET_BACKUP_RECOVERY_SNAPSHOT_PAGE_ENTRY_COUNT,
  })
}

function rebuildRequired(
  parent: 'absent' | 'authenticated',
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  snapshot: EncryptedWalletBackupRecoverySnapshot,
  signal: AbortSignal,
): EncryptedWalletBackupJournalRecoveryResult {
  throwIfEncryptedWalletBackupCycleAborted(signal)
  return Object.freeze({ state: 'rebuild-required' as const, parent, headEvidence, snapshot })
}

export interface EncryptedWalletBackupUploadAbortRemotePort {
  abortUploadAttempt(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalAbortPayload: Uint8Array
    signal: AbortSignal
  }): Promise<
    Readonly<{
      status:
        | 'abandoned'
        | 'already-abandoned'
        | 'already-finalized'
        | 'unauthorized'
        | 'rate-limited'
        | 'overloaded'
        | 'unavailable'
      retryAfterSeconds?: number | null
    }>
  >
}

/** Seals a finalizer-issued bounded target and its first upload cursor together. */
export async function sealBoundedEncryptedWalletBackupUploadAttempt(input: {
  readonly attemptId: string
  readonly ownerId: string
  readonly leaseDurationMilliseconds: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly target: PreparedEncryptedWalletBackupManifestTarget
  readonly store: EncryptedWalletBackupUploadAttemptCursorStore
}): Promise<EncryptedWalletBackupUploadAttemptClaim> {
  const target = requireBoundedEncryptedWalletBackupUploadAttemptTarget({
    keyHandle: input.keyHandle,
    target: input.target,
  })
  const expectedCandidate = createUploadAttemptCandidate({
    attemptId: input.attemptId,
    ownerId: input.ownerId,
    keyHandle: input.keyHandle,
    target,
  })
  const expectedCursor = initialUploadCursor(expectedCandidate, target.head.objectCount)
  const lease = requireInteger(
    input.leaseDurationMilliseconds,
    1,
    300_000,
    'backup upload lease duration',
  )
  requireUploadAttemptCursorStore(input.store)
  let issued: EncryptedWalletBackupUploadAttemptClaim | undefined
  let calls = 0
  let open = true
  let returned: unknown
  try {
    const transaction = input.store.sealActiveUploadAttemptAndCursor(
      {
        candidate: cloneUploadAttemptCandidate(expectedCandidate),
        initialCursor: encodeEncryptedWalletBackupUploadCursor(expectedCursor),
        leaseDurationMilliseconds: lease,
        reservation: uploadAttemptCursorReservation,
      },
      (raw) => {
        if (!open || calls++ !== 0)
          throw new Error('bounded upload attempt seal callback is invalid')
        const committed = requireAtomicAttemptCursorCommit(raw)
        if (committed.attempt === null || committed.cursor === null)
          throw new Error('bounded upload attempt and cursor must both be present')
        const record = decodeActiveUploadAttemptRecord(committed.attempt)
        requireExactInitialUploadAttempt(record, expectedCandidate)
        const cursor = decodeEncryptedWalletBackupUploadCursor(committed.cursor)
        if (!equalUploadCursor(cursor, expectedCursor))
          throw new Error('sealed upload cursor changed')
        issued = issueBoundedUploadAttemptClaim(
          record,
          expectedCursor,
          input.keyHandle,
          input.store,
        )
        return issued
      },
    )
    open = false
    if (!isThenable(transaction))
      throw new Error('bounded upload attempt seal must return a transaction promise')
    returned = await transaction
  } finally {
    open = false
  }
  if (issued === undefined || returned !== issued || calls !== 1)
    throw new Error('bounded upload attempt seal must be synchronous and exact')
  return issued
}

/** Claims one atomically read bounded attempt and cursor pair after restart. */
export async function claimBoundedEncryptedWalletBackupUploadAttempt(input: {
  readonly ownerId: string
  readonly leaseDurationMilliseconds: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly store: EncryptedWalletBackupUploadAttemptCursorStore
}): Promise<EncryptedWalletBackupUploadAttemptClaim | null> {
  requireUploadAttemptCursorStore(input.store)
  const ownerId = requireBoundedText(input.ownerId, 128, 'backup upload owner id')
  const leaseDurationMilliseconds = requireInteger(
    input.leaseDurationMilliseconds,
    1,
    300_000,
    'backup upload lease duration',
  )
  let issued: EncryptedWalletBackupUploadAttemptClaim | null | undefined
  let calls = 0
  let open = true
  let returned: unknown
  try {
    const transaction = input.store.claimActiveUploadAttemptAndCursor(
      {
        realm: input.keyHandle.realm,
        vaultId: input.keyHandle.vaultId,
        ownerId,
        leaseDurationMilliseconds,
        reservation: uploadAttemptCursorReservation,
      },
      (raw) => {
        if (!open || calls++ !== 0)
          throw new Error('bounded upload attempt claim callback is invalid')
        const committed = requireAtomicAttemptCursorCommit(raw)
        if (committed.attempt === null || committed.cursor === null) {
          if (committed.attempt !== null || committed.cursor !== null)
            throw new Error('bounded upload attempt and cursor must both be present')
          issued = null
          return null
        }
        const record = decodeActiveUploadAttemptRecord(committed.attempt)
        const cursor = decodeEncryptedWalletBackupUploadCursor(committed.cursor)
        requireBoundedClaimPair(record, cursor, input.keyHandle, ownerId)
        issued = issueBoundedUploadAttemptClaim(record, cursor, input.keyHandle, input.store)
        return issued
      },
    )
    open = false
    if (!isThenable(transaction))
      throw new Error('bounded upload attempt claim must return a transaction promise')
    returned = await transaction
  } finally {
    open = false
  }
  if (issued === undefined || returned !== issued || calls !== 1)
    throw new Error('bounded upload attempt claim must be synchronous and exact')
  return issued
}

/** Plans one bounded object prefix and seals its exact bytes with the next cursor. */
export async function planAndSealBoundedEncryptedWalletBackupUploadBatch(input: {
  readonly claim: EncryptedWalletBackupUploadAttemptClaim
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly store: EncryptedWalletBackupUploadAttemptCursorStore
  readonly source: EncryptedWalletBackupBoundedUploadObjectSource
}): Promise<SealedEncryptedWalletBackupUploadBatch | null> {
  const claim = requireUploadAttemptClaim(input.claim, input.keyHandle, input.store)
  if (claim.record.activeBatchId !== null)
    throw new Error('bounded upload attempt already has an active batch')
  const cursor = requireBoundedUploadCursor(input.claim)
  requireUploadAttemptCursorStore(input.store)
  requireBoundedUploadObjectSource(input.source)
  const target = validateTargetHead(
    claim.record.canonicalTargetHead,
    claim.record.canonicalTargetReferenceSet,
    claim.record.targetManifestDigest,
  )
  const inherited = decodeReferenceSet(claim.record.canonicalInheritedReferenceSet)
  const references = boundedUploadReferences(target, inherited, cursor)
  if (references.length === 0) return null
  const selected = await readBoundedUploadBatchObjects({
    source: input.source,
    keyHandle: input.keyHandle,
    target,
    references,
    attemptId: claim.record.attemptId,
  })
  const nextCursor = advanceBoundedUploadCursor(cursor, target, inherited, selected)
  const batch = boundedUploadBatchRecord(claim.record, cursor, selected)
  const expectedCursor = encodeEncryptedWalletBackupUploadCursor(cursor)
  const encodedNextCursor = encodeEncryptedWalletBackupUploadCursor(nextCursor)
  let issued: SealedEncryptedWalletBackupUploadBatch | undefined
  let committedAttemptAuthority: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
  let calls = 0
  let open = true
  let returned: unknown
  try {
    const transaction = input.store.sealUploadBatchAndAdvanceCursor(
      {
        claim: cloneActiveUploadAttemptRecord(claim.record),
        expectedCursor: expectedCursor.slice(),
        batch: freezeUploadBatch(batch),
        nextCursor: encodedNextCursor.slice(),
        reservation: uploadBatchReservation,
      },
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('bounded upload batch callback is invalid')
        const committed = requireBoundedUploadBatchCommit(raw)
        if (committed.attempt === null || committed.cursor === null || committed.batch === null)
          throw new Error('bounded upload batch callback is incomplete')
        const committedAttempt = decodeActiveUploadAttemptRecord(committed.attempt)
        const committedCursor = decodeEncryptedWalletBackupUploadCursor(committed.cursor)
        const committedBatch = decodeUploadBatchRecord(committed.batch)
        requireExactBoundedBatchCommit(
          claim.record,
          batch,
          nextCursor,
          committedAttempt,
          committedBatch,
          committedCursor,
        )
        committedAttemptAuthority = committedAttempt
        issued = authorizeUploadBatch(committedBatch, input.keyHandle)
        return issued
      },
    )
    open = false
    if (!isThenable(transaction))
      throw new Error('bounded upload batch must return a transaction promise')
    returned = await transaction
  } finally {
    open = false
  }
  if (issued === undefined || returned !== issued || calls !== 1)
    throw new Error('bounded upload batch must be synchronous and exact')
  if (committedAttemptAuthority === undefined)
    throw new Error('bounded upload batch omitted attempt authority')
  UPLOAD_ATTEMPT_CLAIMS.set(input.claim, {
    keyHandle: input.keyHandle,
    store: input.store,
    record: committedAttemptAuthority,
  })
  BOUNDED_UPLOAD_CURSORS.set(input.claim, nextCursor)
  if (nextCursor.phase === 'complete') INCOMPLETE_BOUNDED_UPLOAD_ATTEMPT_CLAIMS.delete(input.claim)
  return issued
}

export async function rehydrateEncryptedWalletBackupUploadBatch(input: {
  batchId: string
  keyHandle: EncryptedWalletBackupKeyHandle
  store: EncryptedWalletBackupUploadBatchStore
}): Promise<SealedEncryptedWalletBackupUploadBatch> {
  const batchId = requireLowerHex(input.batchId, 16, 'backup upload batch id')
  requireUploadStore(input.store)
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await input.store.readUploadBatch(batchId, (raw) => {
      if (!callbackOpen || callbackCalls++ !== 0)
        throw new Error('backup upload read callback is invalid')
      const committed = decodeUploadBatchRecord(raw)
      if (committed.batchId !== batchId) throw new Error('backup upload batch id does not match')
      validateUploadBatchKey(committed, input.keyHandle)
      const evidence = authorizeUploadBatch(committed, input.keyHandle)
      issued = evidence
      return evidence
    })
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('backup upload read must be synchronous and exact')
  }
  return issued as SealedEncryptedWalletBackupUploadBatch
}

export async function uploadEncryptedWalletBackupBatch(input: {
  batch: SealedEncryptedWalletBackupUploadBatch
  claim: EncryptedWalletBackupUploadAttemptClaim
  store: EncryptedWalletBackupUploadBatchStore
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  clock: EncryptedWalletBackupClock
  objectUrl: (objectId: string) => string
  remote: EncryptedWalletBackupObjectRemotePort
  signal: AbortSignal
  executionLeaseDurationMilliseconds?: number
  runtime?: EncryptedWalletBackupRuntime
}): Promise<SealedEncryptedWalletBackupUploadBatch> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const claim = requireUploadAttemptClaim(input.claim, input.keyHandle, input.store)
  await validateCurrentUploadAttemptClaim(input.store, claim.record, ['active'])
  let authority = requireUploadBatchAuthority(input.batch, input.keyHandle)
  requireSameAttempt(authority.record, claim.record)
  switch (authority.record.state) {
    case 'acknowledged':
      return input.batch
    case 'sealed':
    case 'put-uncertain':
      break
    case 'abort-uncertain':
    case 'finalized':
    case 'abandoned':
      throw new Error('backup upload batch cannot upload from this state')
    default:
      return assertNeverUploadState(authority.record.state)
  }
  if (
    typeof input.objectUrl !== 'function' ||
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.putObject !== 'function'
  ) {
    throw new Error('encrypted backup object remote port is invalid')
  }
  input.batch = await claimUploadBatchExecution(
    input.store,
    input.claim,
    authority.record,
    requireInteger(
      input.executionLeaseDurationMilliseconds ?? 60_000,
      1,
      300_000,
      'backup upload execution lease duration',
    ),
    input.keyHandle,
  )
  authority = requireUploadBatchAuthority(input.batch, input.keyHandle)
  const epoch = requireInteger(
    input.enrollmentEpoch,
    1,
    Number.MAX_SAFE_INTEGER,
    'enrollment epoch',
  )
  if (
    typeof input.clock !== 'object' ||
    input.clock === null ||
    typeof input.clock.nowUnixSeconds !== 'function'
  )
    throw new Error('encrypted backup clock is invalid')
  let nextIndex = 0
  const failures: Array<{ readonly itemIndex: number; readonly error: Error }> = []
  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = nextIndex
      nextIndex += 1
      const item = authority.record.items[index]
      if (item === undefined) return
      try {
        if (item.canonicalPutPayload === null)
          throw new Error('backup PUT payload was compacted too early')
        const issuedAt = requireInteger(
          input.clock.nowUnixSeconds(),
          0,
          Number.MAX_SAFE_INTEGER,
          'request issue time',
        )
        const requestProof = await prepareEncryptedWalletBackupRequestProof({
          keyHandle: input.keyHandle,
          enrollmentEpoch: epoch,
          method: 'PUT',
          url: input.objectUrl(item.objectId),
          issuedAtUnixSeconds: issuedAt,
          expiresAtUnixSeconds: issuedAt + 60,
          payload: item.canonicalPutPayload,
          signal: cycleSignal,
          runtime: input.runtime,
        })
        await validateCurrentUploadBatchExecution(input.store, claim.record, authority.record)
        const response = await awaitEncryptedWalletBackupCycle(
          input.remote.putObject({
            requestProof,
            canonicalPutPayload: item.canonicalPutPayload.slice(),
            signal: cycleSignal,
          }),
          cycleSignal,
        )
        if (response.status !== 'stored' && response.status !== 'already-stored') {
          if (
            response.status === 'quota-exceeded' ||
            response.status === 'rate-limited' ||
            response.status === 'overloaded' ||
            response.status === 'unavailable'
          ) {
            throw new EncryptedWalletBackupRemoteBackoffError(
              response.status,
              response.retryAfterSeconds,
            )
          }
          throw new Error(`encrypted backup object upload failed: ${response.status}`)
        }
      } catch (error) {
        failures.push({
          itemIndex: index,
          error:
            error instanceof Error ? error : new Error('encrypted backup object upload failed'),
        })
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(ENCRYPTED_WALLET_BACKUP_CYCLE_PARALLEL_MAX, authority.record.items.length),
      },
      () => worker(),
    ),
  )
  if (failures.length > 0) throw reduceUploadFailures(failures)
  return transitionUploadBatch(
    input.store,
    input.claim,
    authority.record,
    freezeUploadBatch({
      ...authority.record,
      state: 'acknowledged',
      executionLeaseExpiresAtUnixMilliseconds: null,
      items: authority.record.items.map((item) => ({
        ...item,
        canonicalPutPayload: null,
      })),
    }),
    input.keyHandle,
  )
}

export type BoundedEncryptedWalletBackupUploadCycleResult =
  | Readonly<{
      readonly state: 'upload-pending'
      readonly batch: SealedEncryptedWalletBackupUploadBatch
    }>
  | Readonly<{
      readonly state: 'cas-sealed'
      readonly attempt: SealedEncryptedWalletBackupSyncAttempt
    }>

/**
 * Runs one durable bounded upload cycle. Repeat after `upload-pending` until
 * the persisted cursor is complete. An active batch always wins over planning.
 */
export async function runBoundedEncryptedWalletBackupUploadCycle(input: {
  readonly initialAttempt?: Readonly<{
    readonly attemptId: string
    readonly target: PreparedEncryptedWalletBackupManifestTarget
  }> | null
  readonly ownerId: string
  readonly leaseDurationMilliseconds: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly store: EncryptedWalletBackupUploadAttemptCursorStore &
    EncryptedWalletBackupCoordinatorStore
  readonly source: EncryptedWalletBackupBoundedUploadObjectSource
  readonly enrollmentEpoch: number
  readonly clock: EncryptedWalletBackupClock
  readonly objectUrl: (objectId: string) => string
  readonly remote: EncryptedWalletBackupObjectRemotePort
  readonly signal: AbortSignal
  readonly executionLeaseDurationMilliseconds?: number
  readonly runtime?: EncryptedWalletBackupRuntime
}): Promise<BoundedEncryptedWalletBackupUploadCycleResult> {
  const claim = await claimOrSealBoundedEncryptedWalletBackupUploadAttempt(input)
  const batch = await rehydrateOrPlanBoundedEncryptedWalletBackupUploadBatch(input, claim)
  if (batch === null) return sealBoundedUploadCycleCasAttempt(input, claim)
  const acknowledged = await uploadEncryptedWalletBackupBatch({
    batch,
    claim,
    store: input.store,
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    clock: input.clock,
    objectUrl: input.objectUrl,
    remote: input.remote,
    signal: input.signal,
    executionLeaseDurationMilliseconds: input.executionLeaseDurationMilliseconds,
    runtime: input.runtime,
  })
  if (requireBoundedUploadCursor(claim).phase === 'complete')
    return sealBoundedUploadCycleCasAttempt(input, claim)
  return Object.freeze({ state: 'upload-pending' as const, batch: acknowledged })
}

async function claimOrSealBoundedEncryptedWalletBackupUploadAttempt(input: {
  readonly initialAttempt?: Readonly<{
    readonly attemptId: string
    readonly target: PreparedEncryptedWalletBackupManifestTarget
  }> | null
  readonly ownerId: string
  readonly leaseDurationMilliseconds: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly store: EncryptedWalletBackupUploadAttemptCursorStore
}): Promise<EncryptedWalletBackupUploadAttemptClaim> {
  const claimed = await claimBoundedEncryptedWalletBackupUploadAttempt(input)
  if (claimed !== null) return claimed
  if (input.initialAttempt === null || input.initialAttempt === undefined)
    throw new Error('bounded upload cycle has no active attempt or initial target')
  return sealBoundedEncryptedWalletBackupUploadAttempt({
    ...input,
    attemptId: input.initialAttempt.attemptId,
    target: input.initialAttempt.target,
  })
}

async function rehydrateOrPlanBoundedEncryptedWalletBackupUploadBatch(
  input: Readonly<{
    readonly keyHandle: EncryptedWalletBackupKeyHandle
    readonly store: EncryptedWalletBackupUploadAttemptCursorStore
    readonly source: EncryptedWalletBackupBoundedUploadObjectSource
  }>,
  claim: EncryptedWalletBackupUploadAttemptClaim,
): Promise<SealedEncryptedWalletBackupUploadBatch | null> {
  if (claim.record.activeBatchId !== null)
    return rehydrateEncryptedWalletBackupUploadBatch({
      batchId: claim.record.activeBatchId,
      keyHandle: input.keyHandle,
      store: input.store,
    })
  return planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim,
    keyHandle: input.keyHandle,
    store: input.store,
    source: input.source,
  })
}

async function sealBoundedUploadCycleCasAttempt(
  input: Readonly<{
    readonly keyHandle: EncryptedWalletBackupKeyHandle
    readonly store: EncryptedWalletBackupCoordinatorStore
  }>,
  claim: EncryptedWalletBackupUploadAttemptClaim,
): Promise<BoundedEncryptedWalletBackupUploadCycleResult> {
  const attempt = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim,
    keyHandle: input.keyHandle,
    store: input.store,
  })
  return Object.freeze({ state: 'cas-sealed' as const, attempt })
}

export function deriveEncryptedWalletBackupCasAttemptId(input: {
  realm: string
  vaultId: string
  uploadAttemptId: string
  targetManifestDigest: string
}): string {
  const canonical = encodeCanonical([
    1,
    'backup-cas-attempt-id',
    requireRealm(input.realm),
    hexToBytes(requireLowerHex(input.vaultId, 32, 'backup CAS vault id')),
    hexToBytes(requireLowerHex(input.uploadAttemptId, 16, 'backup upload attempt id')),
    hexToBytes(requireLowerHex(input.targetManifestDigest, 32, 'backup target manifest digest')),
  ])
  return bytesToHex(sha256(canonical).slice(0, 16))
}

/**
 * Atomically finalizes the acknowledged upload partition and journals the
 * deterministic CAS row. Calling this again after restart rehydrates only the
 * exact linked row; callers cannot supply a CAS id, snapshot, or target.
 */
export async function sealOrRehydrateEncryptedWalletBackupCasAttempt(input: {
  claim: EncryptedWalletBackupUploadAttemptClaim
  keyHandle: EncryptedWalletBackupKeyHandle
  store: EncryptedWalletBackupCoordinatorStore
}): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  if (INCOMPLETE_BOUNDED_UPLOAD_ATTEMPT_CLAIMS.has(input.claim))
    throw new Error('bounded upload cursor is not complete')
  const claimAuthority = requireUploadAttemptClaim(input.claim, input.keyHandle, input.store)
  requireCoordinatorStore(input.store)
  const claimed = claimAuthority.record
  if (claimed.activeBatchId !== null)
    throw new Error('backup upload attempt has an active foreground batch')
  if (claimed.lifecycle !== 'active' && claimed.lifecycle !== 'cas-journaled')
    throw new Error('backup upload attempt cannot journal CAS from this state')
  const target = manifestHeadFromUploadAttempt(claimed)
  const attemptId = deriveEncryptedWalletBackupCasAttemptId({
    realm: claimed.realm,
    vaultId: claimed.vaultId,
    uploadAttemptId: claimed.attemptId,
    targetManifestDigest: claimed.targetManifestDigest,
  })
  if (claimed.lifecycle === 'cas-journaled' && claimed.casAttemptId !== attemptId) {
    throw new Error('persisted backup CAS link is not deterministic')
  }
  const canonicalCasPayload = encodeCanonical([
    1,
    'head-cas',
    hexToBytes(claimed.attemptId),
    claimed.parentManifestDigest === null ? null : hexToBytes(claimed.parentManifestDigest),
    claimed.canonicalTargetHead,
    claimed.canonicalTargetReferenceSet,
  ])
  if (canonicalCasPayload.byteLength > ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES) {
    throw new Error('backup CAS payload exceeds the byte limit')
  }
  const candidate: EncryptedWalletBackupSyncAttemptRecord = Object.freeze({
    schemaVersion: 1,
    realm: claimed.realm,
    vaultId: claimed.vaultId,
    attemptId,
    uploadAttemptId: claimed.attemptId,
    localSnapshotId: claimed.localSnapshotId,
    localSnapshotRevision: claimed.localSnapshotRevision,
    expectedHeadDigest: claimed.parentManifestDigest,
    targetHead: target,
    canonicalCasPayload: canonicalCasPayload.slice(),
    casPayloadDigest: bytesToHex(sha256(canonicalCasPayload)),
    casAttempts: 0,
    retryStreak: 0,
    retryNotBeforeUnixMilliseconds: null,
    state: 'sealed',
  })
  let boundStore: EncryptedWalletBackupSyncAttemptStore | undefined
  let committedAttempt: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
  let calls = 0
  let open = true
  let issued: SealedEncryptedWalletBackupSyncAttempt | undefined
  let returned: unknown
  try {
    returned = await input.store.sealOrReadLinkedCasAttempt(
      cloneActiveUploadAttemptRecord(claimed),
      cloneCoordinatorCasRecord(candidate),
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('backup CAS handoff callback is invalid')
        const attempt = decodeActiveUploadAttemptRecord(raw.attempt)
        if (!Array.isArray(raw.batches) || raw.batches.length > 64)
          throw new Error('backup CAS handoff partition is invalid')
        const batches = raw.batches.map(decodeUploadBatchRecord)
        const casAttempt = decodeExactLinkedCasAttempt(attempt, raw.casAttempts)
        validateAggregatePartition(attempt, batches, 'finalized')
        if (
          attempt.lifecycle !== 'cas-journaled' ||
          attempt.casAttemptId !== attemptId ||
          attempt.activeBatchId !== null ||
          !equalActiveUploadAttempt(
            {
              ...claimed,
              activeBatchId: null,
              casAttemptId: attemptId,
              lifecycle: 'cas-journaled',
            },
            attempt,
          ) ||
          !(claimed.lifecycle === 'active'
            ? equalCoordinatorCasRecord(candidate, casAttempt)
            : equalCoordinatorCasIdentity(candidate, casAttempt))
        ) {
          throw new Error('backup CAS handoff changed persisted authority')
        }
        validateFinalizedTargetDelta(attempt, batches)
        committedAttempt = attempt
        boundStore = bindCoordinatorCasStore(input.store, input.claim, input.keyHandle, attempt)
        issued = issueCoordinatedEncryptedWalletBackupCasAttempt(
          casAttempt,
          input.keyHandle,
          boundStore,
        )
        return issued
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || calls !== 1) {
    throw new Error('backup CAS handoff must be synchronous and exact')
  }
  if (committedAttempt === undefined)
    throw new Error('backup CAS handoff did not commit aggregate authority')
  UPLOAD_ATTEMPT_CLAIMS.set(input.claim, {
    keyHandle: input.keyHandle,
    store: input.store,
    record: committedAttempt,
  })
  return issued
}

/**
 * Abandons an incomplete, un-CAS-authorized target after restart. The server
 * tombstones the attempt before its unpinned objects enter bounded garbage
 * collection; local exact payloads are compacted only after that response.
 */
export async function abandonEncryptedWalletBackupUploadAttempt(input: {
  claim: EncryptedWalletBackupUploadAttemptClaim
  store: EncryptedWalletBackupUploadBatchStore
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  url: string
  clock: EncryptedWalletBackupClock
  remote: EncryptedWalletBackupUploadAbortRemotePort
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
}): Promise<AbandonedEncryptedWalletBackupUploadAttempt> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const claim = requireUploadAttemptClaim(input.claim, input.keyHandle, input.store)
  await validateCurrentUploadAttemptClaim(input.store, claim.record, ['active', 'abort-uncertain'])
  let currentAttempt = claim.record
  if (
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.abortUploadAttempt !== 'function' ||
    typeof input.clock !== 'object' ||
    input.clock === null ||
    typeof input.clock.nowUnixSeconds !== 'function'
  ) {
    throw new Error('backup upload abort port is invalid')
  }
  if (claim.record.lifecycle === 'active') {
    currentAttempt = await persistAttemptAbortState(input.store, claim.record, 'abort-uncertain')
  }
  const canonicalAbortPayload = encodeCanonical([
    1,
    'upload-attempt-abort',
    hexToBytes(currentAttempt.attemptId),
    hexToBytes(currentAttempt.targetManifestDigest),
  ])
  structurallyPreflightEncryptedBackupAttemptAbortCbor(canonicalAbortPayload)
  const issuedAt = requireInteger(
    input.clock.nowUnixSeconds(),
    0,
    Number.MAX_SAFE_INTEGER,
    'request issue time',
  )
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: requireInteger(
      input.enrollmentEpoch,
      1,
      Number.MAX_SAFE_INTEGER,
      'enrollment epoch',
    ),
    method: 'DELETE',
    url: input.url,
    issuedAtUnixSeconds: issuedAt,
    expiresAtUnixSeconds: issuedAt + 60,
    payload: canonicalAbortPayload,
    signal: cycleSignal,
    runtime: input.runtime,
  })
  await validateCurrentUploadAttemptClaim(input.store, currentAttempt, ['abort-uncertain'])
  const response = await awaitEncryptedWalletBackupCycle(
    input.remote.abortUploadAttempt({
      requestProof,
      canonicalAbortPayload: canonicalAbortPayload.slice(),
      signal: cycleSignal,
    }),
    cycleSignal,
  )
  if (response.status !== 'abandoned' && response.status !== 'already-abandoned') {
    if (
      response.status === 'rate-limited' ||
      response.status === 'overloaded' ||
      response.status === 'unavailable'
    ) {
      throw new EncryptedWalletBackupRemoteBackoffError(response.status, response.retryAfterSeconds)
    }
    throw new Error(`backup upload abort failed: ${response.status}`)
  }
  const record = await persistAttemptAbortState(input.store, currentAttempt, 'abandoned')
  return Object.freeze({ state: 'abandoned', record })
}

export async function cleanUpRejectedEncryptedWalletBackupFork(input: {
  claim: EncryptedWalletBackupUploadAttemptClaim
  store: EncryptedWalletBackupCoordinatorStore
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  url: string
  clock: EncryptedWalletBackupClock
  remote: EncryptedWalletBackupUploadAbortRemotePort
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
}): Promise<CleanedEncryptedWalletBackupFork> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const claim = requireUploadAttemptClaim(input.claim, input.keyHandle, input.store).record
  requireCoordinatorStore(input.store)
  if (
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.abortUploadAttempt !== 'function' ||
    typeof input.clock !== 'object' ||
    input.clock === null ||
    typeof input.clock.nowUnixSeconds !== 'function'
  ) {
    throw new Error('backup fork cleanup port is invalid')
  }
  if (claim.casAttemptId === null) throw new Error('fork cleanup has no linked CAS attempt')
  const cleanupCas = await readCurrentForkCleanupCasAttempt(input.store, claim)
  const canonicalAbortPayload = encodeCanonical([
    1,
    'upload-attempt-abort',
    hexToBytes(claim.attemptId),
    hexToBytes(claim.targetManifestDigest),
  ])
  structurallyPreflightEncryptedBackupAttemptAbortCbor(canonicalAbortPayload)
  const issuedAt = requireInteger(
    input.clock.nowUnixSeconds(),
    0,
    Number.MAX_SAFE_INTEGER,
    'request issue time',
  )
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: requireInteger(
      input.enrollmentEpoch,
      1,
      Number.MAX_SAFE_INTEGER,
      'enrollment epoch',
    ),
    method: 'DELETE',
    url: input.url,
    issuedAtUnixSeconds: issuedAt,
    expiresAtUnixSeconds: issuedAt + 60,
    payload: canonicalAbortPayload,
    signal: cycleSignal,
    runtime: input.runtime,
  })
  const currentCleanupCas = await readCurrentForkCleanupCasAttempt(input.store, claim)
  if (!equalCoordinatorCasRecord(cleanupCas, currentCleanupCas)) {
    throw new Error('backup fork cleanup authority changed while signing')
  }
  let response: Awaited<
    ReturnType<EncryptedWalletBackupUploadAbortRemotePort['abortUploadAttempt']>
  >
  try {
    response = await awaitEncryptedWalletBackupCycle(
      input.remote.abortUploadAttempt({
        requestProof,
        canonicalAbortPayload: canonicalAbortPayload.slice(),
        signal: cycleSignal,
      }),
      cycleSignal,
    )
  } catch (error) {
    if (error instanceof EncryptedWalletBackupDeadlineError) throw error
    throw new Error('backup fork cleanup is unavailable')
  }
  if (
    response.status !== 'abandoned' &&
    response.status !== 'already-abandoned' &&
    response.status !== 'already-finalized'
  ) {
    if (
      response.status === 'rate-limited' ||
      response.status === 'overloaded' ||
      response.status === 'unavailable'
    ) {
      throw new EncryptedWalletBackupRemoteBackoffError(response.status, response.retryAfterSeconds)
    }
    throw new Error(`backup fork cleanup failed: ${response.status}`)
  }
  const outcome = response.status === 'already-finalized' ? 'already-finalized' : 'abandoned'
  let calls = 0
  let open = true
  let committed: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
  let returned: unknown
  try {
    returned = await input.store.completeForkCleanup(
      cloneActiveUploadAttemptRecord(claim),
      cloneCoordinatorCasRecord(cleanupCas),
      outcome,
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('backup fork cleanup callback is invalid')
        const attempt = decodeActiveUploadAttemptRecord(raw.attempt)
        const casAttempt = decodeExactLinkedCasAttempt(attempt, raw.casAttempts)
        if (!Array.isArray(raw.batches) || raw.batches.length > 64)
          throw new Error('backup fork cleanup partition is invalid')
        const rows = raw.batches.map(decodeUploadBatchRecord)
        const expectedLifecycle = outcome === 'already-finalized' ? 'complete' : 'abandoned'
        if (
          attempt.lifecycle !== expectedLifecycle ||
          attempt.casAttemptId !== casAttempt.attemptId ||
          casAttempt.state !== 'fork-rejected' ||
          !equalCoordinatorCasRecord(cleanupCas, casAttempt)
        ) {
          throw new Error('backup fork cleanup changed terminal authority')
        }
        validateAggregatePartition(
          attempt,
          rows,
          outcome === 'already-finalized' ? 'finalized' : 'abandoned',
        )
        committed = attempt
        return attempt
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || committed === undefined || returned !== committed || calls !== 1) {
    throw new Error('backup fork cleanup must be synchronous and exact')
  }
  UPLOAD_ATTEMPT_CLAIMS.set(input.claim, {
    keyHandle: input.keyHandle,
    store: input.store,
    record: committed,
  })
  return Object.freeze({
    state: committed.lifecycle === 'complete' ? 'complete' : 'abandoned',
    receiptAuthority: 'none' as const,
    record: committed,
  })
}

async function readCurrentForkCleanupCasAttempt(
  store: EncryptedWalletBackupCoordinatorStore,
  expectedAttempt: EncryptedWalletBackupActiveUploadAttemptRecord,
): Promise<EncryptedWalletBackupSyncAttemptRecord> {
  let calls = 0
  let open = true
  let committed: EncryptedWalletBackupSyncAttemptRecord | undefined
  let returned: unknown
  try {
    returned = await store.readLinkedCasAttempts(
      cloneActiveUploadAttemptRecord(expectedAttempt),
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('backup fork cleanup read callback is invalid')
        const attempt = decodeActiveUploadAttemptRecord(raw.attempt)
        if (!equalActiveUploadAttempt(expectedAttempt, attempt)) {
          throw new Error('backup fork cleanup aggregate authority changed')
        }
        committed = decodeExactLinkedCasAttempt(attempt, raw.casAttempts)
        return committed
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || committed === undefined || returned !== committed || calls !== 1) {
    throw new Error('backup fork cleanup read must be synchronous and exact')
  }
  return committed
}

async function persistAttemptAbortState(
  store: EncryptedWalletBackupUploadBatchStore,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  state: 'abort-uncertain' | 'abandoned',
): Promise<EncryptedWalletBackupActiveUploadAttemptRecord> {
  let committed: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
  let calls = 0
  let open = true
  let returned: unknown
  const operation =
    state === 'abort-uncertain'
      ? store.fenceUploadAttemptForAbort.bind(store)
      : store.completeUploadAttemptAbort.bind(store)
  try {
    returned = await operation(cloneActiveUploadAttemptRecord(claim), (raw) => {
      if (!open || calls++ !== 0) throw new Error('backup abort aggregate callback is invalid')
      committed = decodeActiveUploadAttemptRecord(raw.attempt)
      if (!Array.isArray(raw.batches) || raw.batches.length > 64)
        throw new Error('backup abort aggregate batch set is invalid')
      const rows = raw.batches.map(decodeUploadBatchRecord)
      validateAggregatePartition(committed, rows, state)
      if (
        committed.lifecycle !== state ||
        !equalActiveUploadAttempt(
          {
            ...claim,
            activeBatchId: null,
            lifecycle: state,
          },
          committed,
        )
      )
        throw new Error('backup abort aggregate changed')
      return committed
    })
  } finally {
    open = false
  }
  if (isThenable(returned) || committed === undefined || returned !== committed || calls !== 1)
    throw new Error('backup abort aggregate must be synchronous and exact')
  return committed
}

function validateAggregatePartition(
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  rows: readonly EncryptedWalletBackupUploadBatchRecord[],
  state: 'abort-uncertain' | 'abandoned' | 'finalized',
): void {
  if (
    rows.length !== attempt.batchIds.length ||
    new Set(rows.map((row) => row.batchId)).size !== rows.length ||
    attempt.batchIds.some((batchId) => !rows.some((row) => row.batchId === batchId))
  ) {
    throw new Error('backup aggregate batch partition is incomplete')
  }
  const seenIds = new Set<string>()
  const seenDigests = new Set<string>()
  for (const row of rows) {
    if (
      row.state !== state ||
      row.attemptId !== attempt.attemptId ||
      row.targetManifestDigest !== attempt.targetManifestDigest ||
      row.localSnapshotId !== attempt.localSnapshotId ||
      row.localSnapshotRevision !== attempt.localSnapshotRevision ||
      !equalBytes(row.canonicalTargetHead, attempt.canonicalTargetHead) ||
      !equalBytes(row.canonicalTargetReferenceSet, attempt.canonicalTargetReferenceSet) ||
      !equalBytes(row.canonicalInheritedReferenceSet, attempt.canonicalInheritedReferenceSet)
    ) {
      throw new Error('backup aggregate batch partition changed')
    }
    for (const item of row.items) {
      if (seenIds.has(item.objectId) || seenDigests.has(item.objectDigest))
        throw new Error('backup aggregate object reference is duplicated')
      seenIds.add(item.objectId)
      seenDigests.add(item.objectDigest)
    }
  }
}

function validateFinalizedTargetDelta(
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  records: readonly EncryptedWalletBackupUploadBatchRecord[],
): void {
  const targetReferences = decodeReferenceSet(attempt.canonicalTargetReferenceSet)
  const inheritedReferences = decodeReferenceSet(attempt.canonicalInheritedReferenceSet)
  if ([...inheritedReferences].some((reference) => !targetReferences.has(reference))) {
    throw new Error('backup inherited reference is not present in target')
  }
  const requiredUploads = new Set(
    [...targetReferences].filter((reference) => !inheritedReferences.has(reference)),
  )
  const acknowledged = new Set<string>()
  for (const record of records) {
    for (const item of record.items) {
      const reference = `${item.objectId}:${item.objectDigest}`
      if (acknowledged.has(reference))
        throw new Error('backup upload acknowledgement is duplicated')
      acknowledged.add(reference)
    }
  }
  if (
    acknowledged.size !== requiredUploads.size ||
    [...requiredUploads].some((reference) => !acknowledged.has(reference))
  ) {
    throw new Error('backup upload acknowledgements do not cover the target head')
  }
}

function manifestHeadFromUploadAttempt(
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
): EncryptedWalletBackupManifestHead {
  return validateTargetHead(
    attempt.canonicalTargetHead,
    attempt.canonicalTargetReferenceSet,
    attempt.targetManifestDigest,
  ).manifestHead
}

function decodeCoordinatorCasRecord(value: unknown): EncryptedWalletBackupSyncAttemptRecord {
  const raw = requireRecord(value, 'coordinated backup CAS attempt')
  requireKnownFields(raw, [
    'schemaVersion',
    'realm',
    'vaultId',
    'attemptId',
    'uploadAttemptId',
    'localSnapshotId',
    'localSnapshotRevision',
    'expectedHeadDigest',
    'targetHead',
    'canonicalCasPayload',
    'casPayloadDigest',
    'casAttempts',
    'retryStreak',
    'retryNotBeforeUnixMilliseconds',
    'state',
  ])
  if (raw.schemaVersion !== 1) throw new Error('unsupported coordinated backup CAS attempt version')
  const targetHeadRaw = requireRecord(raw.targetHead, 'coordinated CAS target')
  requireKnownFields(targetHeadRaw, [
    'formatVersion',
    'realm',
    'vaultId',
    'backupPublicKey',
    'generation',
    'parent',
    'snapshotNonce',
    'snapshotId',
    'manifestDigest',
    'referenceSetDigest',
    'objectCount',
    'storedBytes',
    'proofCount',
  ])
  const targetParentRaw =
    targetHeadRaw.parent === null ? null : requireRecord(targetHeadRaw.parent, 'target parent')
  if (targetParentRaw !== null)
    requireKnownFields(targetParentRaw, ['generation', 'manifestDigest'])
  const canonicalCasPayload = requireBytesRange(
    raw.canonicalCasPayload,
    1,
    ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
    'coordinated CAS payload',
  ).slice()
  const state = requireOneOf(
    raw.state,
    [
      'sealed',
      'cas-uncertain',
      'retry-cas',
      'retry-exhausted',
      'reconcile-before-retry',
      'acknowledged',
      'fork-rejected',
    ] as const,
    'coordinated CAS state',
  )
  const record: EncryptedWalletBackupSyncAttemptRecord = Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(raw.realm),
    vaultId: requireLowerHex(raw.vaultId, 32, 'coordinated CAS vault id'),
    attemptId: requireLowerHex(raw.attemptId, 16, 'coordinated CAS id'),
    uploadAttemptId: requireLowerHex(raw.uploadAttemptId, 16, 'coordinated CAS upload attempt id'),
    localSnapshotId: requireBoundedText(raw.localSnapshotId, 128, 'coordinated CAS snapshot id'),
    localSnapshotRevision: requireInteger(
      raw.localSnapshotRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      'coordinated CAS snapshot revision',
    ),
    expectedHeadDigest:
      raw.expectedHeadDigest === null
        ? null
        : requireLowerHex(raw.expectedHeadDigest, 32, 'coordinated CAS expected head'),
    targetHead: Object.freeze({
      formatVersion: requireInteger(
        targetHeadRaw.formatVersion,
        1,
        1,
        'coordinated target version',
      ) as 1,
      realm: requireRealm(targetHeadRaw.realm),
      vaultId: requireLowerHex(targetHeadRaw.vaultId, 32, 'target vault id'),
      backupPublicKey: requireLowerHex(
        targetHeadRaw.backupPublicKey,
        32,
        'target backup public key',
      ),
      generation: requireInteger(
        targetHeadRaw.generation,
        1,
        Number.MAX_SAFE_INTEGER,
        'target generation',
      ),
      parent:
        targetParentRaw === null
          ? null
          : Object.freeze({
              generation: requireInteger(
                targetParentRaw.generation,
                1,
                Number.MAX_SAFE_INTEGER,
                'target parent generation',
              ),
              manifestDigest: requireLowerHex(
                targetParentRaw.manifestDigest,
                32,
                'target parent digest',
              ),
            }),
      snapshotNonce: requireLowerHex(targetHeadRaw.snapshotNonce, 16, 'target snapshot nonce'),
      snapshotId: requireLowerHex(targetHeadRaw.snapshotId, 32, 'target snapshot id'),
      manifestDigest: requireLowerHex(targetHeadRaw.manifestDigest, 32, 'target manifest digest'),
      referenceSetDigest: requireLowerHex(
        targetHeadRaw.referenceSetDigest,
        32,
        'target reference digest',
      ),
      objectCount: requireInteger(
        targetHeadRaw.objectCount,
        0,
        ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
        'target object count',
      ),
      storedBytes: requireInteger(
        targetHeadRaw.storedBytes,
        0,
        ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
        'target stored bytes',
      ),
      proofCount: requireInteger(targetHeadRaw.proofCount, 0, 512 * 1_024, 'target proof count'),
    }),
    canonicalCasPayload,
    casPayloadDigest: requireLowerHex(raw.casPayloadDigest, 32, 'coordinated CAS payload digest'),
    casAttempts: requireInteger(
      raw.casAttempts,
      0,
      ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX,
      'CAS attempts',
    ),
    retryStreak: requireInteger(
      raw.retryStreak,
      0,
      ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
      'CAS retry streak',
    ),
    retryNotBeforeUnixMilliseconds:
      raw.retryNotBeforeUnixMilliseconds === null
        ? null
        : requireInteger(
            raw.retryNotBeforeUnixMilliseconds,
            1,
            Number.MAX_SAFE_INTEGER,
            'CAS retry boundary',
          ),
    state,
  })
  if (record.casPayloadDigest !== bytesToHex(sha256(canonicalCasPayload)))
    throw new Error('coordinated CAS payload digest does not match')
  validateEncryptedWalletBackupCasState(record)
  const deterministicId = deriveEncryptedWalletBackupCasAttemptId({
    realm: record.realm,
    vaultId: record.vaultId,
    uploadAttemptId: record.uploadAttemptId,
    targetManifestDigest: record.targetHead.manifestDigest,
  })
  if (record.attemptId !== deterministicId)
    throw new Error('coordinated CAS id is not deterministic')
  preflightEncryptedBackupCasCbor(canonicalCasPayload)
  const payload = decode(canonicalCasPayload)
  if (
    !equalBytes(canonicalCasPayload, encodeCanonical(payload)) ||
    !Array.isArray(payload) ||
    payload.length !== 6 ||
    payload[0] !== 1 ||
    payload[1] !== 'head-cas' ||
    bytesToHex(requireBytes(payload[2], 16, 'CAS upload attempt id')) !== record.uploadAttemptId ||
    (payload[3] === null ? null : bytesToHex(requireBytes(payload[3], 32, 'CAS parent digest'))) !==
      record.expectedHeadDigest
  ) {
    throw new Error('coordinated CAS payload does not match attempt')
  }
  const payloadTarget = validateTargetHead(
    requireBytesRange(payload[4], 1, 65_536, 'CAS target head'),
    requireBytesRange(payload[5], 1, 65_536, 'CAS target references'),
    record.targetHead.manifestDigest,
  )
  if (
    JSON.stringify(payloadTarget.manifestHead) !== JSON.stringify(record.targetHead) ||
    record.targetHead.realm !== record.realm ||
    record.targetHead.vaultId !== record.vaultId ||
    (record.targetHead.parent?.manifestDigest ?? null) !== record.expectedHeadDigest
  ) {
    throw new Error('coordinated CAS target does not match scope')
  }
  return record
}

function cloneCoordinatorCasRecord(
  record: EncryptedWalletBackupSyncAttemptRecord,
): EncryptedWalletBackupSyncAttemptRecord {
  return structuredClone(record)
}

function equalCoordinatorCasRecord(
  left: EncryptedWalletBackupSyncAttemptRecord,
  right: EncryptedWalletBackupSyncAttemptRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.attemptId === right.attemptId &&
    left.uploadAttemptId === right.uploadAttemptId &&
    left.localSnapshotId === right.localSnapshotId &&
    left.localSnapshotRevision === right.localSnapshotRevision &&
    left.expectedHeadDigest === right.expectedHeadDigest &&
    JSON.stringify(left.targetHead) === JSON.stringify(right.targetHead) &&
    equalBytes(left.canonicalCasPayload, right.canonicalCasPayload) &&
    left.casPayloadDigest === right.casPayloadDigest &&
    left.casAttempts === right.casAttempts &&
    left.retryStreak === right.retryStreak &&
    left.retryNotBeforeUnixMilliseconds === right.retryNotBeforeUnixMilliseconds &&
    left.state === right.state
  )
}

function equalCoordinatorCasIdentity(
  left: EncryptedWalletBackupSyncAttemptRecord,
  right: EncryptedWalletBackupSyncAttemptRecord,
): boolean {
  return (
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.attemptId === right.attemptId &&
    left.uploadAttemptId === right.uploadAttemptId &&
    left.localSnapshotId === right.localSnapshotId &&
    left.localSnapshotRevision === right.localSnapshotRevision &&
    left.expectedHeadDigest === right.expectedHeadDigest &&
    JSON.stringify(left.targetHead) === JSON.stringify(right.targetHead) &&
    equalBytes(left.canonicalCasPayload, right.canonicalCasPayload) &&
    left.casPayloadDigest === right.casPayloadDigest
  )
}

function decodeExactLinkedCasAttempt(
  aggregate: EncryptedWalletBackupActiveUploadAttemptRecord,
  value: unknown,
): EncryptedWalletBackupSyncAttemptRecord {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('backup aggregate must have exactly one linked CAS row')
  }
  const record = decodeCoordinatorCasRecord(value[0])
  if (
    aggregate.casAttemptId !== record.attemptId ||
    aggregate.attemptId !== record.uploadAttemptId ||
    aggregate.realm !== record.realm ||
    aggregate.vaultId !== record.vaultId ||
    aggregate.targetManifestDigest !== record.targetHead.manifestDigest ||
    aggregate.parentManifestDigest !== record.expectedHeadDigest ||
    aggregate.localSnapshotId !== record.localSnapshotId ||
    aggregate.localSnapshotRevision !== record.localSnapshotRevision
  ) {
    throw new Error('linked backup CAS immutable identity changed')
  }
  const canonicalAggregateTarget = manifestHeadFromUploadAttempt(aggregate)
  if (JSON.stringify(canonicalAggregateTarget) !== JSON.stringify(record.targetHead)) {
    throw new Error('linked backup CAS target does not match canonical aggregate target')
  }
  validateEncryptedWalletBackupAggregateCasLifecycle({
    lifecycle: aggregate.lifecycle,
    state: record.state,
  })
  return record
}

function bindCoordinatorCasStore(
  coordinator: EncryptedWalletBackupCoordinatorStore,
  claimEvidence: EncryptedWalletBackupUploadAttemptClaim,
  keyHandle: EncryptedWalletBackupKeyHandle,
  initialClaim: EncryptedWalletBackupActiveUploadAttemptRecord,
): EncryptedWalletBackupSyncAttemptStore {
  requireUploadAttemptClaim(claimEvidence, keyHandle, coordinator)
  let currentClaim = cloneActiveUploadAttemptRecord(initialClaim)
  const validateAggregate = (
    raw: unknown,
    allowed: readonly EncryptedWalletBackupActiveUploadAttemptRecord['lifecycle'][],
  ) => {
    const aggregate = decodeActiveUploadAttemptRecord(raw)
    const lifecycleMatches = allowed.includes(aggregate.lifecycle)
    const exactExpected = lifecycleMatches
      ? { ...currentClaim, lifecycle: aggregate.lifecycle }
      : currentClaim
    if (
      aggregate.casAttemptId === null ||
      !lifecycleMatches ||
      !equalActiveUploadAttempt(exactExpected, aggregate)
    ) {
      throw new Error('linked backup aggregate authority changed')
    }
    return aggregate
  }
  const commitAggregate = (aggregate: EncryptedWalletBackupActiveUploadAttemptRecord) => {
    currentClaim = aggregate
    UPLOAD_ATTEMPT_CLAIMS.set(claimEvidence, {
      keyHandle,
      store: coordinator,
      record: aggregate,
    })
  }
  const store: EncryptedWalletBackupSyncAttemptStore = {
    async validatePreparedAttempt<T>(
      expected: EncryptedWalletBackupSyncAttemptRecord,
      read: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
    ): Promise<T> {
      let calls = 0
      let open = true
      let callbackValue: T | undefined
      let returned: unknown
      try {
        returned = await coordinator.validateLinkedCasAttempt(
          cloneActiveUploadAttemptRecord(currentClaim),
          cloneCoordinatorCasRecord(expected),
          (raw) => {
            if (!open || calls++ !== 0) throw new Error('linked CAS read callback is invalid')
            const aggregate = validateAggregate(raw.attempt, ['cas-journaled'])
            const record = decodeExactLinkedCasAttempt(aggregate, raw.casAttempts)
            if (
              aggregate.casAttemptId !== record.attemptId ||
              !equalCoordinatorCasRecord(expected, record)
            ) {
              throw new Error('linked backup CAS authority changed')
            }
            callbackValue = read(record)
            return callbackValue
          },
        )
      } finally {
        open = false
      }
      if (
        isThenable(returned) ||
        callbackValue === undefined ||
        returned !== callbackValue ||
        calls !== 1
      ) {
        throw new Error('linked CAS read must be synchronous and exact')
      }
      return callbackValue
    },
    async transitionPreparedAttempt<T>(
      expected: EncryptedWalletBackupSyncAttemptRecord,
      next: EncryptedWalletBackupSyncAttemptRecord,
      commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
    ): Promise<T> {
      const lifecycle =
        next.state === 'fork-rejected'
          ? 'fork-cleanup-uncertain'
          : next.state === 'acknowledged'
            ? 'complete'
            : 'cas-journaled'
      let calls = 0
      let open = true
      let committedAggregate: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
      let callbackValue: T | undefined
      let returned: unknown
      try {
        const validateCommit = (raw: {
          attempt: EncryptedWalletBackupActiveUploadAttemptRecord
          batches?: readonly EncryptedWalletBackupUploadBatchRecord[]
          casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
        }) => {
          if (!open || calls++ !== 0) throw new Error('linked CAS transition callback is invalid')
          const aggregate = validateAggregate(raw.attempt, [lifecycle])
          const record = decodeExactLinkedCasAttempt(aggregate, raw.casAttempts)
          if (
            aggregate.casAttemptId !== record.attemptId ||
            !equalCoordinatorCasRecord(next, record)
          ) {
            throw new Error('linked backup CAS transition changed')
          }
          if (lifecycle === 'complete') {
            if (!Array.isArray(raw.batches) || raw.batches.length > 64) {
              throw new Error('linked CAS terminal partition is invalid')
            }
            const rows = raw.batches.map(decodeUploadBatchRecord)
            validateAggregatePartition(aggregate, rows, 'finalized')
            validateFinalizedTargetDelta(aggregate, rows)
          }
          committedAggregate = aggregate
          callbackValue = commit(record)
          return callbackValue
        }
        returned =
          lifecycle === 'complete'
            ? await coordinator.completeLinkedCasAttempt(
                cloneActiveUploadAttemptRecord(currentClaim),
                cloneCoordinatorCasRecord(expected),
                cloneCoordinatorCasRecord(next),
                validateCommit,
              )
            : await coordinator.transitionLinkedCasAttempt(
                cloneActiveUploadAttemptRecord(currentClaim),
                cloneCoordinatorCasRecord(expected),
                cloneCoordinatorCasRecord(next),
                lifecycle,
                validateCommit,
              )
      } finally {
        open = false
      }
      if (
        isThenable(returned) ||
        callbackValue === undefined ||
        returned !== callbackValue ||
        calls !== 1 ||
        committedAggregate === undefined
      ) {
        throw new Error('linked CAS transition must be synchronous and exact')
      }
      commitAggregate(committedAggregate)
      return callbackValue
    },
    async exhaustPreparedAttempt<T>(
      expected: EncryptedWalletBackupSyncAttemptRecord,
      next: EncryptedWalletBackupSyncAttemptRecord,
      delayMilliseconds: number,
      commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
    ): Promise<T> {
      let calls = 0
      let open = true
      let committedAggregate: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
      let callbackValue: T | undefined
      let returned: unknown
      try {
        returned = await coordinator.exhaustLinkedCasAttempt(
          cloneActiveUploadAttemptRecord(currentClaim),
          cloneCoordinatorCasRecord(expected),
          cloneCoordinatorCasRecord(next),
          delayMilliseconds,
          (raw) => {
            if (!open || calls++ !== 0) throw new Error('linked CAS exhaustion callback is invalid')
            const aggregate = validateAggregate(raw.attempt, ['cas-journaled'])
            const record = decodeExactLinkedCasAttempt(aggregate, raw.casAttempts)
            if (aggregate.casAttemptId !== record.attemptId)
              throw new Error('linked exhausted CAS attempt changed')
            committedAggregate = aggregate
            callbackValue = commit(record)
            return callbackValue
          },
        )
      } finally {
        open = false
      }
      if (
        isThenable(returned) ||
        callbackValue === undefined ||
        returned !== callbackValue ||
        calls !== 1 ||
        committedAggregate === undefined
      ) {
        throw new Error('linked CAS exhaustion must be synchronous and exact')
      }
      commitAggregate(committedAggregate)
      return callbackValue
    },
    async resumeRetryExhaustedAttempt<T>(
      expected: EncryptedWalletBackupSyncAttemptRecord,
      next: EncryptedWalletBackupSyncAttemptRecord,
      commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
    ): Promise<Readonly<{ state: 'not-ready' }> | Readonly<{ state: 'committed'; value: T }>> {
      let calls = 0
      let open = true
      let committedAggregate: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
      let callbackValue: T | undefined
      let returned: Awaited<
        ReturnType<EncryptedWalletBackupSyncAttemptStore['resumeRetryExhaustedAttempt']>
      >
      try {
        returned = await coordinator.resumeLinkedCasAttempt(
          cloneActiveUploadAttemptRecord(currentClaim),
          cloneCoordinatorCasRecord(expected),
          cloneCoordinatorCasRecord(next),
          (raw) => {
            if (!open || calls++ !== 0) throw new Error('linked CAS resume callback is invalid')
            const aggregate = validateAggregate(raw.attempt, ['cas-journaled'])
            const record = decodeExactLinkedCasAttempt(aggregate, raw.casAttempts)
            if (
              aggregate.casAttemptId !== record.attemptId ||
              !equalCoordinatorCasRecord(next, record)
            ) {
              throw new Error('linked resumed CAS attempt changed')
            }
            committedAggregate = aggregate
            callbackValue = commit(record)
            return callbackValue
          },
        )
      } finally {
        open = false
      }
      if (returned.state === 'not-ready') {
        if (calls !== 0 || callbackValue !== undefined)
          throw new Error('linked CAS not-ready resume invoked its callback')
        return returned
      }
      if (
        callbackValue === undefined ||
        returned.value !== callbackValue ||
        calls !== 1 ||
        committedAggregate === undefined
      ) {
        throw new Error('linked CAS resume must be synchronous and exact')
      }
      commitAggregate(committedAggregate)
      return { state: 'committed', value: callbackValue }
    },
  }
  return Object.freeze(store)
}

function requireCoordinatorStore(
  value: unknown,
): asserts value is EncryptedWalletBackupCoordinatorStore {
  requireUploadStore(value)
  const store = value as EncryptedWalletBackupCoordinatorStore
  if (
    typeof store.sealOrReadLinkedCasAttempt !== 'function' ||
    typeof store.readLinkedCasAttempts !== 'function' ||
    typeof store.validateLinkedCasAttempt !== 'function' ||
    typeof store.transitionLinkedCasAttempt !== 'function' ||
    typeof store.completeLinkedCasAttempt !== 'function' ||
    typeof store.exhaustLinkedCasAttempt !== 'function' ||
    typeof store.resumeLinkedCasAttempt !== 'function' ||
    typeof store.completeForkCleanup !== 'function'
  ) {
    throw new Error('encrypted backup coordinator store is invalid')
  }
}

function decodeReferenceSet(canonical: Uint8Array): Set<string> {
  preflightEncryptedBackupReferenceSetCbor(canonical)
  const decoded = decode(canonical)
  if (
    !equalBytes(canonical, encodeCanonical(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== 1 ||
    decoded[1] !== 'reference-set' ||
    !Array.isArray(decoded[2]) ||
    !Array.isArray(decoded[3])
  ) {
    throw new Error('backup target reference set is invalid')
  }
  const references = new Set<string>()
  const digests = new Set<string>()
  for (const raw of [...decoded[2], ...decoded[3]]) {
    if (!Array.isArray(raw) || raw.length !== 2)
      throw new Error('backup target reference is invalid')
    const objectId = bytesToHex(requireBytes(raw[0], 16, 'backup object id'))
    const digest = bytesToHex(requireBytes(raw[1], 32, 'backup object digest'))
    if ([...references].some((value) => value.startsWith(`${objectId}:`))) {
      throw new Error('backup target object id is duplicated')
    }
    if (digests.has(digest)) {
      throw new Error('backup target object digest is duplicated')
    }
    digests.add(digest)
    references.add(`${objectId}:${digest}`)
  }
  return references
}

function validateTargetHead(
  canonicalHead: Uint8Array,
  canonicalReferenceSet: Uint8Array,
  expectedManifestDigest: string,
): Readonly<{
  references: Set<string>
  pageReferences: readonly Readonly<{ objectId: string; digest: string }>[]
  chunkReferences: readonly Readonly<{ objectId: string; digest: string }>[]
  realm: string
  vaultId: string
  backupPublicKey: string
  generation: number
  objectCount: number
  storedBytes: number
  proofCount: number
  manifestHead: EncryptedWalletBackupManifestHead
}> {
  preflightEncryptedBackupHeadCbor(canonicalHead)
  preflightEncryptedBackupReferenceSetCbor(canonicalReferenceSet)
  const head = decode(canonicalHead)
  const referenceSet = decode(canonicalReferenceSet)
  if (
    !equalBytes(canonicalHead, encodeCanonical(head)) ||
    bytesToHex(sha256(canonicalHead)) !== expectedManifestDigest ||
    !Array.isArray(head) ||
    head.length !== 13 ||
    head[0] !== 1 ||
    head[1] !== 'manifest-head' ||
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    referenceSet[0] !== 1 ||
    referenceSet[1] !== 'reference-set' ||
    !equalBytes(encodeCanonical(head[8]), encodeCanonical(referenceSet[2])) ||
    !equalBytes(encodeCanonical(head[9]), encodeCanonical(referenceSet[3])) ||
    bytesToHex(requireBytes(head[12], 32, 'target reference set digest')) !==
      bytesToHex(sha256(canonicalReferenceSet))
  ) {
    throw new Error('persisted backup target head is invalid')
  }
  const realm = requireRealm(head[2])
  const vaultId = bytesToHex(requireBytes(head[3], 32, 'target vault id'))
  const backupPublicKey = bytesToHex(requireBytes(head[4], 32, 'target request public key'))
  const generation = requireInteger(head[5], 1, Number.MAX_SAFE_INTEGER, 'target generation')
  let parent: EncryptedWalletBackupManifestHead['parent']
  if (head[6] === null) {
    if (generation !== 1) throw new Error('persisted backup target parent is invalid')
    parent = null
  } else if (
    !Array.isArray(head[6]) ||
    head[6].length !== 2 ||
    requireInteger(head[6][0], 1, Number.MAX_SAFE_INTEGER, 'target parent generation') !==
      generation - 1
  ) {
    throw new Error('persisted backup target parent is invalid')
  } else {
    parent = Object.freeze({
      generation: generation - 1,
      manifestDigest: bytesToHex(requireBytes(head[6][1], 32, 'target parent digest')),
    })
  }
  const snapshotNonce = bytesToHex(requireBytes(head[7], 16, 'target snapshot nonce'))
  const pageReferences = decodeTargetReferenceArray(head[8], 'target manifest page references')
  const chunkReferences = decodeTargetReferenceArray(head[9], 'target proof chunk references')
  if (
    pageReferences.length + chunkReferences.length >
    ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX
  ) {
    throw new Error('persisted backup target reference count is invalid')
  }
  for (let index = 1; index < chunkReferences.length; index += 1) {
    if (chunkReferences[index - 1]!.objectId >= chunkReferences[index]!.objectId) {
      throw new Error('persisted backup chunk references are not canonical')
    }
  }
  const allReferences = [...pageReferences, ...chunkReferences]
  if (new Set(allReferences.map((reference) => reference.objectId)).size !== allReferences.length) {
    throw new Error('persisted backup target object id is duplicated')
  }
  if (new Set(allReferences.map((reference) => reference.digest)).size !== allReferences.length) {
    throw new Error('persisted backup target object digest is duplicated')
  }
  const proofCount = requireInteger(head[10], 0, 512 * 1_024, 'target proof count')
  if (
    (proofCount === 0 && allReferences.length !== 0) ||
    (proofCount > 0 && (pageReferences.length === 0 || chunkReferences.length === 0)) ||
    chunkReferences.length < Math.ceil(proofCount / 512) ||
    chunkReferences.length > proofCount ||
    pageReferences.length < Math.ceil(proofCount / 512) ||
    pageReferences.length > proofCount
  ) {
    throw new Error('persisted backup proof count does not match references')
  }
  const storedBytes = requireInteger(
    head[11],
    0,
    ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
    'target stored bytes',
  )
  const expectedStoredBytes =
    pageReferences.length * ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_STORED_BYTES +
    chunkReferences.length * ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_STORED_BYTES
  if (storedBytes !== expectedStoredBytes) {
    throw new Error('persisted backup stored bytes do not match references')
  }
  const referenceSetDigest = bytesToHex(requireBytes(head[12], 32, 'target reference set digest'))
  const manifestHead: EncryptedWalletBackupManifestHead = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm,
    vaultId,
    backupPublicKey,
    generation,
    parent,
    snapshotNonce,
    snapshotId: deriveDurableWalletBackupSnapshotId({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      realm,
      backupPublicKey,
      generation,
      manifestDigest: expectedManifestDigest,
    }),
    manifestDigest: expectedManifestDigest,
    referenceSetDigest,
    objectCount: allReferences.length,
    storedBytes,
    proofCount,
  })
  return Object.freeze({
    references: decodeReferenceSet(canonicalReferenceSet),
    pageReferences: Object.freeze(pageReferences),
    chunkReferences: Object.freeze(chunkReferences),
    realm,
    vaultId,
    backupPublicKey,
    generation,
    objectCount: allReferences.length,
    storedBytes,
    proofCount,
    manifestHead,
  })
}

function validateCanonicalParentHead(
  canonicalParentHead: Uint8Array,
  expectedManifestDigest: string,
): ReturnType<typeof validateTargetHead> {
  try {
    preflightEncryptedBackupHeadCbor(canonicalParentHead)
    const head = decode(canonicalParentHead)
    if (!Array.isArray(head) || head.length !== 13) {
      throw new Error('persisted backup parent head is invalid')
    }
    const canonicalReferenceSet = encodeCanonical([1, 'reference-set', head[8], head[9]])
    return validateTargetHead(canonicalParentHead, canonicalReferenceSet, expectedManifestDigest)
  } catch {
    throw new Error('persisted backup parent head is invalid')
  }
}

function decodeTargetReferenceArray(
  value: unknown,
  name: string,
): Array<{ objectId: string; digest: string }> {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new Error(`${name} are invalid`)
  }
  return value.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error(`${name} are invalid`)
    }
    return {
      objectId: bytesToHex(requireBytes(raw[0], 16, 'backup object id')),
      digest: bytesToHex(requireBytes(raw[1], 32, 'backup object digest')),
    }
  })
}

function validateUploadBatchKey(
  record: EncryptedWalletBackupUploadBatchRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
): void {
  const head = decode(record.canonicalTargetHead)
  if (
    !Array.isArray(head) ||
    head.length !== 13 ||
    head[2] !== keyHandle.realm ||
    bytesToHex(requireBytes(head[3], 32, 'target vault id')) !== keyHandle.vaultId ||
    bytesToHex(requireBytes(head[4], 32, 'target request public key')) !==
      keyHandle.requestAuthPublicKey
  ) {
    throw new Error('persisted backup upload belongs to a foreign key')
  }
}

function validatePutPayload(
  value: unknown[],
  objectDigest: string,
  expected: Readonly<{
    attemptId: string
    realm: string
    vaultId: string
    generation: number
    pageReferences: readonly Readonly<{ objectId: string; digest: string }>[]
  }>,
): void {
  if (bytesToHex(requireBytes(value[2], 16, 'backup upload attempt id')) !== expected.attemptId) {
    throw new Error('backup PUT attempt does not match upload batch')
  }
  const kindValue = requireInteger(value[3], 1, 2, 'backup object kind')
  const kind: 1 | 2 = kindValue === 1 ? 1 : 2
  const realm = value[4]
  if (typeof realm !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(realm)) {
    throw new Error('backup object realm is invalid')
  }
  const vaultId = requireBytes(value[5], 32, 'backup object vault id')
  const objectId = requireBytes(value[6], 16, 'backup object id')
  const generation = requireInteger(
    value[7],
    1,
    Number.MAX_SAFE_INTEGER,
    'backup object generation',
  )
  if (realm !== expected.realm) throw new Error('backup PUT realm does not match target head')
  if (bytesToHex(vaultId) !== expected.vaultId) {
    throw new Error('backup PUT vault does not match target head')
  }
  if (kind === 2 && generation !== expected.generation) {
    throw new Error('backup manifest page generation does not match target head')
  }
  if (kind === 1 && generation > expected.generation) {
    throw new Error('backup proof chunk generation exceeds target head')
  }
  const paddedLength = requireInteger(value[8], 1, 262_144, 'backup object padded length')
  const expectedPaddedLength = kind === 1 ? 262_144 : 65_536
  const expectedBodyLength = kind === 1 ? 262_172 : 65_564
  if (paddedLength !== expectedPaddedLength)
    throw new Error('backup object padded length is invalid')
  const aad = requireBytesRange(value[10], 1, 4_096, 'backup object AAD')
  const body = requireBytes(value[11], expectedBodyLength, 'backup object body')
  try {
    const validatedAad = requireEncryptedWalletBackupObjectAad({
      canonicalAad: aad,
      kindCode: kind,
      realm,
      vaultId: bytesToHex(vaultId),
      objectId: bytesToHex(objectId),
      generation,
      paddedLength: expectedPaddedLength,
    })
    if (validatedAad.kindCode === 2) {
      const reference = expected.pageReferences[validatedAad.pageIndex]
      if (
        reference === undefined ||
        reference.objectId !== bytesToHex(objectId) ||
        reference.digest !== objectDigest ||
        validatedAad.pageCount !== expected.pageReferences.length
      ) {
        throw new Error('manifest page AAD does not match target')
      }
    }
  } catch {
    throw new Error('backup object PUT digest is invalid')
  }
  if (bytesToHex(encryptedWalletBackupObjectDigest(aad, body)) !== objectDigest) {
    throw new Error('backup object PUT digest is invalid')
  }
}

function decodeUploadBatchRecord(value: unknown): EncryptedWalletBackupUploadBatchRecord {
  const raw = requireRecord(value, 'backup upload batch')
  requireKnownFields(raw, [
    'schemaVersion',
    'batchId',
    'attemptId',
    'targetManifestDigest',
    'canonicalTargetHead',
    'canonicalTargetReferenceSet',
    'canonicalInheritedReferenceSet',
    'localSnapshotId',
    'localSnapshotRevision',
    'repackedChunkCount',
    'uploadedBytes',
    'executionEpoch',
    'executionLeaseExpiresAtUnixMilliseconds',
    'items',
    'state',
  ])
  if (raw.schemaVersion !== 1) throw new Error('unsupported backup upload batch version')
  if (
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX
  ) {
    throw new Error('backup upload item count is invalid')
  }
  const targetManifestDigest = requireLowerHex(
    raw.targetManifestDigest,
    32,
    'target manifest digest',
  )
  const canonicalTargetHead = requireBytesRange(
    raw.canonicalTargetHead,
    1,
    65_536,
    'canonical target head',
  ).slice()
  const canonicalTargetReferenceSet = requireBytesRange(
    raw.canonicalTargetReferenceSet,
    1,
    65_536,
    'canonical target reference set',
  ).slice()
  const canonicalInheritedReferenceSet = requireBytesRange(
    raw.canonicalInheritedReferenceSet,
    1,
    65_536,
    'canonical inherited reference set',
  ).slice()
  const target = validateTargetHead(
    canonicalTargetHead,
    canonicalTargetReferenceSet,
    targetManifestDigest,
  )
  const inheritedReferences = decodeReferenceSet(canonicalInheritedReferenceSet)
  const inheritedWire = decode(canonicalInheritedReferenceSet)
  if (
    !Array.isArray(inheritedWire) ||
    !Array.isArray(inheritedWire[2]) ||
    inheritedWire[2].length !== 0
  ) {
    throw new Error('backup inherited references contain manifest pages')
  }
  if ([...inheritedReferences].some((reference) => !target.references.has(reference))) {
    throw new Error('backup inherited reference is not present in target')
  }
  const attemptId = requireLowerHex(raw.attemptId, 16, 'backup attempt id')
  const state = requireOneOf(
    raw.state,
    [
      'sealed',
      'put-uncertain',
      'acknowledged',
      'abort-uncertain',
      'finalized',
      'abandoned',
    ] as const,
    'upload state',
  )
  const seen = new Set<string>()
  const seenDigests = new Set<string>()
  const items = raw.items.map((value) => {
    const item = requireRecord(value, 'backup upload item')
    requireKnownFields(item, ['objectId', 'objectDigest', 'payloadLength', 'canonicalPutPayload'])
    const objectId = requireLowerHex(item.objectId, 16, 'backup object id')
    if (seen.has(objectId)) throw new Error('backup upload object is duplicated')
    seen.add(objectId)
    const objectDigest = requireLowerHex(item.objectDigest, 32, 'backup object digest')
    if (seenDigests.has(objectDigest)) throw new Error('backup upload object digest is duplicated')
    seenDigests.add(objectDigest)
    const payloadLength = requireInteger(
      item.payloadLength,
      1,
      ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
      'backup PUT payload length',
    )
    let canonicalPutPayload: Uint8Array | null = null
    if (item.canonicalPutPayload !== null) {
      canonicalPutPayload = requireBytesRange(
        item.canonicalPutPayload,
        1,
        ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
        'backup object PUT payload',
      ).slice()
      if (canonicalPutPayload.byteLength !== payloadLength) {
        throw new Error('backup PUT payload length does not match')
      }
      preflightEncryptedBackupPutCbor(canonicalPutPayload)
      const decoded = decode(canonicalPutPayload)
      if (
        !equalBytes(canonicalPutPayload, encodeCanonical(decoded)) ||
        !Array.isArray(decoded) ||
        decoded.length !== 12 ||
        decoded[0] !== 1 ||
        decoded[1] !== 'object-put' ||
        bytesToHex(requireBytes(decoded[2], 16, 'backup payload attempt id')) !== attemptId ||
        bytesToHex(requireBytes(decoded[6], 16, 'backup payload object id')) !== objectId
      ) {
        throw new Error('backup object PUT payload is invalid')
      }
      if (
        bytesToHex(requireBytes(decoded[9], 32, 'backup payload object digest')) !== objectDigest
      ) {
        throw new Error('backup object PUT digest does not match')
      }
      validatePutPayload(decoded, objectDigest, {
        attemptId,
        realm: target.realm,
        vaultId: target.vaultId,
        generation: target.generation,
        pageReferences: target.pageReferences,
      })
    }
    if (!target.references.has(`${objectId}:${objectDigest}`)) {
      throw new Error('backup upload object is not referenced by persisted target head')
    }
    return Object.freeze({
      objectId,
      objectDigest,
      payloadLength,
      canonicalPutPayload,
    })
  })
  const uploadedBytes = items.reduce((total, item) => total + item.payloadLength, 0)
  if (
    uploadedBytes !==
    requireInteger(
      raw.uploadedBytes,
      1,
      ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX,
      'uploaded bytes',
    )
  )
    throw new Error('backup upload byte total does not match')
  const executionEpoch = requireInteger(
    raw.executionEpoch,
    0,
    Number.MAX_SAFE_INTEGER,
    'backup upload execution epoch',
  )
  const executionLeaseExpiresAtUnixMilliseconds =
    raw.executionLeaseExpiresAtUnixMilliseconds === null
      ? null
      : requireInteger(
          raw.executionLeaseExpiresAtUnixMilliseconds,
          1,
          Number.MAX_SAFE_INTEGER,
          'backup upload execution lease expiry',
        )
  const payloadCount = items.filter((item) => item.canonicalPutPayload !== null).length
  const allPayloadsPresent = payloadCount === items.length
  const allPayloadsCompacted = payloadCount === 0
  if (
    (state === 'sealed' &&
      (executionEpoch !== 0 ||
        executionLeaseExpiresAtUnixMilliseconds !== null ||
        !allPayloadsPresent)) ||
    (state === 'put-uncertain' &&
      (executionEpoch < 1 ||
        executionLeaseExpiresAtUnixMilliseconds === null ||
        !allPayloadsPresent)) ||
    ((state === 'acknowledged' || state === 'finalized') &&
      (executionEpoch < 1 ||
        executionLeaseExpiresAtUnixMilliseconds !== null ||
        !allPayloadsCompacted)) ||
    (state === 'abandoned' &&
      (executionLeaseExpiresAtUnixMilliseconds !== null || !allPayloadsCompacted)) ||
    (state === 'abort-uncertain' &&
      (executionLeaseExpiresAtUnixMilliseconds !== null ||
        (!allPayloadsPresent && !allPayloadsCompacted) ||
        (allPayloadsCompacted && executionEpoch < 1)))
  ) {
    throw new Error('backup upload execution history is invalid')
  }
  return freezeUploadBatch({
    schemaVersion: 1,
    batchId: requireLowerHex(raw.batchId, 16, 'backup upload batch id'),
    attemptId,
    targetManifestDigest,
    canonicalTargetHead,
    canonicalTargetReferenceSet,
    canonicalInheritedReferenceSet,
    localSnapshotId: requireBoundedText(raw.localSnapshotId, 128, 'local snapshot id'),
    localSnapshotRevision: requireInteger(
      raw.localSnapshotRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      'local snapshot revision',
    ),
    repackedChunkCount: requireInteger(
      raw.repackedChunkCount,
      0,
      ENCRYPTED_WALLET_BACKUP_CYCLE_REPACK_MAX,
      'repacked chunk count',
    ),
    uploadedBytes,
    executionEpoch,
    executionLeaseExpiresAtUnixMilliseconds,
    items,
    state,
  })
}

function decodeActiveUploadAttemptRecord(
  value: unknown,
): EncryptedWalletBackupActiveUploadAttemptRecord {
  const raw = requireRecord(value, 'active backup upload attempt')
  const fields = [
    'schemaVersion',
    'realm',
    'vaultId',
    'ownerId',
    'ownerEpoch',
    'leaseExpiresAtUnixMilliseconds',
    'attemptId',
    'targetManifestDigest',
    'parentManifestDigest',
    'canonicalParentHead',
    'canonicalTargetHead',
    'canonicalTargetReferenceSet',
    'canonicalInheritedReferenceSet',
    'localSnapshotId',
    'localSnapshotRevision',
    'batchIds',
    'activeBatchId',
    'casAttemptId',
    'lifecycle',
  ]
  requireKnownFields(raw, fields)
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.batchIds) || raw.batchIds.length > 64)
    throw new Error('active backup upload attempt is invalid')
  const canonicalTargetHead = requireBytesRange(
    raw.canonicalTargetHead,
    1,
    65_536,
    'active target head',
  ).slice()
  const canonicalTargetReferenceSet = requireBytesRange(
    raw.canonicalTargetReferenceSet,
    1,
    65_536,
    'active target references',
  ).slice()
  const targetManifestDigest = requireLowerHex(raw.targetManifestDigest, 32, 'active target digest')
  const target = validateTargetHead(
    canonicalTargetHead,
    canonicalTargetReferenceSet,
    targetManifestDigest,
  )
  const canonicalInheritedReferenceSet = requireBytesRange(
    raw.canonicalInheritedReferenceSet,
    1,
    65_536,
    'active inherited references',
  ).slice()
  preflightEncryptedBackupReferenceSetCbor(canonicalInheritedReferenceSet)
  const inheritedWire = decode(canonicalInheritedReferenceSet)
  if (
    !Array.isArray(inheritedWire) ||
    !Array.isArray(inheritedWire[2]) ||
    inheritedWire[2].length !== 0
  ) {
    throw new Error('active inherited references contain manifest pages')
  }
  const inherited = decodeReferenceSet(canonicalInheritedReferenceSet)
  if ([...inherited].some((reference) => !target.references.has(reference))) {
    throw new Error('active inherited reference is outside target')
  }
  const decodedHead = decode(canonicalTargetHead)
  const encodedParent = Array.isArray(decodedHead) ? decodedHead[6] : undefined
  const parentManifestDigest =
    encodedParent === null
      ? null
      : Array.isArray(encodedParent) && encodedParent.length === 2
        ? bytesToHex(requireBytes(encodedParent[1], 32, 'active parent digest'))
        : undefined
  if (parentManifestDigest === undefined || raw.parentManifestDigest !== parentManifestDigest) {
    throw new Error('active parent digest does not match target')
  }
  let canonicalParentHead: Uint8Array | null = null
  let parent: ReturnType<typeof validateTargetHead> | null = null
  if (parentManifestDigest === null) {
    if (raw.canonicalParentHead !== null || inherited.size !== 0) {
      throw new Error('genesis upload attempt has parent authority')
    }
  } else {
    canonicalParentHead = requireBytesRange(
      raw.canonicalParentHead,
      1,
      65_536,
      'active canonical parent head',
    ).slice()
    parent = validateCanonicalParentHead(canonicalParentHead, parentManifestDigest)
    if (
      parent.realm !== target.realm ||
      parent.vaultId !== target.vaultId ||
      parent.backupPublicKey !== target.backupPublicKey ||
      parent.generation !== target.generation - 1
    ) {
      throw new Error('active parent head does not match target')
    }
    const parentChunkReferences = new Set(
      parent.chunkReferences.map((reference) => `${reference.objectId}:${reference.digest}`),
    )
    if ([...inherited].some((reference) => !parentChunkReferences.has(reference))) {
      throw new Error('active inherited reference is outside parent')
    }
  }
  const nonInheritedChunkCount = target.chunkReferences.filter(
    (reference) => !inherited.has(`${reference.objectId}:${reference.digest}`),
  ).length
  const nonInheritedTargetDeltaStoredBytes =
    target.pageReferences.length * ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_STORED_BYTES +
    nonInheritedChunkCount * ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_STORED_BYTES
  if (
    (parent?.storedBytes ?? 0) + nonInheritedTargetDeltaStoredBytes >
    ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX
  ) {
    throw new Error('active parent and target delta exceed the stored byte quota')
  }
  const batchIds = raw.batchIds.map((id) => requireLowerHex(id, 16, 'active batch id'))
  if (new Set(batchIds).size !== batchIds.length) throw new Error('active batch id is duplicated')
  const activeBatchId =
    raw.activeBatchId === null
      ? null
      : requireLowerHex(raw.activeBatchId, 16, 'active foreground batch id')
  if (activeBatchId !== null && !batchIds.includes(activeBatchId))
    throw new Error('active foreground batch is outside the attempt ledger')
  const casAttemptId =
    raw.casAttemptId === null
      ? null
      : requireLowerHex(raw.casAttemptId, 16, 'linked CAS attempt id')
  const lifecycle = requireOneOf(
    raw.lifecycle,
    [
      'active',
      'abort-uncertain',
      'cas-journaled',
      'fork-cleanup-uncertain',
      'abandoned',
      'complete',
    ] as const,
    'active lifecycle',
  )
  if (lifecycle !== 'active' && activeBatchId !== null)
    throw new Error('terminal upload attempt retains an active batch')
  if (
    ((lifecycle === 'cas-journaled' ||
      lifecycle === 'fork-cleanup-uncertain' ||
      lifecycle === 'complete') &&
      casAttemptId === null) ||
    ((lifecycle === 'active' || lifecycle === 'abort-uncertain') && casAttemptId !== null)
  ) {
    throw new Error('upload attempt CAS link does not match lifecycle')
  }
  const realm = requireRealm(raw.realm)
  const vaultId = requireLowerHex(raw.vaultId, 32, 'active vault id')
  if (realm !== target.realm || vaultId !== target.vaultId)
    throw new Error('active upload attempt scope does not match target')
  return Object.freeze({
    schemaVersion: 1,
    realm,
    vaultId,
    ownerId: requireBoundedText(raw.ownerId, 128, 'active owner id'),
    ownerEpoch: requireInteger(raw.ownerEpoch, 1, Number.MAX_SAFE_INTEGER, 'active owner epoch'),
    leaseExpiresAtUnixMilliseconds: requireInteger(
      raw.leaseExpiresAtUnixMilliseconds,
      1,
      Number.MAX_SAFE_INTEGER,
      'active lease expiry',
    ),
    attemptId: requireLowerHex(raw.attemptId, 16, 'active attempt id'),
    targetManifestDigest,
    parentManifestDigest,
    canonicalParentHead,
    canonicalTargetHead,
    canonicalTargetReferenceSet,
    canonicalInheritedReferenceSet,
    localSnapshotId: requireBoundedText(raw.localSnapshotId, 128, 'active snapshot id'),
    localSnapshotRevision: requireInteger(
      raw.localSnapshotRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      'active snapshot revision',
    ),
    batchIds: Object.freeze(batchIds),
    activeBatchId,
    casAttemptId,
    lifecycle,
  })
}

function issueUploadAttemptClaim(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
  store: EncryptedWalletBackupUploadBatchStore,
): EncryptedWalletBackupUploadAttemptClaim {
  if (record.realm !== keyHandle.realm || record.vaultId !== keyHandle.vaultId)
    throw new Error('upload attempt belongs to foreign vault')
  const head = decode(record.canonicalTargetHead)
  if (
    !Array.isArray(head) ||
    bytesToHex(requireBytes(head[4], 32, 'active request public key')) !==
      keyHandle.requestAuthPublicKey
  ) {
    throw new Error('upload attempt belongs to foreign backup key')
  }
  const claim = Object.freeze({ state: 'claimed' as const, record })
  UPLOAD_ATTEMPT_CLAIMS.set(claim, { keyHandle, store, record })
  return claim
}

function issueBoundedUploadAttemptClaim(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
  keyHandle: EncryptedWalletBackupKeyHandle,
  store: EncryptedWalletBackupUploadAttemptCursorStore,
): EncryptedWalletBackupUploadAttemptClaim {
  const claim = issueUploadAttemptClaim(record, keyHandle, store)
  BOUNDED_UPLOAD_CURSORS.set(claim, cursor)
  if (cursor.phase !== 'complete') INCOMPLETE_BOUNDED_UPLOAD_ATTEMPT_CLAIMS.add(claim)
  return claim
}

function requireBoundedUploadCursor(
  claim: EncryptedWalletBackupUploadAttemptClaim,
): PersistedEncryptedWalletBackupUploadCursor {
  const cursor = BOUNDED_UPLOAD_CURSORS.get(claim)
  if (cursor === undefined) throw new Error('bounded upload cursor authority is invalid')
  return cursor
}

function requireBoundedClaimPair(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
  keyHandle: EncryptedWalletBackupKeyHandle,
  ownerId: string,
): void {
  if (
    record.realm !== keyHandle.realm ||
    record.vaultId !== keyHandle.vaultId ||
    record.ownerId !== ownerId ||
    (record.lifecycle !== 'active' &&
      record.lifecycle !== 'abort-uncertain' &&
      record.lifecycle !== 'cas-journaled' &&
      record.lifecycle !== 'fork-cleanup-uncertain') ||
    cursor.realm !== record.realm ||
    cursor.vaultId !== record.vaultId ||
    cursor.attemptId !== record.attemptId ||
    cursor.targetManifestDigest !== record.targetManifestDigest
  ) {
    throw new Error('bounded upload attempt claim returned foreign authority')
  }
  requireBoundedCursorPosition(record, cursor)
}

function requireBoundedCursorPosition(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
): void {
  const target = validateTargetHead(
    record.canonicalTargetHead,
    record.canonicalTargetReferenceSet,
    record.targetManifestDigest,
  )
  const inherited = decodeReferenceSet(record.canonicalInheritedReferenceSet)
  const nonInheritedChunkIds = target.chunkReferences
    .filter((reference) => !inherited.has(`${reference.objectId}:${reference.digest}`))
    .map((reference) => reference.objectId)
  const pageCount = target.pageReferences.length
  switch (cursor.phase) {
    case 'pages':
      if (cursor.nextPageIndex >= pageCount)
        throw new Error('bounded upload cursor position is invalid')
      return
    case 'chunks': {
      if (cursor.nextPageIndex !== pageCount || nonInheritedChunkIds.length === 0)
        throw new Error('bounded upload cursor position is invalid')
      if (
        cursor.exclusiveChunkObjectId !== null &&
        (!nonInheritedChunkIds.includes(cursor.exclusiveChunkObjectId) ||
          cursor.exclusiveChunkObjectId === nonInheritedChunkIds.at(-1))
      ) {
        throw new Error('bounded upload cursor position is invalid')
      }
      return
    }
    case 'complete': {
      const finalChunkId = nonInheritedChunkIds.at(-1) ?? null
      const fullyEmpty = pageCount === 0 && finalChunkId === null
      if (
        cursor.nextPageIndex !== pageCount ||
        cursor.exclusiveChunkObjectId !== finalChunkId ||
        (!fullyEmpty && cursor.nextBatchOrdinal === 0)
      ) {
        throw new Error('bounded upload cursor position is invalid')
      }
      return
    }
  }
}

function requireUploadAttemptClaim(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  store: EncryptedWalletBackupUploadBatchStore,
): UploadAttemptClaimAuthority {
  const authority =
    typeof value === 'object' && value !== null ? UPLOAD_ATTEMPT_CLAIMS.get(value) : undefined
  if (authority === undefined || authority.keyHandle !== keyHandle || authority.store !== store)
    throw new Error('backup upload attempt claim is invalid')
  return authority
}

function requireSameAttempt(
  batch: EncryptedWalletBackupUploadBatchRecord,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
): void {
  if (
    batch.attemptId !== claim.attemptId ||
    batch.targetManifestDigest !== claim.targetManifestDigest
  )
    throw new Error('backup batch does not belong to claimed attempt')
}

async function validateCurrentUploadAttemptClaim(
  store: EncryptedWalletBackupUploadBatchStore,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  allowedLifecycle: readonly EncryptedWalletBackupActiveUploadAttemptRecord['lifecycle'][],
): Promise<void> {
  let calls = 0
  let open = true
  let returned: unknown
  let marker: object | undefined
  try {
    returned = await store.validateUploadAttemptClaim(
      cloneActiveUploadAttemptRecord(claim),
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('upload claim validation callback is invalid')
        const current = decodeActiveUploadAttemptRecord(raw)
        if (
          !equalActiveUploadAttempt(claim, current) ||
          !allowedLifecycle.includes(current.lifecycle)
        ) {
          throw new Error('upload claim authority changed')
        }
        marker = Object.freeze({})
        return marker
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || marker === undefined || returned !== marker || calls !== 1)
    throw new Error('upload claim validation must be synchronous and exact')
}

type UploadAttemptCandidate = Omit<
  EncryptedWalletBackupActiveUploadAttemptRecord,
  | 'ownerEpoch'
  | 'leaseExpiresAtUnixMilliseconds'
  | 'batchIds'
  | 'activeBatchId'
  | 'casAttemptId'
  | 'lifecycle'
>

const uploadAttemptCursorReservation: EncryptedWalletBackupUploadAttemptCursorReservation =
  Object.freeze({
    readRows: ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_READ_ROWS_MAX,
    writeRows: ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_WRITE_ROWS_MAX,
    readBytes: ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_BYTES_MAX,
    writeBytes: ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_CURSOR_BYTES_MAX,
  })

const uploadBatchReservation: EncryptedWalletBackupUploadBatchReservation = Object.freeze({
  readRows: ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_READ_ROWS_MAX,
  writeRows: ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_WRITE_ROWS_MAX,
  readBytes: ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  writeBytes: ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
})

function createUploadAttemptCandidate(input: {
  readonly attemptId: string
  readonly ownerId: string
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly target: PreparedEncryptedWalletBackupManifestTarget
}): UploadAttemptCandidate {
  const head = decode(input.target.wire.canonicalHead) as unknown[]
  return Object.freeze({
    schemaVersion: 1 as const,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    ownerId: requireBoundedText(input.ownerId, 128, 'backup upload owner id'),
    attemptId: requireLowerHex(input.attemptId, 16, 'backup attempt id'),
    targetManifestDigest: input.target.head.manifestDigest,
    parentManifestDigest:
      head[6] === null
        ? null
        : bytesToHex(requireBytes((head[6] as unknown[])[1], 32, 'parent digest')),
    canonicalParentHead: input.target.canonicalParentHead?.slice() ?? null,
    canonicalTargetHead: input.target.wire.canonicalHead.slice(),
    canonicalTargetReferenceSet: input.target.wire.canonicalReferenceSet.slice(),
    canonicalInheritedReferenceSet: input.target.canonicalInheritedReferenceSet.slice(),
    localSnapshotId: input.target.localSnapshotId,
    localSnapshotRevision: input.target.localSnapshotRevision,
  })
}

function initialUploadCursor(
  candidate: UploadAttemptCandidate,
  objectCount: number,
): PersistedEncryptedWalletBackupUploadCursor {
  if (!Number.isSafeInteger(objectCount) || objectCount < 0)
    throw new Error('bounded upload attempt target is invalid')
  return Object.freeze({
    schemaVersion: 1 as const,
    realm: candidate.realm,
    vaultId: candidate.vaultId,
    targetManifestDigest: candidate.targetManifestDigest,
    attemptId: candidate.attemptId,
    phase: objectCount === 0 ? ('complete' as const) : ('pages' as const),
    nextPageIndex: 0,
    exclusiveChunkObjectId: null,
    nextBatchOrdinal: 0,
    version: 1,
  })
}

function requireAtomicAttemptCursorCommit(value: unknown): Readonly<{
  readonly attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
  readonly cursor: Uint8Array | null
}> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'attempt') ||
    !Object.hasOwn(value, 'cursor')
  ) {
    throw new Error('bounded upload attempt callback is invalid')
  }
  const committed = value as {
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
    cursor: Uint8Array | null
  }
  if (
    (committed.attempt !== null && typeof committed.attempt !== 'object') ||
    (committed.cursor !== null && !(committed.cursor instanceof Uint8Array))
  ) {
    throw new Error('bounded upload attempt callback is invalid')
  }
  return committed
}

function requireExactInitialUploadAttempt(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
  candidate: UploadAttemptCandidate,
): void {
  if (
    record.attemptId !== candidate.attemptId ||
    record.targetManifestDigest !== candidate.targetManifestDigest ||
    record.ownerId !== candidate.ownerId ||
    record.lifecycle !== 'active' ||
    record.batchIds.length !== 0 ||
    record.activeBatchId !== null ||
    record.casAttemptId !== null ||
    record.realm !== candidate.realm ||
    record.vaultId !== candidate.vaultId ||
    record.parentManifestDigest !== candidate.parentManifestDigest ||
    (record.canonicalParentHead === null || candidate.canonicalParentHead === null
      ? record.canonicalParentHead !== candidate.canonicalParentHead
      : !equalBytes(record.canonicalParentHead, candidate.canonicalParentHead)) ||
    record.localSnapshotId !== candidate.localSnapshotId ||
    record.localSnapshotRevision !== candidate.localSnapshotRevision ||
    !equalBytes(record.canonicalTargetHead, candidate.canonicalTargetHead) ||
    !equalBytes(record.canonicalTargetReferenceSet, candidate.canonicalTargetReferenceSet) ||
    !equalBytes(record.canonicalInheritedReferenceSet, candidate.canonicalInheritedReferenceSet)
  ) {
    throw new Error('sealed upload attempt changed')
  }
}

function equalUploadCursor(
  left: PersistedEncryptedWalletBackupUploadCursor,
  right: PersistedEncryptedWalletBackupUploadCursor,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.targetManifestDigest === right.targetManifestDigest &&
    left.attemptId === right.attemptId &&
    left.phase === right.phase &&
    left.nextPageIndex === right.nextPageIndex &&
    left.exclusiveChunkObjectId === right.exclusiveChunkObjectId &&
    left.nextBatchOrdinal === right.nextBatchOrdinal &&
    left.version === right.version
  )
}

type BoundedUploadReference = Readonly<{
  readonly kindCode: 1 | 2
  readonly objectId: string
  readonly digest: string
}>

type BoundedUploadSelection = Readonly<{
  readonly reference: BoundedUploadReference
  readonly item: EncryptedWalletBackupUploadItemRecord
}>

function requireBoundedUploadObjectSource(
  value: unknown,
): asserts value is EncryptedWalletBackupBoundedUploadObjectSource {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as EncryptedWalletBackupBoundedUploadObjectSource).readManifestPageObject !==
      'function' ||
    typeof (value as EncryptedWalletBackupBoundedUploadObjectSource).readProofChunkObject !==
      'function'
  ) {
    throw new Error('bounded upload object source is invalid')
  }
}

function boundedUploadReferences(
  target: ReturnType<typeof validateTargetHead>,
  inherited: Set<string>,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
): readonly BoundedUploadReference[] {
  const pages = target.pageReferences.map((reference) =>
    Object.freeze({ kindCode: 2 as const, objectId: reference.objectId, digest: reference.digest }),
  )
  const chunks = target.chunkReferences
    .filter((reference) => !inherited.has(`${reference.objectId}:${reference.digest}`))
    .map((reference) =>
      Object.freeze({
        kindCode: 1 as const,
        objectId: reference.objectId,
        digest: reference.digest,
      }),
    )
  switch (cursor.phase) {
    case 'pages':
      return Object.freeze([...pages.slice(cursor.nextPageIndex), ...chunks])
    case 'chunks': {
      const start =
        cursor.exclusiveChunkObjectId === null
          ? 0
          : chunks.findIndex((item) => item.objectId === cursor.exclusiveChunkObjectId) + 1
      return Object.freeze(chunks.slice(start))
    }
    case 'complete':
      return Object.freeze([])
  }
}

async function readBoundedUploadBatchObjects(input: {
  readonly source: EncryptedWalletBackupBoundedUploadObjectSource
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly target: ReturnType<typeof validateTargetHead>
  readonly references: readonly BoundedUploadReference[]
  readonly attemptId: string
}): Promise<readonly BoundedUploadSelection[]> {
  const selected: BoundedUploadSelection[] = []
  let bytes = 0
  let chunks = 0
  for (const reference of input.references) {
    if (selected.length === ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX) break
    if (reference.kindCode === 1 && chunks === ENCRYPTED_WALLET_BACKUP_CYCLE_REPACK_MAX) break
    const maximumPayloadBytes = maximumBoundedCanonicalPutBytes(input, reference)
    if (bytes + maximumPayloadBytes > ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX) break
    const object = await readBoundedUploadObject(input, reference)
    const payload = canonicalBoundedPutPayload(input.attemptId, object)
    selected.push(
      Object.freeze({
        reference,
        item: Object.freeze({
          objectId: reference.objectId,
          objectDigest: reference.digest,
          payloadLength: payload.byteLength,
          canonicalPutPayload: payload,
        }),
      }),
    )
    bytes += payload.byteLength
    if (reference.kindCode === 1) chunks += 1
  }
  if (selected.length === 0) throw new Error('bounded upload object cannot fit a cycle')
  return Object.freeze(selected)
}

async function readBoundedUploadObject(
  input: Parameters<typeof readBoundedUploadBatchObjects>[0],
  reference: BoundedUploadReference,
): Promise<EncryptedWalletBackupWireObject> {
  const query = Object.freeze({
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    generation: input.target.generation,
    objectId: reference.objectId,
    digest: reference.digest,
    maximumRows: 1 as const,
    maximumBytes: 1_048_576 as const,
  })
  const object =
    reference.kindCode === 2
      ? await input.source.readManifestPageObject(query)
      : await input.source.readProofChunkObject(query)
  if (
    object.formatVersion !== ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION ||
    object.kindCode !== reference.kindCode ||
    object.realm !== query.realm ||
    object.vaultId !== query.vaultId ||
    object.generation !== query.generation ||
    object.objectId !== query.objectId ||
    object.digest !== query.digest ||
    object.paddedLength !== (reference.kindCode === 2 ? 65_536 : 262_144)
  ) {
    throw new Error('bounded upload object does not match its target reference')
  }
  const bodyMaximum =
    reference.kindCode === 2
      ? ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES
      : ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  if (
    !(object.aad instanceof Uint8Array) ||
    !(object.body instanceof Uint8Array) ||
    object.aad.byteLength < 1 ||
    object.aad.byteLength > 4_096 ||
    object.body.byteLength < 1 ||
    object.body.byteLength > bodyMaximum ||
    object.aad.byteLength + object.body.byteLength > query.maximumBytes
  ) {
    throw new Error('bounded upload object exceeds its source reservation')
  }
  return Object.freeze({ ...object, aad: object.aad.slice(), body: object.body.slice() })
}

/** Reserves bytes before a source read, so every read object is selected. */
function maximumBoundedCanonicalPutBytes(
  input: Parameters<typeof readBoundedUploadBatchObjects>[0],
  reference: BoundedUploadReference,
): number {
  const paddedLength = reference.kindCode === 2 ? 65_536 : 262_144
  const bodyLength =
    reference.kindCode === 2
      ? ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES
      : ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  return measureEncryptedWalletBackupObjectPutPayload({
    kindCode: reference.kindCode,
    realm: input.keyHandle.realm,
    generation: input.target.generation,
    paddedLength,
    aadByteLength: 4_096,
    bodyByteLength: bodyLength,
  })
}

function canonicalBoundedPutPayload(
  attemptId: string,
  object: EncryptedWalletBackupWireObject,
): Uint8Array {
  const payload = encodeCanonical([
    ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    'object-put',
    hexToBytes(attemptId),
    object.kindCode,
    object.realm,
    hexToBytes(object.vaultId),
    hexToBytes(object.objectId),
    object.generation,
    object.paddedLength,
    hexToBytes(object.digest),
    object.aad,
    object.body,
  ])
  if (payload.byteLength > ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES)
    throw new Error('bounded upload object exceeds the request byte limit')
  return payload
}

function advanceBoundedUploadCursor(
  cursor: PersistedEncryptedWalletBackupUploadCursor,
  target: ReturnType<typeof validateTargetHead>,
  inherited: Set<string>,
  selected: readonly BoundedUploadSelection[],
): PersistedEncryptedWalletBackupUploadCursor {
  const pageCount = target.pageReferences.length
  const nonInheritedChunks = target.chunkReferences.filter(
    (reference) => !inherited.has(`${reference.objectId}:${reference.digest}`),
  )
  const selectedPages = selected.filter((entry) => entry.reference.kindCode === 2).length
  const selectedChunks = selected.filter((entry) => entry.reference.kindCode === 1)
  const nextPageIndex = cursor.nextPageIndex + selectedPages
  const exclusiveChunkObjectId =
    selectedChunks.at(-1)?.reference.objectId ?? cursor.exclusiveChunkObjectId
  const chunkComplete = exclusiveChunkObjectId === nonInheritedChunks.at(-1)?.objectId
  const phase =
    nextPageIndex < pageCount
      ? 'pages'
      : chunkComplete || nonInheritedChunks.length === 0
        ? 'complete'
        : 'chunks'
  if (
    cursor.nextBatchOrdinal >= ENCRYPTED_WALLET_BACKUP_ATTEMPT_BATCH_MAX ||
    cursor.version >= ENCRYPTED_WALLET_BACKUP_ATTEMPT_BATCH_MAX + 1
  ) {
    throw new Error('bounded upload cursor exceeds its batch limit')
  }
  return Object.freeze({
    ...cursor,
    phase,
    nextPageIndex,
    exclusiveChunkObjectId: phase === 'pages' ? null : exclusiveChunkObjectId,
    nextBatchOrdinal: cursor.nextBatchOrdinal + 1,
    version: cursor.version + 1,
  }) as PersistedEncryptedWalletBackupUploadCursor
}

function boundedUploadBatchRecord(
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
  selected: readonly BoundedUploadSelection[],
): EncryptedWalletBackupUploadBatchRecord {
  const items = selected.map((entry) => entry.item)
  return freezeUploadBatch({
    schemaVersion: 1,
    batchId: bytesToHex(
      sha256(
        encodeCanonical([
          1,
          'bounded-upload-batch',
          hexToBytes(attempt.attemptId),
          cursor.nextBatchOrdinal,
        ]),
      ).slice(0, 16),
    ),
    attemptId: attempt.attemptId,
    targetManifestDigest: attempt.targetManifestDigest,
    canonicalTargetHead: attempt.canonicalTargetHead,
    canonicalTargetReferenceSet: attempt.canonicalTargetReferenceSet,
    canonicalInheritedReferenceSet: attempt.canonicalInheritedReferenceSet,
    localSnapshotId: attempt.localSnapshotId,
    localSnapshotRevision: attempt.localSnapshotRevision,
    repackedChunkCount: selected.filter((entry) => entry.reference.kindCode === 1).length,
    uploadedBytes: items.reduce((total, item) => total + item.payloadLength, 0),
    executionEpoch: 0,
    executionLeaseExpiresAtUnixMilliseconds: null,
    items,
    state: 'sealed',
  })
}

function requireBoundedUploadBatchCommit(
  value: unknown,
): EncryptedWalletBackupBoundedUploadBatchCommit {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, 'attempt') ||
    !Object.hasOwn(value, 'cursor') ||
    !Object.hasOwn(value, 'batch')
  )
    throw new Error('bounded upload batch callback is invalid')
  return value as EncryptedWalletBackupBoundedUploadBatchCommit
}

function requireExactBoundedBatchCommit(
  prior: EncryptedWalletBackupActiveUploadAttemptRecord,
  batch: EncryptedWalletBackupUploadBatchRecord,
  nextCursor: PersistedEncryptedWalletBackupUploadCursor,
  attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  committedBatch: EncryptedWalletBackupUploadBatchRecord,
  cursor: PersistedEncryptedWalletBackupUploadCursor,
): void {
  if (prior.activeBatchId !== null)
    throw new Error('bounded upload attempt already has an active batch')
  const expectedAttempt = cloneActiveUploadAttemptRecord({
    ...prior,
    batchIds: Object.freeze(
      prior.batchIds.includes(batch.batchId)
        ? [...prior.batchIds]
        : [...prior.batchIds, batch.batchId],
    ),
    activeBatchId: batch.batchId,
  })
  if (
    !equalActiveUploadAttempt(expectedAttempt, attempt) ||
    !equalUploadBatch(batch, committedBatch) ||
    !equalUploadCursor(nextCursor, cursor)
  )
    throw new Error('bounded upload batch commit changed')
}

function freezeUploadBatch(
  value: EncryptedWalletBackupUploadBatchRecord,
): EncryptedWalletBackupUploadBatchRecord {
  return Object.freeze({
    ...value,
    canonicalTargetHead: value.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: value.canonicalTargetReferenceSet.slice(),
    canonicalInheritedReferenceSet: value.canonicalInheritedReferenceSet.slice(),
    items: Object.freeze(
      value.items.map((item) =>
        Object.freeze({
          ...item,
          canonicalPutPayload: item.canonicalPutPayload?.slice() ?? null,
        }),
      ),
    ),
  })
}

function cloneUploadAttemptCandidate(value: UploadAttemptCandidate): UploadAttemptCandidate {
  return {
    ...value,
    canonicalParentHead: value.canonicalParentHead?.slice() ?? null,
    canonicalTargetHead: value.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: value.canonicalTargetReferenceSet.slice(),
    canonicalInheritedReferenceSet: value.canonicalInheritedReferenceSet.slice(),
  }
}

function cloneActiveUploadAttemptRecord(
  value: EncryptedWalletBackupActiveUploadAttemptRecord,
): EncryptedWalletBackupActiveUploadAttemptRecord {
  return Object.freeze({
    ...value,
    canonicalParentHead: value.canonicalParentHead?.slice() ?? null,
    canonicalTargetHead: value.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: value.canonicalTargetReferenceSet.slice(),
    canonicalInheritedReferenceSet: value.canonicalInheritedReferenceSet.slice(),
    batchIds: Object.freeze([...value.batchIds]),
  })
}

function authorizeUploadBatch(
  record: EncryptedWalletBackupUploadBatchRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
): SealedEncryptedWalletBackupUploadBatch {
  const privateRecord = freezeUploadBatch(record)
  const evidence = Object.freeze({
    state: 'sealed' as const,
    record: freezeUploadBatch(privateRecord),
  })
  UPLOAD_BATCH_AUTHORITIES.set(evidence, { keyHandle, record: privateRecord })
  return evidence
}

function requireUploadBatchAuthority(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
): UploadBatchAuthority {
  const authority =
    typeof value === 'object' && value !== null ? UPLOAD_BATCH_AUTHORITIES.get(value) : undefined
  if (authority === undefined || authority.keyHandle !== keyHandle) {
    throw new Error('backup upload batch is not sealed for this key')
  }
  return authority
}

async function claimUploadBatchExecution(
  store: EncryptedWalletBackupUploadBatchStore,
  claimEvidence: EncryptedWalletBackupUploadAttemptClaim,
  batch: EncryptedWalletBackupUploadBatchRecord,
  leaseDurationMilliseconds: number,
  keyHandle: EncryptedWalletBackupKeyHandle,
): Promise<SealedEncryptedWalletBackupUploadBatch> {
  const claim = requireUploadAttemptClaim(claimEvidence, keyHandle, store).record
  let callbackOpen = true
  let callbackCalls = 0
  let issued: SealedEncryptedWalletBackupUploadBatch | undefined
  let returned: unknown
  try {
    returned = await store.claimUploadBatchExecution(
      cloneActiveUploadAttemptRecord(claim),
      freezeUploadBatch(batch),
      leaseDurationMilliseconds,
      (raw) => {
        if (!callbackOpen || callbackCalls++ !== 0)
          throw new Error('backup upload execution claim callback is invalid')
        const attempt = decodeActiveUploadAttemptRecord(raw.attempt)
        const committed = decodeUploadBatchRecord(raw.batch)
        if (
          !equalActiveUploadAttempt(claim, attempt) ||
          committed.batchId !== batch.batchId ||
          committed.state !== 'put-uncertain' ||
          committed.executionEpoch !== batch.executionEpoch + 1 ||
          committed.executionLeaseExpiresAtUnixMilliseconds === null ||
          !equalUploadBatch(
            {
              ...batch,
              state: 'put-uncertain',
              executionEpoch: committed.executionEpoch,
              executionLeaseExpiresAtUnixMilliseconds:
                committed.executionLeaseExpiresAtUnixMilliseconds,
            },
            committed,
          )
        ) {
          throw new Error('backup upload execution claim changed')
        }
        issued = authorizeUploadBatch(committed, keyHandle)
        return issued
      },
    )
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('backup upload execution claim must be synchronous and exact')
  }
  return issued
}

async function validateCurrentUploadBatchExecution(
  store: EncryptedWalletBackupUploadBatchStore,
  claim: EncryptedWalletBackupActiveUploadAttemptRecord,
  batch: EncryptedWalletBackupUploadBatchRecord,
): Promise<void> {
  let calls = 0
  let open = true
  let returned: unknown
  let marker: object | undefined
  try {
    returned = await store.validateUploadBatchExecution(
      cloneActiveUploadAttemptRecord(claim),
      freezeUploadBatch(batch),
      (raw) => {
        if (!open || calls++ !== 0)
          throw new Error('upload execution validation callback is invalid')
        const currentAttempt = decodeActiveUploadAttemptRecord(raw.attempt)
        const currentBatch = decodeUploadBatchRecord(raw.batch)
        if (
          !equalActiveUploadAttempt(claim, currentAttempt) ||
          !equalUploadBatch(batch, currentBatch) ||
          currentBatch.state !== 'put-uncertain' ||
          currentBatch.executionLeaseExpiresAtUnixMilliseconds === null
        ) {
          throw new Error('upload execution authority changed')
        }
        marker = Object.freeze({})
        return marker
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || marker === undefined || returned !== marker || calls !== 1) {
    throw new Error('upload execution validation must be synchronous and exact')
  }
}

async function transitionUploadBatch(
  store: EncryptedWalletBackupUploadBatchStore,
  claimEvidence: EncryptedWalletBackupUploadAttemptClaim,
  expected: EncryptedWalletBackupUploadBatchRecord,
  next: EncryptedWalletBackupUploadBatchRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
): Promise<SealedEncryptedWalletBackupUploadBatch> {
  const claim = requireUploadAttemptClaim(claimEvidence, keyHandle, store).record
  requireUploadStore(store)
  validateUploadBatchTransition(expected, next)
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let committedAttemptAuthority: EncryptedWalletBackupActiveUploadAttemptRecord | undefined
  let returned: unknown
  try {
    returned = await store.transitionUploadBatch(
      cloneActiveUploadAttemptRecord(claim),
      freezeUploadBatch(expected),
      freezeUploadBatch(next),
      (raw) => {
        if (!callbackOpen || callbackCalls++ !== 0)
          throw new Error('backup upload transition callback is invalid')
        const committedAttempt = decodeActiveUploadAttemptRecord(raw.attempt)
        const committed = decodeUploadBatchRecord(raw.batch)
        if (!equalUploadBatch(committed, next))
          throw new Error('committed backup upload transition changed')
        const expectedAttempt =
          next.state === 'acknowledged' ? { ...claim, activeBatchId: null } : claim
        if (!equalActiveUploadAttempt(expectedAttempt, committedAttempt))
          throw new Error('committed backup upload attempt changed')
        committedAttemptAuthority = committedAttempt
        const evidence = authorizeUploadBatch(committed, keyHandle)
        issued = evidence
        return evidence
      },
    )
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('backup upload transition must be synchronous and exact')
  }
  if (committedAttemptAuthority === undefined)
    throw new Error('backup upload transition omitted aggregate authority')
  UPLOAD_ATTEMPT_CLAIMS.set(claimEvidence, {
    keyHandle,
    store,
    record: committedAttemptAuthority,
  })
  return issued as SealedEncryptedWalletBackupUploadBatch
}

function validateUploadBatchTransition(
  expected: EncryptedWalletBackupUploadBatchRecord,
  next: EncryptedWalletBackupUploadBatchRecord,
): void {
  const allowed = (() => {
    switch (expected.state) {
      case 'sealed':
        return next.state === 'put-uncertain' || next.state === 'abort-uncertain'
      case 'put-uncertain':
        return next.state === 'acknowledged' || next.state === 'abort-uncertain'
      case 'acknowledged':
        return next.state === 'abort-uncertain'
      case 'abort-uncertain':
        return next.state === 'abandoned'
      case 'finalized':
      case 'abandoned':
        return false
      default:
        return assertNeverUploadState(expected.state)
    }
  })()
  if (!allowed) throw new Error('backup upload transition is invalid')
}

function assertNeverUploadState(value: never): never {
  throw new Error(`unsupported backup upload state: ${String(value)}`)
}

function equalUploadBatch(
  left: EncryptedWalletBackupUploadBatchRecord,
  right: EncryptedWalletBackupUploadBatchRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.batchId === right.batchId &&
    left.attemptId === right.attemptId &&
    left.targetManifestDigest === right.targetManifestDigest &&
    equalBytes(left.canonicalTargetHead, right.canonicalTargetHead) &&
    equalBytes(left.canonicalTargetReferenceSet, right.canonicalTargetReferenceSet) &&
    equalBytes(left.canonicalInheritedReferenceSet, right.canonicalInheritedReferenceSet) &&
    left.localSnapshotId === right.localSnapshotId &&
    left.localSnapshotRevision === right.localSnapshotRevision &&
    left.repackedChunkCount === right.repackedChunkCount &&
    left.uploadedBytes === right.uploadedBytes &&
    left.executionEpoch === right.executionEpoch &&
    left.executionLeaseExpiresAtUnixMilliseconds ===
      right.executionLeaseExpiresAtUnixMilliseconds &&
    left.state === right.state &&
    left.items.length === right.items.length &&
    left.items.every((item, index) => {
      const other = right.items[index]!
      return (
        item.objectId === other.objectId &&
        item.objectDigest === other.objectDigest &&
        item.payloadLength === other.payloadLength &&
        (item.canonicalPutPayload === null || other.canonicalPutPayload === null
          ? item.canonicalPutPayload === other.canonicalPutPayload
          : equalBytes(item.canonicalPutPayload, other.canonicalPutPayload))
      )
    })
  )
}

function equalActiveUploadAttempt(
  expected: EncryptedWalletBackupActiveUploadAttemptRecord,
  actual: EncryptedWalletBackupActiveUploadAttemptRecord,
): boolean {
  return (
    expected.schemaVersion === actual.schemaVersion &&
    expected.realm === actual.realm &&
    expected.vaultId === actual.vaultId &&
    expected.ownerId === actual.ownerId &&
    expected.ownerEpoch === actual.ownerEpoch &&
    expected.leaseExpiresAtUnixMilliseconds === actual.leaseExpiresAtUnixMilliseconds &&
    expected.attemptId === actual.attemptId &&
    expected.targetManifestDigest === actual.targetManifestDigest &&
    expected.parentManifestDigest === actual.parentManifestDigest &&
    (expected.canonicalParentHead === null || actual.canonicalParentHead === null
      ? expected.canonicalParentHead === actual.canonicalParentHead
      : equalBytes(expected.canonicalParentHead, actual.canonicalParentHead)) &&
    equalBytes(expected.canonicalTargetHead, actual.canonicalTargetHead) &&
    equalBytes(expected.canonicalTargetReferenceSet, actual.canonicalTargetReferenceSet) &&
    equalBytes(expected.canonicalInheritedReferenceSet, actual.canonicalInheritedReferenceSet) &&
    expected.localSnapshotId === actual.localSnapshotId &&
    expected.localSnapshotRevision === actual.localSnapshotRevision &&
    expected.activeBatchId === actual.activeBatchId &&
    expected.casAttemptId === actual.casAttemptId &&
    expected.lifecycle === actual.lifecycle &&
    expected.batchIds.length === actual.batchIds.length &&
    expected.batchIds.every((batchId, index) => batchId === actual.batchIds[index])
  )
}

function requireUploadStore(
  value: unknown,
): asserts value is EncryptedWalletBackupUploadBatchStore {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).validateUploadAttemptClaim !==
      'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).claimUploadBatchExecution !==
      'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).validateUploadBatchExecution !==
      'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).readUploadBatch !== 'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).transitionUploadBatch !== 'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).fenceUploadAttemptForAbort !==
      'function' ||
    typeof (value as EncryptedWalletBackupUploadBatchStore).completeUploadAttemptAbort !==
      'function'
  ) {
    throw new Error('backup upload batch store is invalid')
  }
}

function requireUploadAttemptCursorStore(
  value: unknown,
): asserts value is EncryptedWalletBackupUploadAttemptCursorStore {
  requireUploadStore(value)
  if (
    typeof (value as EncryptedWalletBackupUploadAttemptCursorStore)
      .sealActiveUploadAttemptAndCursor !== 'function' ||
    typeof (value as EncryptedWalletBackupUploadAttemptCursorStore)
      .claimActiveUploadAttemptAndCursor !== 'function' ||
    typeof (value as EncryptedWalletBackupUploadAttemptCursorStore)
      .sealUploadBatchAndAdvanceCursor !== 'function'
  ) {
    throw new Error('backup upload attempt cursor store is invalid')
  }
}

function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error('backup realm is invalid')
  }
  return value
}

function reduceUploadFailures(
  failures: readonly {
    readonly itemIndex: number
    readonly error: Error
  }[],
): Error {
  const fatal = failures
    .filter((failure) => !(failure.error instanceof EncryptedWalletBackupRemoteBackoffError))
    .sort((left, right) => left.itemIndex - right.itemIndex)[0]
  if (fatal !== undefined) return fatal.error

  const precedence: Record<EncryptedWalletBackupRemoteBackoffError['status'], number> = {
    'quota-exceeded': 4,
    'rate-limited': 3,
    overloaded: 2,
    unavailable: 1,
  }
  const selected = failures
    .map((failure) => ({
      itemIndex: failure.itemIndex,
      error: failure.error as EncryptedWalletBackupRemoteBackoffError,
    }))
    .sort(
      (left, right) =>
        right.error.delayMilliseconds() - left.error.delayMilliseconds() ||
        precedence[right.error.status] - precedence[left.error.status] ||
        left.itemIndex - right.itemIndex,
    )[0]
  if (selected === undefined) throw new Error('encrypted backup upload failure set is empty')
  return selected.error
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function requireKnownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((field) => !fields.includes(field)))
    throw new Error('backup upload record has unknown fields')
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}

function requireBoundedText(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`${name} is invalid`)
  return value
}

function requireBytesRange(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  name: string,
): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) throw new Error(`${name} is invalid`)
  return value as T[number]
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof (value as PromiseLike<unknown>).then === 'function'
    : false
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!
  return difference === 0
}
