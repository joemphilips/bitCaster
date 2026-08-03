import * as Cashu from '@cashu/cashu-ts'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from './durableCustody.ts'
import {
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  readAuthenticatedCtfRedeemTerminalEvidence,
  type AuthenticatedCtfRedeemTerminalEvidence,
} from './ctfRedeem.ts'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  measureCanonicalBackupCbor as measureCanonicalCbor,
  preflightEncryptedBackupRequestProofCbor,
  preflightEncryptedManifestPageCbor as preflightManifestPage,
  preflightEncryptedProofChunkCbor as preflightProofChunk,
} from './encryptedWalletBackupCbor.ts'
import {
  classifyDurableWalletStorage,
  decodeDurableWalletAcknowledgedBackupSnapshot,
  decodeDurableWalletEncryptedBackupReceipt,
  decodeDurableWalletStorageClassification,
  deriveDurableWalletBackupSnapshotId,
  verifyDurableWalletLosingCtfClassification,
  type DurableWalletAcknowledgedBackupSnapshotEvidence,
  type DurableWalletAuthenticatedBackupReceiptEvidence,
  type DurableWalletStorageClassification,
  type DurableWalletVerifiedLosingCtfClassification,
} from './recoverableWalletStorage.ts'
import { issueDurableWalletVerifiedLosingCtfClassification } from './walletStorageAuthority.ts'
import {
  issueDurableWalletAcknowledgedBackupSnapshot,
  issueDurableWalletAuthenticatedBackupReceipt,
} from './encryptedWalletBackupAuthority.ts'
import {
  registerEncryptedWalletBackupKeyHandle,
  requireIssuedEncryptedWalletBackupKeyHandle,
} from './encryptedWalletBackupKeyAuthority.ts'
import { issuePreparedEncryptedWalletBackupUploadAuthority } from './encryptedWalletBackupPlanningAuthority.ts'
import { registerEncryptedWalletBackupPreparedRecordValidator } from './encryptedWalletBackupPreparedRecordValidation.ts'
import {
  ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
  issuePreparedEncryptedWalletBackupRecord,
  type PreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupRecord.ts'
import {
  issueCoordinatedEncryptedWalletBackupCasAttempt,
  readCoordinatedEncryptedWalletBackupCasAuthority,
} from './encryptedWalletBackupCasAuthority.ts'
import {
  ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX,
  ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
  validateEncryptedWalletBackupCasState,
} from './encryptedWalletBackupCasState.ts'
import {
  ENCRYPTED_WALLET_BACKUP_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
  validateEncryptedWalletBackupManifestHeadUnit,
} from './encryptedWalletBackupManifestHead.ts'
import { ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupLimits.ts'
import {
  awaitEncryptedWalletBackupCycle,
  EncryptedWalletBackupDeadlineError,
  requireEncryptedWalletBackupCycleSignal,
  throwIfEncryptedWalletBackupCycleAborted,
} from './encryptedWalletBackupDeadline.ts'
import {
  ENCRYPTED_WALLET_BACKUP_RETRY_BASE_MILLISECONDS,
  ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  planEncryptedWalletBackupRetry,
} from './encryptedWalletBackupRetrySchedule.ts'
import {
  compareEncryptedWalletBackupRestoreTupleText,
  groupEncryptedWalletBackupRestoreRecordsByMintUnit,
} from './encryptedWalletBackupRestore.ts'
export { EncryptedWalletBackupDeadlineError } from './encryptedWalletBackupDeadline.ts'
export {
  ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX,
  ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
} from './encryptedWalletBackupCasState.ts'
export {
  ENCRYPTED_WALLET_BACKUP_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
} from './encryptedWalletBackupManifestHead.ts'
export { ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupLimits.ts'
export {
  ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
  type EncryptedWalletBackupRecordKindCode,
  type PreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupRecord.ts'

export const ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION = 1 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND = 1 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND = 2 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND_RESERVED = ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND
export const ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES = 262_144 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES = 65_536 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED =
  ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES
export const ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES = 245_760 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES = 65_532 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED =
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES

const ROOT_SALT = new TextEncoder().encode('bitcaster/encrypted-wallet-backup/hkdf-salt/v1')
const REALM_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER
const UINT64_MAX = 18_446_744_073_709_551_615n
const REQUEST_SCALAR_ATTEMPTS = 256
const OBJECT_ID_COLLISION_ATTEMPTS = 8

type SecretDeriver = (counter: number) => {
  secret: Uint8Array
  blindingFactor: Uint8Array
}

export interface EncryptedWalletBackupRuntime {
  subtle: SubtleCrypto
  getRandomValues(target: Uint8Array): Uint8Array
}

export interface EncryptedWalletBackupClock {
  nowUnixSeconds(): number
}

export type EncryptedWalletBackupRemoteBackoffStatus =
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'

/** Base class for redacted remote failures that are safe to schedule. */
export class EncryptedWalletBackupRemoteFailureError extends Error {}

/** A redacted, typed handoff that lets the host durably schedule maintenance. */
export class EncryptedWalletBackupRemoteBackoffError extends EncryptedWalletBackupRemoteFailureError {
  readonly status: EncryptedWalletBackupRemoteBackoffStatus
  readonly retryAfterSeconds: number | null

  constructor(status: EncryptedWalletBackupRemoteBackoffStatus, retryAfterSeconds?: number | null) {
    if (
      status !== 'quota-exceeded' &&
      status !== 'rate-limited' &&
      status !== 'overloaded' &&
      status !== 'unavailable'
    ) {
      throw new Error('encrypted backup backoff status is invalid')
    }
    if (status === 'quota-exceeded' && retryAfterSeconds != null) {
      throw new Error('encrypted backup quota backoff must not include retry-after')
    }
    if (
      retryAfterSeconds !== undefined &&
      retryAfterSeconds !== null &&
      (!Number.isSafeInteger(retryAfterSeconds) ||
        retryAfterSeconds < 1 ||
        retryAfterSeconds > 3_600)
    ) {
      throw new Error('encrypted backup retry-after is invalid')
    }
    super(`encrypted backup remote backoff: ${status}`)
    this.name = 'EncryptedWalletBackupRemoteBackoffError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds ?? null
  }

  delayMilliseconds(defaultMilliseconds = 5_000): number {
    const fallback = requireInteger(
      defaultMilliseconds,
      1,
      3_600_000,
      'encrypted backup default backoff',
    )
    return this.retryAfterSeconds === null ? fallback : this.retryAfterSeconds * 1_000
  }
}

export interface EncryptedWalletBackupKeyHandle {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
}

export type EncryptedWalletBackupRequestMethod = 'GET' | 'PUT' | 'POST' | 'DELETE'

export interface EncryptedWalletBackupRequestProof {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
  readonly enrollmentEpoch: number
  readonly method: EncryptedWalletBackupRequestMethod
  readonly url: string
  readonly issuedAtUnixSeconds: number
  readonly expiresAtUnixSeconds: number
  readonly replayNonce: string
  readonly payloadLength: number
  readonly payloadDigest: string
  readonly signature: string
}

export interface EncryptedWalletBackupReplayStore {
  consumeReplayNonce(input: {
    realm: string
    vaultId: string
    requestAuthPublicKey: string
    enrollmentEpoch: number
    replayNonce: string
    expiresAtUnixSeconds: number
    requestDigest: string
  }): Promise<'consumed' | 'replayed'>
}

export interface AuthenticatedEncryptedWalletBackupRequestEvidence {
  readonly state: 'authenticated'
  readonly requestDigest: string
  readonly replayNonce: string
}

export interface VerifiedEncryptedWalletBackupRequestProofEvidence {
  readonly state: 'verified'
  readonly claims: EncryptedWalletBackupRequestProof
}

/** Typed nonce-reuse rejection; preserves the legacy error message. */
export class EncryptedWalletBackupReplayRejectedError extends Error {
  constructor() {
    super('encrypted backup request replayed')
    this.name = 'EncryptedWalletBackupReplayRejectedError'
  }
}

/** Redacted replay-store outage for server adapters to map to HTTP 503. */
export class EncryptedWalletBackupReplayStoreUnavailableError extends Error {
  constructor() {
    super('encrypted backup replay store unavailable')
    this.name = 'EncryptedWalletBackupReplayStoreUnavailableError'
  }
}

const AUTHENTICATED_BACKUP_REQUESTS = new WeakMap<object, EncryptedWalletBackupRequestProof>()
const VERIFIED_BACKUP_REQUEST_PROOFS = new WeakMap<
  object,
  Readonly<{
    proof: EncryptedWalletBackupRequestProof
    requestDigest: string
  }>
>()
const PREPARED_BACKUP_REQUESTS = new WeakMap<object, KeyAuthority>()
const PREPARED_BACKUP_REQUEST_SIGNALS = new WeakMap<object, AbortSignal>()

interface KeyAuthority {
  readonly realm: string
  readonly seedDigest: Uint8Array
  readonly encryptionRoot: Uint8Array
  readonly requestAuthRoot: Uint8Array
  readonly vaultIdBytes: Uint8Array
  readonly runtime: EncryptedWalletBackupRuntime
  readonly derivers: Map<string, SecretDeriver>
  readonly preparedObjectIds: Set<string>
}

const KEY_AUTHORITIES = new WeakMap<object, KeyAuthority>()

export interface EncryptedWalletBackupCtfMetadata {
  conditionId: string
  outcomeLabel: string
  outcomeCollectionId: string
  registeredAtUnixSeconds: number
  finalExpiryUnixSeconds: number
}

export interface EncryptedWalletBackupCtfTerminalEvidence {
  readonly reason: 'verified-losing-outcome'
  readonly operationIdDigest: string
  readonly requestDigest: string
  readonly failureCode: 13015
  readonly classifiedAt: number
}

type EncryptedWalletBackupCtfTerminalSeal = [1, Uint8Array, Uint8Array, 13015, number]

type EncryptedWalletBackupCtfBase = [Uint8Array, string, Uint8Array, number, number]

type EncryptedWalletBackupCtfWire = [
  ...EncryptedWalletBackupCtfBase,
  EncryptedWalletBackupCtfTerminalSeal | null,
]

export interface VerifiedEncryptedWalletBackupConditionalKeyset {
  readonly keysetId: string
}

interface ConditionalKeysetAuthority {
  readonly mint: string
  readonly unit: string
  readonly keysetId: string
  readonly conditionId: string
  readonly outcomeLabel: string
  readonly outcomeCollectionId: string
  readonly registeredAtUnixSeconds: number
  readonly curve: 'secp256k1' | 'bls12-381'
  readonly finalExpiryUnixSeconds: number
}

const VERIFIED_CONDITIONAL_KEYSETS = new WeakMap<object, ConditionalKeysetAuthority>()

export interface EncryptedWalletBackupCommittedProofSnapshot {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly revision: number
  readonly proofId: string
  readonly proofCommitment: string
  readonly proofKind: EncryptedWalletBackupProofKind
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly terminalOperationId: string | null
  readonly conditionalKeysetEvidence: VerifiedEncryptedWalletBackupConditionalKeyset | null
  readonly provenance: 'wallet-seed' | 'external' | 'unknown'
  readonly operationBinding: 'terminally-unlinked' | 'nonterminal' | 'unknown'
  readonly reserved: boolean
  readonly ambiguousMintOperation: boolean
  readonly proofPins: EncryptedWalletBackupProofPins
  readonly derivationLocator: 'committed' | 'missing'
}

type EncryptedWalletBackupProofKind = 'ordinary' | 'ctf' | 'p2pk' | 'htlc' | 'unknown'
interface EncryptedWalletBackupProofPins {
  readonly openOrderCollateral: 'absent' | 'present' | 'unknown'
  readonly outbox: 'absent' | 'present' | 'unknown'
  readonly retryCursor: 'absent' | 'present' | 'unknown'
  readonly replayTombstone: 'absent' | 'present' | 'unknown'
  readonly dependentWork: 'absent' | 'present' | 'unknown'
}

export interface EncryptedWalletBackupProofSnapshotStore {
  withCommittedProofSnapshot<T>(
    stableProofId: string,
    read: (row: EncryptedWalletBackupCommittedProofSnapshot) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupCommittedSnapshotSeal {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly proofCount: number
  readonly proofSetDigest: string
}

export interface EncryptedWalletBackupSnapshotSealStore {
  sealCommittedBackupSnapshot<T>(
    expected: EncryptedWalletBackupCommittedSnapshotSeal,
    seal: (committed: EncryptedWalletBackupCommittedSnapshotSeal) => T,
  ): Promise<T>
}

const COMMITTED_SNAPSHOT_SEALS = new WeakMap<object, EncryptedWalletBackupCommittedSnapshotSeal>()

interface TransactionProofSnapshotAuthority {
  readonly row: EncryptedWalletBackupCommittedProofSnapshot
  readonly conditionalKeyset: ConditionalKeysetAuthority | null
}

const TRANSACTION_PROOF_SNAPSHOTS = new WeakMap<object, TransactionProofSnapshotAuthority>()

export interface EncryptedWalletBackupProofInput {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  mint: string
  unit: string
  counter: number
  proof: {
    id: string
    amount: string
    secret: string
    C: string
    dleq?: { e: string; s: string; r: string }
    witness?: unknown
    p2pk_e?: unknown
  }
  proofKind: EncryptedWalletBackupProofKind
  ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence | null
  effectiveNowUnixSeconds: number
  createdAtUnixSeconds: number
  updatedAtUnixSeconds: number
  proofSnapshotStore: EncryptedWalletBackupProofSnapshotStore
}

export interface PreparedEncryptedWalletBackupProof extends PreparedEncryptedWalletBackupRecord {
  readonly proofId: string
  readonly commitment: string
}

interface PreparedProofAuthority {
  readonly keyAuthority: KeyAuthority
  readonly proofId: string
  readonly commitment: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly mint: string
  readonly unit: string
  readonly amount: string
  readonly proofKindCode: 0 | 1
  readonly ctfMetadata: EncryptedWalletBackupCtfWire | null
  readonly createdAtUnixSeconds: number
  readonly updatedAtUnixSeconds: number
  readonly recordBytes: Uint8Array
}

const PREPARED_PROOF_AUTHORITIES = new WeakMap<object, PreparedProofAuthority>()

export interface PreparedEncryptedWalletBackupProofChunk {
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
  readonly bindings: readonly Readonly<{
    proofId: string
    commitment: string
  }>[]
}

interface PreparedChunkAuthority {
  readonly keyAuthority: KeyAuthority
  readonly canonical: Uint8Array
  readonly proofs: readonly PreparedProofAuthority[]
  readonly snapshotId: string
  readonly snapshotRevision: number
}

const PREPARED_CHUNK_AUTHORITIES = new WeakMap<object, PreparedChunkAuthority>()

export interface PreparedEncryptedWalletBackupObject {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly kindCode:
    | typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
    | typeof ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND
  readonly realm: string
  readonly vaultId: string
  readonly objectId: string
  readonly generation: number
  readonly paddedLength:
    | typeof ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES
    | typeof ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES
  readonly digest: string
}

export interface EncryptedWalletBackupWireObject extends PreparedEncryptedWalletBackupObject {
  readonly aad: Uint8Array
  readonly body: Uint8Array
}

interface PreparedObjectAuthority {
  readonly aad: Uint8Array
  readonly body: Uint8Array
  readonly sourceChunk: PreparedEncryptedWalletBackupProofChunk | null
}

const PREPARED_OBJECT_AUTHORITIES = new WeakMap<object, PreparedObjectAuthority>()

export interface EncryptedWalletBackupManifestEntry {
  readonly proofId: string
  readonly commitment: string
  readonly chunkObjectId: string
  readonly chunkDigest: string
  readonly mint: string
  readonly unit: string
  readonly amount: string
  readonly proofKind: 'ordinary' | 'ctf'
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly terminalEvidence: EncryptedWalletBackupCtfTerminalEvidence | null
  readonly createdAtUnixSeconds: number
  readonly updatedAtUnixSeconds: number
}

export interface PreparedEncryptedWalletBackupManifest {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly generation: number
  readonly snapshotNonce: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly proofCount: number
  readonly pageCount: number
  readonly pages: readonly PreparedEncryptedWalletBackupObject[]
  readonly chunkObjects: readonly PreparedEncryptedWalletBackupObject[]
}

interface PreparedManifestAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly pages: readonly PreparedEncryptedWalletBackupObject[]
  readonly chunkObjects: readonly PreparedEncryptedWalletBackupObject[]
  readonly inheritedChunkReferences: readonly Readonly<{
    objectId: string
    digest: string
  }>[]
  readonly repackedSourceObjectIdsByObjectId: ReadonlyMap<string, ReadonlySet<string>>
  readonly requiredParentHead: EncryptedWalletBackupManifestHead | null
}

const PREPARED_MANIFESTS = new WeakMap<object, PreparedManifestAuthority>()

export interface EncryptedWalletBackupManifestHead {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly backupPublicKey: string
  readonly generation: number
  readonly parent: null | Readonly<{
    generation: number
    manifestDigest: string
  }>
  readonly snapshotNonce: string
  readonly snapshotId: string
  readonly manifestDigest: string
  readonly referenceSetDigest: string
  readonly objectCount: number
  readonly storedBytes: number
  readonly proofCount: number
}

export interface EncryptedWalletBackupManifestHeadWire {
  readonly canonicalHead: Uint8Array
  readonly canonicalReferenceSet: Uint8Array
}

export interface PreparedEncryptedWalletBackupManifestTarget {
  readonly head: EncryptedWalletBackupManifestHead
  readonly wire: EncryptedWalletBackupManifestHeadWire
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly canonicalParentHead: Uint8Array | null
  readonly canonicalInheritedReferenceSet: Uint8Array
}

export interface AuthenticatedEncryptedWalletBackupHeadEvidence {
  readonly state: 'authenticated'
  readonly enrollmentEpoch: number
  readonly head: EncryptedWalletBackupManifestHead | null
}

interface AuthenticatedHeadObservationAuthority {
  readonly keyAuthority: KeyAuthority
  readonly head: EncryptedWalletBackupManifestHead | null
  readonly requestIssuedAtUnixSeconds: number
}

const AUTHENTICATED_HEAD_OBSERVATIONS = new WeakMap<object, AuthenticatedHeadObservationAuthority>()

interface AuthenticatedHeadAuthority extends PreparedManifestHeadAuthority {}

const AUTHENTICATED_MANIFEST_HEADS = new WeakMap<object, AuthenticatedHeadAuthority>()
const AUTHENTICATED_MANIFEST_HEAD_VALUES = new WeakMap<object, AuthenticatedHeadAuthority>()

export interface EncryptedWalletBackupHeadRemotePort {
  readCurrentHead(input: {
    requestProof: EncryptedWalletBackupRequestProof
    signal: AbortSignal
  }): Promise<
    | Readonly<{
        status: 'found'
        enrollmentEpoch: number
        head: EncryptedWalletBackupManifestHeadWire
      }>
    | Readonly<{ status: 'not-found' }>
    | Readonly<{
        status: 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
        retryAfterSeconds?: number | null
      }>
  >
}

export interface EncryptedWalletBackupEnrollmentEpochRemotePort {
  discoverEnrollmentEpoch(input: {
    requestProof: EncryptedWalletBackupRequestProof
    signal: AbortSignal
  }): Promise<
    | Readonly<{ status: 'active'; enrollmentEpoch: number }>
    | Readonly<{ status: 'not-enrolled' }>
    | Readonly<{
        status: 'rate-limited' | 'overloaded' | 'unavailable'
        retryAfterSeconds?: number | null
      }>
  >
}

export type EncryptedWalletBackupEnrollmentEpochDiscovery =
  | Readonly<{ state: 'active'; enrollmentEpoch: number }>
  | Readonly<{ state: 'not-enrolled' }>

export interface EncryptedWalletBackupCasRemotePort extends EncryptedWalletBackupHeadRemotePort {
  compareAndSwapCurrentHead(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalCasPayload: Uint8Array
    signal: AbortSignal
  }): Promise<
    Readonly<{
      status:
        | 'committed'
        | 'conflict'
        | 'quota-exceeded'
        | 'unauthorized'
        | 'rate-limited'
        | 'overloaded'
        | 'unavailable'
      retryAfterSeconds?: number | null
    }>
  >
}

export interface EncryptedWalletBackupSyncAttemptRecord {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly attemptId: string
  readonly uploadAttemptId: string
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly expectedHeadDigest: string | null
  readonly targetHead: EncryptedWalletBackupManifestHead
  readonly canonicalCasPayload: Uint8Array
  readonly casPayloadDigest: string
  readonly casAttempts: number
  readonly retryStreak: number
  readonly retryNotBeforeUnixMilliseconds: number | null
  readonly state:
    | 'sealed'
    | 'cas-uncertain'
    | 'retry-cas'
    | 'retry-exhausted'
    | 'reconcile-before-retry'
    | 'acknowledged'
    | 'fork-rejected'
}

export interface EncryptedWalletBackupSyncAttemptStore {
  /** Revalidates the exact linked aggregate owner lease using database time. */
  validatePreparedAttempt<T>(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    read: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
  ): Promise<T>
  transitionPreparedAttempt<T>(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
  ): Promise<T>
  /** Atomically stamps retryNotBefore from the adapter's DB clock plus the fixed delay. */
  exhaustPreparedAttempt<T>(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    delayMilliseconds: number,
    commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
  ): Promise<T>
  /** Atomically checks the persisted not-before boundary and reopens this exact attempt only. */
  resumeRetryExhaustedAttempt<T>(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
    commit: (committed: EncryptedWalletBackupSyncAttemptRecord) => T,
  ): Promise<Readonly<{ state: 'not-ready' }> | Readonly<{ state: 'committed'; value: T }>>
}

export interface SealedEncryptedWalletBackupSyncAttempt {
  readonly state: 'sealed'
  readonly record: EncryptedWalletBackupSyncAttemptRecord
}

interface PreparedManifestHeadAuthority {
  readonly head: EncryptedWalletBackupManifestHead
  readonly keyAuthority: KeyAuthority
  readonly localSnapshotId: string | null
  readonly localSnapshotRevision: number | null
  readonly canonicalHead: Uint8Array
  readonly canonicalReferenceSet: Uint8Array
  readonly canonicalParentHead: Uint8Array | null
  readonly canonicalInheritedReferenceSet: Uint8Array
  readonly pageObjects: readonly PreparedEncryptedWalletBackupObject[]
  readonly chunkObjects: readonly PreparedEncryptedWalletBackupObject[]
}

const PREPARED_MANIFEST_HEADS = new WeakMap<object, PreparedManifestHeadAuthority>()

export interface DecryptedEncryptedWalletBackupManifestPage {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND
  readonly generation: number
  readonly snapshotNonce: string
  readonly pageIndex: number
  readonly pageCount: number
  readonly entries: readonly EncryptedWalletBackupManifestEntry[]
}

interface DecryptedManifestPageAuthority {
  readonly keyAuthority: KeyAuthority
  readonly head: EncryptedWalletBackupManifestHead
}

const DECRYPTED_MANIFEST_PAGE_AUTHORITIES = new WeakMap<object, DecryptedManifestPageAuthority>()

export interface EncryptedWalletBackupManifestRestoreCursor {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly generation: number
  readonly pageCount: number
  readonly nextPageIndex: number
  readonly restoredEntryCount: number
  readonly complete: boolean
}

/** One exact page reference from an authenticated current manifest head. */
export interface AuthenticatedEncryptedWalletBackupManifestPageReference {
  readonly state: 'authenticated'
  readonly pageIndex: number
  readonly objectId: string
  readonly objectDigest: string
  readonly generation: number
}

interface ManifestRestoreCursorAuthority {
  readonly keyAuthority: KeyAuthority
  readonly head: EncryptedWalletBackupManifestHead
  readonly pageCount: number
  readonly nextPageIndex: number
  readonly restoredEntryCount: number
  readonly lastProofId: string | null
  consumed: boolean
}

const MANIFEST_RESTORE_CURSOR_AUTHORITIES = new WeakMap<object, ManifestRestoreCursorAuthority>()

export interface DecryptedEncryptedWalletBackupProofChunk {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
  readonly recordCount: number
}

interface UnverifiedEncryptedWalletBackupProof {
  readonly proofId: string
  readonly commitment: string
  readonly mint: string
  readonly unit: string
  readonly counter: number
  readonly encodedProofKind: 0 | 1
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly terminalEvidence: EncryptedWalletBackupCtfTerminalEvidence | null
  readonly createdAtUnixSeconds: number
  readonly updatedAtUnixSeconds: number
  readonly proof: {
    readonly id: string
    readonly amount: string
    readonly secret: string
    readonly C: string
    readonly dleq?: {
      readonly e: string
      readonly s: string
      readonly r: string
    }
  }
}

interface DecryptedProofChunkAuthority {
  readonly keyAuthority: KeyAuthority
  readonly objectId: string
  readonly objectDigest: string
  readonly generation: number
  readonly records: readonly UnverifiedEncryptedWalletBackupProof[]
}

const DECRYPTED_PROOF_CHUNK_AUTHORITIES = new WeakMap<object, DecryptedProofChunkAuthority>()

export const ENCRYPTED_WALLET_BACKUP_RESTORE_PROOF_LIMIT_MAX = 64 as const

export interface EncryptedWalletBackupRestoreSelection {
  readonly manifestPage: DecryptedEncryptedWalletBackupManifestPage
  readonly proofId: string
}

export interface EncryptedWalletBackupRestoreKeysetPort {
  resolveKeysets(
    input: Readonly<{
      requests: readonly Readonly<{
        mint: string
        unit: string
        keysetId: string
      }>[]
      signal: AbortSignal
    }>,
  ): Promise<
    readonly Readonly<{
      mint: string
      unit: string
      keysetId: string
      mintKeys: unknown
    }>[]
  >
}

export interface EncryptedWalletBackupRestoreProofStatePort {
  checkProofStates(
    input: Readonly<{
      proofs: readonly Readonly<{
        proofId: string
        mint: string
        keysetId: string
        y: string
      }>[]
      signal: AbortSignal
    }>,
  ): Promise<
    readonly Readonly<{
      proofId: string
      y: string
      state: 'UNSPENT' | 'PENDING' | 'SPENT'
    }>[]
  >
}

export interface EncryptedWalletBackupRestoreProofRecord {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly generation: number
  readonly manifestDigest: string
  readonly parentGeneration: number | null
  readonly parentManifestDigest: string | null
  readonly chunkObjectId: string
  readonly chunkDigest: string
  readonly proofId: string
  readonly proofCommitment: string
  readonly mint: string
  readonly unit: string
  readonly counter: number
  readonly proofKind: 'ordinary' | 'ctf'
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly terminalEvidence: EncryptedWalletBackupCtfTerminalEvidence | null
  readonly createdAtUnixSeconds: number
  readonly updatedAtUnixSeconds: number
  readonly disposition: 'selectable' | 'user-retained-nonselectable'
  readonly nonselectableReason: null | 'recorded-ctf-expiry-passed' | 'verified-losing-outcome'
  readonly proof: Readonly<{
    id: string
    amount: string
    secret: string
    C: string
    dleq?: Readonly<{ e: string; s: string; r: string }>
  }>
}

export interface EncryptedWalletBackupRestoreProofRow {
  readonly proofId: string
  readonly storageClassification: DurableWalletStorageClassification
  readonly proof: EncryptedWalletBackupRestoreProofRecord
}

export interface EncryptedWalletBackupRestoreCurrentProofState {
  readonly proofId: string
  /**
   * Both nullable fields may be null only when this global proof identity is
   * absent from every proof, reservation, operation-link, pin, and tombstone
   * authority in the same physical transaction.
   */
  readonly storageClassification: DurableWalletStorageClassification | null
  readonly proof: EncryptedWalletBackupRestoreProofRecord | null
}

export interface EncryptedWalletBackupRestoreStore {
  commitRestoredProofs<T>(
    input: Readonly<{
      expected: readonly EncryptedWalletBackupRestoreProofRow[]
      restoreMode: 'complete-origin' | 'hydrate-existing'
      signal: AbortSignal
    }>,
    commit: (current: readonly EncryptedWalletBackupRestoreCurrentProofState[]) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupProofRestoreResult {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly generation: number
  readonly manifestDigest: string
  readonly proofCount: number
  readonly proofIds: readonly string[]
}

export async function createEncryptedWalletBackupKeyHandle(input: {
  seed: Uint8Array
  realm: string
  runtime?: EncryptedWalletBackupRuntime
}): Promise<EncryptedWalletBackupKeyHandle> {
  const seed = requireSeed(input.seed)
  const realm = requireRealm(input.realm)
  const runtime = requireRuntime(input.runtime)
  const encryptionRoot = await hkdf(
    runtime.subtle,
    seed,
    ROOT_SALT,
    encodeCanonical([1, 'encryption-root', realm]),
  )
  const requestAuthRoot = await hkdf(
    runtime.subtle,
    seed,
    ROOT_SALT,
    encodeCanonical([1, 'request-auth-root', realm]),
  )
  const preparationPersistenceKey = await hkdf(
    runtime.subtle,
    encryptionRoot,
    ROOT_SALT,
    encodeCanonical([1, 'preparation-persistence', realm]),
  )
  const vaultIdBytes = await hkdf(
    runtime.subtle,
    encryptionRoot,
    ROOT_SALT,
    encodeCanonical([1, 'vault-id', realm]),
  )
  const requestScalar = await deriveRequestAuthScalar(runtime.subtle, requestAuthRoot, realm)
  const requestAuthPublicKey = bytesToHex(secp256k1.getPublicKey(requestScalar, true).slice(1))
  const handle = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm,
    vaultId: bytesToHex(vaultIdBytes),
    requestAuthPublicKey,
  })
  registerEncryptedWalletBackupKeyHandle(handle, {
    walletId: deriveDurableCustodyWalletId(seed),
    preparationPersistenceKey,
    subtle: runtime.subtle,
  })
  KEY_AUTHORITIES.set(handle, {
    realm,
    seedDigest: sha256(seed),
    encryptionRoot,
    requestAuthRoot,
    vaultIdBytes,
    runtime,
    derivers: new Map(),
    preparedObjectIds: new Set(),
  })
  return handle
}

export async function prepareEncryptedWalletBackupRequestProof(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  method: EncryptedWalletBackupRequestMethod
  url: string
  issuedAtUnixSeconds: number
  expiresAtUnixSeconds: number
  payload: Uint8Array
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
}): Promise<EncryptedWalletBackupRequestProof> {
  return prepareEncryptedWalletBackupRequestProofForEpoch(input, 1)
}

/** Signed, non-listing lookup used only when local enrollment epoch state was lost. */
export async function prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  url: string
  issuedAtUnixSeconds: number
  expiresAtUnixSeconds: number
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
}): Promise<EncryptedWalletBackupRequestProof> {
  return prepareEncryptedWalletBackupRequestProofForEpoch(
    {
      ...input,
      enrollmentEpoch: 0,
      method: 'GET',
      payload: new Uint8Array(),
    },
    0,
  )
}

async function prepareEncryptedWalletBackupRequestProofForEpoch(
  input: {
    keyHandle: EncryptedWalletBackupKeyHandle
    enrollmentEpoch: number
    method: EncryptedWalletBackupRequestMethod
    url: string
    issuedAtUnixSeconds: number
    expiresAtUnixSeconds: number
    payload: Uint8Array
    signal: AbortSignal
    runtime?: EncryptedWalletBackupRuntime
  },
  minimumEpoch: 0 | 1,
): Promise<EncryptedWalletBackupRequestProof> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const authority = requireKeyAuthority(input.keyHandle)
  const epoch = requireInteger(
    input.enrollmentEpoch,
    minimumEpoch,
    Number.MAX_SAFE_INTEGER,
    'enrollment epoch',
  )
  if (minimumEpoch === 0 && epoch !== 0)
    throw new Error('epoch discovery proof must use epoch zero')
  const method = requireRequestMethod(input.method)
  const url = requireExactHttpsUrl(input.url)
  const issuedAt = requireNonNegativeSafeInteger(input.issuedAtUnixSeconds, 'request issue time')
  const expiresAt = requireNonNegativeSafeInteger(input.expiresAtUnixSeconds, 'request expiry time')
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 60)
    throw new Error('request freshness window is invalid')
  const payload = requireBytesRange(
    input.payload,
    0,
    ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
    'request payload',
  )
  const runtime = input.runtime === undefined ? authority.runtime : requireRuntime(input.runtime)
  const replayNonce = randomBytes(runtime, 16)
  const auxiliaryRandomness = randomBytes(runtime, 32)
  const payloadDigest = sha256(payload)
  const preimage = encodeBackupRequestPreimage({
    realm: authority.realm,
    vaultId: authority.vaultIdBytes,
    requestAuthPublicKey: hexToBytes(input.keyHandle.requestAuthPublicKey),
    enrollmentEpoch: epoch,
    method,
    url,
    issuedAtUnixSeconds: issuedAt,
    expiresAtUnixSeconds: expiresAt,
    replayNonce,
    payloadLength: payload.byteLength,
    payloadDigest,
  })
  const scalar = await awaitEncryptedWalletBackupCycle(
    deriveRequestAuthScalar(runtime.subtle, authority.requestAuthRoot, authority.realm),
    cycleSignal,
  )
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const signature = schnorr.sign(sha256(preimage), scalar, auxiliaryRandomness)
  const proof = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm: authority.realm,
    vaultId: bytesToHex(authority.vaultIdBytes),
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    enrollmentEpoch: epoch,
    method,
    url,
    issuedAtUnixSeconds: issuedAt,
    expiresAtUnixSeconds: expiresAt,
    replayNonce: bytesToHex(replayNonce),
    payloadLength: payload.byteLength,
    payloadDigest: bytesToHex(payloadDigest),
    signature: bytesToHex(signature),
  })
  PREPARED_BACKUP_REQUESTS.set(proof, authority)
  PREPARED_BACKUP_REQUEST_SIGNALS.set(proof, cycleSignal)
  return proof
}

export function verifyEncryptedWalletBackupRequestProof(input: {
  proof: unknown
  expectedRealm: string
  expectedVaultId: string
  expectedPublicKey: string
  expectedEnrollmentEpoch: number
  expectedMethod: EncryptedWalletBackupRequestMethod
  expectedUrl: string
  payload: Uint8Array
  serverNowUnixSeconds: number
}): boolean {
  try {
    const verified = verifyEncryptedWalletBackupRequestProofEvidence({
      proof: input.proof,
      expectedMethod: input.expectedMethod,
      expectedUrl: input.expectedUrl,
      payload: input.payload,
      serverNowUnixSeconds: input.serverNowUnixSeconds,
    })
    return verifiedRequestProofMatchesIdentity(
      verified.claims,
      input.expectedRealm,
      input.expectedVaultId,
      input.expectedPublicKey,
      input.expectedEnrollmentEpoch,
    )
  } catch {
    return false
  }
}

/**
 * Verifies one self-signed proof exactly once and issues replay-consumption
 * authority retained only in an internal WeakMap.
 */
export function verifyEncryptedWalletBackupRequestProofEvidence(input: {
  proof: unknown
  expectedMethod: EncryptedWalletBackupRequestMethod
  expectedUrl: string
  payload: Uint8Array
  serverNowUnixSeconds: number
}): VerifiedEncryptedWalletBackupRequestProofEvidence {
  const proof = decodeBackupRequestProof(input.proof)
  const payload = requireBytesRange(
    input.payload,
    0,
    ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
    'request payload',
  )
  const now = requireNonNegativeSafeInteger(input.serverNowUnixSeconds, 'server time')
  if (
    proof.method !== requireRequestMethod(input.expectedMethod) ||
    proof.url !== requireExactHttpsUrl(input.expectedUrl) ||
    proof.expiresAtUnixSeconds <= proof.issuedAtUnixSeconds ||
    proof.expiresAtUnixSeconds - proof.issuedAtUnixSeconds > 60 ||
    proof.issuedAtUnixSeconds > now + 30 ||
    now > proof.expiresAtUnixSeconds ||
    proof.payloadLength !== payload.byteLength ||
    proof.payloadDigest !== bytesToHex(sha256(payload))
  ) {
    throw new Error('encrypted backup request authentication failed')
  }
  const preimage = encodeBackupRequestPreimage({
    realm: proof.realm,
    vaultId: hexToBytes(proof.vaultId),
    requestAuthPublicKey: hexToBytes(proof.requestAuthPublicKey),
    enrollmentEpoch: proof.enrollmentEpoch,
    method: proof.method,
    url: proof.url,
    issuedAtUnixSeconds: proof.issuedAtUnixSeconds,
    expiresAtUnixSeconds: proof.expiresAtUnixSeconds,
    replayNonce: hexToBytes(proof.replayNonce),
    payloadLength: proof.payloadLength,
    payloadDigest: hexToBytes(proof.payloadDigest),
  })
  const requestDigestBytes = sha256(preimage)
  if (
    !schnorr.verify(
      hexToBytes(proof.signature),
      requestDigestBytes,
      hexToBytes(proof.requestAuthPublicKey),
    )
  ) {
    throw new Error('encrypted backup request authentication failed')
  }
  const evidence = Object.freeze({
    state: 'verified' as const,
    claims: proof,
  })
  VERIFIED_BACKUP_REQUEST_PROOFS.set(
    evidence,
    Object.freeze({
      proof,
      requestDigest: bytesToHex(requestDigestBytes),
    }),
  )
  return evidence
}

export function encodeEncryptedWalletBackupRequestProof(
  value: EncryptedWalletBackupRequestProof,
): Uint8Array {
  const proof = decodeBackupRequestProof(value)
  return encodeCanonical([
    ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    'backup-request-proof',
    proof.realm,
    hexToBytes(proof.vaultId),
    hexToBytes(proof.requestAuthPublicKey),
    proof.enrollmentEpoch,
    proof.method,
    proof.url,
    proof.issuedAtUnixSeconds,
    proof.expiresAtUnixSeconds,
    hexToBytes(proof.replayNonce),
    proof.payloadLength,
    hexToBytes(proof.payloadDigest),
    hexToBytes(proof.signature),
  ])
}

/**
 * Returns the response-binding digest for the exact delegated request proof.
 * This deliberately hashes the signed preimage, not the proof envelope that
 * also carries the signature.
 */
export function encryptedWalletBackupRequestDigest(
  value: EncryptedWalletBackupRequestProof,
): string {
  const proof = decodeBackupRequestProof(value)
  return bytesToHex(
    sha256(
      encodeBackupRequestPreimage({
        realm: proof.realm,
        vaultId: hexToBytes(proof.vaultId),
        requestAuthPublicKey: hexToBytes(proof.requestAuthPublicKey),
        enrollmentEpoch: proof.enrollmentEpoch,
        method: proof.method,
        url: proof.url,
        issuedAtUnixSeconds: proof.issuedAtUnixSeconds,
        expiresAtUnixSeconds: proof.expiresAtUnixSeconds,
        replayNonce: hexToBytes(proof.replayNonce),
        payloadLength: proof.payloadLength,
        payloadDigest: hexToBytes(proof.payloadDigest),
      }),
    ),
  )
}

export async function authenticateEncryptedWalletBackupRequest(input: {
  proof: unknown
  expectedRealm: string
  expectedVaultId: string
  expectedPublicKey: string
  expectedEnrollmentEpoch: number
  expectedMethod: EncryptedWalletBackupRequestMethod
  expectedUrl: string
  payload: Uint8Array
  serverNowUnixSeconds: number
  replayStore: EncryptedWalletBackupReplayStore
}): Promise<AuthenticatedEncryptedWalletBackupRequestEvidence> {
  let verified: VerifiedEncryptedWalletBackupRequestProofEvidence
  try {
    verified = verifyEncryptedWalletBackupRequestProofEvidence({
      proof: input.proof,
      expectedMethod: input.expectedMethod,
      expectedUrl: input.expectedUrl,
      payload: input.payload,
      serverNowUnixSeconds: input.serverNowUnixSeconds,
    })
    if (
      !verifiedRequestProofMatchesIdentity(
        verified.claims,
        input.expectedRealm,
        input.expectedVaultId,
        input.expectedPublicKey,
        input.expectedEnrollmentEpoch,
      )
    ) {
      throw new Error()
    }
  } catch {
    throw new Error('encrypted backup request authentication failed')
  }
  return consumeEncryptedWalletBackupVerifiedRequestReplay({
    verifiedProof: verified,
    replayStore: input.replayStore,
  })
}

export async function consumeEncryptedWalletBackupVerifiedRequestReplay(input: {
  verifiedProof: VerifiedEncryptedWalletBackupRequestProofEvidence
  replayStore: EncryptedWalletBackupReplayStore
}): Promise<AuthenticatedEncryptedWalletBackupRequestEvidence> {
  if (
    typeof input.replayStore !== 'object' ||
    input.replayStore === null ||
    typeof input.replayStore.consumeReplayNonce !== 'function'
  ) {
    throw new Error('encrypted backup replay store is invalid')
  }
  const authority = VERIFIED_BACKUP_REQUEST_PROOFS.get(input.verifiedProof)
  if (authority === undefined) {
    throw new Error('encrypted backup verified request proof is invalid')
  }
  const { proof, requestDigest } = authority
  let consumed: 'consumed' | 'replayed'
  try {
    consumed = await input.replayStore.consumeReplayNonce({
      realm: proof.realm,
      vaultId: proof.vaultId,
      requestAuthPublicKey: proof.requestAuthPublicKey,
      enrollmentEpoch: proof.enrollmentEpoch,
      replayNonce: proof.replayNonce,
      expiresAtUnixSeconds: proof.expiresAtUnixSeconds,
      requestDigest,
    })
  } catch {
    throw new EncryptedWalletBackupReplayStoreUnavailableError()
  }
  if (consumed === 'replayed') {
    throw new EncryptedWalletBackupReplayRejectedError()
  }
  if (consumed !== 'consumed') {
    throw new EncryptedWalletBackupReplayStoreUnavailableError()
  }
  const evidence = Object.freeze({
    state: 'authenticated' as const,
    requestDigest,
    replayNonce: proof.replayNonce,
  })
  AUTHENTICATED_BACKUP_REQUESTS.set(evidence, proof)
  return evidence
}

function verifiedRequestProofMatchesIdentity(
  proof: EncryptedWalletBackupRequestProof,
  expectedRealm: unknown,
  expectedVaultId: unknown,
  expectedPublicKey: unknown,
  expectedEnrollmentEpoch: unknown,
): boolean {
  return (
    proof.realm === requireRealm(expectedRealm) &&
    proof.vaultId === requireLowerHex(expectedVaultId, 32, 'expected vault id') &&
    proof.requestAuthPublicKey === requireLowerHex(expectedPublicKey, 32, 'expected public key') &&
    proof.enrollmentEpoch ===
      requireInteger(
        expectedEnrollmentEpoch,
        0,
        Number.MAX_SAFE_INTEGER,
        'expected enrollment epoch',
      )
  )
}

export function verifyEncryptedWalletBackupConditionalKeyset(input: {
  mint: string
  unit: string
  outcomeLabel: string
  registeredAtUnixSeconds: number
  mintKeys: unknown
  conditionalMetadata: unknown
}): VerifiedEncryptedWalletBackupConditionalKeyset {
  const mint = requireNormalizedMint(input.mint)
  const unit = requireBoundedText(input.unit, 64, 'conditional keyset unit')
  const outcomeLabel = requireBoundedText(input.outcomeLabel, 256, 'conditional outcome label')
  const registeredAt = requireNonNegativeSafeInteger(
    input.registeredAtUnixSeconds,
    'conditional registration time',
  )
  const keys = requireRecord(input.mintKeys, 'conditional mint keys')
  requireKnownFields(
    keys,
    ['id', 'unit', 'keys'],
    ['active', 'input_fee_ppk', 'final_expiry', 'conditional'],
  )
  const keyset = decodeKeysetId(keys.id)
  if (keyset.kindCode !== 2 || keyset.curve !== 'secp256k1' || keys.unit !== unit) {
    throw new Error('conditional mint keys are invalid')
  }
  const finalExpiry = requireNonNegativeSafeInteger(keys.final_expiry, 'conditional final expiry')
  if (finalExpiry <= registeredAt) throw new Error('conditional final expiry is invalid')
  const metadata = requireRecord(input.conditionalMetadata, 'conditional keyset metadata')
  requireKnownFields(metadata, [
    'conditionId',
    'outcomeCollection',
    'outcomeCollectionId',
    'registeredAt',
  ])
  const conditionId = requireLowerHex(metadata.conditionId, 32, 'conditional condition id')
  const outcomeCollection = requireBoundedText(
    metadata.outcomeCollection,
    256,
    'conditional outcome collection',
  )
  const outcomeCollectionId = requireLowerHex(
    metadata.outcomeCollectionId,
    32,
    'conditional outcome collection id',
  )
  if (
    outcomeCollection !== outcomeLabel ||
    requireNonNegativeSafeInteger(metadata.registeredAt, 'conditional metadata registration') !==
      registeredAt
  ) {
    throw new Error('conditional keyset metadata does not match context')
  }
  const publicKeys = requireRecord(keys.keys, 'conditional denomination keys')
  const denominations = Object.entries(publicKeys)
  if (
    denominations.length < 1 ||
    denominations.length > 64 ||
    new TextEncoder().encode(JSON.stringify(publicKeys)).byteLength > 65_536
  ) {
    throw new Error('conditional denomination keys exceed bounds')
  }
  const normalizedPublicKeys: Record<string, string> = {}
  for (const [amount, publicKey] of denominations) {
    if (
      !/^[1-9][0-9]{0,19}$/.test(amount) ||
      BigInt(amount) > UINT64_MAX ||
      typeof publicKey !== 'string' ||
      !/^(?:02|03)[0-9a-f]{64}$/.test(publicKey)
    ) {
      throw new Error('conditional denomination key is invalid')
    }
    normalizedPublicKeys[amount] = publicKey
  }
  const inputFee =
    keys.input_fee_ppk === undefined
      ? undefined
      : requireInteger(keys.input_fee_ppk, 0, 2_147_483_647, 'conditional input fee')
  if (keys.active !== undefined) requireBoolean(keys.active, 'conditional active marker')
  if (keys.conditional !== undefined) {
    const embedded = requireRecord(keys.conditional, 'embedded conditional metadata')
    requireKnownFields(embedded, [
      'conditionId',
      'outcomeCollection',
      'outcomeCollectionId',
      'registeredAt',
    ])
    if (
      embedded.conditionId !== conditionId ||
      embedded.outcomeCollection !== outcomeCollection ||
      embedded.outcomeCollectionId !== outcomeCollectionId ||
      embedded.registeredAt !== registeredAt
    ) {
      throw new Error('embedded conditional metadata conflicts')
    }
  }
  const normalizedKeys = {
    id: keyset.text,
    unit,
    ...(keys.active === undefined ? {} : { active: keys.active }),
    ...(inputFee === undefined ? {} : { input_fee_ppk: inputFee }),
    final_expiry: finalExpiry,
    keys: normalizedPublicKeys,
    conditional: {
      conditionId,
      outcomeCollection,
      outcomeCollectionId,
      registeredAt,
    },
  }
  const normalizedMetadata = {
    conditionId,
    outcomeCollection,
    outcomeCollectionId,
    registeredAt,
  }
  const keysetApi = (
    Cashu as unknown as {
      Keyset?: {
        verifyConditionalKeysetId(keys: unknown, metadata: unknown): boolean
      }
    }
  ).Keyset
  if (
    keysetApi === undefined ||
    !keysetApi.verifyConditionalKeysetId(normalizedKeys, normalizedMetadata)
  ) {
    throw new Error('conditional keyset cryptographic verification failed')
  }
  const handle = Object.freeze({ keysetId: keyset.text })
  VERIFIED_CONDITIONAL_KEYSETS.set(handle, {
    mint,
    unit,
    keysetId: keyset.text,
    conditionId,
    outcomeLabel,
    outcomeCollectionId,
    registeredAtUnixSeconds: registeredAt,
    curve: keyset.curve,
    finalExpiryUnixSeconds: finalExpiry,
  })
  return handle
}

export async function prepareEncryptedWalletBackupProof(
  input: EncryptedWalletBackupProofInput,
): Promise<PreparedEncryptedWalletBackupProof> {
  const authority = requireKeyAuthority(input.keyHandle)
  const seed = requireSeed(input.seed)
  if (!equalBytes(authority.seedDigest, sha256(seed))) {
    throw new Error('backup seed does not match key handle')
  }
  const mint = requireNormalizedMint(input.mint)
  const unit = requireBoundedText(input.unit, 64, 'backup proof unit')
  const counter = requireInteger(input.counter, 0, 2_147_483_647, 'backup proof counter')
  const proof = requireRecord(input.proof, 'backup proof')
  requireKnownFields(proof, ['id', 'amount', 'secret', 'C'], ['dleq', 'witness', 'p2pk_e'])
  if (proof.witness !== undefined || proof.p2pk_e !== undefined) {
    throw new Error('unsupported proof field')
  }
  const keyset = decodeKeysetId(proof.id)
  const amount = requireAmount(proof.amount)
  const secret = requireLowerHexSecret(proof.secret)
  const signature = requireSignature(proof.C, keyset.curve)
  const dleq = requireDleq(proof.dleq, keyset.curve)
  let deriver = authority.derivers.get(keyset.text)
  if (deriver === undefined) {
    try {
      deriver = cashuSecretDeriver(seed, keyset.text)
    } catch {
      throw new Error('backup proof keyset is invalid')
    }
    authority.derivers.set(keyset.text, deriver)
  }
  let derivedSecret: Uint8Array
  try {
    derivedSecret = deriver(counter).secret
  } catch {
    throw new Error('backup proof derivation failed')
  }
  if (bytesToHex(derivedSecret) !== secret) {
    throw new Error('proof secret does not match deterministic derivation')
  }
  const proofId = deriveDurableCustodyProofId({
    scopeId: deriveEncryptedWalletBackupDurableCustodyScopeId(seed),
    normalizedMint: mint,
    unit,
    keysetId: keyset.identityText,
    secret,
  })
  const effectiveNow = requireNonNegativeSafeInteger(
    input.effectiveNowUnixSeconds,
    'backup preparation effective time',
  )
  const createdAt = requireNonNegativeSafeInteger(input.createdAtUnixSeconds, 'proof creation time')
  const updatedAt = requireNonNegativeSafeInteger(input.updatedAtUnixSeconds, 'proof update time')
  if (updatedAt < createdAt) throw new Error('proof timestamps are invalid')
  const proofKindCode = input.proofKind === 'ordinary' ? 0 : 1
  const ctfBase = decodeCtfMetadata(input.ctfMetadata, proofKindCode)
  const terminalSeal = prepareCtfTerminalSeal(input, mint, keyset.text, ctfBase)
  const ctfMetadata: EncryptedWalletBackupCtfWire | null =
    ctfBase === null ? null : [...ctfBase, terminalSeal]
  const keysetWire = [keyset.kindCode, keyset.text]
  const commitmentPreimage = [
    1,
    'proof-record-commitment',
    mint,
    unit,
    keysetWire,
    amount,
    new TextEncoder().encode(secret),
    signature,
    dleq,
    counter,
    proofKindCode,
    ctfMetadata,
    createdAt,
    updatedAt,
  ]
  const commitment = bytesToHex(sha256(encodeCanonical(commitmentPreimage)))
  const committedSnapshot = await requireAuthoritativeStorageSnapshot(
    input,
    proofId,
    commitment,
    mint,
    unit,
    keyset,
    ctfMetadata,
    effectiveNow,
  )
  const record = [
    hexToBytes(proofId),
    hexToBytes(commitment),
    mint,
    unit,
    keysetWire,
    amount,
    new TextEncoder().encode(secret),
    signature,
    dleq,
    counter,
    proofKindCode,
    ctfMetadata,
    createdAt,
    updatedAt,
  ]
  if (measureCanonicalCbor(record) > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES) {
    throw new Error('backup proof record exceeds the encoded size limit')
  }
  const recordBytes = encodeCanonical(record)
  const handle = Object.freeze({ proofId, commitment })
  PREPARED_PROOF_AUTHORITIES.set(handle, {
    keyAuthority: authority,
    proofId,
    commitment,
    snapshotId: committedSnapshot.row.snapshotId,
    snapshotRevision: committedSnapshot.row.revision,
    mint,
    unit,
    amount,
    proofKindCode,
    ctfMetadata,
    createdAtUnixSeconds: createdAt,
    updatedAtUnixSeconds: updatedAt,
    recordBytes,
  })
  return issuePreparedEncryptedWalletBackupRecord(handle, {
    recordId: proofId,
    commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
    keyHandle: input.keyHandle,
    canonicalRecord: recordBytes,
    snapshotId: committedSnapshot.row.snapshotId,
    snapshotRevision: committedSnapshot.row.revision,
    canonicalManifestEntry: encodeCanonical([
      ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
      hexToBytes(proofId),
      hexToBytes(commitment),
      mint,
      unit,
      amount,
      proofKindCode,
      ctfMetadata,
      createdAt,
      updatedAt,
    ]),
  })
}

function requireBackupEligibleClassification(
  input: Pick<
    EncryptedWalletBackupCommittedProofSnapshot,
    | 'provenance'
    | 'proofKind'
    | 'ctfMetadata'
    | 'operationBinding'
    | 'reserved'
    | 'ambiguousMintOperation'
    | 'proofPins'
    | 'derivationLocator'
  >,
  proofId: string,
  commitment: string,
  effectiveNowUnixSeconds: number,
  terminalEvidence: DurableWalletVerifiedLosingCtfClassification | null,
): void {
  const classification = classifyDurableWalletStorage({
    schemaVersion: 1,
    recordId: proofId,
    kind: 'deterministic-proof',
    provenance: input.provenance,
    proofKind: input.proofKind,
    ctfMetadata:
      input.proofKind === 'ctf'
        ? {
            finalExpiryUnixSeconds: input.ctfMetadata!.finalExpiryUnixSeconds,
            terminalEvidence,
          }
        : null,
    effectiveNowUnixSeconds,
    operationBinding: input.operationBinding,
    reserved: input.reserved,
    ambiguousMintOperation: input.ambiguousMintOperation,
    proofPins: input.proofPins,
    derivationLocator: input.derivationLocator,
    proofCommitment: { state: 'verified', digest: commitment },
    backupReceiptEvidence: null,
  })
  const activeMissingReceipt =
    classification.storageClass === 'pinned-local-recovery-state' &&
    classification.pinReasons.length === 1 &&
    classification.pinReasons[0] === 'missing-current-backup-receipt'
  const retainedCtf =
    classification.storageClass === 'user-retained-nonselectable-ctf' &&
    classification.pinReasons.length === 0
  if (
    (!activeMissingReceipt && !retainedCtf) ||
    classification.recordId !== proofId ||
    classification.proofCommitment !== commitment ||
    classification.backupBinding !== null
  ) {
    throw new Error('proof is not backup eligible')
  }
}

async function requireAuthoritativeStorageSnapshot(
  input: EncryptedWalletBackupProofInput,
  proofId: string,
  commitment: string,
  mint: string,
  unit: string,
  keyset: KeysetId,
  ctfTuple: EncryptedWalletBackupCtfWire | null,
  effectiveNowUnixSeconds: number,
): Promise<TransactionProofSnapshotAuthority> {
  const store = requireProofSnapshotStore(input.proofSnapshotStore)
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await store.withCommittedProofSnapshot(proofId, (rawRow) => {
      if (!callbackOpen || callbackCalls++ !== 0)
        throw new Error('proof snapshot transaction callback is invalid')
      const row = decodeCommittedProofSnapshot(rawRow)
      const terminalClassification = requireAuthoritativeTerminalClassification({
        input,
        row,
        mint,
        keysetId: keyset.text,
        ctfTuple,
      })
      requireBackupEligibleClassification(
        row,
        row.proofId,
        row.proofCommitment,
        effectiveNowUnixSeconds,
        terminalClassification,
      )
      const conditionalKeyset =
        row.conditionalKeysetEvidence === null
          ? null
          : VERIFIED_CONDITIONAL_KEYSETS.get(row.conditionalKeysetEvidence)
      if (row.conditionalKeysetEvidence !== null && conditionalKeyset === undefined) {
        throw new Error('conditional keyset evidence is invalid')
      }
      const capability = Object.freeze({
        snapshotId: row.snapshotId,
        revision: row.revision,
      })
      TRANSACTION_PROOF_SNAPSHOTS.set(capability, {
        row,
        conditionalKeyset: conditionalKeyset ?? null,
      })
      issued = capability
      return capability
    })
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('proof snapshot transaction must be synchronous and exact')
  }
  const snapshot = TRANSACTION_PROOF_SNAPSHOTS.get(issued)
  if (snapshot === undefined) throw new Error('authoritative storage snapshot is invalid')
  const row = snapshot.row
  if (row.proofId !== proofId)
    throw new Error('proof id does not match authoritative storage snapshot')
  if (row.proofCommitment !== commitment) {
    throw new Error('proof commitment does not match authoritative storage snapshot')
  }
  if (row.proofKind !== input.proofKind)
    throw new Error('proof does not match authoritative storage snapshot')
  const metadata = ctfTuple === null ? null : ctfTupleToMetadata(ctfTuple)
  if (!equalCtfMetadata(row.ctfMetadata, metadata)) {
    throw new Error('proof does not match authoritative storage snapshot')
  }
  if (input.proofKind === 'ctf') {
    const conditional = snapshot.conditionalKeyset
    if (
      conditional === null ||
      conditional.mint !== mint ||
      conditional.unit !== unit ||
      conditional.keysetId !== keyset.text ||
      conditional.curve !== keyset.curve ||
      metadata === null ||
      conditional.conditionId !== metadata.conditionId ||
      conditional.outcomeLabel !== metadata.outcomeLabel ||
      conditional.outcomeCollectionId !== metadata.outcomeCollectionId ||
      conditional.registeredAtUnixSeconds !== metadata.registeredAtUnixSeconds ||
      conditional.finalExpiryUnixSeconds !== metadata.finalExpiryUnixSeconds
    ) {
      throw new Error('proof does not match validated conditional keyset')
    }
  } else if (snapshot.conditionalKeyset !== null || row.conditionalKeysetEvidence !== null) {
    throw new Error('ordinary proof cannot bind a conditional keyset')
  }
  return snapshot
}

function requireAuthoritativeTerminalClassification(input: {
  input: EncryptedWalletBackupProofInput
  row: EncryptedWalletBackupCommittedProofSnapshot
  mint: string
  keysetId: string
  ctfTuple: EncryptedWalletBackupCtfWire | null
}): DurableWalletVerifiedLosingCtfClassification | null {
  if (input.input.terminalEvidence === null && input.row.terminalOperationId === null) {
    return null
  }
  if (
    input.input.terminalEvidence === null ||
    input.row.terminalOperationId === null ||
    input.ctfTuple === null
  ) {
    throw new Error('proof does not match authoritative terminal operation')
  }
  return verifyDurableWalletLosingCtfClassification({
    evidence: input.input.terminalEvidence,
    operationId: input.row.terminalOperationId,
    mintUrl: input.mint,
    conditionId: bytesToHex(input.ctfTuple[0]),
    outcome: input.ctfTuple[1],
    keysetId: input.keysetId,
    proof: input.input.proof,
  })
}

function requireProofSnapshotStore(value: unknown): EncryptedWalletBackupProofSnapshotStore {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { withCommittedProofSnapshot?: unknown }).withCommittedProofSnapshot !==
      'function'
  ) {
    throw new Error('proof snapshot store is invalid')
  }
  return value as EncryptedWalletBackupProofSnapshotStore
}

async function requireCommittedSnapshotSeal(
  storeInput: unknown,
  expected: EncryptedWalletBackupCommittedSnapshotSeal,
): Promise<void> {
  if (
    typeof storeInput !== 'object' ||
    storeInput === null ||
    typeof (storeInput as { sealCommittedBackupSnapshot?: unknown }).sealCommittedBackupSnapshot !==
      'function'
  ) {
    throw new Error('backup snapshot seal store is invalid')
  }
  const store = storeInput as EncryptedWalletBackupSnapshotSealStore
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await store.sealCommittedBackupSnapshot(expected, (rawSeal) => {
      if (!callbackOpen || callbackCalls++ !== 0)
        throw new Error('backup snapshot seal callback is invalid')
      const seal = decodeCommittedSnapshotSeal(rawSeal)
      if (
        seal.snapshotId !== expected.snapshotId ||
        seal.snapshotRevision !== expected.snapshotRevision ||
        seal.proofCount !== expected.proofCount ||
        seal.proofSetDigest !== expected.proofSetDigest
      ) {
        throw new Error('committed wallet snapshot changed')
      }
      const capability = Object.freeze({
        snapshotId: seal.snapshotId,
        revision: seal.snapshotRevision,
      })
      COMMITTED_SNAPSHOT_SEALS.set(capability, seal)
      issued = capability
      return capability
    })
  } finally {
    callbackOpen = false
  }
  if (
    isThenable(returned) ||
    issued === undefined ||
    returned !== issued ||
    callbackCalls !== 1 ||
    COMMITTED_SNAPSHOT_SEALS.get(issued) === undefined
  ) {
    throw new Error('backup snapshot seal must be synchronous and exact')
  }
}

function decodeCommittedSnapshotSeal(value: unknown): EncryptedWalletBackupCommittedSnapshotSeal {
  const seal = requireRecord(value, 'committed backup snapshot seal')
  requireKnownFields(seal, [
    'schemaVersion',
    'snapshotId',
    'snapshotRevision',
    'proofCount',
    'proofSetDigest',
  ])
  if (seal.schemaVersion !== 1) throw new Error('unsupported backup snapshot seal version')
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: requireBoundedText(seal.snapshotId, 128, 'sealed snapshot id'),
    snapshotRevision: requireNonNegativeSafeInteger(
      seal.snapshotRevision,
      'sealed snapshot revision',
    ),
    proofCount: requireInteger(
      seal.proofCount,
      0,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
      'sealed proof count',
    ),
    proofSetDigest: requireLowerHex(seal.proofSetDigest, 32, 'sealed proof-set digest'),
  })
}

function decodeCommittedProofSnapshot(value: unknown): EncryptedWalletBackupCommittedProofSnapshot {
  const row = requireRecord(value, 'committed proof snapshot')
  requireKnownFields(row, [
    'schemaVersion',
    'snapshotId',
    'revision',
    'proofId',
    'proofCommitment',
    'proofKind',
    'ctfMetadata',
    'terminalOperationId',
    'conditionalKeysetEvidence',
    'provenance',
    'operationBinding',
    'reserved',
    'ambiguousMintOperation',
    'proofPins',
    'derivationLocator',
  ])
  if (row.schemaVersion !== 1) throw new Error('unsupported committed proof snapshot version')
  const proofKind = requireProofKind(row.proofKind)
  const ctf = decodeCtfMetadata(
    row.ctfMetadata as EncryptedWalletBackupCtfMetadata | null,
    proofKind === 'ordinary' ? 0 : 1,
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: requireBoundedText(row.snapshotId, 128, 'storage snapshot id'),
    revision: requireNonNegativeSafeInteger(row.revision, 'storage snapshot revision'),
    proofId: requireLowerHex(row.proofId, 32, 'stored proof id'),
    proofCommitment: requireLowerHex(row.proofCommitment, 32, 'stored proof commitment'),
    proofKind,
    ctfMetadata: ctf === null ? null : ctfTupleToMetadata(ctf),
    terminalOperationId:
      row.terminalOperationId === null
        ? null
        : requireBoundedText(row.terminalOperationId, 512, 'stored CTF terminal operation id'),
    conditionalKeysetEvidence:
      row.conditionalKeysetEvidence as VerifiedEncryptedWalletBackupConditionalKeyset | null,
    provenance: requireOneOfValue(
      row.provenance,
      ['wallet-seed', 'external', 'unknown'],
      'stored provenance',
    ),
    operationBinding: requireOneOfValue(
      row.operationBinding,
      ['terminally-unlinked', 'nonterminal', 'unknown'],
      'stored operation binding',
    ),
    reserved: requireBoolean(row.reserved, 'stored reservation'),
    ambiguousMintOperation: requireBoolean(row.ambiguousMintOperation, 'stored ambiguity'),
    proofPins: decodeProofPins(row.proofPins),
    derivationLocator: requireOneOfValue(
      row.derivationLocator,
      ['committed', 'missing'],
      'stored derivation locator',
    ),
  })
}

function requireProofKind(value: unknown): EncryptedWalletBackupProofKind {
  if (!['ordinary', 'ctf', 'p2pk', 'htlc', 'unknown'].includes(value as string)) {
    throw new Error('stored proof kind is invalid')
  }
  return value as EncryptedWalletBackupProofKind
}

export async function prepareEncryptedWalletBackupProofs(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  records: readonly Omit<EncryptedWalletBackupProofInput, 'keyHandle' | 'seed'>[]
}): Promise<PreparedEncryptedWalletBackupProof[]> {
  if (
    !Array.isArray(input.records) ||
    input.records.length === 0 ||
    input.records.length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX
  ) {
    throw new Error('backup proof count is invalid')
  }
  const groups = new Map<string, typeof input.records>()
  for (const record of input.records) {
    const keysetId = requireRecord(record.proof, 'backup proof').id
    const keyset = decodeKeysetId(keysetId).text
    groups.set(keyset, [...(groups.get(keyset) ?? []), record])
  }
  const result: PreparedEncryptedWalletBackupProof[] = []
  for (const records of groups.values()) {
    for (const record of records) {
      result.push(
        await prepareEncryptedWalletBackupProof({
          ...record,
          keyHandle: input.keyHandle,
          seed: input.seed,
        }),
      )
    }
  }
  return result
}

export function packEncryptedWalletBackupProofChunk(
  handles: readonly PreparedEncryptedWalletBackupProof[],
): PreparedEncryptedWalletBackupProofChunk {
  if (
    !Array.isArray(handles) ||
    handles.length === 0 ||
    handles.length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX
  ) {
    throw new Error('backup proof count is invalid')
  }
  const authorities = handles
    .map((handle) => requireProofAuthority(handle))
    .sort((left, right) => compareHex(left.proofId, right.proofId))
  if (new Set(authorities.map((authority) => authority.proofId)).size !== authorities.length) {
    throw new Error('backup proof id is duplicated')
  }
  const records = authorities.map((authority) => decode(authority.recordBytes))
  const root = [1, ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND, records]
  const measured = measureCanonicalCbor(root)
  if (measured > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES) {
    throw new Error('backup proof chunk exceeds the canonical CBOR limit')
  }
  const canonical = encodeCanonical(root)
  const bindings = Object.freeze(
    authorities.map((authority) =>
      Object.freeze({
        proofId: authority.proofId,
        commitment: authority.commitment,
      }),
    ),
  )
  const chunk = Object.freeze({
    kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
    bindings,
  })
  const snapshotId = authorities[0]!.snapshotId
  const snapshotRevision = authorities[0]!.snapshotRevision
  const keyAuthority = authorities[0]!.keyAuthority
  if (
    authorities.some(
      (authority) =>
        authority.keyAuthority !== keyAuthority ||
        authority.snapshotId !== snapshotId ||
        authority.snapshotRevision !== snapshotRevision,
    )
  ) {
    throw new Error('committed wallet snapshot changed')
  }
  PREPARED_CHUNK_AUTHORITIES.set(chunk, {
    keyAuthority,
    canonical,
    proofs: Object.freeze([...authorities]),
    snapshotId,
    snapshotRevision,
  })
  return chunk
}

export async function prepareEncryptedWalletBackupObject(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  chunk: PreparedEncryptedWalletBackupProofChunk
  generation: number
  runtime?: EncryptedWalletBackupRuntime
  objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupObject> {
  const authority = requireKeyAuthority(input.keyHandle)
  const chunkAuthority = requireChunkAuthority(input.chunk)
  if (chunkAuthority.keyAuthority !== authority)
    throw new Error('proof chunk belongs to a different backup key')
  const generation = requireInteger(
    input.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    'backup generation',
  )
  const runtime = input.runtime === undefined ? authority.runtime : requireRuntime(input.runtime)
  let objectIdBytes: Uint8Array | undefined
  let objectId: string | undefined
  for (let attempt = 0; attempt < OBJECT_ID_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = randomBytes(runtime, 16)
    const candidateId = bytesToHex(candidate)
    if (authority.preparedObjectIds.has(candidateId)) continue
    authority.preparedObjectIds.add(candidateId)
    try {
      if (input.objectIdExists !== undefined && (await input.objectIdExists(candidateId))) {
        authority.preparedObjectIds.delete(candidateId)
        continue
      }
    } catch (error) {
      authority.preparedObjectIds.delete(candidateId)
      throw error
    }
    objectIdBytes = candidate
    objectId = candidateId
    break
  }
  if (objectIdBytes === undefined || objectId === undefined) {
    throw new Error('backup object id collision limit exceeded')
  }
  try {
    const nonce = randomBytes(runtime, 12)
    const aad = encodeCanonical([
      1,
      ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      authority.realm,
      authority.vaultIdBytes,
      objectIdBytes,
      generation,
      ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
    ])
    const objectKey = await hkdf(
      runtime.subtle,
      authority.encryptionRoot,
      objectIdBytes,
      encodeCanonical([
        1,
        'object-key',
        authority.realm,
        authority.vaultIdBytes,
        ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      ]),
    )
    const frame = new Uint8Array(ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES)
    writeUint32(frame, 0, chunkAuthority.canonical.byteLength)
    frame.set(chunkAuthority.canonical, 4)
    const key = await runtime.subtle.importKey('raw', asArrayBuffer(objectKey), 'AES-GCM', false, [
      'encrypt',
    ])
    const encrypted = new Uint8Array(
      await runtime.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: asArrayBuffer(nonce),
          additionalData: asArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        frame,
      ),
    )
    const body = concatBytes(nonce, encrypted)
    const digest = bytesToHex(sha256(concatBytes(uint32Bytes(aad.byteLength), aad, body)))
    const prepared = Object.freeze({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      realm: authority.realm,
      vaultId: bytesToHex(authority.vaultIdBytes),
      objectId,
      generation,
      paddedLength: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
      digest,
    })
    PREPARED_OBJECT_AUTHORITIES.set(prepared, {
      aad: aad.slice(),
      body: body.slice(),
      sourceChunk: input.chunk,
    })
    return prepared
  } catch (error) {
    authority.preparedObjectIds.delete(objectId)
    throw error
  }
}

export function readPreparedEncryptedWalletBackupObject(
  prepared: PreparedEncryptedWalletBackupObject,
): EncryptedWalletBackupWireObject {
  const authority =
    typeof prepared === 'object' && prepared !== null
      ? PREPARED_OBJECT_AUTHORITIES.get(prepared)
      : undefined
  if (authority === undefined) throw new Error('prepared backup object is invalid')
  return {
    ...prepared,
    aad: authority.aad.slice(),
    body: authority.body.slice(),
  }
}

export async function rehydratePreparedEncryptedWalletBackupProofObject(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  chunk: PreparedEncryptedWalletBackupProofChunk
  object: EncryptedWalletBackupWireObject
}): Promise<PreparedEncryptedWalletBackupObject> {
  try {
    const authority = requireKeyAuthority(input.keyHandle)
    const chunkAuthority = requireChunkAuthority(input.chunk)
    if (chunkAuthority.keyAuthority !== authority) throw new Error('foreign chunk')
    const seed = requireSeed(input.seed)
    if (!equalBytes(authority.seedDigest, sha256(seed))) throw new Error('foreign seed')
    const object = requireWireObject(input.object, authority)
    if (object.kindCode !== ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND) {
      throw new Error('foreign object kind')
    }
    const canonical = await decryptObjectFrame({
      authority,
      object,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      frameBytes: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
      cborMaxBytes: ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
    })
    preflightProofChunk(canonical)
    if (
      !equalBytes(canonical, encodeCanonical(decode(canonical))) ||
      !equalBytes(canonical, chunkAuthority.canonical)
    ) {
      throw new Error('foreign canonical chunk')
    }
    const prepared = Object.freeze({
      formatVersion: object.formatVersion,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      realm: object.realm,
      vaultId: object.vaultId,
      objectId: object.objectId,
      generation: object.generation,
      paddedLength: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
      digest: object.digest,
    })
    PREPARED_OBJECT_AUTHORITIES.set(prepared, {
      aad: object.aad.slice(),
      body: object.body.slice(),
      sourceChunk: input.chunk,
    })
    return prepared
  } catch {
    throw new Error('persisted encrypted wallet backup proof object is invalid')
  }
}

export async function prepareEncryptedWalletBackupManifest(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  generation: number
  snapshotNonce: Uint8Array
  chunks: readonly Readonly<{
    chunk: PreparedEncryptedWalletBackupProofChunk
    object: PreparedEncryptedWalletBackupObject
  }>[]
  emptySnapshot?: Readonly<{ snapshotId: string; snapshotRevision: number }>
  snapshotStore: EncryptedWalletBackupSnapshotSealStore
  runtime?: EncryptedWalletBackupRuntime
  objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupManifest> {
  const authority = requireKeyAuthority(input.keyHandle)
  const generation = requireInteger(
    input.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    'backup generation',
  )
  if (generation !== 1) {
    throw new Error('non-genesis manifest requires authenticated parent provenance')
  }
  const snapshotNonce = requireBytes(input.snapshotNonce, 16, 'manifest snapshot nonce').slice()
  if (!Array.isArray(input.chunks) || input.chunks.length > 1_024) {
    throw new Error('manifest chunk count is invalid')
  }
  if ((input.chunks.length === 0) !== (input.emptySnapshot !== undefined)) {
    throw new Error('empty manifest snapshot identity is invalid')
  }
  const seenObjectIds = new Set<string>()
  const seenDigests = new Set<string>()
  const bindings: Array<{
    proof: PreparedProofAuthority
    object: PreparedEncryptedWalletBackupObject
  }> = []
  let snapshotId: string | undefined
  let snapshotRevision: number | undefined
  for (const binding of input.chunks) {
    const chunkAuthority = requireChunkAuthority(binding.chunk)
    const objectAuthority = requirePreparedObjectAuthority(binding.object)
    if (
      objectAuthority.sourceChunk !== binding.chunk ||
      chunkAuthority.keyAuthority !== authority ||
      binding.object.kindCode !== ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND ||
      binding.object.realm !== authority.realm ||
      binding.object.vaultId !== bytesToHex(authority.vaultIdBytes) ||
      binding.object.paddedLength !== ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES ||
      binding.object.generation > generation
    ) {
      throw new Error('manifest chunk binding is invalid')
    }
    if (seenObjectIds.has(binding.object.objectId) || seenDigests.has(binding.object.digest)) {
      throw new Error('manifest chunk reference is duplicated')
    }
    seenObjectIds.add(binding.object.objectId)
    seenDigests.add(binding.object.digest)
    snapshotId ??= chunkAuthority.snapshotId
    snapshotRevision ??= chunkAuthority.snapshotRevision
    if (
      chunkAuthority.snapshotId !== snapshotId ||
      chunkAuthority.snapshotRevision !== snapshotRevision
    ) {
      throw new Error('committed wallet snapshot changed')
    }
    for (const proof of chunkAuthority.proofs) bindings.push({ proof, object: binding.object })
  }
  bindings.sort((left, right) => compareHex(left.proof.proofId, right.proof.proofId))
  const seenCommitments = new Set<string>()
  for (let index = 1; index < bindings.length; index += 1) {
    if (bindings[index - 1]!.proof.proofId === bindings[index]!.proof.proofId) {
      throw new Error('manifest proof binding is duplicated')
    }
  }
  for (const binding of bindings) {
    if (seenCommitments.has(binding.proof.commitment)) {
      throw new Error('manifest proof binding is duplicated')
    }
    seenCommitments.add(binding.proof.commitment)
  }
  if (input.emptySnapshot !== undefined) {
    snapshotId = requireBoundedText(input.emptySnapshot.snapshotId, 128, 'empty snapshot id')
    snapshotRevision = requireNonNegativeSafeInteger(
      input.emptySnapshot.snapshotRevision,
      'empty snapshot revision',
    )
  }
  const proofSetDigest = bytesToHex(
    sha256(
      encodeCanonical([
        1,
        'eligible-proof-set',
        bindings.map((binding) => [
          hexToBytes(binding.proof.proofId),
          hexToBytes(binding.proof.commitment),
        ]),
      ]),
    ),
  )
  await requireCommittedSnapshotSeal(input.snapshotStore, {
    schemaVersion: 1,
    snapshotId: snapshotId!,
    snapshotRevision: snapshotRevision!,
    proofCount: bindings.length,
    proofSetDigest,
  })
  const wireEntries = bindings.map(({ proof, object }) => manifestEntryWire(proof, object))
  const pageEntries: unknown[][][] = []
  let current: unknown[][] = []
  for (const entry of wireEntries) {
    const candidate = [...current, entry]
    const provisional = [
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      generation,
      snapshotNonce,
      pageEntries.length,
      1_024,
      candidate,
    ]
    if (
      candidate.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX ||
      measureCanonicalCbor(provisional) > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES
    ) {
      if (current.length === 0) throw new Error('manifest entry exceeds the encoded size limit')
      pageEntries.push(current)
      current = [entry]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) pageEntries.push(current)
  if (pageEntries.length > 1_024) {
    throw new Error('manifest page count is invalid')
  }
  const runtime = input.runtime === undefined ? authority.runtime : requireRuntime(input.runtime)
  const pages: PreparedEncryptedWalletBackupObject[] = []
  for (let pageIndex = 0; pageIndex < pageEntries.length; pageIndex += 1) {
    const canonical = encodeCanonical([
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      generation,
      snapshotNonce,
      pageIndex,
      pageEntries.length,
      pageEntries[pageIndex],
    ])
    if (canonical.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES) {
      throw new Error('manifest page exceeds the canonical CBOR limit')
    }
    pages.push(
      await prepareManifestObject({
        authority,
        generation,
        canonical,
        runtime,
        objectIdExists: input.objectIdExists,
      }),
    )
  }
  const manifest = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    generation,
    snapshotNonce: bytesToHex(snapshotNonce),
    snapshotId: snapshotId!,
    snapshotRevision: snapshotRevision!,
    proofCount: bindings.length,
    pageCount: pages.length,
    pages: Object.freeze(pages),
    chunkObjects: Object.freeze(input.chunks.map((binding) => binding.object)),
  })
  PREPARED_MANIFESTS.set(manifest, {
    keyHandle: input.keyHandle,
    pages: manifest.pages,
    chunkObjects: manifest.chunkObjects,
    inheritedChunkReferences: Object.freeze([]),
    repackedSourceObjectIdsByObjectId: new Map(),
    requiredParentHead: null,
  })
  return manifest
}

/**
 * Builds an exact child from authenticated parent metadata plus newly prepared
 * proofs. Inherited entries remain opaque manifest metadata and never become
 * proof-selection authority.
 */
export async function prepareIncrementalEncryptedWalletBackupManifest(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  generation: number
  snapshotNonce: Uint8Array
  parentEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  parentPages: readonly DecryptedEncryptedWalletBackupManifestPage[]
  chunks: readonly Readonly<{
    chunk: PreparedEncryptedWalletBackupProofChunk
    object: PreparedEncryptedWalletBackupObject
  }>[]
  removedProofIds: readonly string[]
  snapshot: Readonly<{ snapshotId: string; snapshotRevision: number }>
  snapshotStore: EncryptedWalletBackupSnapshotSealStore
  runtime?: EncryptedWalletBackupRuntime
  objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupManifest> {
  const authority = requireKeyAuthority(input.keyHandle)
  const observation =
    typeof input.parentEvidence === 'object' && input.parentEvidence !== null
      ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.parentEvidence)
      : undefined
  if (
    observation === undefined ||
    observation.keyAuthority !== authority ||
    observation.head === null
  ) {
    throw new Error('incremental manifest parent is not authenticated')
  }
  const generation = requireInteger(
    input.generation,
    2,
    Number.MAX_SAFE_INTEGER,
    'backup generation',
  )
  if (generation !== observation.head.generation + 1) {
    throw new Error('incremental manifest generation does not advance parent')
  }
  const snapshotNonce = requireBytes(input.snapshotNonce, 16, 'manifest snapshot nonce').slice()
  const snapshotId = requireBoundedText(input.snapshot.snapshotId, 128, 'incremental snapshot id')
  const snapshotRevision = requireNonNegativeSafeInteger(
    input.snapshot.snapshotRevision,
    'incremental snapshot revision',
  )
  if (
    !Array.isArray(input.parentPages) ||
    !Array.isArray(input.chunks) ||
    input.chunks.length > 1_024 ||
    !Array.isArray(input.removedProofIds) ||
    input.removedProofIds.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX
  ) {
    throw new Error('incremental manifest input is invalid')
  }
  const parentPages = [...input.parentPages].sort((left, right) => left.pageIndex - right.pageIndex)
  if (
    parentPages.length === 0
      ? observation.head.proofCount !== 0
      : parentPages.some((page, index) => {
          const pageAuthority = DECRYPTED_MANIFEST_PAGE_AUTHORITIES.get(page)
          return (
            pageAuthority === undefined ||
            pageAuthority.keyAuthority !== authority ||
            pageAuthority.head !== observation.head ||
            page.pageIndex !== index ||
            page.pageCount !== parentPages.length
          )
        })
  )
    throw new Error('incremental manifest parent pages are incomplete or foreign')
  const parentEntries = parentPages.flatMap((page) => page.entries)
  if (parentEntries.length !== observation.head.proofCount) {
    throw new Error('incremental manifest parent proof count changed')
  }
  const removed = new Set(
    input.removedProofIds.map((proofId) => requireLowerHex(proofId, 32, 'removed backup proof id')),
  )
  if (removed.size !== input.removedProofIds.length)
    throw new Error('removed backup proof id is duplicated')

  const entries = new Map<string, EncryptedWalletBackupManifestEntry>()
  const parentEntryByProofId = new Map(parentEntries.map((entry) => [entry.proofId, entry]))
  for (const entry of parentEntries) {
    if (removed.has(entry.proofId)) removed.delete(entry.proofId)
    else entries.set(entry.proofId, entry)
  }
  const newChunkObjects: PreparedEncryptedWalletBackupObject[] = []
  const newProofIds = new Set<string>()
  const newObjectIds = new Set<string>()
  const newObjectDigests = new Set<string>()
  const repackedSourceObjectIdsByObjectId = new Map<string, ReadonlySet<string>>()
  for (const binding of input.chunks) {
    const chunkAuthority = requireChunkAuthority(binding.chunk)
    const objectAuthority = requirePreparedObjectAuthority(binding.object)
    if (
      objectAuthority.sourceChunk !== binding.chunk ||
      chunkAuthority.keyAuthority !== authority ||
      binding.object.kindCode !== ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND ||
      binding.object.generation > generation ||
      chunkAuthority.snapshotId !== snapshotId ||
      chunkAuthority.snapshotRevision !== snapshotRevision
    ) {
      throw new Error('incremental manifest chunk binding is invalid')
    }
    if (newObjectIds.has(binding.object.objectId) || newObjectDigests.has(binding.object.digest)) {
      throw new Error('incremental manifest chunk object is duplicated')
    }
    newObjectIds.add(binding.object.objectId)
    newObjectDigests.add(binding.object.digest)
    newChunkObjects.push(binding.object)
    const repackedSources = new Set<string>()
    for (const proof of chunkAuthority.proofs) {
      if (newProofIds.has(proof.proofId)) {
        throw new Error('incremental manifest new proof id is duplicated')
      }
      newProofIds.add(proof.proofId)
      const parentEntry = parentEntryByProofId.get(proof.proofId)
      if (parentEntry !== undefined && parentEntry.chunkObjectId !== binding.object.objectId) {
        repackedSources.add(parentEntry.chunkObjectId)
      }
      entries.set(proof.proofId, decodeManifestEntry(manifestEntryWire(proof, binding.object)))
      removed.delete(proof.proofId)
    }
    repackedSourceObjectIdsByObjectId.set(binding.object.objectId, repackedSources)
  }
  if (removed.size !== 0)
    throw new Error('removed backup proof is not present in parent or replacement')
  const sortedEntries = [...entries.values()].sort((left, right) =>
    compareHex(left.proofId, right.proofId),
  )
  for (const object of newChunkObjects) {
    if (
      !sortedEntries.some(
        (entry) => entry.chunkObjectId === object.objectId && entry.chunkDigest === object.digest,
      )
    ) {
      throw new Error('incremental manifest chunk contributes no final entry')
    }
  }
  if (new Set(sortedEntries.map((entry) => entry.commitment)).size !== sortedEntries.length) {
    throw new Error('incremental manifest proof binding is duplicated')
  }
  const proofSetDigest = bytesToHex(
    sha256(
      encodeCanonical([
        1,
        'eligible-proof-set',
        sortedEntries.map((entry) => [hexToBytes(entry.proofId), hexToBytes(entry.commitment)]),
      ]),
    ),
  )
  await requireCommittedSnapshotSeal(input.snapshotStore, {
    schemaVersion: 1,
    snapshotId,
    snapshotRevision,
    proofCount: sortedEntries.length,
    proofSetDigest,
  })

  const newChunkIds = new Set(newChunkObjects.map((object) => object.objectId))
  const inheritedChunkReferences = new Map<string, string>()
  for (const entry of sortedEntries) {
    if (!newChunkIds.has(entry.chunkObjectId)) {
      inheritedChunkReferences.set(entry.chunkObjectId, entry.chunkDigest)
    }
  }
  const parentAuthority = AUTHENTICATED_MANIFEST_HEAD_VALUES.get(observation.head)
  if (parentAuthority === undefined)
    throw new Error('incremental manifest parent is not authenticated')
  const parentReferenceSet = decode(parentAuthority.canonicalReferenceSet)
  const parentChunks = decodeObjectReferences(
    Array.isArray(parentReferenceSet) ? parentReferenceSet[3] : undefined,
    'parent chunk references',
  )
  for (const [objectId, digest] of inheritedChunkReferences) {
    if (
      !parentChunks.some(
        (reference) => reference.objectId === objectId && reference.digest === digest,
      )
    ) {
      throw new Error('incremental manifest inherited reference is stale or foreign')
    }
  }

  const pageEntryGroups: EncryptedWalletBackupManifestEntry[][] = []
  let current: EncryptedWalletBackupManifestEntry[] = []
  for (const entry of sortedEntries) {
    const candidate = [...current, entry]
    const provisional = [
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      generation,
      snapshotNonce,
      pageEntryGroups.length,
      1_024,
      candidate.map(manifestEntryValue),
    ]
    if (
      candidate.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX ||
      measureCanonicalCbor(provisional) > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES
    ) {
      if (current.length === 0) throw new Error('manifest entry exceeds the encoded size limit')
      pageEntryGroups.push(current)
      current = [entry]
    } else current = candidate
  }
  if (current.length > 0) pageEntryGroups.push(current)
  const runtime = input.runtime === undefined ? authority.runtime : requireRuntime(input.runtime)
  const pages: PreparedEncryptedWalletBackupObject[] = []
  for (let pageIndex = 0; pageIndex < pageEntryGroups.length; pageIndex += 1) {
    pages.push(
      await prepareManifestObject({
        authority,
        generation,
        canonical: encodeCanonical([
          1,
          ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
          generation,
          snapshotNonce,
          pageIndex,
          pageEntryGroups.length,
          pageEntryGroups[pageIndex]!.map(manifestEntryValue),
        ]),
        runtime,
        objectIdExists: input.objectIdExists,
      }),
    )
  }
  const manifest = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    generation,
    snapshotNonce: bytesToHex(snapshotNonce),
    snapshotId,
    snapshotRevision,
    proofCount: sortedEntries.length,
    pageCount: pages.length,
    pages: Object.freeze(pages),
    chunkObjects: Object.freeze(newChunkObjects),
  })
  PREPARED_MANIFESTS.set(manifest, {
    keyHandle: input.keyHandle,
    pages: manifest.pages,
    chunkObjects: manifest.chunkObjects,
    inheritedChunkReferences: Object.freeze(
      [...inheritedChunkReferences].map(([objectId, digest]) =>
        Object.freeze({ objectId, digest }),
      ),
    ),
    repackedSourceObjectIdsByObjectId,
    requiredParentHead: observation.head,
  })
  return manifest
}

export function prepareEncryptedWalletBackupManifestHead(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  manifest: PreparedEncryptedWalletBackupManifest
  parent: EncryptedWalletBackupManifestHead | null
}): EncryptedWalletBackupManifestHead {
  const authority = requireKeyAuthority(input.keyHandle)
  const manifest = requirePreparedManifest(input.manifest, authority)
  const manifestAuthority = PREPARED_MANIFESTS.get(manifest)!
  const parentAuthority = input.parent === null ? null : requireManifestHeadAuthority(input.parent)
  if (parentAuthority !== null && parentAuthority.keyAuthority !== authority) {
    throw new Error('manifest parent belongs to a different backup key')
  }
  const parent = parentAuthority?.head ?? null
  if (
    (parent === null && manifest.generation !== 1) ||
    (parent !== null && manifest.generation !== parent.generation + 1)
  ) {
    throw new Error('manifest generation does not advance its parent')
  }
  if (input.parent !== manifestAuthority.requiredParentHead) {
    throw new Error('manifest parent is not the authenticated source head')
  }
  const pageReferences = manifest.pages.map((object) => objectReferenceWire(object))
  const parentChunkReferences =
    parentAuthority === null
      ? []
      : (() => {
          const value = decode(parentAuthority.canonicalReferenceSet)
          return decodeObjectReferences(
            Array.isArray(value) ? value[3] : undefined,
            'parent chunk references',
          )
        })()
  const inheritedById = new Map(
    manifestAuthority.inheritedChunkReferences.map((reference) => [
      reference.objectId,
      reference.digest,
    ]),
  )
  for (const object of manifest.chunkObjects) {
    if (
      parentChunkReferences.some(
        (reference) => reference.objectId === object.objectId && reference.digest === object.digest,
      )
    )
      inheritedById.set(object.objectId, object.digest)
  }
  const inheritedChunkReferences = [...inheritedById].map(([objectId, digest]) => ({
    objectId,
    digest,
  }))
  const chunkReferenceRecords = [
    ...inheritedChunkReferences,
    ...manifest.chunkObjects
      .filter((object) => !inheritedById.has(object.objectId))
      .map((object) => ({ objectId: object.objectId, digest: object.digest })),
  ].sort((left, right) => compareHex(left.objectId, right.objectId))
  const chunkReferences = chunkReferenceRecords.map((reference) => [
    hexToBytes(reference.objectId),
    hexToBytes(reference.digest),
  ])
  const allObjectIds = [
    ...manifest.pages.map((object) => object.objectId),
    ...chunkReferenceRecords.map((reference) => reference.objectId),
  ]
  if (
    allObjectIds.length > ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX ||
    new Set(allObjectIds).size !== allObjectIds.length
  ) {
    throw new Error('manifest reference count is invalid')
  }
  const allObjectDigests = [
    ...manifest.pages.map((object) => object.digest),
    ...chunkReferenceRecords.map((reference) => reference.digest),
  ]
  if (new Set(allObjectDigests).size !== allObjectDigests.length) {
    throw new Error('manifest object digest is duplicated')
  }
  if (
    (manifest.proofCount === 0 && allObjectIds.length !== 0) ||
    (manifest.proofCount > 0 &&
      (manifest.pages.length === 0 || chunkReferenceRecords.length === 0)) ||
    chunkReferenceRecords.length <
      Math.ceil(manifest.proofCount / ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX) ||
    chunkReferenceRecords.length > manifest.proofCount ||
    manifest.pages.length <
      Math.ceil(manifest.proofCount / ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX) ||
    manifest.pages.length > manifest.proofCount
  ) {
    throw new Error('manifest proof count does not match reference bounds')
  }
  const referenceSet = [1, 'reference-set', pageReferences, chunkReferences]
  const canonicalReferenceSet = encodeCanonical(referenceSet)
  if (canonicalReferenceSet.byteLength > ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES) {
    throw new Error('manifest reference metadata exceeds the byte limit')
  }
  const referenceSetDigest = sha256(canonicalReferenceSet)
  const canonicalInheritedReferenceSet = encodeCanonical([
    1,
    'reference-set',
    [],
    inheritedChunkReferences
      .slice()
      .sort((left, right) => compareHex(left.objectId, right.objectId))
      .map((reference) => [hexToBytes(reference.objectId), hexToBytes(reference.digest)]),
  ])
  const storedBytes =
    manifest.pages.length * ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
    chunkReferenceRecords.length * ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  if (storedBytes > ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX) {
    throw new Error('manifest target exceeds the stored byte quota')
  }
  const inheritedReferenceKeys = new Set(
    inheritedChunkReferences.map((reference) => `${reference.objectId}:${reference.digest}`),
  )
  const nonInheritedChunkCount = chunkReferenceRecords.filter(
    (reference) => !inheritedReferenceKeys.has(`${reference.objectId}:${reference.digest}`),
  ).length
  const parentReachableStoredBytes = parent?.storedBytes ?? 0
  const nonInheritedTargetDeltaStoredBytes =
    manifest.pages.length * ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
    nonInheritedChunkCount * ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  if (
    parentReachableStoredBytes + nonInheritedTargetDeltaStoredBytes >
    ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX
  ) {
    throw new Error('manifest parent and target delta exceed the stored byte quota')
  }
  const headCore = [
    1,
    'manifest-head',
    authority.realm,
    authority.vaultIdBytes,
    hexToBytes(input.keyHandle.requestAuthPublicKey),
    manifest.generation,
    parent === null ? null : [parent.generation, hexToBytes(parent.manifestDigest)],
    hexToBytes(manifest.snapshotNonce),
    pageReferences,
    chunkReferences,
    manifest.proofCount,
    storedBytes,
    referenceSetDigest,
  ]
  const canonicalHead = encodeCanonical(headCore)
  if (canonicalHead.byteLength > ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES) {
    throw new Error('manifest head exceeds the byte limit')
  }
  const manifestDigest = bytesToHex(sha256(canonicalHead))
  const head = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm: authority.realm,
    vaultId: bytesToHex(authority.vaultIdBytes),
    backupPublicKey: input.keyHandle.requestAuthPublicKey,
    generation: manifest.generation,
    parent:
      parent === null
        ? null
        : Object.freeze({
            generation: parent.generation,
            manifestDigest: parent.manifestDigest,
          }),
    snapshotNonce: manifest.snapshotNonce,
    snapshotId: deriveDurableWalletBackupSnapshotId({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      realm: authority.realm,
      backupPublicKey: input.keyHandle.requestAuthPublicKey,
      generation: manifest.generation,
      manifestDigest,
    }),
    manifestDigest,
    referenceSetDigest: bytesToHex(referenceSetDigest),
    objectCount: allObjectIds.length,
    storedBytes,
    proofCount: manifest.proofCount,
  })
  PREPARED_MANIFEST_HEADS.set(head, {
    head,
    keyAuthority: authority,
    localSnapshotId: manifest.snapshotId,
    localSnapshotRevision: manifest.snapshotRevision,
    canonicalHead,
    canonicalReferenceSet,
    canonicalParentHead: parentAuthority?.canonicalHead.slice() ?? null,
    canonicalInheritedReferenceSet,
    pageObjects: manifest.pages,
    chunkObjects: manifest.chunkObjects,
  })
  const uploadChunkObjects = manifest.chunkObjects.filter(
    (object) => !inheritedById.has(object.objectId),
  )
  issuePreparedEncryptedWalletBackupUploadAuthority(
    head,
    input.keyHandle,
    [...manifest.pages, ...uploadChunkObjects],
    manifestAuthority.repackedSourceObjectIdsByObjectId,
  )
  return head
}

export function readPreparedEncryptedWalletBackupManifestHead(
  head: EncryptedWalletBackupManifestHead,
): EncryptedWalletBackupManifestHeadWire {
  const authority =
    typeof head === 'object' && head !== null ? PREPARED_MANIFEST_HEADS.get(head) : undefined
  if (authority === undefined) throw new Error('prepared manifest head is invalid')
  return Object.freeze({
    canonicalHead: authority.canonicalHead.slice(),
    canonicalReferenceSet: authority.canonicalReferenceSet.slice(),
  })
}

export function readPreparedEncryptedWalletBackupManifestTarget(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  head: EncryptedWalletBackupManifestHead
}): PreparedEncryptedWalletBackupManifestTarget {
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  const authority =
    typeof input.head === 'object' && input.head !== null
      ? PREPARED_MANIFEST_HEADS.get(input.head)
      : undefined
  if (
    authority === undefined ||
    authority.keyAuthority !== keyAuthority ||
    authority.localSnapshotId === null ||
    authority.localSnapshotRevision === null
  ) {
    throw new Error('prepared manifest target is invalid')
  }
  return Object.freeze({
    head: input.head,
    wire: Object.freeze({
      canonicalHead: authority.canonicalHead.slice(),
      canonicalReferenceSet: authority.canonicalReferenceSet.slice(),
    }),
    localSnapshotId: authority.localSnapshotId,
    localSnapshotRevision: authority.localSnapshotRevision,
    canonicalParentHead: authority.canonicalParentHead?.slice() ?? null,
    canonicalInheritedReferenceSet: authority.canonicalInheritedReferenceSet.slice(),
  })
}

export async function resumeEncryptedWalletBackupSyncAttempt(input: {
  attempt: SealedEncryptedWalletBackupSyncAttempt
}): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  const authority =
    typeof input.attempt === 'object' && input.attempt !== null
      ? readCoordinatedEncryptedWalletBackupCasAuthority(input.attempt)
      : undefined
  if (
    authority === undefined ||
    authority.record.state !== 'retry-exhausted' ||
    authority.record.retryNotBeforeUnixMilliseconds === null
  ) {
    throw new Error('backup sync attempt is not retry-exhausted')
  }
  if (typeof authority.store.resumeRetryExhaustedAttempt !== 'function') {
    throw new Error('backup sync attempt store is invalid')
  }
  const next = freezeSyncAttempt({
    ...authority.record,
    retryNotBeforeUnixMilliseconds: null,
    state: 'reconcile-before-retry',
  })
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await authority.store.resumeRetryExhaustedAttempt(
      authority.record,
      next,
      (rawRecord) => {
        if (!callbackOpen || callbackCalls++ !== 0)
          throw new Error('backup resume callback is invalid')
        const committed = decodeSyncAttemptRecord(rawRecord)
        if (!equalSyncAttemptRecord(committed, next))
          throw new Error('resumed backup attempt changed')
        const evidence = issueCoordinatedEncryptedWalletBackupCasAttempt(
          committed,
          authority.keyHandle,
          authority.store,
        )
        issued = evidence
        return evidence
      },
    )
  } finally {
    callbackOpen = false
  }
  if (
    isThenable(returned) ||
    typeof returned !== 'object' ||
    returned === null ||
    !('state' in returned)
  ) {
    throw new Error('backup retry resume must be synchronous and exact')
  }
  if (returned.state === 'not-ready') {
    if (issued !== undefined || callbackCalls !== 0) {
      throw new Error('backup retry resume must be synchronous and exact')
    }
    return input.attempt
  }
  if (
    returned.state !== 'committed' ||
    !('value' in returned) ||
    issued === undefined ||
    returned.value !== issued ||
    callbackCalls !== 1
  ) {
    throw new Error('backup retry resume must be synchronous and exact')
  }
  return issued as SealedEncryptedWalletBackupSyncAttempt
}

export async function advanceEncryptedWalletBackupSyncAttempt(input: {
  attempt: SealedEncryptedWalletBackupSyncAttempt
  event:
    | Readonly<{ type: 'cas-dispatched' }>
    | Readonly<{ type: 'retry-deferred'; delayMilliseconds: number }>
    | Readonly<{
        type: 'head-observed'
        observation: AuthenticatedEncryptedWalletBackupHeadEvidence
      }>
}): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  const attemptAuthority =
    typeof input.attempt === 'object' && input.attempt !== null
      ? readCoordinatedEncryptedWalletBackupCasAuthority(input.attempt)
      : undefined
  if (attemptAuthority === undefined) throw new Error('backup sync attempt is not sealed')
  const current = attemptAuthority.record
  let next: EncryptedWalletBackupSyncAttemptRecord
  switch (input.event.type) {
    case 'cas-dispatched': {
      if (current.state !== 'sealed' && current.state !== 'retry-cas') {
        throw new Error('backup CAS cannot dispatch from this state')
      }
      if (current.casAttempts >= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX) {
        throw new Error('backup CAS attempt limit exceeded')
      }
      next = freezeSyncAttempt({
        ...current,
        casAttempts: current.casAttempts + 1,
        state: 'cas-uncertain',
      })
      break
    }
    case 'retry-deferred': {
      if (current.state !== 'cas-uncertain')
        throw new Error('backup CAS retry deferral is out of order')
      const schedule = planEncryptedWalletBackupRetry({
        realm: current.realm,
        vaultId: current.vaultId,
        attemptId: current.attemptId,
        currentStreak: current.retryStreak,
        minimumDelayMilliseconds: input.event.delayMilliseconds,
      })
      const exhaustedCandidate = freezeSyncAttempt({
        ...current,
        retryStreak: schedule.streak,
        state: 'retry-exhausted',
        retryNotBeforeUnixMilliseconds: 1,
      })
      return persistExhaustedSyncAttempt(
        attemptAuthority.store,
        current,
        exhaustedCandidate,
        attemptAuthority.keyHandle,
        requireInteger(schedule.delayMilliseconds, 1, 3_600_000, 'backup retry deferral delay'),
      )
    }
    case 'head-observed': {
      if (
        current.state !== 'cas-uncertain' &&
        current.state !== 'retry-exhausted' &&
        current.state !== 'reconcile-before-retry'
      )
        throw new Error('backup head observation is out of order')
      const observation =
        typeof input.event.observation === 'object' && input.event.observation !== null
          ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.event.observation)
          : undefined
      if (
        observation === undefined ||
        observation.keyAuthority !== requireKeyAuthority(attemptAuthority.keyHandle)
      ) {
        throw new Error('backup head observation is not authenticated')
      }
      const observed = observation.head?.manifestDigest ?? null
      if (observed === current.targetHead.manifestDigest) {
        next = freezeSyncAttempt({
          ...current,
          retryStreak: 0,
          state: 'acknowledged',
          retryNotBeforeUnixMilliseconds: null,
        })
      } else if (observed === current.expectedHeadDigest) {
        if (current.state === 'retry-exhausted') {
          return input.attempt
        } else if (current.state === 'reconcile-before-retry') {
          next = freezeSyncAttempt({
            ...current,
            casAttempts: 0,
            state: 'sealed',
          })
        } else if (current.casAttempts < ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX) {
          next = freezeSyncAttempt({ ...current, state: 'retry-cas' })
        } else {
          const schedule = planEncryptedWalletBackupRetry({
            realm: current.realm,
            vaultId: current.vaultId,
            attemptId: current.attemptId,
            currentStreak: current.retryStreak,
            minimumDelayMilliseconds: ENCRYPTED_WALLET_BACKUP_RETRY_BASE_MILLISECONDS,
          })
          const exhaustedCandidate = freezeSyncAttempt({
            ...current,
            retryStreak: schedule.streak,
            state: 'retry-exhausted',
            retryNotBeforeUnixMilliseconds: 1,
          })
          return persistExhaustedSyncAttempt(
            attemptAuthority.store,
            current,
            exhaustedCandidate,
            attemptAuthority.keyHandle,
            schedule.delayMilliseconds,
          )
        }
      } else {
        next = freezeSyncAttempt({
          ...current,
          state: 'fork-rejected',
          retryNotBeforeUnixMilliseconds: null,
        })
      }
      break
    }
    default:
      return assertNeverSyncEvent(input.event)
  }
  return persistSyncAttemptTransition(
    attemptAuthority.store,
    current,
    next,
    attemptAuthority.keyHandle,
  )
}

async function persistExhaustedSyncAttempt(
  store: EncryptedWalletBackupSyncAttemptStore,
  expected: EncryptedWalletBackupSyncAttemptRecord,
  candidate: EncryptedWalletBackupSyncAttemptRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
  delayMilliseconds = 5_000,
): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  if (typeof store.exhaustPreparedAttempt !== 'function')
    throw new Error('backup exhaustion store is invalid')
  let issued: object | undefined
  let calls = 0
  let open = true
  let returned: unknown
  try {
    returned = await store.exhaustPreparedAttempt(
      expected,
      candidate,
      requireInteger(delayMilliseconds, 1, 3_600_000, 'backup exhaustion delay'),
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('backup exhaustion callback is invalid')
        const committed = decodeSyncAttemptRecord(raw)
        if (
          committed.state !== 'retry-exhausted' ||
          committed.retryNotBeforeUnixMilliseconds === null ||
          !equalSyncAttemptRecord(
            committed,
            freezeSyncAttempt({
              ...candidate,
              retryNotBeforeUnixMilliseconds: committed.retryNotBeforeUnixMilliseconds,
            }),
          )
        )
          throw new Error('backup exhaustion stamp is invalid')
        issued = issueCoordinatedEncryptedWalletBackupCasAttempt(committed, keyHandle, store)
        return issued
      },
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || calls !== 1)
    throw new Error('backup exhaustion must be synchronous and exact')
  return issued as SealedEncryptedWalletBackupSyncAttempt
}

/**
 * Runs only the bounded, crash-safe head-CAS slice. Object staging is a
 * separate cursor-driven phase. Every dispatch is journaled before network I/O,
 * and an uncertain response is resolved by reading the authenticated head.
 */
export async function synchronizeEncryptedWalletBackupManifestHead(input: {
  attempt: SealedEncryptedWalletBackupSyncAttempt
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  casUrl: string
  headUrl: string
  clock: EncryptedWalletBackupClock
  remote: EncryptedWalletBackupCasRemotePort
  signal: AbortSignal
  runtime?: EncryptedWalletBackupRuntime
}): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  requireSealedSyncAttempt(input.attempt, input.keyHandle)
  let attempt = input.attempt
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
  ) {
    throw new Error('encrypted backup clock is invalid')
  }
  const casUrl = requireExactHttpsUrl(input.casUrl)
  const headUrl = requireExactHttpsUrl(input.headUrl)
  const runtime = input.runtime === undefined ? keyAuthority.runtime : requireRuntime(input.runtime)
  if (
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.compareAndSwapCurrentHead !== 'function' ||
    typeof input.remote.readCurrentHead !== 'function'
  ) {
    throw new Error('encrypted backup CAS remote port is invalid')
  }

  if (attempt.record.state === 'retry-exhausted') {
    attempt = await resumeEncryptedWalletBackupSyncAttempt({
      attempt,
    })
  }

  const observeHead = async (): Promise<SealedEncryptedWalletBackupSyncAttempt> => {
    const issuedAt = requireNonNegativeSafeInteger(
      input.clock.nowUnixSeconds(),
      'request issue time',
    )
    const requestProof = await prepareEncryptedWalletBackupRequestProof({
      keyHandle: input.keyHandle,
      enrollmentEpoch: epoch,
      method: 'GET',
      url: headUrl,
      issuedAtUnixSeconds: issuedAt,
      expiresAtUnixSeconds: issuedAt + 60,
      payload: new Uint8Array(),
      signal: cycleSignal,
      runtime,
    })
    const observation = await readAuthenticatedEncryptedWalletBackupHead({
      keyHandle: input.keyHandle,
      enrollmentEpoch: epoch,
      requestProof,
      remote: input.remote,
    })
    return advanceEncryptedWalletBackupSyncAttempt({
      attempt,
      event: {
        type: 'head-observed',
        observation,
      },
    })
  }

  if (
    attempt.record.state === 'cas-uncertain' ||
    attempt.record.state === 'reconcile-before-retry'
  ) {
    attempt = await observeHead()
  }
  while (attempt.record.state === 'sealed' || attempt.record.state === 'retry-cas') {
    attempt = await advanceEncryptedWalletBackupSyncAttempt({
      attempt,
      event: { type: 'cas-dispatched' },
    })
    const privateAttempt = requireSealedSyncAttempt(attempt, input.keyHandle)
    const issuedAt = requireNonNegativeSafeInteger(
      input.clock.nowUnixSeconds(),
      'request issue time',
    )
    const requestProof = await prepareEncryptedWalletBackupRequestProof({
      keyHandle: input.keyHandle,
      enrollmentEpoch: epoch,
      method: 'POST',
      url: casUrl,
      issuedAtUnixSeconds: issuedAt,
      expiresAtUnixSeconds: issuedAt + 60,
      payload: privateAttempt.record.canonicalCasPayload,
      signal: cycleSignal,
      runtime,
    })
    await validateCurrentCoordinatedCasAttempt(attempt)
    let response: Awaited<
      ReturnType<EncryptedWalletBackupCasRemotePort['compareAndSwapCurrentHead']>
    > | null
    let retryDelayMilliseconds: number | undefined
    try {
      response = await awaitEncryptedWalletBackupCycle(
        input.remote.compareAndSwapCurrentHead({
          requestProof,
          canonicalCasPayload: privateAttempt.record.canonicalCasPayload.slice(),
          signal: cycleSignal,
        }),
        cycleSignal,
      )
    } catch (error) {
      if (error instanceof EncryptedWalletBackupDeadlineError) throw error
      response = null
      retryDelayMilliseconds = 5_000
    }
    if (response !== null) {
      if (
        typeof response !== 'object' ||
        response === null ||
        typeof response.status !== 'string'
      ) {
        throw new Error('encrypted backup CAS response is invalid')
      }
      if (response.status === 'unauthorized') {
        throw new Error(`encrypted backup CAS failed: ${response.status}`)
      }
      if (
        response.status !== 'committed' &&
        response.status !== 'conflict' &&
        response.status !== 'quota-exceeded' &&
        response.status !== 'rate-limited' &&
        response.status !== 'overloaded' &&
        response.status !== 'unavailable'
      ) {
        throw new Error('encrypted backup CAS response is invalid')
      }
      if (
        response.status === 'quota-exceeded' ||
        response.status === 'rate-limited' ||
        response.status === 'overloaded' ||
        response.status === 'unavailable'
      ) {
        retryDelayMilliseconds = new EncryptedWalletBackupRemoteBackoffError(
          response.status,
          response.retryAfterSeconds,
        ).delayMilliseconds()
      }
    }
    // Backpressure and transport uncertainty are durable before the
    // acknowledgement read. A failed read therefore cannot erase the
    // database-time boundary or permit an immediate restart loop.
    if (retryDelayMilliseconds !== undefined) {
      throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
      attempt = await advanceEncryptedWalletBackupSyncAttempt({
        attempt,
        event: {
          type: 'retry-deferred',
          delayMilliseconds: retryDelayMilliseconds,
        },
      })
      try {
        attempt = await observeHead()
      } catch (error) {
        if (error instanceof EncryptedWalletBackupDeadlineError) throw error
        if (!(error instanceof EncryptedWalletBackupRemoteFailureError)) throw error
        return attempt
      }
    } else {
      try {
        attempt = await observeHead()
      } catch (error) {
        if (error instanceof EncryptedWalletBackupDeadlineError) throw error
        if (!(error instanceof EncryptedWalletBackupRemoteFailureError)) throw error
        throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
        attempt = await advanceEncryptedWalletBackupSyncAttempt({
          attempt,
          event: { type: 'retry-deferred', delayMilliseconds: 5_000 },
        })
      }
    }
  }
  return attempt
}

async function validateCurrentCoordinatedCasAttempt(
  attempt: SealedEncryptedWalletBackupSyncAttempt,
): Promise<void> {
  const authority = readCoordinatedEncryptedWalletBackupCasAuthority(attempt)
  if (authority === undefined || typeof authority.store.validatePreparedAttempt !== 'function') {
    throw new Error('backup CAS authority is invalid')
  }
  let calls = 0
  let open = true
  let marker: object | undefined
  let returned: unknown
  try {
    returned = await authority.store.validatePreparedAttempt(authority.record, (raw) => {
      if (!open || calls++ !== 0) throw new Error('backup CAS validation callback is invalid')
      const current = decodeSyncAttemptRecord(raw)
      if (!equalSyncAttemptRecord(authority.record, current))
        throw new Error('backup CAS authority changed')
      marker = Object.freeze({})
      return marker
    })
  } finally {
    open = false
  }
  if (isThenable(returned) || marker === undefined || returned !== marker || calls !== 1) {
    throw new Error('backup CAS validation must be synchronous and exact')
  }
}

export async function readAuthenticatedEncryptedWalletBackupHead(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  enrollmentEpoch: number
  requestProof: EncryptedWalletBackupRequestProof
  remote: EncryptedWalletBackupHeadRemotePort
}): Promise<AuthenticatedEncryptedWalletBackupHeadEvidence> {
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  const preparedSignal =
    typeof input.requestProof === 'object' && input.requestProof !== null
      ? PREPARED_BACKUP_REQUEST_SIGNALS.get(input.requestProof)
      : undefined
  if (preparedSignal === undefined) throw new Error('prepared head request is invalid')
  const cycleSignal = preparedSignal
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const epoch = requireInteger(
    input.enrollmentEpoch,
    1,
    Number.MAX_SAFE_INTEGER,
    'enrollment epoch',
  )
  if (
    typeof input.requestProof !== 'object' ||
    input.requestProof === null ||
    PREPARED_BACKUP_REQUESTS.get(input.requestProof) !== keyAuthority ||
    input.requestProof.enrollmentEpoch !== epoch ||
    input.requestProof.method !== 'GET'
  ) {
    throw new Error('prepared head request is invalid')
  }
  if (
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.readCurrentHead !== 'function'
  ) {
    throw new Error('encrypted backup remote port is invalid')
  }
  const response = await awaitEncryptedWalletBackupCycle(
    input.remote.readCurrentHead({
      requestProof: input.requestProof,
      signal: cycleSignal,
    }),
    cycleSignal,
  )
  if (typeof response !== 'object' || response === null || typeof response.status !== 'string') {
    throw new Error('encrypted backup head response is invalid')
  }
  switch (response.status) {
    case 'not-found': {
      const evidence = Object.freeze({
        state: 'authenticated' as const,
        enrollmentEpoch: epoch,
        head: null,
      })
      AUTHENTICATED_HEAD_OBSERVATIONS.set(evidence, {
        keyAuthority,
        head: null,
        requestIssuedAtUnixSeconds: input.requestProof.issuedAtUnixSeconds,
      })
      return evidence
    }
    case 'unauthorized':
      throw new Error(`encrypted backup head read failed: ${response.status}`)
    case 'rate-limited':
    case 'overloaded':
    case 'unavailable':
      throw new EncryptedWalletBackupRemoteBackoffError(response.status, response.retryAfterSeconds)
    case 'found': {
      if (response.enrollmentEpoch !== epoch)
        throw new Error('encrypted backup head epoch is stale')
      const decoded = decodeManifestHeadWire(
        response.head,
        keyAuthority,
        input.keyHandle.requestAuthPublicKey,
      )
      const evidence = Object.freeze({
        state: 'authenticated' as const,
        enrollmentEpoch: epoch,
        head: decoded.head,
      })
      const authenticated: AuthenticatedHeadAuthority = {
        keyAuthority,
        localSnapshotId: null,
        localSnapshotRevision: null,
        head: decoded.head,
        canonicalHead: decoded.canonicalHead,
        canonicalReferenceSet: decoded.canonicalReferenceSet,
        canonicalParentHead: null,
        canonicalInheritedReferenceSet: encodeCanonical([1, 'reference-set', [], []]),
        pageObjects: Object.freeze([]),
        chunkObjects: Object.freeze([]),
      }
      AUTHENTICATED_MANIFEST_HEADS.set(evidence, authenticated)
      AUTHENTICATED_MANIFEST_HEAD_VALUES.set(decoded.head, authenticated)
      AUTHENTICATED_HEAD_OBSERVATIONS.set(evidence, {
        keyAuthority,
        head: decoded.head,
        requestIssuedAtUnixSeconds: input.requestProof.issuedAtUnixSeconds,
      })
      return evidence
    }
    default:
      return assertNeverRemoteHeadStatus(response)
  }
}

export async function discoverEncryptedWalletBackupEnrollmentEpoch(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  requestProof: EncryptedWalletBackupRequestProof
  remote: EncryptedWalletBackupEnrollmentEpochRemotePort
}): Promise<EncryptedWalletBackupEnrollmentEpochDiscovery> {
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  const preparedSignal =
    typeof input.requestProof === 'object' && input.requestProof !== null
      ? PREPARED_BACKUP_REQUEST_SIGNALS.get(input.requestProof)
      : undefined
  if (preparedSignal === undefined) throw new Error('prepared epoch discovery request is invalid')
  const cycleSignal = preparedSignal
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  if (
    typeof input.requestProof !== 'object' ||
    input.requestProof === null ||
    PREPARED_BACKUP_REQUESTS.get(input.requestProof) !== keyAuthority ||
    input.requestProof.enrollmentEpoch !== 0 ||
    input.requestProof.method !== 'GET' ||
    input.requestProof.payloadLength !== 0
  ) {
    throw new Error('prepared epoch discovery request is invalid')
  }
  if (
    typeof input.remote !== 'object' ||
    input.remote === null ||
    typeof input.remote.discoverEnrollmentEpoch !== 'function'
  ) {
    throw new Error('encrypted backup epoch discovery remote port is invalid')
  }
  const response = await awaitEncryptedWalletBackupCycle(
    input.remote.discoverEnrollmentEpoch({
      requestProof: input.requestProof,
      signal: cycleSignal,
    }),
    cycleSignal,
  )
  if (typeof response !== 'object' || response === null || typeof response.status !== 'string') {
    throw new Error('encrypted backup epoch discovery response is invalid')
  }
  switch (response.status) {
    case 'active':
      return Object.freeze({
        state: 'active' as const,
        enrollmentEpoch: requireInteger(
          response.enrollmentEpoch,
          1,
          Number.MAX_SAFE_INTEGER,
          'discovered enrollment epoch',
        ),
      })
    case 'not-enrolled':
      return Object.freeze({ state: 'not-enrolled' as const })
    case 'rate-limited':
    case 'overloaded':
    case 'unavailable':
      throw new EncryptedWalletBackupRemoteBackoffError(response.status, response.retryAfterSeconds)
    default:
      throw new Error('encrypted backup epoch discovery response is invalid')
  }
}

export async function decryptEncryptedWalletBackupManifestPage(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  object: EncryptedWalletBackupWireObject
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
}): Promise<DecryptedEncryptedWalletBackupManifestPage> {
  try {
    const authority = requireKeyAuthority(input.keyHandle)
    const observation =
      typeof input.headEvidence === 'object' && input.headEvidence !== null
        ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
        : undefined
    if (
      observation === undefined ||
      observation.keyAuthority !== authority ||
      observation.head === null
    ) {
      throw new Error('manifest head is not authenticated')
    }
    const seed = requireSeed(input.seed)
    if (!equalBytes(authority.seedDigest, sha256(seed))) throw new Error('foreign seed')
    const object = requireManifestWireObject(input.object, authority)
    const pageReference = requireAuthenticatedPageReference(observation.head, object)
    const canonical = await decryptObjectFrame({
      authority,
      object,
      kindCode: ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      frameBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES,
      cborMaxBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
    })
    preflightManifestPage(canonical)
    const decoded = decode(canonical)
    if (!equalBytes(canonical, encodeCanonical(decoded))) throw new Error('noncanonical cbor')
    const page = decodeManifestPage(decoded, object.generation)
    if (
      page.generation !== observation.head.generation ||
      page.snapshotNonce !== observation.head.snapshotNonce ||
      page.pageIndex !== pageReference.pageIndex ||
      page.pageCount !== pageReference.pageCount
    ) {
      throw new Error('manifest page does not match authenticated head')
    }
    for (const entry of page.entries) {
      requireAuthenticatedChunkReference(observation.head, entry.chunkObjectId, entry.chunkDigest)
    }
    DECRYPTED_MANIFEST_PAGE_AUTHORITIES.set(page, {
      keyAuthority: authority,
      head: observation.head,
    })
    return page
  } catch {
    throw new Error('corrupt encrypted wallet backup object')
  }
}

export function beginEncryptedWalletBackupManifestRestore(input: {
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
}): EncryptedWalletBackupManifestRestoreCursor {
  const observation =
    typeof input.headEvidence === 'object' && input.headEvidence !== null
      ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
      : undefined
  const authenticated =
    typeof input.headEvidence === 'object' && input.headEvidence !== null
      ? AUTHENTICATED_MANIFEST_HEADS.get(input.headEvidence)
      : undefined
  if (
    observation === undefined ||
    observation.head === null ||
    authenticated === undefined ||
    authenticated.keyAuthority !== observation.keyAuthority ||
    authenticated.head !== observation.head
  ) {
    throw new Error('backup manifest restore head is not authenticated')
  }
  const referenceSet = decode(authenticated.canonicalReferenceSet)
  if (
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    !Array.isArray(referenceSet[2])
  ) {
    throw new Error('backup manifest restore reference set is invalid')
  }
  const pageCount = referenceSet[2].length
  if (
    pageCount < 0 ||
    pageCount > 1_024 ||
    (observation.head.proofCount === 0) !== (pageCount === 0)
  ) {
    throw new Error('backup manifest restore page count is invalid')
  }
  return issueManifestRestoreCursor({
    keyAuthority: observation.keyAuthority,
    head: observation.head,
    pageCount,
    nextPageIndex: 0,
    restoredEntryCount: 0,
    lastProofId: null,
    consumed: false,
  })
}

/**
 * Reads one exact page reference without exposing the whole authenticated
 * reference set. The reference is suitable for one authenticated object GET.
 */
export function readAuthenticatedEncryptedWalletBackupManifestPageReference(input: {
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  pageIndex: number
}): AuthenticatedEncryptedWalletBackupManifestPageReference {
  const observation = AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
  const authenticated = AUTHENTICATED_MANIFEST_HEADS.get(input.headEvidence)
  if (
    observation === undefined ||
    observation.head === null ||
    authenticated === undefined ||
    authenticated.keyAuthority !== observation.keyAuthority ||
    authenticated.head !== observation.head
  ) {
    throw new Error('backup manifest page head is not authenticated')
  }
  const referenceSet = decode(authenticated.canonicalReferenceSet)
  const pages =
    Array.isArray(referenceSet) && referenceSet.length === 4 ? referenceSet[2] : undefined
  const references = decodeObjectReferences(pages, 'manifest page references')
  const pageIndex = requireInteger(input.pageIndex, 0, references.length - 1, 'manifest page index')
  const reference = references[pageIndex]!
  return Object.freeze({
    state: 'authenticated' as const,
    pageIndex,
    objectId: reference.objectId,
    objectDigest: reference.digest,
    generation: observation.head.generation,
  })
}

export function advanceEncryptedWalletBackupManifestRestore(input: {
  cursor: EncryptedWalletBackupManifestRestoreCursor
  manifestPage: DecryptedEncryptedWalletBackupManifestPage
}): EncryptedWalletBackupManifestRestoreCursor {
  const cursorAuthority =
    typeof input.cursor === 'object' && input.cursor !== null
      ? MANIFEST_RESTORE_CURSOR_AUTHORITIES.get(input.cursor)
      : undefined
  if (cursorAuthority === undefined) throw new Error('backup manifest restore cursor is invalid')
  if (cursorAuthority.consumed) throw new Error('backup manifest restore cursor is stale')
  if (input.cursor.complete) throw new Error('backup manifest restore is already complete')
  const pageAuthority =
    typeof input.manifestPage === 'object' && input.manifestPage !== null
      ? DECRYPTED_MANIFEST_PAGE_AUTHORITIES.get(input.manifestPage)
      : undefined
  if (
    pageAuthority === undefined ||
    pageAuthority.keyAuthority !== cursorAuthority.keyAuthority ||
    pageAuthority.head !== cursorAuthority.head ||
    input.manifestPage.generation !== cursorAuthority.head.generation ||
    input.manifestPage.pageCount !== cursorAuthority.pageCount ||
    input.manifestPage.pageIndex !== cursorAuthority.nextPageIndex
  ) {
    throw new Error('backup manifest restore page is foreign or out of order')
  }
  const first = input.manifestPage.entries[0]
  const last = input.manifestPage.entries.at(-1)
  if (
    first === undefined ||
    last === undefined ||
    (cursorAuthority.lastProofId !== null &&
      compareHex(cursorAuthority.lastProofId, first.proofId) >= 0)
  ) {
    throw new Error('backup manifest restore proof order is invalid')
  }
  const restoredEntryCount = cursorAuthority.restoredEntryCount + input.manifestPage.entries.length
  const nextPageIndex = cursorAuthority.nextPageIndex + 1
  const complete = nextPageIndex === cursorAuthority.pageCount
  if (
    restoredEntryCount > cursorAuthority.head.proofCount ||
    (complete && restoredEntryCount !== cursorAuthority.head.proofCount) ||
    (!complete && restoredEntryCount >= cursorAuthority.head.proofCount)
  ) {
    throw new Error('backup manifest restore proof count is invalid')
  }
  cursorAuthority.consumed = true
  return issueManifestRestoreCursor({
    keyAuthority: cursorAuthority.keyAuthority,
    head: cursorAuthority.head,
    pageCount: cursorAuthority.pageCount,
    nextPageIndex,
    restoredEntryCount,
    lastProofId: last.proofId,
    consumed: false,
  })
}

function issueManifestRestoreCursor(
  authority: ManifestRestoreCursorAuthority,
): EncryptedWalletBackupManifestRestoreCursor {
  const cursor = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    generation: authority.head.generation,
    pageCount: authority.pageCount,
    nextPageIndex: authority.nextPageIndex,
    restoredEntryCount: authority.restoredEntryCount,
    complete: authority.nextPageIndex === authority.pageCount,
  })
  MANIFEST_RESTORE_CURSOR_AUTHORITIES.set(cursor, authority)
  return cursor
}

export function acknowledgeDurableWalletBackupSnapshot(input: {
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
}): DurableWalletAcknowledgedBackupSnapshotEvidence {
  const observation =
    typeof input.headEvidence === 'object' && input.headEvidence !== null
      ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
      : undefined
  if (observation === undefined || observation.head === null) {
    throw new Error('backup head evidence is not authenticated')
  }
  const headAuthority = AUTHENTICATED_MANIFEST_HEAD_VALUES.get(observation.head)
  if (headAuthority === undefined || headAuthority.keyAuthority !== observation.keyAuthority) {
    throw new Error('backup head evidence is not authenticated')
  }
  const referenceSet = decode(headAuthority.canonicalReferenceSet)
  if (
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    !Array.isArray(referenceSet[3])
  ) {
    throw new Error('manifest reference set is invalid')
  }
  const reachableChunkDigests = referenceSet[3].map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error('manifest chunk reference is invalid')
    }
    requireBytes(raw[0], 16, 'manifest chunk object id')
    return bytesToHex(requireBytes(raw[1], 32, 'manifest chunk digest'))
  })
  const snapshot = Object.freeze(
    decodeDurableWalletAcknowledgedBackupSnapshot({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      realm: observation.head.realm,
      backupPublicKey: observation.head.backupPublicKey,
      generation: observation.head.generation,
      snapshotId: observation.head.snapshotId,
      manifestDigest: observation.head.manifestDigest,
      reachableChunkDigests,
    }),
  )
  return issueDurableWalletAcknowledgedBackupSnapshot(snapshot)
}

export function deriveDurableWalletEncryptedBackupReceipt(input: {
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  manifestPage: DecryptedEncryptedWalletBackupManifestPage
  proofId: string
  proofCommitment: string
}): DurableWalletAuthenticatedBackupReceiptEvidence {
  const observation =
    typeof input.headEvidence === 'object' && input.headEvidence !== null
      ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
      : undefined
  const pageAuthority =
    typeof input.manifestPage === 'object' && input.manifestPage !== null
      ? DECRYPTED_MANIFEST_PAGE_AUTHORITIES.get(input.manifestPage)
      : undefined
  if (
    observation === undefined ||
    observation.head === null ||
    pageAuthority === undefined ||
    pageAuthority.keyAuthority !== observation.keyAuthority ||
    pageAuthority.head !== observation.head
  ) {
    throw new Error('backup manifest membership is not authenticated')
  }
  const proofId = requireLowerHex(input.proofId, 32, 'backup proof id')
  const proofCommitment = requireLowerHex(input.proofCommitment, 32, 'backup proof commitment')
  const matches = input.manifestPage.entries.filter((entry) => entry.proofId === proofId)
  if (matches.length !== 1 || matches[0]!.commitment !== proofCommitment) {
    throw new Error('proof is not a member of the authenticated backup head')
  }
  const entry = matches[0]!
  requireAuthenticatedChunkReference(observation.head, entry.chunkObjectId, entry.chunkDigest)
  const receipt = Object.freeze(
    decodeDurableWalletEncryptedBackupReceipt({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      realm: observation.head.realm,
      backupPublicKey: observation.head.backupPublicKey,
      generation: observation.head.generation,
      snapshotId: observation.head.snapshotId,
      manifestDigest: observation.head.manifestDigest,
      chunkDigest: entry.chunkDigest,
      proofCommitment,
    }),
  )
  return issueDurableWalletAuthenticatedBackupReceipt(receipt)
}

export async function restoreEncryptedWalletBackupProofs(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  proofChunk: DecryptedEncryptedWalletBackupProofChunk
  selections: readonly EncryptedWalletBackupRestoreSelection[]
  restoreMode: 'complete-origin' | 'hydrate-existing'
  effectiveNowUnixSeconds: number
  signal: AbortSignal
  keysetPort: EncryptedWalletBackupRestoreKeysetPort
  proofStatePort: EncryptedWalletBackupRestoreProofStatePort
  restoreStore: EncryptedWalletBackupRestoreStore
}): Promise<EncryptedWalletBackupProofRestoreResult> {
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const observation =
    typeof input.headEvidence === 'object' && input.headEvidence !== null
      ? AUTHENTICATED_HEAD_OBSERVATIONS.get(input.headEvidence)
      : undefined
  const chunkAuthority =
    typeof input.proofChunk === 'object' && input.proofChunk !== null
      ? DECRYPTED_PROOF_CHUNK_AUTHORITIES.get(input.proofChunk)
      : undefined
  if (
    observation === undefined ||
    observation.head === null ||
    observation.keyAuthority !== keyAuthority ||
    chunkAuthority === undefined ||
    chunkAuthority.keyAuthority !== keyAuthority ||
    chunkAuthority.generation > observation.head.generation
  ) {
    throw new Error('restored proof authority is invalid')
  }
  if (
    !Array.isArray(input.selections) ||
    input.selections.length < 1 ||
    input.selections.length > ENCRYPTED_WALLET_BACKUP_RESTORE_PROOF_LIMIT_MAX
  ) {
    throw new Error('restored proof selection is invalid')
  }
  const effectiveNow = requireNonNegativeSafeInteger(
    input.effectiveNowUnixSeconds,
    'restore effective time',
  )
  const restoreMode = requireOneOfValue(
    input.restoreMode,
    ['complete-origin', 'hydrate-existing'],
    'restored proof mode',
  )
  const selected: Array<{
    record: UnverifiedEncryptedWalletBackupProof
    entry: EncryptedWalletBackupManifestEntry
    page: DecryptedEncryptedWalletBackupManifestPage
  }> = []
  const selectedIds = new Set<string>()
  const chunkRecordsById = new Map(chunkAuthority.records.map((record) => [record.proofId, record]))
  const pageEntriesById = new WeakMap<
    object,
    ReadonlyMap<string, EncryptedWalletBackupManifestEntry>
  >()
  for (const rawSelection of input.selections) {
    const selection = requireRecord(rawSelection, 'restored proof selection')
    requireKnownFields(selection, ['manifestPage', 'proofId'])
    const proofId = requireLowerHex(selection.proofId, 32, 'restored proof id')
    if (selectedIds.has(proofId)) throw new Error('restored proof selection is duplicated')
    selectedIds.add(proofId)
    const page = selection.manifestPage as DecryptedEncryptedWalletBackupManifestPage | null
    const pageAuthority =
      typeof page === 'object' && page !== null
        ? DECRYPTED_MANIFEST_PAGE_AUTHORITIES.get(page)
        : undefined
    if (
      pageAuthority === undefined ||
      pageAuthority.keyAuthority !== keyAuthority ||
      pageAuthority.head !== observation.head
    ) {
      throw new Error('restored proof membership is invalid')
    }
    let entriesById = pageEntriesById.get(page!)
    if (entriesById === undefined) {
      entriesById = new Map(page!.entries.map((entry) => [entry.proofId, entry]))
      pageEntriesById.set(page!, entriesById)
    }
    const entry = entriesById.get(proofId)
    const record = chunkRecordsById.get(proofId)
    if (
      entry === undefined ||
      record === undefined ||
      entry.chunkObjectId !== chunkAuthority.objectId ||
      entry.chunkDigest !== chunkAuthority.objectDigest ||
      !restoreRecordMatchesManifestEntry(record, entry)
    ) {
      throw new Error('restored proof membership is invalid')
    }
    selected.push({ record, entry, page: page! })
  }
  selected.sort((left, right) => compareHex(left.record.proofId, right.record.proofId))
  const activeSelected = selected.filter(
    ({ record }) =>
      record.encodedProofKind === 0 ||
      (record.terminalEvidence === null &&
        record.ctfMetadata!.finalExpiryUnixSeconds > effectiveNow),
  )

  const keysetRequestsByKey = new Map<
    string,
    Readonly<{ mint: string; unit: string; keysetId: string }>
  >()
  const selectedRecordsByKeyset = new Map<string, UnverifiedEncryptedWalletBackupProof[]>()
  for (const { record } of activeSelected) {
    const request = Object.freeze({
      mint: record.mint,
      unit: record.unit,
      keysetId: record.proof.id,
    })
    const lookupKey = restoreKeysetLookupKey(request)
    keysetRequestsByKey.set(lookupKey, request)
    const records = selectedRecordsByKeyset.get(lookupKey) ?? []
    records.push(record)
    selectedRecordsByKeyset.set(lookupKey, records)
  }
  const keysetRequests = Object.freeze(
    [...keysetRequestsByKey.values()].sort((left, right) =>
      compareEncryptedWalletBackupRestoreTupleText(
        restoreKeysetLookupKey(left),
        restoreKeysetLookupKey(right),
      ),
    ),
  )
  const verifiedKeysets = new Map<string, Record<string, unknown>>()
  if (activeSelected.length > 0) {
    if (
      typeof input.keysetPort !== 'object' ||
      input.keysetPort === null ||
      typeof input.keysetPort.resolveKeysets !== 'function'
    ) {
      throw new Error('restored proof keyset port is invalid')
    }
    const rawKeysets = await awaitEncryptedWalletBackupCycle(
      input.keysetPort.resolveKeysets({
        requests: keysetRequests,
        signal: cycleSignal,
      }),
      cycleSignal,
    )
    throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
    if (!Array.isArray(rawKeysets) || rawKeysets.length !== keysetRequests.length) {
      throw new Error('restored proof keyset response is invalid')
    }
    for (const rawKeyset of rawKeysets) {
      const response = requireRecord(rawKeyset, 'restored proof keyset response')
      requireKnownFields(response, ['mint', 'unit', 'keysetId', 'mintKeys'])
      const identity = {
        mint: requireNormalizedMint(response.mint),
        unit: requireBoundedText(response.unit, 64, 'restored keyset unit'),
        keysetId: requireBoundedText(response.keysetId, 128, 'restored keyset id'),
      }
      const lookupKey = restoreKeysetLookupKey(identity)
      const request = keysetRequestsByKey.get(lookupKey)
      if (request === undefined || verifiedKeysets.has(lookupKey))
        throw new Error('restored proof keyset response is invalid')
      const matchingRecords = selectedRecordsByKeyset.get(lookupKey)
      if (matchingRecords === undefined)
        throw new Error('restored proof keyset response is invalid')
      verifiedKeysets.set(
        lookupKey,
        verifyRestoreMintKeys(response.mintKeys, matchingRecords, effectiveNow),
      )
    }
    if (verifiedKeysets.size !== keysetRequests.length)
      throw new Error('restored proof keyset response is incomplete')
    const stateQueries = await verifyRestoreProofSignaturesAndDeriveStateQueries(
      activeSelected,
      verifiedKeysets,
      cycleSignal,
      defaultCooperativeYield,
    )
    if (
      typeof input.proofStatePort !== 'object' ||
      input.proofStatePort === null ||
      typeof input.proofStatePort.checkProofStates !== 'function'
    ) {
      throw new Error('restored proof state port is invalid')
    }
    const rawStates = await awaitEncryptedWalletBackupCycle(
      input.proofStatePort.checkProofStates({
        proofs: stateQueries,
        signal: cycleSignal,
      }),
      cycleSignal,
    )
    throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
    requireEveryRestoreProofUnspent(rawStates, stateQueries)
  }

  const candidates = Object.freeze(
    selected.map(({ record, page }) => {
      const isVerifiedLosing = record.terminalEvidence !== null
      const isExpiredCtf =
        record.encodedProofKind === 1 && record.ctfMetadata!.finalExpiryUnixSeconds <= effectiveNow
      const proof = freezeRestoreProofRecord({
        schemaVersion: 1,
        realm: observation.head!.realm,
        vaultId: observation.head!.vaultId,
        generation: observation.head!.generation,
        manifestDigest: observation.head!.manifestDigest,
        parentGeneration: observation.head!.parent?.generation ?? null,
        parentManifestDigest: observation.head!.parent?.manifestDigest ?? null,
        chunkObjectId: chunkAuthority.objectId,
        chunkDigest: chunkAuthority.objectDigest,
        proofId: record.proofId,
        proofCommitment: record.commitment,
        mint: record.mint,
        unit: record.unit,
        counter: record.counter,
        proofKind: record.encodedProofKind === 0 ? 'ordinary' : 'ctf',
        ctfMetadata: record.ctfMetadata,
        terminalEvidence: record.terminalEvidence,
        createdAtUnixSeconds: record.createdAtUnixSeconds,
        updatedAtUnixSeconds: record.updatedAtUnixSeconds,
        disposition:
          isExpiredCtf || isVerifiedLosing ? 'user-retained-nonselectable' : 'selectable',
        nonselectableReason: isVerifiedLosing
          ? 'verified-losing-outcome'
          : isExpiredCtf
            ? 'recorded-ctf-expiry-passed'
            : null,
        proof: record.proof,
      })
      const storageClassification = classifyEncryptedWalletBackupRestoreProof({
        headEvidence: input.headEvidence,
        manifestPage: page,
        proof,
        effectiveNowUnixSeconds: effectiveNow,
      })
      return Object.freeze({
        proofId: proof.proofId,
        storageClassification,
        proof,
      })
    }),
  )
  await commitRestoreProofRecords(
    input.restoreStore,
    candidates,
    restoreMode,
    observation.head.backupPublicKey,
    cycleSignal,
  )
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    generation: observation.head.generation,
    manifestDigest: observation.head.manifestDigest,
    proofCount: candidates.length,
    proofIds: Object.freeze(candidates.map((row) => row.proofId)),
  })
}

function classifyEncryptedWalletBackupRestoreProof(input: {
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  manifestPage: DecryptedEncryptedWalletBackupManifestPage
  proof: EncryptedWalletBackupRestoreProofRecord
  effectiveNowUnixSeconds: number
}): DurableWalletStorageClassification {
  const evidence = deriveDurableWalletEncryptedBackupReceipt({
    headEvidence: input.headEvidence,
    manifestPage: input.manifestPage,
    proofId: input.proof.proofId,
    proofCommitment: input.proof.proofCommitment,
  })
  const classified = classifyDurableWalletStorage({
    schemaVersion: 1,
    recordId: input.proof.proofId,
    kind: 'deterministic-proof',
    provenance: 'wallet-seed',
    proofKind: input.proof.proofKind,
    ctfMetadata:
      input.proof.ctfMetadata === null
        ? null
        : {
            finalExpiryUnixSeconds: input.proof.ctfMetadata.finalExpiryUnixSeconds,
            terminalEvidence:
              input.proof.nonselectableReason === 'verified-losing-outcome'
                ? issueDurableWalletVerifiedLosingCtfClassification()
                : null,
          },
    effectiveNowUnixSeconds: input.effectiveNowUnixSeconds,
    operationBinding: 'terminally-unlinked',
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: {
      openOrderCollateral: 'absent',
      outbox: 'absent',
      retryCursor: 'absent',
      replayTombstone: 'absent',
      dependentWork: 'absent',
    },
    derivationLocator: 'committed',
    proofCommitment: {
      state: 'verified',
      digest: input.proof.proofCommitment,
    },
    backupReceiptEvidence: evidence,
  })
  const expectedClass =
    input.proof.disposition === 'selectable'
      ? 'remotely-backed-deterministic-proof'
      : 'user-retained-nonselectable-ctf'
  if (classified.storageClass !== expectedClass)
    throw new Error('restored proof storage classification is invalid')
  return freezeRestoreStorageClassification(classified)
}

function restoreRecordMatchesManifestEntry(
  record: UnverifiedEncryptedWalletBackupProof,
  entry: EncryptedWalletBackupManifestEntry,
): boolean {
  return (
    record.proofId === entry.proofId &&
    record.commitment === entry.commitment &&
    record.mint === entry.mint &&
    record.unit === entry.unit &&
    record.proof.amount === entry.amount &&
    (record.encodedProofKind === 0 ? 'ordinary' : 'ctf') === entry.proofKind &&
    equalCtfMetadata(record.ctfMetadata, entry.ctfMetadata) &&
    equalCtfTerminalEvidence(record.terminalEvidence, entry.terminalEvidence) &&
    record.createdAtUnixSeconds === entry.createdAtUnixSeconds &&
    record.updatedAtUnixSeconds === entry.updatedAtUnixSeconds
  )
}

function restoreKeysetLookupKey(input: { mint: string; unit: string; keysetId: string }): string {
  return `${input.mint}\0${input.unit}\0${input.keysetId}`
}

function verifyRestoreMintKeys(
  value: unknown,
  records: readonly UnverifiedEncryptedWalletBackupProof[],
  effectiveNowUnixSeconds: number,
): Record<string, unknown> {
  if (records.length < 1) throw new Error('restored proof keyset is unreferenced')
  const first = records[0]!
  const raw = requireRecord(value, 'restored mint keys')
  requireKnownFields(
    raw,
    ['id', 'unit', 'keys'],
    ['active', 'input_fee_ppk', 'final_expiry', 'conditional'],
  )
  if (raw.id !== first.proof.id || raw.unit !== first.unit)
    throw new Error('restored proof keyset does not match proof')
  const keyset = decodeKeysetId(raw.id)
  const keys = requireRecord(raw.keys, 'restored denomination keys')
  const entries = Object.entries(keys)
  if (entries.length < 1 || entries.length > 64)
    throw new Error('restored proof keyset exceeds bounds')
  const normalizedKeys: Record<string, string> = {}
  for (const [amount, publicKey] of entries) {
    if (
      !/^[1-9][0-9]{0,19}$/.test(amount) ||
      BigInt(amount) > UINT64_MAX ||
      typeof publicKey !== 'string' ||
      (keyset.curve === 'secp256k1'
        ? !/^(?:02|03)[0-9a-f]{64}$/.test(publicKey)
        : !/^[0-9a-f]{192}$/.test(publicKey))
    ) {
      throw new Error('restored denomination key is invalid')
    }
    normalizedKeys[amount] = publicKey
  }
  const normalized: Record<string, unknown> = {
    id: keyset.text,
    unit: first.unit,
    keys: normalizedKeys,
  }
  if (raw.active !== undefined)
    normalized.active = requireBoolean(raw.active, 'restored keyset active')
  if (raw.input_fee_ppk !== undefined)
    normalized.input_fee_ppk = requireInteger(
      raw.input_fee_ppk,
      0,
      2_147_483_647,
      'restored keyset input fee',
    )
  if (raw.final_expiry !== undefined)
    normalized.final_expiry = requireNonNegativeSafeInteger(
      raw.final_expiry,
      'restored keyset final expiry',
    )
  const hasConditional = records.some((record) => record.encodedProofKind === 1)
  if (hasConditional !== records.every((record) => record.encodedProofKind === 1)) {
    throw new Error('restored keyset mixes proof classes')
  }
  if (hasConditional) {
    const metadata = first.ctfMetadata
    if (metadata === null || metadata.finalExpiryUnixSeconds <= effectiveNowUnixSeconds) {
      throw new Error('restored CTF proof is expired')
    }
    const evidence = verifyEncryptedWalletBackupConditionalKeyset({
      mint: first.mint,
      unit: first.unit,
      outcomeLabel: metadata.outcomeLabel,
      registeredAtUnixSeconds: metadata.registeredAtUnixSeconds,
      mintKeys: raw,
      conditionalMetadata: raw.conditional,
    })
    const conditional = VERIFIED_CONDITIONAL_KEYSETS.get(evidence)
    if (
      conditional === undefined ||
      conditional.conditionId !== metadata.conditionId ||
      conditional.outcomeCollectionId !== metadata.outcomeCollectionId ||
      conditional.finalExpiryUnixSeconds !== metadata.finalExpiryUnixSeconds ||
      records.some((record) => !equalCtfMetadata(record.ctfMetadata, metadata))
    ) {
      throw new Error('restored proof conditional keyset does not match')
    }
    normalized.conditional = raw.conditional
  } else {
    if (raw.conditional !== undefined)
      throw new Error('ordinary restored keyset cannot be conditional')
    const api = (
      Cashu as unknown as {
        Keyset?: { verifyKeysetId(keys: unknown): boolean }
      }
    ).Keyset
    if (api === undefined || !api.verifyKeysetId(normalized))
      throw new Error('restored proof keyset verification failed')
  }
  return Object.freeze(normalized)
}

async function verifyRestoreProofSignaturesAndDeriveStateQueries(
  selected: readonly Readonly<{
    record: UnverifiedEncryptedWalletBackupProof
  }>[],
  keysets: ReadonlyMap<string, Record<string, unknown>>,
  signal: AbortSignal,
  cooperativeYield: () => void | Promise<void>,
): Promise<
  readonly Readonly<{
    proofId: string
    mint: string
    keysetId: string
    y: string
  }>[]
> {
  const api = Cashu as unknown as {
    verifyProofsForReceive?: (
      proofs: readonly unknown[],
      getKeyset: (id: string) => unknown,
    ) => void
  }
  if (typeof api.verifyProofsForReceive !== 'function')
    throw new Error('restored proof signature verifier is unavailable')
  const stateQueries: Array<{
    proofId: string
    mint: string
    keysetId: string
    y: string
  }> = []
  for (let offset = 0; offset < selected.length; offset += 4) {
    throwIfEncryptedWalletBackupCycleAborted(signal)
    const slice = selected.slice(offset, offset + 4)
    const byMintUnit = groupEncryptedWalletBackupRestoreRecordsByMintUnit(
      slice.map(({ record }) => record),
    )
    try {
      for (const records of byMintUnit) {
        const byKeyset = new Map(records.map((record) => [record.proof.id, record]))
        api.verifyProofsForReceive(
          records.map((record) => record.proof),
          (keysetId) => {
            const matching = byKeyset.get(keysetId)
            if (matching === undefined) throw new Error('restored proof keyset is missing')
            const keyset = keysets.get(
              restoreKeysetLookupKey({
                mint: matching.mint,
                unit: matching.unit,
                keysetId,
              }),
            )
            if (keyset === undefined) throw new Error('restored proof keyset is missing')
            return keyset
          },
        )
      }
    } catch {
      throw new Error('restored proof signature verification failed')
    }
    throwIfEncryptedWalletBackupCycleAborted(signal)
    for (const { record } of slice) {
      stateQueries.push({
        proofId: record.proofId,
        mint: record.mint,
        keysetId: record.proof.id,
        y: deriveRestoreNut07Y(record.proof),
      })
    }
    throwIfEncryptedWalletBackupCycleAborted(signal)
    if (offset + slice.length < selected.length) {
      await awaitEncryptedWalletBackupCycle(Promise.resolve().then(cooperativeYield), signal)
    }
  }
  return Object.freeze(stateQueries.map((query) => Object.freeze(query)))
}

function deriveRestoreNut07Y(proof: UnverifiedEncryptedWalletBackupProof['proof']): string {
  const api = Cashu as unknown as {
    isBlsKeyset?: (keysetId: string) => boolean
    hashToCurve?: (secret: Uint8Array) => {
      toHex(compressed: boolean): string
    }
    hashToCurveBls?: (secret: Uint8Array) => {
      toHex(compressed: boolean): string
    }
  }
  if (
    typeof api.isBlsKeyset !== 'function' ||
    typeof api.hashToCurve !== 'function' ||
    typeof api.hashToCurveBls !== 'function'
  ) {
    throw new Error('restored proof state derivation is unavailable')
  }
  const secret = new TextEncoder().encode(proof.secret)
  return api.isBlsKeyset(proof.id)
    ? api.hashToCurveBls(secret).toHex(true)
    : api.hashToCurve(secret).toHex(true)
}

function requireEveryRestoreProofUnspent(
  value: unknown,
  expected: readonly Readonly<{ proofId: string; y: string }>[],
): void {
  if (!Array.isArray(value) || value.length !== expected.length)
    throw new Error('restored proof state response is invalid')
  const expectedById = new Map(expected.map((query) => [query.proofId, query]))
  const observed = new Set<string>()
  for (const raw of value) {
    const state = requireRecord(raw, 'restored proof state')
    requireKnownFields(state, ['proofId', 'y', 'state'])
    const proofId = requireLowerHex(state.proofId, 32, 'restored state proof id')
    const query = expectedById.get(proofId)
    if (
      query === undefined ||
      observed.has(proofId) ||
      state.y !== query.y ||
      (state.state !== 'UNSPENT' && state.state !== 'PENDING' && state.state !== 'SPENT')
    ) {
      throw new Error('restored proof state response is invalid')
    }
    observed.add(proofId)
    if (state.state !== 'UNSPENT') throw new Error('restored proof is not spendable')
  }
  if (observed.size !== expected.length)
    throw new Error('restored proof state response is incomplete')
}

function freezeRestoreProofRecord(
  value: EncryptedWalletBackupRestoreProofRecord,
): EncryptedWalletBackupRestoreProofRecord {
  const ctfMetadata = value.ctfMetadata === null ? null : Object.freeze({ ...value.ctfMetadata })
  const terminalEvidence =
    value.terminalEvidence === null ? null : Object.freeze({ ...value.terminalEvidence })
  const proof = Object.freeze({
    ...value.proof,
    ...(value.proof.dleq === undefined ? {} : { dleq: Object.freeze({ ...value.proof.dleq }) }),
  })
  return Object.freeze({ ...value, ctfMetadata, terminalEvidence, proof })
}

async function commitRestoreProofRecords(
  store: EncryptedWalletBackupRestoreStore,
  expected: readonly EncryptedWalletBackupRestoreProofRow[],
  restoreMode: 'complete-origin' | 'hydrate-existing',
  expectedBackupPublicKey: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.commitRestoredProofs !== 'function'
  ) {
    throw new Error('restored proof store is invalid')
  }
  let open = true
  let calls = 0
  let marker: object | undefined
  let returned: unknown
  try {
    returned = await awaitEncryptedWalletBackupCycle(
      store.commitRestoredProofs({ expected, restoreMode, signal }, (raw) => {
        if (!open || calls++ !== 0) throw new Error('restored proof commit callback is invalid')
        requireExactRestoreCurrentProofStates(raw, expected, restoreMode, expectedBackupPublicKey)
        marker = Object.freeze({})
        return marker
      }),
      signal,
    )
  } finally {
    open = false
  }
  if (isThenable(returned) || marker === undefined || returned !== marker || calls !== 1) {
    throw new Error('restored proof commit must be synchronous and exact')
  }
}

function requireExactRestoreCurrentProofStates(
  value: unknown,
  expected: readonly EncryptedWalletBackupRestoreProofRow[],
  restoreMode: 'complete-origin' | 'hydrate-existing',
  expectedBackupPublicKey: string,
): void {
  if (!Array.isArray(value) || value.length !== expected.length)
    throw new Error('restored proof current state is invalid')
  const expectedById = new Map(expected.map((row) => [row.proofId, row]))
  const observed = new Set<string>()
  for (const raw of value) {
    const current = requireRecord(raw, 'restored proof current state')
    requireKnownFields(current, ['proofId', 'storageClassification', 'proof'])
    const proofId = requireLowerHex(current.proofId, 32, 'restored current proof id')
    const candidate = expectedById.get(proofId)
    if (candidate === undefined || observed.has(proofId))
      throw new Error('restored proof current state is invalid')
    observed.add(proofId)
    if (current.storageClassification === null && current.proof === null) {
      if (restoreMode !== 'complete-origin')
        throw new Error('restored proof current state conflicts')
      continue
    }
    if (current.storageClassification === null)
      throw new Error('restored proof current state conflicts')
    const classification = decodeDurableWalletStorageClassification(current.storageClassification)
    const currentProof = current.proof === null ? null : decodeRestoreProofRecord(current.proof)
    const exactCurrent = equalRestoreStorageClassification(
      classification,
      candidate.storageClassification,
    )
    const exactPair =
      exactCurrent &&
      (currentProof === null || equalRestoreProofRecord(currentProof, candidate.proof))
    const activeToRetained =
      currentProof !== null &&
      isExactActiveToRetainedCtfClassification(
        classification,
        currentProof,
        candidate.storageClassification,
        candidate.proof,
      ) &&
      isExactActiveToRetainedCtfProof(currentProof, candidate.proof)
    const activeToVerifiedLosing =
      currentProof !== null &&
      isExactActiveToVerifiedLosingCtfClassification(
        classification,
        currentProof,
        candidate.storageClassification,
        candidate.proof,
        expectedBackupPublicKey,
      ) &&
      isExactActiveToVerifiedLosingCtfProof(currentProof, candidate.proof)
    if (!exactPair && !activeToRetained && !activeToVerifiedLosing) {
      throw new Error('restored proof current state conflicts')
    }
  }
  if (observed.size !== expected.length)
    throw new Error('restored proof current state is incomplete')
}

function freezeRestoreStorageClassification(
  value: DurableWalletStorageClassification,
): DurableWalletStorageClassification {
  return Object.freeze({
    ...value,
    pinReasons: Object.freeze([...value.pinReasons]) as typeof value.pinReasons,
    backupBinding: value.backupBinding === null ? null : Object.freeze({ ...value.backupBinding }),
  })
}

function equalRestoreStorageClassification(
  left: DurableWalletStorageClassification,
  right: DurableWalletStorageClassification,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.recordId === right.recordId &&
    left.recordKind === right.recordKind &&
    left.storageClass === right.storageClass &&
    left.pinReasons.length === right.pinReasons.length &&
    left.pinReasons.every((reason, index) => reason === right.pinReasons[index]) &&
    left.proofCommitment === right.proofCommitment &&
    left.backupBinding?.snapshotId === right.backupBinding?.snapshotId &&
    left.backupBinding?.chunkDigest === right.backupBinding?.chunkDigest &&
    left.backupBinding?.proofCommitment === right.backupBinding?.proofCommitment &&
    left.purgeAfterMs === right.purgeAfterMs
  )
}

function isExactActiveToRetainedCtfClassification(
  current: DurableWalletStorageClassification,
  currentProof: EncryptedWalletBackupRestoreProofRecord,
  candidate: DurableWalletStorageClassification,
  candidateProof: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    current.storageClass === 'remotely-backed-deterministic-proof' &&
    candidate.storageClass === 'user-retained-nonselectable-ctf' &&
    current.schemaVersion === candidate.schemaVersion &&
    current.recordId === candidate.recordId &&
    current.recordKind === 'deterministic-proof' &&
    candidate.recordKind === 'deterministic-proof' &&
    current.pinReasons.length === 0 &&
    candidate.pinReasons.length === 0 &&
    current.proofCommitment === currentProof.proofCommitment &&
    candidate.proofCommitment === candidateProof.proofCommitment &&
    current.proofCommitment === candidate.proofCommitment &&
    current.backupBinding?.snapshotId === candidate.backupBinding?.snapshotId &&
    current.backupBinding?.chunkDigest === currentProof.chunkDigest &&
    candidate.backupBinding?.chunkDigest === candidateProof.chunkDigest &&
    current.backupBinding?.chunkDigest === candidate.backupBinding?.chunkDigest &&
    current.backupBinding?.proofCommitment === candidate.backupBinding?.proofCommitment &&
    current.purgeAfterMs === null &&
    candidate.purgeAfterMs === null
  )
}

function isExactActiveToVerifiedLosingCtfClassification(
  current: DurableWalletStorageClassification,
  currentProof: EncryptedWalletBackupRestoreProofRecord,
  candidate: DurableWalletStorageClassification,
  candidateProof: EncryptedWalletBackupRestoreProofRecord,
  expectedBackupPublicKey: string,
): boolean {
  return (
    candidateProof.proofKind === 'ctf' &&
    candidateProof.disposition === 'user-retained-nonselectable' &&
    candidateProof.nonselectableReason === 'verified-losing-outcome' &&
    candidateProof.terminalEvidence !== null &&
    current.storageClass === 'remotely-backed-deterministic-proof' &&
    candidate.storageClass === 'user-retained-nonselectable-ctf' &&
    current.schemaVersion === candidate.schemaVersion &&
    current.recordId === candidate.recordId &&
    current.recordKind === 'deterministic-proof' &&
    candidate.recordKind === 'deterministic-proof' &&
    current.pinReasons.length === 0 &&
    candidate.pinReasons.length === 0 &&
    current.proofCommitment === currentProof.proofCommitment &&
    candidate.proofCommitment === candidateProof.proofCommitment &&
    current.backupBinding?.snapshotId ===
      deriveDurableWalletBackupSnapshotId({
        formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
        realm: currentProof.realm,
        backupPublicKey: expectedBackupPublicKey,
        generation: currentProof.generation,
        manifestDigest: currentProof.manifestDigest,
      }) &&
    current.backupBinding?.proofCommitment === current.proofCommitment &&
    candidate.backupBinding?.proofCommitment === candidate.proofCommitment &&
    current.backupBinding?.chunkDigest === currentProof.chunkDigest &&
    candidate.backupBinding?.chunkDigest === candidateProof.chunkDigest &&
    current.purgeAfterMs === null &&
    candidate.purgeAfterMs === null
  )
}

function decodeRestoreProofRecord(value: unknown): EncryptedWalletBackupRestoreProofRecord {
  const record = requireRecord(value, 'restored proof')
  requireKnownFields(record, [
    'schemaVersion',
    'realm',
    'vaultId',
    'generation',
    'manifestDigest',
    'parentGeneration',
    'parentManifestDigest',
    'chunkObjectId',
    'chunkDigest',
    'proofId',
    'proofCommitment',
    'mint',
    'unit',
    'counter',
    'proofKind',
    'ctfMetadata',
    'terminalEvidence',
    'createdAtUnixSeconds',
    'updatedAtUnixSeconds',
    'disposition',
    'nonselectableReason',
    'proof',
  ])
  if (record.schemaVersion !== 1) throw new Error('restored proof version is invalid')
  const disposition = requireOneOfValue(
    record.disposition,
    ['selectable', 'user-retained-nonselectable'],
    'restored proof disposition',
  )
  const nonselectableReason =
    record.nonselectableReason === null
      ? null
      : requireOneOfValue(
          record.nonselectableReason,
          ['recorded-ctf-expiry-passed', 'verified-losing-outcome'],
          'restored proof nonselectable reason',
        )
  const proofKind = requireOneOfValue(record.proofKind, ['ordinary', 'ctf'], 'restored proof kind')
  const proof = requireRecord(record.proof, 'restored proof body')
  requireKnownFields(proof, ['id', 'amount', 'secret', 'C'], ['dleq'])
  const keyset = decodeKeysetId(proof.id)
  const dleq = proof.dleq === undefined ? undefined : requireRecord(proof.dleq, 'restored DLEQ')
  if (dleq !== undefined) requireKnownFields(dleq, ['e', 's', 'r'])
  const ctf = decodeCtfMetadata(
    record.ctfMetadata as EncryptedWalletBackupCtfMetadata | null,
    proofKind === 'ordinary' ? 0 : 1,
  )
  const terminalEvidence =
    record.terminalEvidence === null
      ? null
      : ctfTerminalSealToEvidence(
          ctfTerminalEvidenceToSeal(
            record.terminalEvidence as EncryptedWalletBackupCtfTerminalEvidence,
          ),
        )
  if (
    (disposition === 'selectable' && nonselectableReason !== null) ||
    (disposition === 'user-retained-nonselectable' &&
      (proofKind !== 'ctf' ||
        (nonselectableReason !== 'recorded-ctf-expiry-passed' &&
          nonselectableReason !== 'verified-losing-outcome'))) ||
    (nonselectableReason === 'verified-losing-outcome') !== (terminalEvidence !== null) ||
    (nonselectableReason === 'recorded-ctf-expiry-passed' && terminalEvidence !== null)
  ) {
    throw new Error('restored proof disposition is invalid')
  }
  const createdAtUnixSeconds = requireNonNegativeSafeInteger(
    record.createdAtUnixSeconds,
    'restored creation time',
  )
  const updatedAtUnixSeconds = requireNonNegativeSafeInteger(
    record.updatedAtUnixSeconds,
    'restored update time',
  )
  if (updatedAtUnixSeconds < createdAtUnixSeconds)
    throw new Error('restored proof update time is invalid')
  const parentGeneration =
    record.parentGeneration === null
      ? null
      : requireInteger(
          record.parentGeneration,
          1,
          Number.MAX_SAFE_INTEGER,
          'restored parent generation',
        )
  const parentManifestDigest =
    record.parentManifestDigest === null
      ? null
      : requireLowerHex(record.parentManifestDigest, 32, 'restored parent manifest digest')
  const generation = requireInteger(
    record.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    'restored generation',
  )
  if (
    (parentGeneration === null) !== (parentManifestDigest === null) ||
    (parentGeneration !== null && parentGeneration + 1 !== generation)
  ) {
    throw new Error('restored parent head is invalid')
  }
  return freezeRestoreProofRecord({
    schemaVersion: 1,
    realm: requireRealm(record.realm),
    vaultId: requireLowerHex(record.vaultId, 32, 'restored vault id'),
    generation,
    manifestDigest: requireLowerHex(record.manifestDigest, 32, 'restored manifest digest'),
    parentGeneration,
    parentManifestDigest,
    chunkObjectId: requireLowerHex(record.chunkObjectId, 16, 'restored chunk id'),
    chunkDigest: requireLowerHex(record.chunkDigest, 32, 'restored chunk digest'),
    proofId: requireLowerHex(record.proofId, 32, 'restored proof id'),
    proofCommitment: requireLowerHex(record.proofCommitment, 32, 'restored proof commitment'),
    mint: requireNormalizedMint(record.mint),
    unit: requireBoundedText(record.unit, 64, 'restored proof unit'),
    counter: requireInteger(record.counter, 0, 2_147_483_647, 'restored counter'),
    proofKind,
    ctfMetadata: ctf === null ? null : ctfTupleToMetadata(ctf),
    terminalEvidence,
    createdAtUnixSeconds,
    updatedAtUnixSeconds,
    disposition,
    nonselectableReason,
    proof: {
      id: keyset.text,
      amount: requireAmount(proof.amount),
      secret: requireLowerHexSecret(proof.secret),
      C: bytesToHex(requireSignature(proof.C, keyset.curve)),
      ...(dleq === undefined
        ? {}
        : {
            dleq: {
              e: requireLowerHex(dleq.e, 32, 'restored DLEQ e'),
              s: requireLowerHex(dleq.s, 32, 'restored DLEQ s'),
              r: requireLowerHex(dleq.r, 32, 'restored DLEQ r'),
            },
          }),
    },
  })
}

function equalRestoreProofRecord(
  left: EncryptedWalletBackupRestoreProofRecord,
  right: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    equalRestoreProofAuthority(left, right) &&
    left.disposition === right.disposition &&
    left.nonselectableReason === right.nonselectableReason
  )
}

function isExactActiveToRetainedCtfProof(
  current: EncryptedWalletBackupRestoreProofRecord,
  candidate: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    current.proofKind === 'ctf' &&
    candidate.proofKind === 'ctf' &&
    current.disposition === 'selectable' &&
    current.nonselectableReason === null &&
    candidate.disposition === 'user-retained-nonselectable' &&
    candidate.nonselectableReason === 'recorded-ctf-expiry-passed' &&
    equalRestoreProofAuthority(current, candidate)
  )
}

function isExactActiveToVerifiedLosingCtfProof(
  current: EncryptedWalletBackupRestoreProofRecord,
  candidate: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    current.proofKind === 'ctf' &&
    candidate.proofKind === 'ctf' &&
    current.disposition === 'selectable' &&
    current.nonselectableReason === null &&
    current.terminalEvidence === null &&
    candidate.disposition === 'user-retained-nonselectable' &&
    candidate.nonselectableReason === 'verified-losing-outcome' &&
    candidate.terminalEvidence !== null &&
    current.realm === candidate.realm &&
    current.vaultId === candidate.vaultId &&
    candidate.parentGeneration === current.generation &&
    candidate.parentManifestDigest === current.manifestDigest &&
    current.proofCommitment === deriveRestoreProofCommitment(current, null) &&
    current.proofId === candidate.proofId &&
    current.mint === candidate.mint &&
    current.unit === candidate.unit &&
    current.counter === candidate.counter &&
    equalCtfMetadata(current.ctfMetadata, candidate.ctfMetadata) &&
    current.createdAtUnixSeconds === candidate.createdAtUnixSeconds &&
    current.updatedAtUnixSeconds <= candidate.updatedAtUnixSeconds &&
    current.proof.id === candidate.proof.id &&
    current.proof.amount === candidate.proof.amount &&
    current.proof.secret === candidate.proof.secret &&
    current.proof.C === candidate.proof.C &&
    current.proof.dleq?.e === candidate.proof.dleq?.e &&
    current.proof.dleq?.s === candidate.proof.dleq?.s &&
    current.proof.dleq?.r === candidate.proof.dleq?.r
  )
}

function deriveRestoreProofCommitment(
  record: EncryptedWalletBackupRestoreProofRecord,
  terminalEvidence: EncryptedWalletBackupCtfTerminalEvidence | null,
): string {
  const keyset = decodeKeysetId(record.proof.id)
  const proofKindCode = record.proofKind === 'ordinary' ? 0 : 1
  const ctfBase = decodeCtfMetadata(record.ctfMetadata, proofKindCode)
  const ctf =
    ctfBase === null
      ? null
      : [...ctfBase, terminalEvidence === null ? null : ctfTerminalEvidenceToSeal(terminalEvidence)]
  const dleq =
    record.proof.dleq === undefined
      ? null
      : [
          hexToBytes(record.proof.dleq.e),
          hexToBytes(record.proof.dleq.s),
          hexToBytes(record.proof.dleq.r),
        ]
  return bytesToHex(
    sha256(
      encodeCanonical([
        1,
        'proof-record-commitment',
        record.mint,
        record.unit,
        [keyset.kindCode, keyset.text],
        record.proof.amount,
        new TextEncoder().encode(record.proof.secret),
        requireSignature(record.proof.C, keyset.curve),
        dleq,
        record.counter,
        proofKindCode,
        ctf,
        record.createdAtUnixSeconds,
        record.updatedAtUnixSeconds,
      ]),
    ),
  )
}

function equalRestoreProofAuthority(
  left: EncryptedWalletBackupRestoreProofRecord,
  right: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.generation === right.generation &&
    left.manifestDigest === right.manifestDigest &&
    left.parentGeneration === right.parentGeneration &&
    left.parentManifestDigest === right.parentManifestDigest &&
    left.chunkObjectId === right.chunkObjectId &&
    left.chunkDigest === right.chunkDigest &&
    left.proofId === right.proofId &&
    left.proofCommitment === right.proofCommitment &&
    left.mint === right.mint &&
    left.unit === right.unit &&
    left.counter === right.counter &&
    left.proofKind === right.proofKind &&
    equalCtfMetadata(left.ctfMetadata, right.ctfMetadata) &&
    equalCtfTerminalEvidence(left.terminalEvidence, right.terminalEvidence) &&
    left.createdAtUnixSeconds === right.createdAtUnixSeconds &&
    left.updatedAtUnixSeconds === right.updatedAtUnixSeconds &&
    left.proof.id === right.proof.id &&
    left.proof.amount === right.proof.amount &&
    left.proof.secret === right.proof.secret &&
    left.proof.C === right.proof.C &&
    left.proof.dleq?.e === right.proof.dleq?.e &&
    left.proof.dleq?.s === right.proof.dleq?.s &&
    left.proof.dleq?.r === right.proof.dleq?.r
  )
}

function equalCtfMetadata(
  left: EncryptedWalletBackupCtfMetadata | null,
  right: EncryptedWalletBackupCtfMetadata | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.conditionId === right.conditionId &&
      left.outcomeLabel === right.outcomeLabel &&
      left.outcomeCollectionId === right.outcomeCollectionId &&
      left.registeredAtUnixSeconds === right.registeredAtUnixSeconds &&
      left.finalExpiryUnixSeconds === right.finalExpiryUnixSeconds)
  )
}

function equalCtfTerminalEvidence(
  left: EncryptedWalletBackupCtfTerminalEvidence | null,
  right: EncryptedWalletBackupCtfTerminalEvidence | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.reason === right.reason &&
      left.operationIdDigest === right.operationIdDigest &&
      left.requestDigest === right.requestDigest &&
      left.failureCode === right.failureCode &&
      left.classifiedAt === right.classifiedAt)
  )
}

async function prepareManifestObject(input: {
  authority: KeyAuthority
  generation: number
  canonical: Uint8Array
  runtime: EncryptedWalletBackupRuntime
  objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupObject> {
  const { objectId, objectIdBytes } = await allocateObjectId(
    input.authority,
    input.runtime,
    input.objectIdExists,
  )
  try {
    const nonce = randomBytes(input.runtime, 12)
    const aad = encodeCanonical([
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      input.authority.realm,
      input.authority.vaultIdBytes,
      objectIdBytes,
      input.generation,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES,
    ])
    const objectKey = await hkdf(
      input.runtime.subtle,
      input.authority.encryptionRoot,
      objectIdBytes,
      encodeCanonical([
        1,
        'object-key',
        input.authority.realm,
        input.authority.vaultIdBytes,
        ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      ]),
    )
    const frame = new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES)
    writeUint32(frame, 0, input.canonical.byteLength)
    frame.set(input.canonical, 4)
    const key = await input.runtime.subtle.importKey(
      'raw',
      asArrayBuffer(objectKey),
      'AES-GCM',
      false,
      ['encrypt'],
    )
    const encrypted = new Uint8Array(
      await input.runtime.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: asArrayBuffer(nonce),
          additionalData: asArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        frame,
      ),
    )
    const body = concatBytes(nonce, encrypted)
    const digest = bytesToHex(sha256(concatBytes(uint32Bytes(aad.byteLength), aad, body)))
    const prepared = Object.freeze({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      kindCode: ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
      realm: input.authority.realm,
      vaultId: bytesToHex(input.authority.vaultIdBytes),
      objectId,
      generation: input.generation,
      paddedLength: ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES,
      digest,
    })
    PREPARED_OBJECT_AUTHORITIES.set(prepared, {
      aad: aad.slice(),
      body: body.slice(),
      sourceChunk: null,
    })
    return prepared
  } catch (error) {
    input.authority.preparedObjectIds.delete(objectId)
    throw error
  }
}

export async function decryptEncryptedWalletBackupProofChunk(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  object: EncryptedWalletBackupWireObject
  cooperativeYield?: () => void | Promise<void>
}): Promise<DecryptedEncryptedWalletBackupProofChunk> {
  try {
    const authority = requireKeyAuthority(input.keyHandle)
    const object = requireWireObject(input.object, authority)
    const records = await decryptProofChunk({ ...input, object })
    const handle = Object.freeze({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      recordCount: records.length,
    })
    DECRYPTED_PROOF_CHUNK_AUTHORITIES.set(handle, {
      keyAuthority: authority,
      objectId: object.objectId,
      objectDigest: object.digest,
      generation: object.generation,
      records,
    })
    return handle
  } catch {
    throw new Error('corrupt encrypted wallet backup object')
  }
}

async function decryptProofChunk(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  object: EncryptedWalletBackupWireObject
  cooperativeYield?: () => void | Promise<void>
}): Promise<UnverifiedEncryptedWalletBackupProof[]> {
  const authority = requireKeyAuthority(input.keyHandle)
  const seed = requireSeed(input.seed)
  if (!equalBytes(authority.seedDigest, sha256(seed))) throw new Error('foreign seed')
  const object = requireWireObject(input.object, authority)
  const objectId = hexToBytes(object.objectId)
  const expectedAad = encodeCanonical([
    1,
    1,
    authority.realm,
    authority.vaultIdBytes,
    objectId,
    object.generation,
    ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
  ])
  if (!equalBytes(expectedAad, object.aad)) throw new Error('foreign aad')
  const expectedDigest = bytesToHex(
    sha256(concatBytes(uint32Bytes(object.aad.byteLength), object.aad, object.body)),
  )
  if (expectedDigest !== object.digest) throw new Error('digest mismatch')
  const objectKey = await hkdf(
    authority.runtime.subtle,
    authority.encryptionRoot,
    objectId,
    encodeCanonical([1, 'object-key', authority.realm, authority.vaultIdBytes, 1]),
  )
  const key = await authority.runtime.subtle.importKey(
    'raw',
    asArrayBuffer(objectKey),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const frame = new Uint8Array(
    await authority.runtime.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(object.body.slice(0, 12)),
        additionalData: asArrayBuffer(object.aad),
        tagLength: 128,
      },
      key,
      asArrayBuffer(object.body.slice(12)),
    ),
  )
  if (frame.byteLength !== ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES)
    throw new Error('frame length')
  const cborLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    false,
  )
  if (
    cborLength < 1 ||
    cborLength > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES ||
    cborLength > frame.byteLength - 4
  )
    throw new Error('cbor length')
  for (let index = 4 + cborLength; index < frame.byteLength; index += 1) {
    if (frame[index] !== 0) throw new Error('padding')
  }
  const canonical = frame.slice(4, 4 + cborLength)
  preflightProofChunk(canonical)
  const decoded = decode(canonical)
  const reencoded = encodeCanonical(decoded)
  if (!equalBytes(canonical, reencoded)) throw new Error('noncanonical cbor')
  const scopeId = deriveEncryptedWalletBackupDurableCustodyScopeId(seed)
  return decodeProofChunkRecords(decoded, seed, scopeId, input.cooperativeYield)
}

async function decodeProofChunkRecords(
  value: unknown,
  seed: Uint8Array,
  scopeId: string,
  cooperativeYield: (() => void | Promise<void>) | undefined,
): Promise<UnverifiedEncryptedWalletBackupProof[]> {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    value[1] !== 1 ||
    !Array.isArray(value[2]) ||
    value[2].length < 1 ||
    value[2].length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX
  )
    throw new Error('root')
  const records = value[2]
  const derivers = new Map<string, SecretDeriver>()
  const restored: UnverifiedEncryptedWalletBackupProof[] = []
  const yieldToHost = cooperativeYield ?? defaultCooperativeYield
  for (let index = 0; index < records.length; index += 1) {
    restored.push(decodeProofRecord(records[index], seed, scopeId, derivers))
    // Four-record work slices keep legacy BIP-32 derivation comfortably below
    // a browser long-task budget on the measured corpus; this is a work bound,
    // not a latency guarantee.
    if ((index + 1) % 4 === 0 && index + 1 < records.length) await yieldToHost()
  }
  for (let index = 1; index < restored.length; index += 1) {
    if (compareHex(restored[index - 1]!.proofId, restored[index]!.proofId) >= 0) {
      throw new Error('proof order')
    }
  }
  return restored
}

function decodeProofRecord(
  value: unknown,
  seed: Uint8Array,
  scopeId: string,
  derivers: Map<string, SecretDeriver>,
): UnverifiedEncryptedWalletBackupProof {
  if (!Array.isArray(value) || value.length !== 14) throw new Error('record')
  const [
    proofIdRaw,
    commitmentRaw,
    mintRaw,
    unitRaw,
    keysetRaw,
    amountRaw,
    secretRaw,
    signatureRaw,
    dleqRaw,
    counterRaw,
    proofKindRaw,
    ctfRaw,
    createdRaw,
    updatedRaw,
  ] = value
  const proofId = requireBytes(proofIdRaw, 32, 'proof id')
  const commitment = requireBytes(commitmentRaw, 32, 'commitment')
  const mint = requireNormalizedMint(mintRaw)
  const unit = requireBoundedText(unitRaw, 64, 'unit')
  const keyset = decodeKeysetWire(keysetRaw)
  const amount = requireAmount(amountRaw)
  const secretBytes = requireBytes(secretRaw, 64, 'secret')
  const secret = new TextDecoder('utf-8', { fatal: true }).decode(secretBytes)
  requireLowerHexSecret(secret)
  const signature = requireSignatureBytes(signatureRaw, keyset.curve)
  const dleq = requireDleqBytes(dleqRaw, keyset.curve)
  const counter = requireInteger(counterRaw, 0, 2_147_483_647, 'counter')
  if (proofKindRaw !== 0 && proofKindRaw !== 1) throw new Error('proof kind')
  const effectiveNow = 0
  const ctf = decodeCtfWire(ctfRaw, proofKindRaw, effectiveNow, false)
  const createdAt = requireNonNegativeSafeInteger(createdRaw, 'created')
  const updatedAt = requireNonNegativeSafeInteger(updatedRaw, 'updated')
  if (updatedAt < createdAt) throw new Error('timestamps')
  let deriver = derivers.get(keyset.text)
  if (deriver === undefined) {
    deriver = cashuSecretDeriver(seed, keyset.text)
    derivers.set(keyset.text, deriver)
  }
  if (bytesToHex(deriver(counter).secret) !== secret) throw new Error('secret derivation')
  const expectedProofId = deriveDurableCustodyProofId({
    scopeId,
    normalizedMint: mint,
    unit,
    keysetId: keyset.identityText,
    secret,
  })
  if (bytesToHex(proofId) !== expectedProofId) throw new Error('proof id')
  const keysetWire = [keyset.kindCode, keyset.text]
  const commitmentPreimage = [
    1,
    'proof-record-commitment',
    mint,
    unit,
    keysetWire,
    amount,
    secretBytes,
    signature,
    dleq,
    counter,
    proofKindRaw,
    ctf,
    createdAt,
    updatedAt,
  ]
  const expectedCommitment = sha256(encodeCanonical(commitmentPreimage))
  if (!equalBytes(commitment, expectedCommitment)) throw new Error('commitment')
  const proofBase = {
    id: keyset.text,
    amount,
    secret,
    C: bytesToHex(signature),
  }
  const proof: UnverifiedEncryptedWalletBackupProof['proof'] =
    dleq === null
      ? proofBase
      : {
          ...proofBase,
          dleq: {
            e: bytesToHex(dleq[0]),
            s: bytesToHex(dleq[1]),
            r: bytesToHex(dleq[2]),
          },
        }
  return {
    proofId: expectedProofId,
    commitment: bytesToHex(expectedCommitment),
    mint,
    unit,
    counter,
    encodedProofKind: proofKindRaw,
    ctfMetadata:
      ctf === null
        ? null
        : {
            conditionId: bytesToHex(ctf[0] as Uint8Array),
            outcomeLabel: ctf[1] as string,
            outcomeCollectionId: bytesToHex(ctf[2] as Uint8Array),
            registeredAtUnixSeconds: ctf[3] as number,
            finalExpiryUnixSeconds: ctf[4] as number,
          },
    terminalEvidence: ctf === null ? null : ctfTerminalSealToEvidence(ctf[5]),
    createdAtUnixSeconds: createdAt,
    updatedAtUnixSeconds: updatedAt,
    proof,
  }
}

registerEncryptedWalletBackupPreparedRecordValidator({
  validate: validatePreparedRecordPersistence,
  rehydrate: rehydratePreparedRecordPersistence,
})

function validatePreparedRecordPersistence(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
}) {
  const decoded = decodePreparedRecordPersistence(input)
  return Object.freeze({
    recordId: decoded.proof.proofId,
    commitment: decoded.proof.commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
  })
}

function rehydratePreparedRecordPersistence(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
  readonly snapshotId: string
  readonly snapshotRevision: number
}): PreparedEncryptedWalletBackupProof {
  const decoded = decodePreparedRecordPersistence(input)
  const proof = decoded.proof
  const handle = Object.freeze({ proofId: proof.proofId, commitment: proof.commitment })
  PREPARED_PROOF_AUTHORITIES.set(handle, {
    keyAuthority: decoded.keyAuthority,
    proofId: proof.proofId,
    commitment: proof.commitment,
    snapshotId: requireBoundedText(input.snapshotId, 128, 'prepared snapshot id'),
    snapshotRevision: requireNonNegativeSafeInteger(
      input.snapshotRevision,
      'prepared snapshot revision',
    ),
    mint: proof.mint,
    unit: proof.unit,
    amount: proof.proof.amount,
    proofKindCode: proof.encodedProofKind,
    ctfMetadata: decoded.raw[11] as EncryptedWalletBackupCtfWire | null,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
    recordBytes: decoded.canonicalRecord,
  })
  return issuePreparedEncryptedWalletBackupRecord(handle, {
    recordId: proof.proofId,
    commitment: proof.commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
    keyHandle: input.keyHandle,
    canonicalRecord: decoded.canonicalRecord,
    snapshotId: input.snapshotId,
    snapshotRevision: input.snapshotRevision,
    canonicalManifestEntry: decoded.canonicalManifestEntry,
  })
}

function decodePreparedRecordPersistence(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
}): {
  readonly keyAuthority: KeyAuthority
  readonly proof: UnverifiedEncryptedWalletBackupProof
  readonly raw: readonly unknown[]
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
} {
  const keyAuthority = requireKeyAuthority(input.keyHandle)
  const seed = requireSeed(input.seed)
  if (!equalBytes(keyAuthority.seedDigest, sha256(seed))) {
    throw new Error('backup seed does not match key handle')
  }
  const canonicalRecord = requireBytesRange(
    input.canonicalRecord,
    1,
    ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
    'prepared record',
  )
  const raw = decode(canonicalRecord)
  if (!Array.isArray(raw) || !equalBytes(canonicalRecord, encodeCanonical(raw))) {
    throw new Error('prepared backup record is not canonical CBOR')
  }
  const scopeId = deriveEncryptedWalletBackupDurableCustodyScopeId(seed)
  const proof = decodeProofRecord(raw, seed, scopeId, new Map())
  const expectedManifestEntry = encodeCanonical([
    ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
    raw[0],
    raw[1],
    raw[2],
    raw[3],
    raw[5],
    raw[10],
    raw[11],
    raw[12],
    raw[13],
  ])
  const canonicalManifestEntry = requireBytesRange(
    input.canonicalManifestEntry,
    1,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
    'prepared manifest entry',
  )
  if (!equalBytes(canonicalManifestEntry, expectedManifestEntry)) {
    throw new Error('prepared backup manifest metadata changed')
  }
  return {
    keyAuthority,
    proof,
    raw,
    canonicalRecord,
    canonicalManifestEntry,
  }
}

function defaultCooperativeYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function requireWireObject(
  value: unknown,
  authority: KeyAuthority,
): EncryptedWalletBackupWireObject {
  const object = requireRecord(value, 'wire object')
  requireKnownFields(object, [
    'formatVersion',
    'kindCode',
    'realm',
    'vaultId',
    'objectId',
    'generation',
    'paddedLength',
    'digest',
    'aad',
    'body',
  ])
  if (
    object.formatVersion !== 1 ||
    object.kindCode !== 1 ||
    object.realm !== authority.realm ||
    object.vaultId !== bytesToHex(authority.vaultIdBytes) ||
    object.paddedLength !== ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES
  )
    throw new Error('metadata')
  const objectId = requireLowerHex(object.objectId, 16, 'object id')
  const digest = requireLowerHex(object.digest, 32, 'digest')
  const generation = requireInteger(object.generation, 1, Number.MAX_SAFE_INTEGER, 'generation')
  const aad = requireBytesRange(object.aad, 1, 4_096, 'aad')
  const body = requireBytes(object.body, ENCRYPTED_WALLET_BACKUP_BODY_BYTES, 'body')
  return {
    formatVersion: 1,
    kindCode: 1,
    realm: authority.realm,
    vaultId: bytesToHex(authority.vaultIdBytes),
    objectId,
    generation,
    paddedLength: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
    digest,
    aad,
    body,
  }
}

function requireManifestWireObject(
  value: unknown,
  authority: KeyAuthority,
): EncryptedWalletBackupWireObject {
  const object = requireRecord(value, 'wire object')
  requireKnownFields(object, [
    'formatVersion',
    'kindCode',
    'realm',
    'vaultId',
    'objectId',
    'generation',
    'paddedLength',
    'digest',
    'aad',
    'body',
  ])
  if (
    object.formatVersion !== 1 ||
    object.kindCode !== ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND ||
    object.realm !== authority.realm ||
    object.vaultId !== bytesToHex(authority.vaultIdBytes) ||
    object.paddedLength !== ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES
  )
    throw new Error('metadata')
  return {
    formatVersion: 1,
    kindCode: ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
    realm: authority.realm,
    vaultId: bytesToHex(authority.vaultIdBytes),
    objectId: requireLowerHex(object.objectId, 16, 'object id'),
    generation: requireInteger(object.generation, 1, Number.MAX_SAFE_INTEGER, 'generation'),
    paddedLength: ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES,
    digest: requireLowerHex(object.digest, 32, 'digest'),
    aad: requireBytesRange(object.aad, 1, 4_096, 'aad'),
    body: requireBytes(object.body, ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES, 'body'),
  }
}

async function decryptObjectFrame(input: {
  authority: KeyAuthority
  object: EncryptedWalletBackupWireObject
  kindCode: 1 | 2
  frameBytes: number
  cborMaxBytes: number
}): Promise<Uint8Array> {
  const objectId = hexToBytes(input.object.objectId)
  const expectedAad = encodeCanonical([
    1,
    input.kindCode,
    input.authority.realm,
    input.authority.vaultIdBytes,
    objectId,
    input.object.generation,
    input.frameBytes,
  ])
  if (!equalBytes(expectedAad, input.object.aad)) throw new Error('foreign aad')
  const expectedDigest = bytesToHex(
    sha256(
      concatBytes(uint32Bytes(input.object.aad.byteLength), input.object.aad, input.object.body),
    ),
  )
  if (expectedDigest !== input.object.digest) throw new Error('digest mismatch')
  const objectKey = await hkdf(
    input.authority.runtime.subtle,
    input.authority.encryptionRoot,
    objectId,
    encodeCanonical([
      1,
      'object-key',
      input.authority.realm,
      input.authority.vaultIdBytes,
      input.kindCode,
    ]),
  )
  const key = await input.authority.runtime.subtle.importKey(
    'raw',
    asArrayBuffer(objectKey),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const frame = new Uint8Array(
    await input.authority.runtime.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(input.object.body.slice(0, 12)),
        additionalData: asArrayBuffer(input.object.aad),
        tagLength: 128,
      },
      key,
      asArrayBuffer(input.object.body.slice(12)),
    ),
  )
  if (frame.byteLength !== input.frameBytes) throw new Error('frame length')
  const cborLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    false,
  )
  if (cborLength < 1 || cborLength > input.cborMaxBytes || cborLength > frame.byteLength - 4) {
    throw new Error('cbor length')
  }
  for (let index = 4 + cborLength; index < frame.byteLength; index += 1) {
    if (frame[index] !== 0) throw new Error('padding')
  }
  return frame.slice(4, 4 + cborLength)
}

function decodeManifestPage(
  value: unknown,
  objectGeneration: number,
): DecryptedEncryptedWalletBackupManifestPage {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION ||
    value[1] !== ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND
  )
    throw new Error('manifest root')
  const generation = requireInteger(value[2], 1, Number.MAX_SAFE_INTEGER, 'manifest generation')
  if (generation !== objectGeneration) throw new Error('manifest generation')
  const snapshotNonce = requireBytes(value[3], 16, 'manifest snapshot nonce')
  const pageIndex = requireInteger(value[4], 0, 1_023, 'manifest page index')
  const pageCount = requireInteger(value[5], 1, 1_024, 'manifest page count')
  if (
    pageIndex >= pageCount ||
    !Array.isArray(value[6]) ||
    value[6].length < 1 ||
    value[6].length > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX
  ) {
    throw new Error('manifest page shape')
  }
  const entries = (value[6] as unknown[]).map(decodeManifestEntry)
  for (let index = 1; index < entries.length; index += 1) {
    if (compareHex(entries[index - 1]!.proofId, entries[index]!.proofId) >= 0) {
      throw new Error('manifest proof order')
    }
  }
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    kindCode: ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND,
    generation,
    snapshotNonce: bytesToHex(snapshotNonce),
    pageIndex,
    pageCount,
    entries: Object.freeze(entries),
  })
}

function decodeManifestEntry(value: unknown): EncryptedWalletBackupManifestEntry {
  if (!Array.isArray(value) || value.length !== 11) throw new Error('manifest entry')
  const proofId = bytesToHex(requireBytes(value[0], 32, 'manifest proof id'))
  const commitment = bytesToHex(requireBytes(value[1], 32, 'manifest proof commitment'))
  const chunkObjectId = bytesToHex(requireBytes(value[2], 16, 'manifest chunk object id'))
  const chunkDigest = bytesToHex(requireBytes(value[3], 32, 'manifest chunk digest'))
  const mint = requireNormalizedMint(value[4])
  const unit = requireBoundedText(value[5], 64, 'manifest unit')
  const amount = requireAmount(value[6])
  if (value[7] !== 0 && value[7] !== 1) throw new Error('manifest proof kind')
  const ctf = decodeCtfWire(value[8], value[7], 0, false)
  const createdAt = requireNonNegativeSafeInteger(value[9], 'manifest creation time')
  const updatedAt = requireNonNegativeSafeInteger(value[10], 'manifest update time')
  if (updatedAt < createdAt) throw new Error('manifest timestamps')
  return Object.freeze({
    proofId,
    commitment,
    chunkObjectId,
    chunkDigest,
    mint,
    unit,
    amount,
    proofKind: value[7] === 0 ? 'ordinary' : 'ctf',
    ctfMetadata: ctf === null ? null : ctfTupleToMetadata(ctf),
    terminalEvidence: ctf === null ? null : ctfTerminalSealToEvidence(ctf[5]),
    createdAtUnixSeconds: createdAt,
    updatedAtUnixSeconds: updatedAt,
  })
}

function manifestEntryWire(
  proof: PreparedProofAuthority,
  object: PreparedEncryptedWalletBackupObject,
): unknown[] {
  return [
    hexToBytes(proof.proofId),
    hexToBytes(proof.commitment),
    hexToBytes(object.objectId),
    hexToBytes(object.digest),
    proof.mint,
    proof.unit,
    proof.amount,
    proof.proofKindCode,
    proof.ctfMetadata,
    proof.createdAtUnixSeconds,
    proof.updatedAtUnixSeconds,
  ]
}

function manifestEntryValue(entry: EncryptedWalletBackupManifestEntry): unknown[] {
  return [
    hexToBytes(entry.proofId),
    hexToBytes(entry.commitment),
    hexToBytes(entry.chunkObjectId),
    hexToBytes(entry.chunkDigest),
    entry.mint,
    entry.unit,
    entry.amount,
    entry.proofKind === 'ordinary' ? 0 : 1,
    entry.ctfMetadata === null
      ? null
      : [
          hexToBytes(entry.ctfMetadata.conditionId),
          entry.ctfMetadata.outcomeLabel,
          hexToBytes(entry.ctfMetadata.outcomeCollectionId),
          entry.ctfMetadata.registeredAtUnixSeconds,
          entry.ctfMetadata.finalExpiryUnixSeconds,
          ctfTerminalEvidenceToSeal(entry.terminalEvidence),
        ],
    entry.createdAtUnixSeconds,
    entry.updatedAtUnixSeconds,
  ]
}

interface KeysetId {
  kindCode: 0 | 1 | 2
  text: string
  identityText: string
  curve: 'secp256k1' | 'bls12-381'
}

function decodeKeysetId(value: unknown): KeysetId {
  if (typeof value !== 'string') throw new Error('backup proof keyset is invalid')
  if (/^(?:01|02)[0-9a-f]{14}$/.test(value)) throw new Error('unresolved short modern keyset')
  if (/^00[0-9a-f]{14}$/.test(value)) {
    return {
      kindCode: 1,
      text: value,
      identityText: value,
      curve: 'secp256k1',
    }
  }
  if (/^(?:01|02)[0-9a-f]{64}$/.test(value)) {
    return {
      kindCode: 2,
      text: value,
      identityText: value,
      curve: value.startsWith('02') ? 'bls12-381' : 'secp256k1',
    }
  }
  if (/^[0-9a-fA-F]+$/.test(value)) throw new Error('backup proof keyset is invalid')
  if (isCashuLegacyBase64(value)) {
    return {
      kindCode: 0,
      text: value,
      identityText: `legacy:${bytesToHex(base64Decode(value.replace(/=+$/, '')))}`,
      curve: 'secp256k1',
    }
  }
  throw new Error('backup proof keyset is invalid')
}

function decodeKeysetWire(value: unknown): KeysetId {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('keyset wire')
  const decoded = decodeKeysetId(value[1])
  if (decoded.kindCode !== value[0]) throw new Error('keyset tag')
  return decoded
}

function isCashuLegacyBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 128) return false
  if (/[+/]/.test(value) && /[-_]/.test(value)) return false
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return false
  try {
    const decoded = base64Decode(normalized)
    const standard = base64Encode(decoded).replace(/=+$/, '')
    return standard === normalized
  } catch {
    return false
  }
}

function prepareCtfTerminalSeal(
  input: EncryptedWalletBackupProofInput,
  mint: string,
  keysetId: string,
  ctf: EncryptedWalletBackupCtfBase | null,
): EncryptedWalletBackupCtfTerminalSeal | null {
  if (input.terminalEvidence === null) return null
  if (ctf === null) {
    throw new Error('ordinary proof cannot contain CTF terminal evidence')
  }
  const evidence = readAuthenticatedCtfRedeemTerminalEvidence(input.terminalEvidence)
  if (
    evidence.normalizedMint !== mint ||
    evidence.rejectionBody.code !== ORACLE_NOT_ATTESTED_OUTCOME_CODE
  ) {
    throw new Error('CTF terminal evidence does not match proof')
  }
  const operationIdDigest = sha256(new TextEncoder().encode(evidence.operationId))
  const terminalRequestDigest = sha256(
    encodeCanonical([1, 'ctf-terminal-rejection', operationIdDigest, mint, keysetId, 13015]),
  )
  return [
    1,
    operationIdDigest,
    terminalRequestDigest,
    13015,
    requireNonNegativeSafeInteger(input.updatedAtUnixSeconds, 'CTF terminal classification time'),
  ]
}

function decodeCtfMetadata(
  value: EncryptedWalletBackupCtfMetadata | null,
  proofKindCode: number,
): EncryptedWalletBackupCtfBase | null {
  if (proofKindCode === 0) {
    if (value !== null) throw new Error('ordinary proof cannot contain CTF metadata')
    return null
  }
  if (value === null) throw new Error('CTF metadata is invalid')
  const record = requireRecord(value, 'CTF metadata')
  requireKnownFields(record, [
    'conditionId',
    'outcomeLabel',
    'outcomeCollectionId',
    'registeredAtUnixSeconds',
    'finalExpiryUnixSeconds',
  ])
  const conditionId = hexToBytes(requireLowerHex(record.conditionId, 32, 'condition id'))
  const outcomeLabel = requireBoundedText(record.outcomeLabel, 256, 'CTF outcome label')
  const collectionId = hexToBytes(
    requireLowerHex(record.outcomeCollectionId, 32, 'outcome collection id'),
  )
  const registeredAt = requireNonNegativeSafeInteger(
    record.registeredAtUnixSeconds,
    'CTF registration time',
  )
  const finalExpiry = requireNonNegativeSafeInteger(
    record.finalExpiryUnixSeconds,
    'CTF final expiry',
  )
  return [conditionId, outcomeLabel, collectionId, registeredAt, finalExpiry]
}

function ctfTupleToMetadata(
  value: EncryptedWalletBackupCtfBase | EncryptedWalletBackupCtfWire,
): EncryptedWalletBackupCtfMetadata {
  return {
    conditionId: bytesToHex(value[0]),
    outcomeLabel: value[1],
    outcomeCollectionId: bytesToHex(value[2]),
    registeredAtUnixSeconds: value[3],
    finalExpiryUnixSeconds: value[4],
  }
}

function decodeCtfWire(
  value: unknown,
  proofKindCode: number,
  effectiveNow: number,
  enforceExpiry: boolean,
): EncryptedWalletBackupCtfWire | null {
  if (proofKindCode === 0) {
    if (value !== null) throw new Error('ctf wire')
    return null
  }
  if (!Array.isArray(value) || value.length !== 6) throw new Error('ctf wire')
  const conditionId = requireBytes(value[0], 32, 'condition id')
  const label = requireBoundedText(value[1], 256, 'outcome')
  const collectionId = requireBytes(value[2], 32, 'collection id')
  const registered = requireNonNegativeSafeInteger(value[3], 'registration')
  const expiry = requireNonNegativeSafeInteger(value[4], 'expiry')
  if (enforceExpiry && expiry <= effectiveNow) throw new Error('expired')
  const terminalSeal = decodeCtfTerminalSeal(value[5])
  return [conditionId, label, collectionId, registered, expiry, terminalSeal]
}

function decodeCtfTerminalSeal(value: unknown): EncryptedWalletBackupCtfTerminalSeal | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1) {
    throw new Error('CTF terminal evidence is invalid')
  }
  const operationIdDigest = requireBytes(value[1], 32, 'CTF terminal operation digest')
  const requestDigest = requireBytes(value[2], 32, 'CTF terminal request digest')
  if (value[3] !== 13015) throw new Error('CTF terminal failure code is invalid')
  return [
    1,
    operationIdDigest,
    requestDigest,
    13015,
    requireNonNegativeSafeInteger(value[4], 'CTF terminal classification time'),
  ]
}

function ctfTerminalSealToEvidence(
  value: EncryptedWalletBackupCtfTerminalSeal | null,
): EncryptedWalletBackupCtfTerminalEvidence | null {
  return value === null
    ? null
    : {
        reason: 'verified-losing-outcome',
        operationIdDigest: bytesToHex(value[1]),
        requestDigest: bytesToHex(value[2]),
        failureCode: 13015,
        classifiedAt: value[4],
      }
}

function ctfTerminalEvidenceToSeal(
  value: EncryptedWalletBackupCtfTerminalEvidence | null,
): EncryptedWalletBackupCtfTerminalSeal | null {
  if (value === null) return null
  if (value.reason !== 'verified-losing-outcome' || value.failureCode !== 13015) {
    throw new Error('CTF terminal evidence is invalid')
  }
  return [
    1,
    hexToBytes(requireLowerHex(value.operationIdDigest, 32, 'CTF terminal operation digest')),
    hexToBytes(requireLowerHex(value.requestDigest, 32, 'CTF terminal request digest')),
    13015,
    requireNonNegativeSafeInteger(value.classifiedAt, 'CTF terminal classification time'),
  ]
}

function requireDleq(
  value: unknown,
  curve: KeysetId['curve'],
): null | [Uint8Array, Uint8Array, Uint8Array] {
  if (curve === 'bls12-381') {
    if (value !== undefined && value !== null) throw new Error('BLS proof cannot contain DLEQ')
    return null
  }
  const record = requireRecord(value, 'proof DLEQ')
  requireKnownFields(record, ['e', 's', 'r'])
  return [
    hexToBytes(requireLowerHex(record.e, 32, 'DLEQ e')),
    hexToBytes(requireLowerHex(record.s, 32, 'DLEQ s')),
    hexToBytes(requireLowerHex(record.r, 32, 'DLEQ r')),
  ]
}

function requireDleqBytes(
  value: unknown,
  curve: KeysetId['curve'],
): null | [Uint8Array, Uint8Array, Uint8Array] {
  if (curve === 'bls12-381') {
    if (value !== null) throw new Error('dleq')
    return null
  }
  if (!Array.isArray(value) || value.length !== 3) throw new Error('dleq')
  return [
    requireBytes(value[0], 32, 'dleq e'),
    requireBytes(value[1], 32, 'dleq s'),
    requireBytes(value[2], 32, 'dleq r'),
  ]
}

function requireSignature(value: unknown, curve: KeysetId['curve']): Uint8Array {
  const bytes = hexToBytes(
    requireLowerHex(value, curve === 'bls12-381' ? 48 : 33, 'proof signature'),
  )
  return bytes
}

function requireSignatureBytes(value: unknown, curve: KeysetId['curve']): Uint8Array {
  return requireBytes(value, curve === 'bls12-381' ? 48 : 33, 'signature')
}

function requireAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('backup proof amount is invalid')
  }
  let amount: bigint
  try {
    amount = BigInt(value)
  } catch {
    throw new Error('backup proof amount is invalid')
  }
  if (amount > UINT64_MAX) throw new Error('backup proof amount is invalid')
  return value
}

function requireLowerHexSecret(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('backup proof secret is invalid')
  }
  return value
}

function requireNormalizedMint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('normalized mint is invalid')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('normalized mint is invalid')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    /%[0-9a-f]{2}/i.test(parsed.pathname)
  )
    throw new Error('normalized mint is invalid')
  const normalized = parsed.href.replace(/\/+$/, '')
  if (normalized !== value || new TextEncoder().encode(normalized).byteLength > 2_048) {
    throw new Error('normalized mint is invalid')
  }
  return normalized
}

function requireBoundedText(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasInvalidText(value)) {
    throw new Error(`${name} is invalid`)
  }
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > maxBytes) throw new Error(`${name} is invalid`)
  return value
}

function hasInvalidText(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !REALM_PATTERN.test(value))
    throw new Error('backup realm is invalid')
  return value
}

function requireRequestMethod(value: unknown): EncryptedWalletBackupRequestMethod {
  if (value !== 'GET' && value !== 'PUT' && value !== 'POST' && value !== 'DELETE') {
    throw new Error('backup request method is invalid')
  }
  return value
}

function decodeBackupRequestProof(value: unknown): EncryptedWalletBackupRequestProof {
  if (value instanceof Uint8Array) {
    preflightEncryptedBackupRequestProofCbor(value)
    const decoded = decode(value)
    if (
      !equalBytes(value, encodeCanonical(decoded)) ||
      !Array.isArray(decoded) ||
      decoded.length !== 14 ||
      decoded[0] !== ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION ||
      decoded[1] !== 'backup-request-proof'
    ) {
      throw new Error('backup request proof encoding is invalid')
    }
    value = {
      formatVersion: decoded[0],
      realm: decoded[2],
      vaultId: bytesToHex(requireBytes(decoded[3], 32, 'vault id')),
      requestAuthPublicKey: bytesToHex(requireBytes(decoded[4], 32, 'request public key')),
      enrollmentEpoch: decoded[5],
      method: decoded[6],
      url: decoded[7],
      issuedAtUnixSeconds: decoded[8],
      expiresAtUnixSeconds: decoded[9],
      replayNonce: bytesToHex(requireBytes(decoded[10], 16, 'replay nonce')),
      payloadLength: decoded[11],
      payloadDigest: bytesToHex(requireBytes(decoded[12], 32, 'payload digest')),
      signature: bytesToHex(requireBytes(decoded[13], 64, 'request signature')),
    }
  }
  const raw = requireRecord(value, 'backup request proof')
  requireKnownFields(raw, [
    'formatVersion',
    'realm',
    'vaultId',
    'requestAuthPublicKey',
    'enrollmentEpoch',
    'method',
    'url',
    'issuedAtUnixSeconds',
    'expiresAtUnixSeconds',
    'replayNonce',
    'payloadLength',
    'payloadDigest',
    'signature',
  ])
  if (raw.formatVersion !== ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION) {
    throw new Error('unsupported backup request proof version')
  }
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm: requireRealm(raw.realm),
    vaultId: requireLowerHex(raw.vaultId, 32, 'vault id'),
    requestAuthPublicKey: requireLowerHex(raw.requestAuthPublicKey, 32, 'request public key'),
    enrollmentEpoch: requireInteger(
      raw.enrollmentEpoch,
      0,
      Number.MAX_SAFE_INTEGER,
      'enrollment epoch',
    ),
    method: requireRequestMethod(raw.method),
    url: requireExactHttpsUrl(raw.url),
    issuedAtUnixSeconds: requireNonNegativeSafeInteger(
      raw.issuedAtUnixSeconds,
      'request issue time',
    ),
    expiresAtUnixSeconds: requireNonNegativeSafeInteger(
      raw.expiresAtUnixSeconds,
      'request expiry time',
    ),
    replayNonce: requireLowerHex(raw.replayNonce, 16, 'replay nonce'),
    payloadLength: requireInteger(
      raw.payloadLength,
      0,
      ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
      'payload length',
    ),
    payloadDigest: requireLowerHex(raw.payloadDigest, 32, 'payload digest'),
    signature: requireLowerHex(raw.signature, 64, 'request signature'),
  })
}

function requireExactHttpsUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw new Error('backup request URL is invalid')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('backup request URL is invalid')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  )
    throw new Error('backup request URL is invalid')
  return value
}

function encodeBackupRequestPreimage(input: {
  realm: string
  vaultId: Uint8Array
  requestAuthPublicKey: Uint8Array
  enrollmentEpoch: number
  method: EncryptedWalletBackupRequestMethod
  url: string
  issuedAtUnixSeconds: number
  expiresAtUnixSeconds: number
  replayNonce: Uint8Array
  payloadLength: number
  payloadDigest: Uint8Array
}): Uint8Array {
  return encodeCanonical([
    1,
    'backup-request',
    input.realm,
    input.vaultId,
    input.requestAuthPublicKey,
    input.enrollmentEpoch,
    input.method,
    input.url,
    input.issuedAtUnixSeconds,
    input.expiresAtUnixSeconds,
    input.replayNonce,
    input.payloadLength,
    input.payloadDigest,
  ])
}

function deriveEncryptedWalletBackupDurableCustodyScopeId(seed: Uint8Array): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(seed),
  })
}

function requireSeed(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 64)
    throw new Error('backup seed is invalid')
  return value.slice()
}

function requireRuntime(
  value: EncryptedWalletBackupRuntime | undefined,
): EncryptedWalletBackupRuntime {
  const runtime = value ?? globalThis.crypto
  if (
    runtime === undefined ||
    typeof runtime.getRandomValues !== 'function' ||
    runtime.subtle === undefined
  )
    throw new Error('encrypted backup crypto runtime is unavailable')
  return {
    subtle: runtime.subtle,
    getRandomValues: (target) => runtime.getRandomValues(target),
  }
}

function requireKeyAuthority(value: unknown): KeyAuthority {
  const handle = requireIssuedEncryptedWalletBackupKeyHandle(value)
  const authority = KEY_AUTHORITIES.get(handle)
  if (authority === undefined) throw new Error('backup key handle is invalid')
  return authority
}

function requireProofAuthority(value: unknown): PreparedProofAuthority {
  if (typeof value !== 'object' || value === null)
    throw new Error('prepared backup proof handle is invalid')
  const authority = PREPARED_PROOF_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('prepared backup proof handle is invalid')
  return authority
}

function requireChunkAuthority(value: unknown): PreparedChunkAuthority {
  if (typeof value !== 'object' || value === null) throw new Error('proof chunk handle is invalid')
  const authority = PREPARED_CHUNK_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('proof chunk handle is invalid')
  return authority
}

function requirePreparedObjectAuthority(value: unknown): PreparedObjectAuthority {
  if (typeof value !== 'object' || value === null)
    throw new Error('prepared backup object is invalid')
  const authority = PREPARED_OBJECT_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('prepared backup object is invalid')
  return authority
}

function requirePreparedManifest(
  value: unknown,
  keyAuthority: KeyAuthority,
): PreparedEncryptedWalletBackupManifest {
  if (typeof value !== 'object' || value === null) throw new Error('prepared manifest is invalid')
  const authority = PREPARED_MANIFESTS.get(value)
  if (authority === undefined || requireKeyAuthority(authority.keyHandle) !== keyAuthority) {
    throw new Error('prepared manifest is invalid')
  }
  return value as PreparedEncryptedWalletBackupManifest
}

function requireManifestHeadAuthority(value: unknown): PreparedManifestHeadAuthority {
  if (typeof value !== 'object' || value === null) {
    throw new Error('manifest head is not authenticated')
  }
  const authority =
    PREPARED_MANIFEST_HEADS.get(value) ?? AUTHENTICATED_MANIFEST_HEAD_VALUES.get(value)
  if (authority === undefined) throw new Error('manifest head is not authenticated')
  return authority
}

function requireSealedSyncAttempt(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
): NonNullable<ReturnType<typeof readCoordinatedEncryptedWalletBackupCasAuthority>> {
  const authority = readCoordinatedEncryptedWalletBackupCasAuthority(value)
  if (authority === undefined || authority.keyHandle !== keyHandle) {
    throw new Error('backup sync attempt is not sealed for this key')
  }
  return authority
}

function decodeManifestHeadWire(
  value: unknown,
  keyAuthority: KeyAuthority,
  expectedPublicKey: string,
): AuthenticatedHeadAuthority {
  const wire = requireRecord(value, 'manifest head wire')
  requireKnownFields(wire, ['canonicalHead', 'canonicalReferenceSet'])
  const canonicalHead = requireBytesRange(
    wire.canonicalHead,
    1,
    ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
    'canonical manifest head',
  ).slice()
  const canonicalReferenceSet = requireBytesRange(
    wire.canonicalReferenceSet,
    1,
    ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
    'canonical manifest reference set',
  ).slice()
  const validated = validateEncryptedWalletBackupManifestHeadUnit({
    canonicalHead,
    canonicalReferenceSet,
  })
  const {
    realm,
    vaultId,
    backupPublicKey,
    generation,
    parent,
    snapshotNonce,
    pageReferences,
    chunkReferences,
    proofCount,
    storedBytes,
    referenceSetDigest,
    manifestDigest,
  } = validated
  if (
    realm !== keyAuthority.realm ||
    vaultId !== bytesToHex(keyAuthority.vaultIdBytes) ||
    backupPublicKey !== requireLowerHex(expectedPublicKey, 32, 'expected backup public key')
  ) {
    throw new Error('manifest head belongs to a foreign vault')
  }
  const head = Object.freeze({
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
      manifestDigest,
    }),
    manifestDigest,
    referenceSetDigest,
    objectCount: pageReferences.length + chunkReferences.length,
    storedBytes,
    proofCount,
  })
  return {
    keyAuthority,
    localSnapshotId: null,
    localSnapshotRevision: null,
    head,
    canonicalHead,
    canonicalReferenceSet,
    canonicalParentHead: null,
    canonicalInheritedReferenceSet: encodeCanonical([1, 'reference-set', [], []]),
    pageObjects: Object.freeze([]),
    chunkObjects: Object.freeze([]),
  }
}

function decodeObjectReferences(
  value: unknown,
  name: string,
): Array<{ objectId: string; digest: string }> {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX) {
    throw new Error(`${name} are invalid`)
  }
  return value.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${name} are invalid`)
    return {
      objectId: bytesToHex(requireBytes(raw[0], 16, 'referenced object id')),
      digest: bytesToHex(requireBytes(raw[1], 32, 'referenced object digest')),
    }
  })
}

function requireAuthenticatedPageReference(
  head: EncryptedWalletBackupManifestHead,
  object: EncryptedWalletBackupWireObject,
): { pageIndex: number; pageCount: number } {
  const authority = AUTHENTICATED_MANIFEST_HEAD_VALUES.get(head)
  if (authority === undefined) throw new Error('manifest head is not authenticated')
  const referenceSet = decode(authority.canonicalReferenceSet)
  if (
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    !Array.isArray(referenceSet[2])
  ) {
    throw new Error('manifest reference set is invalid')
  }
  const pages = referenceSet[2]
  let matchedIndex = -1
  for (let index = 0; index < pages.length; index += 1) {
    const reference = pages[index]
    if (!Array.isArray(reference) || reference.length !== 2) {
      throw new Error('manifest page reference is invalid')
    }
    if (
      bytesToHex(requireBytes(reference[0], 16, 'manifest page object id')) === object.objectId &&
      bytesToHex(requireBytes(reference[1], 32, 'manifest page digest')) === object.digest
    ) {
      if (matchedIndex !== -1) throw new Error('manifest page reference is duplicated')
      matchedIndex = index
    }
  }
  if (matchedIndex === -1) throw new Error('manifest page is not reachable from authenticated head')
  return { pageIndex: matchedIndex, pageCount: pages.length }
}

function requireAuthenticatedChunkReference(
  head: EncryptedWalletBackupManifestHead,
  objectId: string,
  digest: string,
): void {
  const authority = AUTHENTICATED_MANIFEST_HEAD_VALUES.get(head)
  if (authority === undefined) throw new Error('manifest head is not authenticated')
  const referenceSet = decode(authority.canonicalReferenceSet)
  if (
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    !Array.isArray(referenceSet[3])
  ) {
    throw new Error('manifest reference set is invalid')
  }
  let matches = 0
  for (const raw of referenceSet[3]) {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error('manifest chunk reference is invalid')
    }
    if (
      bytesToHex(requireBytes(raw[0], 16, 'manifest chunk object id')) === objectId &&
      bytesToHex(requireBytes(raw[1], 32, 'manifest chunk digest')) === digest
    ) {
      matches += 1
    }
  }
  if (matches !== 1) throw new Error('manifest chunk is not reachable from authenticated head')
}

function assertNeverRemoteHeadStatus(value: never): never {
  throw new Error(`unsupported encrypted backup head status: ${String(value)}`)
}

function decodeSyncAttemptRecord(value: unknown): EncryptedWalletBackupSyncAttemptRecord {
  const record = requireRecord(value, 'backup sync attempt')
  requireKnownFields(record, [
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
  if (record.schemaVersion !== 1) throw new Error('unsupported backup sync attempt version')
  const targetHead = decodePersistedManifestHeadSummary(record.targetHead)
  const expectedHeadDigest =
    record.expectedHeadDigest === null
      ? null
      : requireLowerHex(record.expectedHeadDigest, 32, 'expected head digest')
  if (expectedHeadDigest !== (targetHead.parent?.manifestDigest ?? null)) {
    throw new Error('backup sync attempt parent does not match target')
  }
  const canonicalCasPayload = requireBytesRange(
    record.canonicalCasPayload,
    1,
    ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
    'CAS payload',
  ).slice()
  const casPayloadDigest = requireLowerHex(record.casPayloadDigest, 32, 'CAS payload digest')
  if (casPayloadDigest !== bytesToHex(sha256(canonicalCasPayload))) {
    throw new Error('backup sync attempt payload digest does not match')
  }
  const state = requireOneOfValue(
    record.state,
    [
      'sealed',
      'cas-uncertain',
      'retry-cas',
      'retry-exhausted',
      'reconcile-before-retry',
      'acknowledged',
      'fork-rejected',
    ] as const,
    'backup sync state',
  )
  const casAttempts = requireInteger(
    record.casAttempts,
    0,
    ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX,
    'CAS attempts',
  )
  const retryStreak = requireInteger(
    record.retryStreak,
    0,
    ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
    'backup retry streak',
  )
  const retryNotBeforeUnixMilliseconds =
    record.retryNotBeforeUnixMilliseconds === null
      ? null
      : requireInteger(
          record.retryNotBeforeUnixMilliseconds,
          1,
          Number.MAX_SAFE_INTEGER,
          'backup retry-not-before time',
        )
  validateEncryptedWalletBackupCasState({
    state,
    casAttempts,
    retryStreak,
    retryNotBeforeUnixMilliseconds,
  })
  return freezeSyncAttempt({
    schemaVersion: 1,
    realm: requireRealm(record.realm),
    vaultId: requireLowerHex(record.vaultId, 32, 'backup CAS vault id'),
    attemptId: requireLowerHex(record.attemptId, 16, 'backup attempt id'),
    uploadAttemptId: requireLowerHex(record.uploadAttemptId, 16, 'backup upload attempt id'),
    localSnapshotId: requireBoundedText(record.localSnapshotId, 128, 'local snapshot id'),
    localSnapshotRevision: requireNonNegativeSafeInteger(
      record.localSnapshotRevision,
      'local snapshot revision',
    ),
    expectedHeadDigest,
    targetHead,
    canonicalCasPayload,
    casPayloadDigest,
    casAttempts,
    retryStreak,
    retryNotBeforeUnixMilliseconds,
    state,
  })
}

function decodePersistedManifestHeadSummary(value: unknown): EncryptedWalletBackupManifestHead {
  const head = requireRecord(value, 'persisted manifest head')
  requireKnownFields(head, [
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
  if (head.formatVersion !== ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION) {
    throw new Error('unsupported persisted manifest head version')
  }
  const generation = requireInteger(
    head.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    'manifest generation',
  )
  let parent: EncryptedWalletBackupManifestHead['parent']
  if (head.parent === null) {
    if (generation !== 1) throw new Error('persisted manifest parent is invalid')
    parent = null
  } else {
    const rawParent = requireRecord(head.parent, 'persisted manifest parent')
    requireKnownFields(rawParent, ['generation', 'manifestDigest'])
    const parentGeneration = requireInteger(
      rawParent.generation,
      1,
      Number.MAX_SAFE_INTEGER,
      'parent generation',
    )
    if (parentGeneration !== generation - 1) throw new Error('persisted manifest parent is invalid')
    parent = Object.freeze({
      generation: parentGeneration,
      manifestDigest: requireLowerHex(rawParent.manifestDigest, 32, 'parent manifest digest'),
    })
  }
  const realm = requireRealm(head.realm)
  const backupPublicKey = requireLowerHex(head.backupPublicKey, 32, 'backup public key')
  const manifestDigest = requireLowerHex(head.manifestDigest, 32, 'manifest digest')
  const snapshotId = requireLowerHex(head.snapshotId, 32, 'backup snapshot id')
  if (
    snapshotId !==
    deriveDurableWalletBackupSnapshotId({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      realm,
      backupPublicKey,
      generation,
      manifestDigest,
    })
  )
    throw new Error('persisted backup snapshot id does not match head')
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm,
    vaultId: requireLowerHex(head.vaultId, 32, 'vault id'),
    backupPublicKey,
    generation,
    parent,
    snapshotNonce: requireLowerHex(head.snapshotNonce, 16, 'snapshot nonce'),
    snapshotId,
    manifestDigest,
    referenceSetDigest: requireLowerHex(head.referenceSetDigest, 32, 'reference set digest'),
    objectCount: requireInteger(
      head.objectCount,
      0,
      ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
      'object count',
    ),
    storedBytes: requireNonNegativeSafeInteger(head.storedBytes, 'stored bytes'),
    proofCount: requireInteger(
      head.proofCount,
      0,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
      'proof count',
    ),
  })
}

function freezeSyncAttempt(
  value: EncryptedWalletBackupSyncAttemptRecord,
): EncryptedWalletBackupSyncAttemptRecord {
  return Object.freeze({
    ...value,
    targetHead: decodePersistedManifestHeadSummary(value.targetHead),
    canonicalCasPayload: value.canonicalCasPayload.slice(),
  })
}

function equalSyncAttemptRecord(
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

async function persistSyncAttemptTransition(
  store: EncryptedWalletBackupSyncAttemptStore,
  expected: EncryptedWalletBackupSyncAttemptRecord,
  next: EncryptedWalletBackupSyncAttemptRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
): Promise<SealedEncryptedWalletBackupSyncAttempt> {
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.transitionPreparedAttempt !== 'function'
  ) {
    throw new Error('backup sync attempt store is invalid')
  }
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await store.transitionPreparedAttempt(expected, next, (rawRecord) => {
      if (!callbackOpen || callbackCalls++ !== 0)
        throw new Error('backup transition callback is invalid')
      const committed = decodeSyncAttemptRecord(rawRecord)
      if (!equalSyncAttemptRecord(committed, next))
        throw new Error('committed backup transition changed')
      const evidence = issueCoordinatedEncryptedWalletBackupCasAttempt(committed, keyHandle, store)
      issued = evidence
      return evidence
    })
  } finally {
    callbackOpen = false
  }
  if (
    isThenable(returned) ||
    issued === undefined ||
    returned !== issued ||
    callbackCalls !== 1 ||
    readCoordinatedEncryptedWalletBackupCasAuthority(issued) === undefined
  ) {
    throw new Error('backup transition must be synchronous and exact')
  }
  return issued as SealedEncryptedWalletBackupSyncAttempt
}

function assertNeverSyncEvent(value: never): never {
  throw new Error(`unsupported backup sync event: ${String(value)}`)
}

function objectReferenceWire(object: PreparedEncryptedWalletBackupObject): unknown[] {
  if (!PREPARED_OBJECT_AUTHORITIES.has(object))
    throw new Error('manifest object reference is invalid')
  return [hexToBytes(object.objectId), hexToBytes(object.digest)]
}

async function allocateObjectId(
  authority: KeyAuthority,
  runtime: EncryptedWalletBackupRuntime,
  objectIdExists: ((objectId: string) => boolean | Promise<boolean>) | undefined,
): Promise<{ objectId: string; objectIdBytes: Uint8Array }> {
  for (let attempt = 0; attempt < OBJECT_ID_COLLISION_ATTEMPTS; attempt += 1) {
    const objectIdBytes = randomBytes(runtime, 16)
    const objectId = bytesToHex(objectIdBytes)
    if (authority.preparedObjectIds.has(objectId)) continue
    authority.preparedObjectIds.add(objectId)
    try {
      if (objectIdExists !== undefined && (await objectIdExists(objectId))) {
        authority.preparedObjectIds.delete(objectId)
        continue
      }
    } catch (error) {
      authority.preparedObjectIds.delete(objectId)
      throw error
    }
    return { objectId, objectIdBytes }
  }
  throw new Error('backup object id collision limit exceeded')
}

async function deriveRequestAuthScalar(
  subtle: SubtleCrypto,
  requestAuthRoot: Uint8Array,
  realm: string,
): Promise<Uint8Array> {
  for (let counter = 0; counter < REQUEST_SCALAR_ATTEMPTS; counter += 1) {
    const candidate = await hkdf(
      subtle,
      requestAuthRoot,
      ROOT_SALT,
      encodeCanonical([1, 'request-auth-scalar', realm, counter]),
    )
    const scalar = bytesToBigInt(candidate)
    if (scalar > 0n && scalar < SECP256K1_ORDER) return candidate
  }
  throw new Error('request authentication scalar derivation exhausted')
}

async function hkdf(
  subtle: SubtleCrypto,
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', asArrayBuffer(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(info),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

function randomBytes(runtime: EncryptedWalletBackupRuntime, length: number): Uint8Array {
  const result = new Uint8Array(length)
  const returned = runtime.getRandomValues(result)
  if (returned !== result || result.byteLength !== length)
    throw new Error('crypto runtime returned invalid randomness')
  return result
}

function cashuSecretDeriver(seed: Uint8Array, keysetId: string): SecretDeriver {
  const create = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(seed: Uint8Array, keysetId: string): SecretDeriver
    }
  ).createSecretAndBlindingFactorDeriver
  if (typeof create !== 'function') throw new Error('cashu derivation is unavailable')
  return create(seed, keysetId)
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function requireKnownFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key))
      throw new Error('unsupported proof field')
  }
  for (const key of required)
    if (!(key in record)) throw new Error(`missing required field '${key}'`)
}

function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, name)
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function requireOneOfValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name} is invalid`)
  return value as T[number]
}

function decodeProofPins(value: unknown): EncryptedWalletBackupProofPins {
  const pins = requireRecord(value, 'stored proof pins')
  requireKnownFields(pins, [
    'openOrderCollateral',
    'outbox',
    'retryCursor',
    'replayTombstone',
    'dependentWork',
  ])
  const state = (entry: unknown, name: string) =>
    requireOneOfValue(entry, ['absent', 'present', 'unknown'] as const, name)
  return Object.freeze({
    openOrderCollateral: state(pins.openOrderCollateral, 'stored collateral pin'),
    outbox: state(pins.outbox, 'stored outbox pin'),
    retryCursor: state(pins.retryCursor, 'stored retry pin'),
    replayTombstone: state(pins.replayTombstone, 'stored replay pin'),
    dependentWork: state(pins.dependentWork, 'stored dependency pin'),
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  return requireBytesRange(value, length, length, name)
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

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  return result
}

function compareHex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!
  return difference === 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false)
}

function uint32Bytes(value: number): Uint8Array {
  const result = new Uint8Array(4)
  writeUint32(result, 0, value)
  return result
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer
}

function base64Decode(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const text = atob(padded)
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

function base64Encode(value: Uint8Array): string {
  let text = ''
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text)
}
