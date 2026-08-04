import { deriveDurableCustodyWalletId } from './durableCustody.ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupProof,
} from './encryptedWalletBackup.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import { measureFinalManifestEntryBytes } from './encryptedWalletBackupManifestPageAuthority.ts'
import {
  requireEncryptedWalletBackupKeyWalletId,
  requireIssuedEncryptedWalletBackupKeyHandle,
  signEncryptedWalletBackupPreparationCapability,
  verifyEncryptedWalletBackupPreparationCapability,
} from './encryptedWalletBackupKeyAuthority.ts'
import {
  rehydrateValidatedPreparedEncryptedWalletBackupRecord,
  validatePreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupPreparedRecordValidation.ts'
import {
  requirePreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupRecordKindCode,
  type PreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupRecord.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'

export interface PersistedPreparedEncryptedWalletBackupRecord {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordId: string
  readonly commitment: string
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
  readonly authenticationTag: Uint8Array
}

export interface EncryptedWalletBackupPreparedRecordSnapshot {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordId: string
  readonly commitment: string
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode
}

export interface EncryptedWalletBackupPreparedRecordSnapshotStore {
  withCommittedPreparedRecordSnapshot<T>(
    recordId: string,
    read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
    sourceDescriptor?: Uint8Array,
  ): Promise<T>
}

export const ENCRYPTED_WALLET_BACKUP_PREPARED_RECORD_SNAPSHOT_BATCH_MAX = 256 as const

export interface EncryptedWalletBackupPreparedRecordSnapshotBatchStore {
  /**
   * Invokes `read` exactly once while the returned Promise is pending. The
   * callback must return a non-thenable exact value for the ordered exact rows.
   */
  withCommittedPreparedRecordSnapshotBatch<T>(
    recordIds: readonly string[],
    read: (rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[]) => T,
    sourceDescriptors?: readonly Uint8Array[],
  ): Promise<T>
}

declare const authenticatedPreparedEncryptedWalletBackupSourceBrand: unique symbol

export interface AuthenticatedPreparedEncryptedWalletBackupSource {
  readonly [authenticatedPreparedEncryptedWalletBackupSourceBrand]: true
}

const AUTHENTICATED_SOURCES = new WeakMap<object, Uint8Array>()

export interface EncryptedWalletBackupPreparedSourceDescriptor {
  readonly realm: string
  readonly vaultId: string
  readonly bodyReference: string
  readonly revision: number
  readonly recordKindCode: 0
  readonly recordId: string
  readonly commitment: string
  readonly canonicalManifestEntryBytes: number
}

export function encodeEncryptedWalletBackupPreparedSourceDescriptor(
  value: PersistedPreparedEncryptedWalletBackupRecord,
): Uint8Array {
  const persisted = requirePersistedRecord(value)
  const descriptor = descriptorFromPersisted(persisted)
  return encodeCanonical([
    1,
    'prepared-proof-source',
    descriptor.realm,
    hexBytes(descriptor.vaultId),
    hexBytes(descriptor.bodyReference),
    descriptor.revision,
    descriptor.recordKindCode,
    hexBytes(descriptor.recordId),
    hexBytes(descriptor.commitment),
    descriptor.canonicalManifestEntryBytes,
  ])
}

export function decodeEncryptedWalletBackupPreparedSourceDescriptor(
  value: Uint8Array,
): EncryptedWalletBackupPreparedSourceDescriptor {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 1_024) {
    throw new Error('prepared backup source descriptor is invalid')
  }
  const decoded = decode(value)
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 10 ||
    !equalBytes(value, encodeCanonical(decoded))
  ) {
    throw new Error('prepared backup source descriptor is invalid')
  }
  if (decoded[0] !== 1 || decoded[1] !== 'prepared-proof-source' || decoded[6] !== 0) {
    throw new Error('prepared backup source descriptor is invalid')
  }
  return Object.freeze({
    realm: requireRealm(decoded[2]),
    vaultId: bytesFingerprint(decoded[3], 'source vault id'),
    bodyReference: bytesFingerprint(decoded[4], 'source body reference'),
    revision: requireInteger(decoded[5], 'source revision'),
    recordKindCode: 0,
    recordId: bytesFingerprint(decoded[7], 'source record id'),
    commitment: bytesFingerprint(decoded[8], 'source commitment'),
    canonicalManifestEntryBytes: requireManifestEntryBytes(decoded[9]),
  })
}

export async function authenticatePreparedEncryptedWalletBackupSources(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly persisted: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
}): Promise<readonly AuthenticatedPreparedEncryptedWalletBackupSource[]> {
  const candidates = await authenticatePreparedRecordBatch(input)
  return Object.freeze(candidates.map((candidate) => issueAuthenticatedSource(candidate)))
}

export function readAuthenticatedPreparedEncryptedWalletBackupSource(
  value: AuthenticatedPreparedEncryptedWalletBackupSource,
): Uint8Array {
  const descriptor =
    typeof value === 'object' && value !== null ? AUTHENTICATED_SOURCES.get(value) : undefined
  if (descriptor === undefined) throw new Error('authenticated prepared backup source is invalid')
  return descriptor.slice()
}

export async function sealPreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly record: PreparedEncryptedWalletBackupRecord
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore
}): Promise<PersistedPreparedEncryptedWalletBackupRecord> {
  const keyHandle = requireMatchingKeyHandle(input.keyHandle, input.seed)
  const authority = requirePreparedEncryptedWalletBackupRecord(input.record)
  if (authority.keyHandle !== keyHandle) {
    throw new Error('prepared backup record belongs to a foreign key')
  }
  const candidate = candidateFromAuthority(keyHandle, authority)
  validateCandidate(candidate, keyHandle, input.seed)
  await requireCommittedSnapshot(input.snapshotStore, snapshotOf(candidate))
  const authenticationTag = await signEncryptedWalletBackupPreparationCapability(
    keyHandle,
    capabilityPayload(candidate),
  )
  return Object.freeze({ ...candidate, authenticationTag })
}

export async function rehydratePreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly persisted: PersistedPreparedEncryptedWalletBackupRecord
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore
}): Promise<PreparedEncryptedWalletBackupProof> {
  const keyHandle = requireMatchingKeyHandle(input.keyHandle, input.seed)
  const persisted = requirePersistedRecord(input.persisted)
  requireKeyBinding(keyHandle, persisted)
  await verifyEncryptedWalletBackupPreparationCapability(
    keyHandle,
    capabilityPayload(persisted),
    persisted.authenticationTag,
  )
  validateCandidate(persisted, keyHandle, input.seed)
  await requireCommittedSnapshot(
    input.snapshotStore,
    snapshotOf(persisted),
    encodeEncryptedWalletBackupPreparedSourceDescriptor(persisted),
  )
  return rehydrateValidatedPreparedEncryptedWalletBackupRecord({
    keyHandle,
    seed: input.seed,
    canonicalRecord: persisted.canonicalRecord,
    canonicalManifestEntry: persisted.canonicalManifestEntry,
    snapshotId: persisted.snapshotId,
    snapshotRevision: persisted.snapshotRevision,
  })
}

export async function rehydratePreparedEncryptedWalletBackupRecordBatch(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly persisted: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
}): Promise<readonly PreparedEncryptedWalletBackupProof[]> {
  const persisted = await authenticatePreparedRecordBatch(input)
  return Object.freeze(
    persisted.map((record) =>
      rehydrateValidatedPreparedEncryptedWalletBackupRecord({
        keyHandle: input.keyHandle,
        seed: input.seed,
        canonicalRecord: record.canonicalRecord,
        canonicalManifestEntry: record.canonicalManifestEntry,
        snapshotId: record.snapshotId,
        snapshotRevision: record.snapshotRevision,
      }),
    ),
  )
}

async function authenticatePreparedRecordBatch(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly persisted: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
}): Promise<readonly PersistedPreparedEncryptedWalletBackupRecord[]> {
  if (
    !Array.isArray(input.persisted) ||
    input.persisted.length < 1 ||
    input.persisted.length > ENCRYPTED_WALLET_BACKUP_PREPARED_RECORD_SNAPSHOT_BATCH_MAX
  )
    throw new Error('prepared backup snapshot batch count is invalid')
  const keyHandle = requireMatchingKeyHandle(input.keyHandle, input.seed)
  const persisted = await Promise.all(
    input.persisted.map(async (raw) => {
      const exact = requirePersistedRecord(raw)
      requireKeyBinding(keyHandle, exact)
      await verifyEncryptedWalletBackupPreparationCapability(
        keyHandle,
        capabilityPayload(exact),
        exact.authenticationTag,
      )
      validateCandidate(exact, keyHandle, input.seed)
      return exact
    }),
  )
  await requireCommittedSnapshotBatch(
    input.snapshotStore,
    persisted.map(snapshotOf),
    persisted.map(encodeEncryptedWalletBackupPreparedSourceDescriptor),
  )
  return Object.freeze(persisted)
}

type CapabilityCandidate = Omit<PersistedPreparedEncryptedWalletBackupRecord, 'authenticationTag'>

function candidateFromAuthority(
  keyHandle: EncryptedWalletBackupKeyHandle,
  authority: ReturnType<typeof requirePreparedEncryptedWalletBackupRecord>,
): CapabilityCandidate {
  return Object.freeze({
    schemaVersion: 1,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    snapshotId: requireUtf8Text(authority.snapshotId, 128, 'snapshot id'),
    snapshotRevision: requireInteger(authority.snapshotRevision, 'snapshot revision'),
    recordId: requireFingerprint(authority.recordId, 'record id'),
    commitment: requireFingerprint(authority.commitment, 'record commitment'),
    recordKindCode: requireRecordKind(authority.recordKindCode),
    canonicalRecord: requireBytesRange(
      authority.canonicalRecord,
      1,
      ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
      'canonical record',
    ),
    canonicalManifestEntry: requireBytesRange(
      authority.canonicalManifestEntry,
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
      'canonical manifest entry',
    ),
  })
}

function validateCandidate(
  candidate: CapabilityCandidate,
  keyHandle: EncryptedWalletBackupKeyHandle,
  seed: Uint8Array,
): void {
  const validated = validatePreparedEncryptedWalletBackupRecord({
    keyHandle,
    seed,
    canonicalRecord: candidate.canonicalRecord,
    canonicalManifestEntry: candidate.canonicalManifestEntry,
  })
  if (
    validated.recordId !== candidate.recordId ||
    validated.commitment !== candidate.commitment ||
    validated.recordKindCode !== candidate.recordKindCode
  ) {
    throw new Error('prepared backup record authority changed')
  }
}

function requirePersistedRecord(
  value: PersistedPreparedEncryptedWalletBackupRecord,
): PersistedPreparedEncryptedWalletBackupRecord {
  const record = requireStrictRecord(value)
  const candidate = candidateFromPersistedRecord(record)
  const authenticationTag = requireBytes(record.authenticationTag, 32, 'authentication tag')
  return Object.freeze({ ...candidate, authenticationTag })
}

function candidateFromPersistedRecord(record: Record<string, unknown>): CapabilityCandidate {
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(record.realm),
    vaultId: requireFingerprint(record.vaultId, 'vault id'),
    snapshotId: requireUtf8Text(record.snapshotId, 128, 'snapshot id'),
    snapshotRevision: requireInteger(record.snapshotRevision, 'snapshot revision'),
    recordId: requireFingerprint(record.recordId, 'record id'),
    commitment: requireFingerprint(record.commitment, 'record commitment'),
    recordKindCode: requireRecordKind(record.recordKindCode),
    canonicalRecord: requireBytesRange(
      record.canonicalRecord,
      1,
      ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
      'canonical record',
    ),
    canonicalManifestEntry: requireBytesRange(
      record.canonicalManifestEntry,
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
      'canonical manifest entry',
    ),
  })
}

function requireStrictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('persisted prepared backup record is invalid')
  }
  const record = value as Record<string, unknown>
  const fields = [
    'schemaVersion',
    'realm',
    'vaultId',
    'snapshotId',
    'snapshotRevision',
    'recordId',
    'commitment',
    'recordKindCode',
    'canonicalRecord',
    'canonicalManifestEntry',
    'authenticationTag',
  ]
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !(field in record))
  ) {
    throw new Error('persisted prepared backup record is invalid')
  }
  return record
}

function capabilityPayload(value: CapabilityCandidate): Uint8Array {
  return encodeCanonical([
    1,
    'prepared-record-capability',
    value.realm,
    hexBytes(value.vaultId),
    value.snapshotId,
    value.snapshotRevision,
    hexBytes(value.recordId),
    hexBytes(value.commitment),
    value.recordKindCode,
    value.canonicalRecord,
    value.canonicalManifestEntry,
  ])
}

function issueAuthenticatedSource(
  value: PersistedPreparedEncryptedWalletBackupRecord,
): AuthenticatedPreparedEncryptedWalletBackupSource {
  const descriptor = encodeEncryptedWalletBackupPreparedSourceDescriptor(value)
  const handle = Object.freeze({})
  AUTHENTICATED_SOURCES.set(handle, descriptor)
  return handle as AuthenticatedPreparedEncryptedWalletBackupSource
}

function descriptorFromPersisted(
  value: PersistedPreparedEncryptedWalletBackupRecord,
): EncryptedWalletBackupPreparedSourceDescriptor {
  const bodyReference = bytesToHex(
    sha256(
      encodeCanonical([
        1,
        'prepared-proof-body',
        value.realm,
        hexBytes(value.vaultId),
        value.snapshotId,
        value.snapshotRevision,
        hexBytes(value.recordId),
        hexBytes(value.commitment),
        value.recordKindCode,
        value.canonicalRecord,
        value.canonicalManifestEntry,
        value.authenticationTag,
      ]),
    ),
  )
  return Object.freeze({
    realm: value.realm,
    vaultId: value.vaultId,
    bodyReference,
    revision: value.snapshotRevision,
    recordKindCode: 0,
    recordId: value.recordId,
    commitment: value.commitment,
    canonicalManifestEntryBytes: measureFinalManifestEntryBytes(value.canonicalManifestEntry),
  })
}

function snapshotOf(value: CapabilityCandidate): EncryptedWalletBackupPreparedRecordSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    recordId: value.recordId,
    commitment: value.commitment,
    recordKindCode: value.recordKindCode,
  })
}

async function requireCommittedSnapshot(
  store: EncryptedWalletBackupPreparedRecordSnapshotStore,
  expected: EncryptedWalletBackupPreparedRecordSnapshot,
  sourceDescriptor?: Uint8Array,
): Promise<void> {
  if (!store || typeof store.withCommittedPreparedRecordSnapshot !== 'function') {
    throw new Error('prepared backup snapshot store is invalid')
  }
  const sentinel = Object.freeze({ committed: true })
  let calls = 0
  let open = true
  let returned: unknown
  try {
    returned = await store.withCommittedPreparedRecordSnapshot(
      expected.recordId,
      (raw) => {
        if (!open || calls++ !== 0) throw new Error('prepared backup snapshot callback is invalid')
        requireExactSnapshot(expected, raw)
        return sentinel
      },
      sourceDescriptor,
    )
  } finally {
    open = false
  }
  if (calls !== 1 || returned !== sentinel) {
    throw new Error(
      'prepared backup snapshot callback must run before settlement and return exactly',
    )
  }
}

async function requireCommittedSnapshotBatch(
  store: EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  expected: readonly EncryptedWalletBackupPreparedRecordSnapshot[],
  sourceDescriptors?: readonly Uint8Array[],
): Promise<void> {
  if (!store || typeof store.withCommittedPreparedRecordSnapshotBatch !== 'function')
    throw new Error('prepared backup snapshot batch store is invalid')
  const recordIds = Object.freeze(expected.map(({ recordId }) => recordId))
  const sentinel = Object.freeze({ committed: true })
  let calls = 0
  let open = true
  let returned: unknown
  try {
    returned = await store.withCommittedPreparedRecordSnapshotBatch(
      recordIds,
      (rows) => {
        if (!open || calls++ !== 0)
          throw new Error('prepared backup snapshot batch callback is invalid')
        if (!Array.isArray(rows) || rows.length !== expected.length)
          throw new Error('committed prepared backup snapshot batch changed')
        for (let index = 0; index < expected.length; index += 1)
          requireExactSnapshot(expected[index]!, rows[index]!)
        return sentinel
      },
      sourceDescriptors,
    )
  } finally {
    open = false
  }
  if (calls !== 1 || returned !== sentinel)
    throw new Error(
      'prepared backup snapshot batch callback must run before settlement and return exactly',
    )
}

function requireExactSnapshot(
  expected: EncryptedWalletBackupPreparedRecordSnapshot,
  actual: EncryptedWalletBackupPreparedRecordSnapshot,
): void {
  const snapshot = requireStrictSnapshot(actual)
  if (
    snapshot.snapshotId !== expected.snapshotId ||
    snapshot.snapshotRevision !== expected.snapshotRevision ||
    snapshot.recordId !== expected.recordId ||
    snapshot.commitment !== expected.commitment ||
    snapshot.recordKindCode !== expected.recordKindCode
  ) {
    throw new Error('committed prepared backup snapshot changed')
  }
}

function requireStrictSnapshot(value: unknown): EncryptedWalletBackupPreparedRecordSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('committed prepared backup snapshot is invalid')
  }
  const record = value as Record<string, unknown>
  const fields = [
    'schemaVersion',
    'snapshotId',
    'snapshotRevision',
    'recordId',
    'commitment',
    'recordKindCode',
  ]
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !(field in record))
  ) {
    throw new Error('committed prepared backup snapshot is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: requireUtf8Text(record.snapshotId, 128, 'snapshot id'),
    snapshotRevision: requireInteger(record.snapshotRevision, 'snapshot revision'),
    recordId: requireFingerprint(record.recordId, 'record id'),
    commitment: requireFingerprint(record.commitment, 'record commitment'),
    recordKindCode: requireRecordKind(record.recordKindCode),
  })
}

function requireMatchingKeyHandle(
  value: EncryptedWalletBackupKeyHandle,
  seed: Uint8Array,
): EncryptedWalletBackupKeyHandle {
  const handle = requireIssuedEncryptedWalletBackupKeyHandle(value)
  if (
    !(seed instanceof Uint8Array) ||
    seed.byteLength !== 64 ||
    requireEncryptedWalletBackupKeyWalletId(handle) !== deriveDurableCustodyWalletId(seed)
  ) {
    throw new Error('backup key handle does not match the seed')
  }
  return handle
}

function requireKeyBinding(
  keyHandle: EncryptedWalletBackupKeyHandle,
  persisted: PersistedPreparedEncryptedWalletBackupRecord,
): void {
  if (persisted.realm !== keyHandle.realm || persisted.vaultId !== keyHandle.vaultId) {
    throw new Error('persisted prepared backup record belongs to a foreign vault')
  }
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`prepared backup ${name} is invalid`)
  }
  return value as number
}
function requireManifestEntryBytes(value: unknown): number {
  const result = requireInteger(value, 'manifest entry bytes')
  if (result < 1 || result > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES)
    throw new Error('prepared backup manifest entry bytes is invalid')
  return result
}

function requireFingerprint(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`prepared backup ${name} is invalid`)
  }
  return value
}

function requireRecordKind(value: unknown): EncryptedWalletBackupRecordKindCode {
  if (value !== 0) {
    throw new Error('prepared backup record kind is invalid')
  }
  return value
}

function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`prepared backup ${name} is invalid`)
  }
  return value.slice()
}

function requireBytesRange(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`prepared backup ${name} is invalid`)
  }
  return value.slice()
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

function bytesFingerprint(value: unknown, name: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`prepared backup ${name} is invalid`)
  }
  return bytesToHex(value)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
