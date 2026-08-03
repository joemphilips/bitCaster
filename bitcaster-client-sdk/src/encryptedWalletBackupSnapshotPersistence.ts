import { decode } from 'cborg'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import {
  authenticatePreparedEncryptedWalletBackupSources,
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  readAuthenticatedPreparedEncryptedWalletBackupSource,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupPreparedRecordPersistence.ts'
import { ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD } from './encryptedWalletBackupRecord.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  requireEncryptedWalletBackupFrozenSnapshotControl,
  type EncryptedWalletBackupFrozenSnapshotControl,
} from './encryptedWalletBackupSnapshotAuthority.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'
import type { EncryptedWalletBackupKeyHandle } from './encryptedWalletBackup.ts'

export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES = 1_048_576 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_PROOF_APPEND_MAX = 127 as const

export interface PersistedEncryptedWalletBackupFrozenSnapshot {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly parentGeneration: number | null
  readonly parentManifestDigest: string | null
  readonly parentReferenceSetDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly version: number
}

export interface PersistedEncryptedWalletBackupSnapshotPin {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordKindCode: 0
  readonly recordId: string
  readonly commitment: string
  readonly sourceBodyReference: string
  readonly sourceRevision: number
}

export interface EncryptedWalletBackupSnapshotSourceIdentity {
  readonly realm: string
  readonly vaultId: string
  readonly recordKindCode: 0
  readonly recordId: string
  readonly commitment: string
  readonly bodyReference: string
  readonly revision: number
}

export interface EncryptedWalletBackupSnapshotPinIdentity {
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordKindCode: 0
  readonly recordId: string
  readonly commitment: string
}

export interface EncryptedWalletBackupSnapshotSourcePinBinding {
  readonly source: EncryptedWalletBackupSnapshotSourceIdentity
  readonly pin: EncryptedWalletBackupSnapshotPinIdentity
}

export interface EncryptedWalletBackupSnapshotPersistenceTransaction {
  readSnapshotControl(scope: Uint8Array): Promise<Uint8Array | null>
  insertSnapshotControl(control: Uint8Array): Promise<void>
  writeSnapshotControl(control: Uint8Array): Promise<void>
  /**
   * Re-read every source descriptor in this transaction immediately before
   * pin insertion. Use `validateEncryptedWalletBackupSnapshotSourcePinBinding`.
   * Reject a changed source. Block deletion by its returned `source` identity
   * while a matching pin exists. Insert every pin atomically.
   */
  insertSnapshotPins(
    input: Readonly<{
      readonly sourceDescriptors: readonly Uint8Array[]
      readonly pins: readonly Uint8Array[]
    }>,
  ): Promise<void>
}

export interface EncryptedWalletBackupSnapshotPersistenceStore {
  /**
   * Scope every control and pin by `(realm,vaultId,snapshotId,snapshotRevision)`.
   * Enforce pin uniqueness by that scope plus `(kind,recordId,commitment)`.
   * Reserve every declared application row and byte before any buffer copy.
   */
  withExactVersionTransaction<T>(
    expected: Readonly<{
      readonly scope: Uint8Array
      readonly expectedVersion: number
      readonly reservedReadRows: number
      readonly reservedReadBytes: number
      readonly reservedWriteRows: number
      readonly reservedWriteBytes: number
    }>,
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
  ): Promise<unknown>
}

export async function beginEncryptedWalletBackupFrozenSnapshot(input: {
  readonly store: EncryptedWalletBackupSnapshotPersistenceStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  return appendExactSnapshotPage({ ...input, expectedVersion: 0, sources: [] })
}

export async function appendEncryptedWalletBackupFrozenSnapshotProofPage(input: {
  readonly store: EncryptedWalletBackupSnapshotPersistenceStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly expectedVersion: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly preparedRecords: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly preparedSnapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  if (
    !Array.isArray(input.preparedRecords) ||
    input.preparedRecords.length < 1 ||
    input.preparedRecords.length > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_PROOF_APPEND_MAX
  ) {
    throw new Error('backup snapshot proof page exceeds its capacity')
  }
  const sources = await authenticatePreparedEncryptedWalletBackupSources({
    keyHandle: input.keyHandle,
    seed: input.seed,
    persisted: input.preparedRecords,
    snapshotStore: input.preparedSnapshotStore,
  })
  return appendExactSnapshotPage({
    store: input.store,
    control: input.control,
    expectedVersion: input.expectedVersion,
    sources: sources.map(readAuthenticatedPreparedEncryptedWalletBackupSource),
  })
}

async function appendExactSnapshotPage(input: {
  readonly store: EncryptedWalletBackupSnapshotPersistenceStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly expectedVersion: number
  readonly sources: readonly Uint8Array[]
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const authority = requireEncryptedWalletBackupFrozenSnapshotControl(input.control)
  const expectedVersion = integer(input.expectedVersion, 'snapshot version')
  const snapshot = controlRow(authority, expectedVersion + 1)
  const pins = input.sources.map((source) => pinRow(authority, source))
  requireUniquePins(pins)
  const reservation = reserve(authority, expectedVersion, snapshot, input.sources, pins)
  return exactTransaction(input.store, reservation, async (transaction) => {
    const actualControl = await transaction.readSnapshotControl(reservation.scope)
    requireExactControl(actualControl, reservation.expectedControl)
    if (reservation.expectedControl === null)
      await transaction.insertSnapshotControl(reservation.control)
    else await transaction.writeSnapshotControl(reservation.control)
    await transaction.insertSnapshotPins({
      sourceDescriptors: reservation.sources,
      pins: reservation.pins,
    })
    return snapshot
  })
}

type Reservation = Readonly<{
  readonly scope: Uint8Array
  readonly expectedVersion: number
  readonly expectedControl: Uint8Array | null
  readonly control: Uint8Array
  readonly sources: readonly Uint8Array[]
  readonly pins: readonly Uint8Array[]
  readonly readRows: number
  readonly readBytes: number
  readonly writeRows: number
  readonly writeBytes: number
}>

function reserve(
  authority: ReturnType<typeof requireEncryptedWalletBackupFrozenSnapshotControl>,
  expectedVersion: number,
  snapshot: PersistedEncryptedWalletBackupFrozenSnapshot,
  sources: readonly Uint8Array[],
  pins: readonly PersistedEncryptedWalletBackupSnapshotPin[],
): Reservation {
  if (pins.length > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_PROOF_APPEND_MAX) {
    throw new Error('backup snapshot proof page exceeds its capacity')
  }
  const scope = encodeScope(authority)
  const expectedControl =
    expectedVersion === 0 ? null : encodeControl(controlRow(authority, expectedVersion))
  const control = encodeControl(snapshot)
  const exactSources = sources.map((source) => source.slice())
  const encodedPins = pins.map(encodePin)
  const reads = exactSources
  const writes = [control, ...encodedPins]
  const readBytes = scope.byteLength + (expectedControl?.byteLength ?? 0) + sum(reads)
  const writeBytes = sum(writes)
  if (reads.length + 1 + writes.length > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX) {
    throw new Error('backup snapshot transaction exceeds the aggregate row limit')
  }
  if (readBytes + writeBytes > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES) {
    throw new Error('backup snapshot transaction exceeds the aggregate byte limit')
  }
  return Object.freeze({
    scope,
    expectedVersion,
    expectedControl,
    control,
    sources: Object.freeze(exactSources),
    pins: Object.freeze(encodedPins),
    readRows: reads.length + 1,
    readBytes,
    writeRows: writes.length,
    writeBytes,
  })
}

function controlRow(
  authority: ReturnType<typeof requireEncryptedWalletBackupFrozenSnapshotControl>,
  version: number,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    realm: authority.realm,
    vaultId: authority.vaultId,
    enrollmentEpoch: authority.enrollmentEpoch,
    parentGeneration: authority.parentGeneration,
    parentManifestDigest: authority.parentManifestDigest,
    parentReferenceSetDigest: authority.parentReferenceSetDigest,
    generation: authority.generation,
    snapshotNonce: authority.snapshotNonce,
    snapshotId: authority.snapshotId,
    snapshotRevision: authority.snapshotRevision,
    version,
  })
}

function pinRow(
  authority: ReturnType<typeof requireEncryptedWalletBackupFrozenSnapshotControl>,
  sourceDescriptor: Uint8Array,
): PersistedEncryptedWalletBackupSnapshotPin {
  const source = decodeSource(sourceDescriptor)
  if (source.realm !== authority.realm || source.vaultId !== authority.vaultId) {
    throw new Error('backup snapshot source belongs to a foreign scope')
  }
  return Object.freeze({
    schemaVersion: 1,
    realm: authority.realm,
    vaultId: authority.vaultId,
    snapshotId: authority.snapshotId,
    snapshotRevision: authority.snapshotRevision,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD,
    recordId: source.recordId,
    commitment: source.commitment,
    sourceBodyReference: source.bodyReference,
    sourceRevision: source.revision,
  })
}

function requireUniquePins(pins: readonly PersistedEncryptedWalletBackupSnapshotPin[]): void {
  const seen = new Set<string>()
  for (const pin of pins) {
    const key = `${pin.recordId}:${pin.commitment}`
    if (seen.has(key)) throw new Error('backup snapshot pin is duplicated')
    seen.add(key)
  }
}

function exactTransaction<T>(
  store: EncryptedWalletBackupSnapshotPersistenceStore,
  reservation: Reservation,
  use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
): Promise<T> {
  if (!store || typeof store.withExactVersionTransaction !== 'function') {
    throw new Error('backup snapshot persistence store is invalid')
  }
  const sentinel = Object.freeze({ snapshot: true })
  let calls = 0
  let settled = false
  let result: T | undefined
  return store
    .withExactVersionTransaction(
      Object.freeze({
        scope: reservation.scope.slice(),
        expectedVersion: reservation.expectedVersion,
        reservedReadRows: reservation.readRows,
        reservedReadBytes: reservation.readBytes,
        reservedWriteRows: reservation.writeRows,
        reservedWriteBytes: reservation.writeBytes,
      }),
      async (transaction) => {
        if (settled || calls++ !== 0)
          throw new Error('backup snapshot transaction callback is invalid')
        result = await use(transaction)
        return sentinel
      },
    )
    .then((returned) => {
      if (calls !== 1 || returned !== sentinel)
        throw new Error('backup snapshot transaction callback is invalid')
      return result as T
    })
    .finally(() => {
      settled = true
    })
}

function encodeScope(
  authority: ReturnType<typeof requireEncryptedWalletBackupFrozenSnapshotControl>,
): Uint8Array {
  return encodeCanonical([
    1,
    authority.realm,
    hexBytes(authority.vaultId),
    authority.snapshotId,
    authority.snapshotRevision,
  ])
}

export function encodeEncryptedWalletBackupFrozenSnapshot(
  value: PersistedEncryptedWalletBackupFrozenSnapshot,
): Uint8Array {
  return encodeControl(value)
}

export function decodeEncryptedWalletBackupFrozenSnapshot(
  value: Uint8Array,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  const raw = canonicalArray(value, 'backup snapshot control')
  if (raw.length !== 13 || raw[0] !== 1 || raw[11] !== 0)
    throw new Error('backup snapshot control is invalid')
  const parentGeneration = raw[4] === null ? null : positive(raw[4], 'parent generation')
  const parentManifestDigest = raw[5] === null ? null : fingerprint(raw[5], 'parent manifest')
  const generation = positive(raw[7], 'snapshot generation')
  if (
    (parentGeneration === null &&
      (parentManifestDigest !== null ||
        generation !== 1 ||
        fingerprint(raw[6], 'parent reference set') !==
          ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST)) ||
    (parentGeneration !== null &&
      (parentManifestDigest === null || generation !== parentGeneration + 1))
  )
    throw new Error('backup snapshot control is invalid')
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(raw[1]),
    vaultId: fingerprint(raw[2], 'snapshot vault'),
    enrollmentEpoch: positive(raw[3], 'snapshot epoch'),
    parentGeneration,
    parentManifestDigest,
    parentReferenceSetDigest: fingerprint(raw[6], 'parent reference set'),
    generation,
    snapshotNonce: fingerprintBytes(raw[8], 16, 'snapshot nonce'),
    snapshotId: requireUtf8Text(raw[9], 128, 'snapshot id'),
    snapshotRevision: integer(raw[10], 'snapshot revision'),
    version: positive(raw[12], 'snapshot version'),
  })
}

function encodeControl(value: PersistedEncryptedWalletBackupFrozenSnapshot): Uint8Array {
  const control = requireControl(value)
  return encodeCanonical([
    1,
    control.realm,
    hexBytes(control.vaultId),
    control.enrollmentEpoch,
    control.parentGeneration,
    control.parentManifestDigest === null ? null : hexBytes(control.parentManifestDigest),
    hexBytes(control.parentReferenceSetDigest),
    control.generation,
    hexBytes(control.snapshotNonce),
    control.snapshotId,
    control.snapshotRevision,
    0,
    control.version,
  ])
}

function encodePin(value: PersistedEncryptedWalletBackupSnapshotPin): Uint8Array {
  const pin = requirePin(value)
  return encodeCanonical([
    1,
    pin.realm,
    hexBytes(pin.vaultId),
    pin.snapshotId,
    pin.snapshotRevision,
    0,
    hexBytes(pin.recordId),
    hexBytes(pin.commitment),
    hexBytes(pin.sourceBodyReference),
    pin.sourceRevision,
  ])
}

export function decodeEncryptedWalletBackupSnapshotPin(
  value: Uint8Array,
): PersistedEncryptedWalletBackupSnapshotPin {
  const raw = canonicalArray(value, 'backup snapshot pin')
  if (raw.length !== 10 || raw[0] !== 1 || raw[5] !== 0)
    throw new Error('backup snapshot pin is invalid')
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(raw[1]),
    vaultId: fingerprint(raw[2], 'pin vault'),
    snapshotId: requireUtf8Text(raw[3], 128, 'pin snapshot'),
    snapshotRevision: integer(raw[4], 'pin revision'),
    recordKindCode: 0,
    recordId: fingerprint(raw[6], 'pin record'),
    commitment: fingerprint(raw[7], 'pin commitment'),
    sourceBodyReference: fingerprint(raw[8], 'pin body reference'),
    sourceRevision: integer(raw[9], 'pin source revision'),
  })
}

export function encodeEncryptedWalletBackupSnapshotPin(
  value: PersistedEncryptedWalletBackupSnapshotPin,
): Uint8Array {
  return encodePin(value)
}

export function validateEncryptedWalletBackupSnapshotSourcePinBinding(
  input: Readonly<{
    readonly sourceDescriptor: Uint8Array
    readonly pin: Uint8Array
  }>,
): EncryptedWalletBackupSnapshotSourcePinBinding {
  const source = decodeEncryptedWalletBackupPreparedSourceDescriptor(input.sourceDescriptor)
  const pin = decodeEncryptedWalletBackupSnapshotPin(input.pin)
  if (
    source.realm !== pin.realm ||
    source.vaultId !== pin.vaultId ||
    source.recordKindCode !== pin.recordKindCode ||
    source.recordId !== pin.recordId ||
    source.commitment !== pin.commitment ||
    source.bodyReference !== pin.sourceBodyReference ||
    source.revision !== pin.sourceRevision
  )
    throw new Error('backup snapshot pin source binding is invalid')
  return Object.freeze({
    source: Object.freeze({
      realm: source.realm,
      vaultId: source.vaultId,
      recordKindCode: source.recordKindCode,
      recordId: source.recordId,
      commitment: source.commitment,
      bodyReference: source.bodyReference,
      revision: source.revision,
    }),
    pin: Object.freeze({
      realm: pin.realm,
      vaultId: pin.vaultId,
      snapshotId: pin.snapshotId,
      snapshotRevision: pin.snapshotRevision,
      recordKindCode: pin.recordKindCode,
      recordId: pin.recordId,
      commitment: pin.commitment,
    }),
  })
}

const decodeSource = decodeEncryptedWalletBackupPreparedSourceDescriptor

function requireControl(
  value: PersistedEncryptedWalletBackupFrozenSnapshot,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  const control = strictObject(value, controlFields, 'backup snapshot control')
  const parentGeneration =
    control.parentGeneration === null
      ? null
      : positive(control.parentGeneration, 'parent generation')
  const parentManifestDigest =
    control.parentManifestDigest === null
      ? null
      : hexBytesValue(control.parentManifestDigest, 32, 'parent manifest')
  const generation = positive(control.generation, 'snapshot generation')
  if (
    control.schemaVersion !== 1 ||
    (parentGeneration === null &&
      (parentManifestDigest !== null ||
        generation !== 1 ||
        control.parentReferenceSetDigest !== ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST)) ||
    (parentGeneration !== null &&
      (parentManifestDigest === null || generation !== parentGeneration + 1))
  )
    throw new Error('backup snapshot control is invalid')
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(control.realm),
    vaultId: hexBytesValue(control.vaultId, 32, 'snapshot vault'),
    enrollmentEpoch: positive(control.enrollmentEpoch, 'snapshot epoch'),
    parentGeneration,
    parentManifestDigest,
    parentReferenceSetDigest: hexBytesValue(
      control.parentReferenceSetDigest,
      32,
      'parent reference set',
    ),
    generation,
    snapshotNonce: hexBytesValue(control.snapshotNonce, 16, 'snapshot nonce'),
    snapshotId: requireUtf8Text(control.snapshotId, 128, 'snapshot id'),
    snapshotRevision: integer(control.snapshotRevision, 'snapshot revision'),
    version: positive(control.version, 'snapshot version'),
  })
}

function requirePin(
  value: PersistedEncryptedWalletBackupSnapshotPin,
): PersistedEncryptedWalletBackupSnapshotPin {
  const pin = strictObject(value, pinFields, 'backup snapshot pin')
  if (pin.schemaVersion !== 1 || pin.recordKindCode !== 0)
    throw new Error('backup snapshot pin is invalid')
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(pin.realm),
    vaultId: hexBytesValue(pin.vaultId, 32, 'pin vault'),
    snapshotId: requireUtf8Text(pin.snapshotId, 128, 'pin snapshot'),
    snapshotRevision: integer(pin.snapshotRevision, 'pin revision'),
    recordKindCode: 0,
    recordId: hexBytesValue(pin.recordId, 32, 'pin record'),
    commitment: hexBytesValue(pin.commitment, 32, 'pin commitment'),
    sourceBodyReference: hexBytesValue(pin.sourceBodyReference, 32, 'pin body reference'),
    sourceRevision: integer(pin.sourceRevision, 'pin source revision'),
  })
}

const controlFields = [
  'schemaVersion',
  'realm',
  'vaultId',
  'enrollmentEpoch',
  'parentGeneration',
  'parentManifestDigest',
  'parentReferenceSetDigest',
  'generation',
  'snapshotNonce',
  'snapshotId',
  'snapshotRevision',
  'version',
] as const

const pinFields = [
  'schemaVersion',
  'realm',
  'vaultId',
  'snapshotId',
  'snapshotRevision',
  'recordKindCode',
  'recordId',
  'commitment',
  'sourceBodyReference',
  'sourceRevision',
] as const

function strictObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function requireExactControl(actual: Uint8Array | null, expected: Uint8Array | null): void {
  if (!equalBytes(actual, expected)) throw new Error('backup snapshot control changed')
}

function canonicalArray(value: Uint8Array, name: string): readonly unknown[] {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 16_384)
    throw new Error(`${name} is invalid`)
  const raw = decode(value)
  if (!Array.isArray(raw) || !equalBytes(value, encodeCanonical(raw)))
    throw new Error(`${name} is invalid`)
  return raw
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`backup ${name} is invalid`)
  return value as number
}
function positive(value: unknown, name: string): number {
  const result = integer(value, name)
  if (result === 0) throw new Error(`backup ${name} is invalid`)
  return result
}
function fingerprint(value: unknown, name: string): string {
  return fingerprintBytes(value, 32, name)
}
function fingerprintBytes(value: unknown, size: number, name: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== size)
    throw new Error(`backup ${name} is invalid`)
  let result = ''
  for (const item of value) result += item.toString(16).padStart(2, '0')
  return result
}
function hexBytesValue(value: unknown, size: number, name: string): string {
  if (typeof value !== 'string' || value.length !== size * 2 || !/^[0-9a-f]+$/.test(value))
    throw new Error(`backup ${name} is invalid`)
  return value
}
function hexBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value))
    throw new Error('backup snapshot hex is invalid')
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return result
}
function sum(values: readonly Uint8Array[]): number {
  let total = 0
  for (const value of values) total += value.byteLength
  return total
}
function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false
  return true
}
