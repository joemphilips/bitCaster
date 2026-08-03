import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
  ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX,
  packEncryptedWalletBackupProofChunk,
  prepareEncryptedWalletBackupObject,
  readPreparedEncryptedWalletBackupObject,
  rehydratePreparedEncryptedWalletBackupProofObject,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRuntime,
  type PreparedEncryptedWalletBackupProofChunk,
  type PreparedEncryptedWalletBackupObject,
} from './encryptedWalletBackup.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import {
  rehydratePreparedEncryptedWalletBackupRecordBatch,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupPreparedRecordPersistence.ts'

export const ENCRYPTED_WALLET_BACKUP_PACK_APPEND_RECORD_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_PACK_READ_RECORD_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES = 1_048_576 as const
export const ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES = 900_000 as const

interface EncryptedWalletBackupPackScope {
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
}

export interface PersistedEncryptedWalletBackupBuildCursor {
  readonly schemaVersion: 1
  readonly buildId: string
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly version: number
  readonly nextRecordOrdinal: number
  readonly openPackId: string | null
}

export interface PersistedEncryptedWalletBackupPackControl {
  readonly schemaVersion: 1
  readonly buildId: string
  readonly packId: string
  readonly realm: string
  readonly vaultId: string
  readonly version: number
  readonly state: 'open' | 'frozen' | 'staged'
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordCount: number
  /** Sum of the exact canonical record items, excluding chunk array framing. */
  readonly recordCanonicalBytes: number
  /** Exact canonical persisted prepared-row plus binding-row bytes. */
  readonly persistedRowBytes: number
  readonly lastRecordId: string | null
  readonly canonicalBytes: number | null
  readonly membershipDigest: string | null
  readonly stagedObjectId: string | null
  readonly stagedObjectDigest: string | null
}

export interface PersistedEncryptedWalletBackupPreparedBuildRecord {
  readonly schemaVersion: 1
  readonly buildId: string
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordId: string
  readonly prepared: PersistedPreparedEncryptedWalletBackupRecord
}

export interface PersistedEncryptedWalletBackupPackBinding {
  readonly schemaVersion: 1
  readonly buildId: string
  readonly packId: string
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordId: string
  readonly ordinal: number
}

export interface PersistedEncryptedWalletBackupStagedObject {
  readonly schemaVersion: 1
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly formatVersion: 1
  readonly kindCode: 1
  readonly realm: string
  readonly vaultId: string
  readonly objectId: string
  readonly generation: number
  readonly paddedLength: 262_144
  readonly digest: string
  readonly aad: Uint8Array
  readonly body: Uint8Array
}

export interface EncryptedWalletBackupPackRecordPageRow {
  readonly binding: PersistedEncryptedWalletBackupPackBinding
  readonly prepared: PersistedEncryptedWalletBackupPreparedBuildRecord
}

export interface EncryptedWalletBackupPackSerializedPageRow {
  readonly binding: Uint8Array
  readonly prepared: Uint8Array
}

export interface EncryptedWalletBackupPackSerializedPage {
  readonly rows: readonly EncryptedWalletBackupPackSerializedPageRow[]
  /** Exact sum of the canonical persisted row bytes returned in `rows`. */
  readonly serializedBytes: number
}

export interface EncryptedWalletBackupPackPersistenceTransaction {
  readBuildCursor(buildId: string): Promise<PersistedEncryptedWalletBackupBuildCursor | null>
  readPackControl(
    buildId: string,
    packId: string,
  ): Promise<PersistedEncryptedWalletBackupPackControl | null>
  readPackRecordPage(
    buildId: string,
    packId: string,
    afterRecordId: string | null,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupPackSerializedPage>
  readStagedObject(
    buildId: string,
    packId: string,
  ): Promise<PersistedEncryptedWalletBackupStagedObject | null>
  insertPreparedRecord(row: PersistedEncryptedWalletBackupPreparedBuildRecord): Promise<void>
  insertPackBinding(row: PersistedEncryptedWalletBackupPackBinding): Promise<void>
  writeBuildCursor(row: PersistedEncryptedWalletBackupBuildCursor): Promise<void>
  writePackControl(row: PersistedEncryptedWalletBackupPackControl): Promise<void>
  insertStagedObject(row: PersistedEncryptedWalletBackupStagedObject): Promise<void>
}

export interface EncryptedWalletBackupPackPersistenceStore {
  /**
   * Runs one physical exact-version CAS transaction. The adapter enforces the
   * normalized unique keys `(buildId, recordId)` and
   * `(buildId, packId, recordId)`. A thrown callback must atomically roll back
   * every insert and control-row write. It invokes `use` exactly once and
   * returns its exact value after the transaction commits; it must not commit
   * a substituted value.
   * `readPackRecordPage` performs a keyset read of the canonical persisted row
   * bytes and stops before `maxBytes`; it must not materialize a larger
   * structured page and trim it afterward.
   */
  withExactVersionTransaction<T>(
    expected: Readonly<{
      buildId: string
      buildVersion: number
      packId: string
      packVersion: number
      realm: string
      vaultId: string
      snapshotId: string
      snapshotRevision: number
    }>,
    use: (transaction: EncryptedWalletBackupPackPersistenceTransaction) => Promise<T>,
  ): Promise<unknown>
}

export interface PreparedEncryptedWalletBackupPackObject {
  readonly buildId: string
  readonly packId: string
  readonly chunk: PreparedEncryptedWalletBackupProofChunk
  readonly object: PreparedEncryptedWalletBackupObject
  readonly pageReadCount: number
}

export interface FrozenEncryptedWalletBackupPack {
  readonly buildId: string
  readonly packId: string
  readonly recordCount: number
  readonly canonicalBytes: number
  readonly membershipDigest: string
}

interface FrozenPackAuthority extends PreparedPackObjectAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly chunk: PreparedEncryptedWalletBackupProofChunk
  readonly pageReadCount: number
}

const frozenPackAuthorities = new WeakMap<object, FrozenPackAuthority>()

interface PreparedPackObjectAuthority {
  readonly buildId: string
  readonly packId: string
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly recordCount: number
  readonly canonicalBytes: number
  readonly membershipDigest: string
}

const preparedPackObjectAuthorities = new WeakMap<object, PreparedPackObjectAuthority>()

export function measureEncryptedWalletBackupPackTransaction(input: {
  readonly readRows: readonly Uint8Array[]
  readonly writtenRows: readonly Uint8Array[]
}): number {
  if (!Array.isArray(input.readRows) || !Array.isArray(input.writtenRows))
    throw new Error('backup pack transaction rows are invalid')
  let total = 0
  for (const row of [...input.readRows, ...input.writtenRows]) {
    if (!(row instanceof Uint8Array)) throw new Error('backup pack transaction row is invalid')
    total += row.byteLength
    if (total > ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES)
      throw new Error('backup pack transaction exceeds the aggregate serialized byte limit')
  }
  return total
}

type ExactVersionExpectation = Readonly<{
  buildId: string
  buildVersion: number
  packId: string
  packVersion: number
  realm: string
  vaultId: string
  snapshotId: string
  snapshotRevision: number
}>

async function exactVersionTransaction<T>(
  store: EncryptedWalletBackupPackPersistenceStore,
  expected: ExactVersionExpectation,
  use: (transaction: EncryptedWalletBackupPackPersistenceTransaction) => Promise<T>,
): Promise<T> {
  if (!store || typeof store.withExactVersionTransaction !== 'function')
    throw new Error('backup pack persistence store is invalid')
  const sentinel = Object.freeze({ exactPackCommit: true })
  let calls = 0
  let storeResolved = false
  let value: T | undefined
  const pending = store.withExactVersionTransaction(expected, async (transaction) => {
    if (storeResolved || calls++ !== 0)
      throw new Error('backup pack transaction callback is invalid')
    value = await use(transaction)
    return sentinel
  })
  const returned = await pending
  storeResolved = true
  if (calls !== 1 || returned !== sentinel)
    throw new Error('backup pack transaction callback must be exact')
  return value as T
}

export async function appendEncryptedWalletBackupPreparedRecordPage(input: {
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
  readonly records: readonly PersistedPreparedEncryptedWalletBackupRecord[]
}): Promise<
  Readonly<{
    buildCursor: PersistedEncryptedWalletBackupBuildCursor
    packControl: PersistedEncryptedWalletBackupPackControl
    transactionBytes: number
  }>
> {
  const buildId = requireIdentifier(input.buildId, 'build id')
  const packId = requireIdentifier(input.packId, 'pack id')
  const expectedBuildVersion = requireVersion(input.expectedBuildVersion, 'build version')
  const expectedPackVersion = requireVersion(input.expectedPackVersion, 'pack version')
  if (
    !Array.isArray(input.records) ||
    input.records.length === 0 ||
    input.records.length > ENCRYPTED_WALLET_BACKUP_PACK_APPEND_RECORD_MAX
  )
    throw new Error('backup pack append record count is invalid')

  const records = await rehydrateAppendRecords(input)
  requireStrictlyIncreasingRecordIds(records.map((row) => row.recordId))
  requireOneSnapshot(records)
  const scope = requireRecordScope(records[0]!.prepared, input)
  return exactVersionTransaction(
    input.store,
    expectation({
      ...input,
      ...scope,
      buildId,
      packId,
      expectedBuildVersion,
      expectedPackVersion,
    }),
    (transaction) =>
      commitAppend(transaction, {
        buildId,
        packId,
        ...scope,
        expectedBuildVersion,
        expectedPackVersion,
        records,
      }),
  )
}

export async function freezeEncryptedWalletBackupPack(input: {
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
}): Promise<
  Readonly<{
    buildCursor: PersistedEncryptedWalletBackupBuildCursor
    packControl: PersistedEncryptedWalletBackupPackControl
    pageReadCount: number
    transactionBytes: number
    frozenPack: FrozenEncryptedWalletBackupPack
  }>
> {
  const candidate = await readAndValidatePack({
    ...input,
    requiredState: 'open',
  })
  const chunk = packEncryptedWalletBackupProofChunk(candidate.records)
  const seal = computePackSeal(candidate.rows)
  const result = await exactVersionTransaction(
    input.store,
    expectation(input),
    async (rawTransaction) => {
      const transaction = new AccountedTransaction(rawTransaction)
      const build = requireExistingBuild(await transaction.readBuildCursor(input.buildId), input)
      requireOpenBuild(build, input.packId)
      const pack = requireExistingPack(
        await transaction.readPackControl(input.buildId, input.packId),
        input,
        'open',
      )
      if (pack.recordCount !== seal.recordCount) throw new Error('backup frozen pack count changed')
      const nextBuild = Object.freeze({
        ...build,
        version: input.expectedBuildVersion + 1,
        openPackId: null,
      })
      const nextPack = Object.freeze({
        ...pack,
        version: input.expectedPackVersion + 1,
        state: 'frozen' as const,
        canonicalBytes: seal.canonicalBytes,
        membershipDigest: seal.membershipDigest,
      })
      await transaction.writeBuildCursor(nextBuild)
      await transaction.writePackControl(nextPack)
      return {
        buildCursor: nextBuild,
        packControl: nextPack,
        transactionBytes: transaction.totalBytes,
      }
    },
  )
  const frozenPack = issueFrozenPack(input, chunk, seal, candidate.pageReadCount)
  return Object.freeze({
    ...result,
    pageReadCount: candidate.pageReadCount,
    frozenPack,
  })
}

export async function prepareEncryptedWalletBackupFrozenPackObjectImmediately(input: {
  readonly frozenPack: FrozenEncryptedWalletBackupPack
  readonly generation: number
  readonly runtime?: EncryptedWalletBackupRuntime
  readonly objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupPackObject> {
  const authority = frozenPackAuthorities.get(input.frozenPack)
  if (authority === undefined) throw new Error('frozen backup pack authority is invalid')
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle: authority.keyHandle,
    chunk: authority.chunk,
    generation: input.generation,
    runtime: input.runtime,
    objectIdExists: input.objectIdExists,
  })
  return issuePreparedPackObjectFromAuthority(authority, object)
}

export async function prepareEncryptedWalletBackupFrozenPackObject(input: {
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
  readonly generation: number
  readonly runtime?: EncryptedWalletBackupRuntime
  readonly objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupPackObject> {
  const candidate = await readAndValidatePack({
    ...input,
    requiredState: 'frozen',
  })
  const seal = computePackSeal(candidate.rows)
  requireFrozenSeal(candidate.pack, seal)
  const chunk = packEncryptedWalletBackupProofChunk(candidate.records)
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle: input.keyHandle,
    chunk,
    generation: input.generation,
    runtime: input.runtime,
    objectIdExists: input.objectIdExists,
  })
  return issuePreparedPackObject(input, chunk, object, seal, candidate.pageReadCount)
}

export async function rehydrateEncryptedWalletBackupStagedPackObject(input: {
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
}): Promise<PreparedEncryptedWalletBackupPackObject> {
  const candidate = await readAndValidatePack({
    ...input,
    requiredState: 'staged',
  })
  const seal = computePackSeal(candidate.rows)
  requireFrozenSeal(candidate.pack, seal)
  const chunk = packEncryptedWalletBackupProofChunk(candidate.records)
  const staged = await readExactStagedObject(input, seal)
  const object = await rehydratePreparedEncryptedWalletBackupProofObject({
    keyHandle: input.keyHandle,
    seed: input.seed,
    chunk,
    object: wireObject(staged),
  })
  return issuePreparedPackObject(input, chunk, object, seal, candidate.pageReadCount)
}

export async function stageEncryptedWalletBackupPackObject(input: {
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly prepared: PreparedEncryptedWalletBackupPackObject
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
}): Promise<
  Readonly<{
    buildCursor: PersistedEncryptedWalletBackupBuildCursor
    packControl: PersistedEncryptedWalletBackupPackControl
    stagedObject: PersistedEncryptedWalletBackupStagedObject
    idempotent: boolean
    transactionBytes: number
  }>
> {
  const authority = requirePreparedPackObject(input.prepared)
  const candidate = stagedCandidate(input.prepared.object, authority)
  return exactVersionTransaction(
    input.store,
    {
      buildId: authority.buildId,
      buildVersion: requireVersion(input.expectedBuildVersion, 'build version'),
      packId: authority.packId,
      packVersion: requireVersion(input.expectedPackVersion, 'pack version'),
      realm: authority.realm,
      vaultId: authority.vaultId,
      snapshotId: authority.snapshotId,
      snapshotRevision: authority.snapshotRevision,
    },
    async (transaction) => commitStage(transaction, input, authority, candidate),
  )
}

function stagedCandidate(
  object: PreparedEncryptedWalletBackupObject,
  authority: PreparedPackObjectAuthority,
) {
  const wire = readPreparedEncryptedWalletBackupObject(object)
  if (wire.kindCode !== ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND)
    throw new Error('prepared backup pack object kind is invalid')
  return requireStagedObject({
    schemaVersion: 1,
    buildId: authority.buildId,
    packId: authority.packId,
    snapshotId: authority.snapshotId,
    snapshotRevision: authority.snapshotRevision,
    formatVersion: wire.formatVersion,
    kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
    realm: wire.realm,
    vaultId: wire.vaultId,
    objectId: wire.objectId,
    generation: wire.generation,
    paddedLength: 262_144,
    digest: wire.digest,
    aad: wire.aad,
    body: wire.body,
  })
}

async function commitStage(
  rawTransaction: EncryptedWalletBackupPackPersistenceTransaction,
  input: { expectedBuildVersion: number; expectedPackVersion: number },
  authority: PreparedPackObjectAuthority,
  candidate: PersistedEncryptedWalletBackupStagedObject,
) {
  const transaction = new AccountedTransaction(rawTransaction)
  const stateInput = { ...input, ...authority }
  const build = requireExistingBuild(
    await transaction.readBuildCursor(authority.buildId),
    stateInput,
  )
  const pack = requireExistingPack(
    await transaction.readPackControl(authority.buildId, authority.packId),
    stateInput,
    ['frozen', 'staged'],
  )
  requireClosedBuild(build)
  requireFrozenSeal(pack, authority)
  if (pack.state === 'staged') return requireIdempotentStage(transaction, build, pack, candidate)
  if ((await transaction.readStagedObject(authority.buildId, authority.packId)) !== null)
    throw new Error('backup staged object exists before its pack link')
  return insertStage(transaction, input, build, pack, candidate)
}

async function requireIdempotentStage(
  transaction: AccountedTransaction,
  build: PersistedEncryptedWalletBackupBuildCursor,
  pack: PersistedEncryptedWalletBackupPackControl,
  candidate: PersistedEncryptedWalletBackupStagedObject,
) {
  const existing = await transaction.readStagedObject(pack.buildId, pack.packId)
  if (
    pack.stagedObjectId !== candidate.objectId ||
    pack.stagedObjectDigest !== candidate.digest ||
    existing === null ||
    !sameStagedObject(existing, candidate)
  )
    throw new Error('backup staged object conflicts with the frozen pack')
  return Object.freeze({
    buildCursor: build,
    packControl: pack,
    stagedObject: requireStagedObject(existing),
    idempotent: true,
    transactionBytes: transaction.totalBytes,
  })
}

async function insertStage(
  transaction: AccountedTransaction,
  input: { expectedBuildVersion: number; expectedPackVersion: number },
  build: PersistedEncryptedWalletBackupBuildCursor,
  pack: PersistedEncryptedWalletBackupPackControl,
  candidate: PersistedEncryptedWalletBackupStagedObject,
) {
  await transaction.insertStagedObject(candidate)
  const nextBuild = Object.freeze({
    ...build,
    version: input.expectedBuildVersion + 1,
  })
  const nextPack = Object.freeze({
    ...pack,
    version: input.expectedPackVersion + 1,
    state: 'staged' as const,
    stagedObjectId: candidate.objectId,
    stagedObjectDigest: candidate.digest,
  })
  await transaction.writeBuildCursor(nextBuild)
  await transaction.writePackControl(nextPack)
  return Object.freeze({
    buildCursor: nextBuild,
    packControl: nextPack,
    stagedObject: candidate,
    idempotent: false,
    transactionBytes: transaction.totalBytes,
  })
}

async function commitAppend(
  rawTransaction: EncryptedWalletBackupPackPersistenceTransaction,
  input: {
    buildId: string
    packId: string
    realm: string
    vaultId: string
    snapshotId: string
    snapshotRevision: number
    expectedBuildVersion: number
    expectedPackVersion: number
    records: readonly PersistedEncryptedWalletBackupPreparedBuildRecord[]
  },
) {
  const transaction = new AccountedTransaction(rawTransaction)
  const build = requireExpectedBuild(
    await transaction.readBuildCursor(input.buildId),
    input.buildId,
    input.packId,
    input.expectedBuildVersion,
    input,
  )
  const pack = requireExpectedOpenPack(
    await transaction.readPackControl(input.buildId, input.packId),
    input.buildId,
    input.packId,
    input.expectedPackVersion,
    input.records[0]!.prepared,
    input,
  )
  const appendedPersistedRowBytes = appendPersistedRowBytes(input, pack.recordCount)
  requireAppendCapacityAndOrder(pack, input.records, appendedPersistedRowBytes)
  await insertAppendRows(transaction, input, pack.recordCount)
  const nextBuild = Object.freeze({
    ...build,
    version: input.expectedBuildVersion + 1,
    nextRecordOrdinal: build.nextRecordOrdinal + input.records.length,
    openPackId: input.packId,
  })
  const nextPack = Object.freeze({
    ...pack,
    version: input.expectedPackVersion + 1,
    recordCount: pack.recordCount + input.records.length,
    recordCanonicalBytes:
      pack.recordCanonicalBytes +
      input.records.reduce((sum, { prepared }) => sum + prepared.canonicalRecord.byteLength, 0),
    persistedRowBytes: pack.persistedRowBytes + appendedPersistedRowBytes,
    lastRecordId: input.records.at(-1)!.recordId,
  })
  const exactNextPack = Object.freeze({
    ...nextPack,
    canonicalBytes: canonicalChunkBytes(nextPack.recordCount, nextPack.recordCanonicalBytes),
  })
  await transaction.writeBuildCursor(nextBuild)
  await transaction.writePackControl(exactNextPack)
  return Object.freeze({
    buildCursor: nextBuild,
    packControl: exactNextPack,
    transactionBytes: transaction.totalBytes,
  })
}

function requireAppendCapacityAndOrder(
  pack: PersistedEncryptedWalletBackupPackControl,
  records: readonly PersistedEncryptedWalletBackupPreparedBuildRecord[],
  appendedPersistedRowBytes: number,
) {
  if (pack.recordCount + records.length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX)
    throw new Error('backup pack record count exceeds the limit')
  if (pack.lastRecordId !== null && records[0]!.recordId <= pack.lastRecordId)
    throw new Error('backup pack append order is invalid')
  const nextRecordCount = pack.recordCount + records.length
  const nextRecordBytes =
    pack.recordCanonicalBytes +
    records.reduce((sum, { prepared }) => sum + prepared.canonicalRecord.byteLength, 0)
  if (
    canonicalChunkBytes(nextRecordCount, nextRecordBytes) >
    ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES
  )
    throw new Error('backup pack canonical chunk exceeds the limit')
  if (
    pack.persistedRowBytes + appendedPersistedRowBytes >
    ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES
  )
    throw new Error('backup pack persisted rows exceed the limit')
}

async function insertAppendRows(
  transaction: AccountedTransaction,
  input: {
    buildId: string
    packId: string
    records: readonly PersistedEncryptedWalletBackupPreparedBuildRecord[]
  },
  firstOrdinal: number,
) {
  for (let index = 0; index < input.records.length; index += 1) {
    const record = input.records[index]!
    await transaction.insertPreparedRecord(record)
    await transaction.insertPackBinding(packBinding(record, input.packId, firstOrdinal + index))
  }
}

function appendPersistedRowBytes(
  input: {
    buildId: string
    packId: string
    records: readonly PersistedEncryptedWalletBackupPreparedBuildRecord[]
  },
  firstOrdinal: number,
) {
  return input.records.reduce(
    (sum, record, index) =>
      sum + persistedAppendRowBytes(record, input.packId, firstOrdinal + index),
    0,
  )
}

function persistedAppendRowBytes(
  record: PersistedEncryptedWalletBackupPreparedBuildRecord,
  packId: string,
  ordinal: number,
) {
  return (
    serializeEncryptedWalletBackupPreparedBuildRecord(record).byteLength +
    serializeEncryptedWalletBackupPackBinding(packBinding(record, packId, ordinal)).byteLength
  )
}

function packBinding(
  record: PersistedEncryptedWalletBackupPreparedBuildRecord,
  packId: string,
  ordinal: number,
): PersistedEncryptedWalletBackupPackBinding {
  return Object.freeze({
    schemaVersion: 1,
    buildId: record.buildId,
    packId,
    realm: record.realm,
    vaultId: record.vaultId,
    snapshotId: record.snapshotId,
    snapshotRevision: record.snapshotRevision,
    recordId: record.recordId,
    ordinal,
  })
}

class AccountedTransaction {
  readonly #transaction: EncryptedWalletBackupPackPersistenceTransaction
  readonly #readRows: Uint8Array[] = []
  readonly #writtenRows: Uint8Array[] = []

  constructor(transaction: EncryptedWalletBackupPackPersistenceTransaction) {
    if (!transaction) throw new Error('backup pack transaction is invalid')
    this.#transaction = transaction
  }

  get totalBytes(): number {
    return measureEncryptedWalletBackupPackTransaction({
      readRows: this.#readRows,
      writtenRows: this.#writtenRows,
    })
  }

  async readBuildCursor(buildId: string) {
    const row = await this.#transaction.readBuildCursor(buildId)
    if (row === null) {
      this.assertBound()
      return null
    }
    const exact = Object.freeze({ ...row })
    this.#readRows.push(serializeEncryptedWalletBackupBuildCursor(exact))
    this.assertBound()
    return exact
  }

  async readPackControl(buildId: string, packId: string) {
    const row = await this.#transaction.readPackControl(buildId, packId)
    if (row === null) {
      this.assertBound()
      return null
    }
    const exact = Object.freeze({ ...row })
    this.#readRows.push(serializeEncryptedWalletBackupPackControl(exact))
    this.assertBound()
    return exact
  }

  async readPackRecordPage(
    buildId: string,
    packId: string,
    afterRecordId: string | null,
    expectedCount: number,
  ) {
    const remainingBytes = ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES - this.totalBytes
    const page = await this.#transaction.readPackRecordPage(
      buildId,
      packId,
      afterRecordId,
      expectedCount,
      remainingBytes,
    )
    const rows = requireSerializedPackPage(page, expectedCount, remainingBytes)
    for (const row of page.rows) {
      this.#readRows.push(row.binding.slice())
      this.#readRows.push(row.prepared.slice())
    }
    this.assertBound()
    return rows
  }

  async readStagedObject(buildId: string, packId: string) {
    const row = await this.#transaction.readStagedObject(buildId, packId)
    if (row === null) return null
    const exact = requireStagedObject(row)
    this.#readRows.push(serializeEncryptedWalletBackupStagedObject(exact))
    this.assertBound()
    return exact
  }

  async insertPreparedRecord(row: PersistedEncryptedWalletBackupPreparedBuildRecord) {
    this.#writtenRows.push(serializeEncryptedWalletBackupPreparedBuildRecord(row))
    this.assertBound()
    await this.#transaction.insertPreparedRecord(row)
  }

  async insertPackBinding(row: PersistedEncryptedWalletBackupPackBinding) {
    this.#writtenRows.push(serializeEncryptedWalletBackupPackBinding(row))
    this.assertBound()
    await this.#transaction.insertPackBinding(row)
  }

  async writeBuildCursor(row: PersistedEncryptedWalletBackupBuildCursor) {
    this.#writtenRows.push(serializeEncryptedWalletBackupBuildCursor(row))
    this.assertBound()
    await this.#transaction.writeBuildCursor(row)
  }

  async writePackControl(row: PersistedEncryptedWalletBackupPackControl) {
    this.#writtenRows.push(serializeEncryptedWalletBackupPackControl(row))
    this.assertBound()
    await this.#transaction.writePackControl(row)
  }

  async insertStagedObject(row: PersistedEncryptedWalletBackupStagedObject) {
    const exact = requireStagedObject(row)
    this.#writtenRows.push(serializeEncryptedWalletBackupStagedObject(exact))
    this.assertBound()
    await this.#transaction.insertStagedObject(exact)
  }

  private assertBound() {
    void this.totalBytes
  }
}

async function rehydrateAppendRecords(
  input: Parameters<typeof appendEncryptedWalletBackupPreparedRecordPage>[0],
): Promise<PersistedEncryptedWalletBackupPreparedBuildRecord[]> {
  const records = snapshotAppendRecords(input)
  await rehydratePreparedEncryptedWalletBackupRecordBatch({
    keyHandle: input.keyHandle,
    seed: input.seed,
    persisted: records.map(({ prepared }) => prepared),
    snapshotStore: input.snapshotStore,
  })
  return records
}

function snapshotAppendRecords(
  input: Parameters<typeof appendEncryptedWalletBackupPreparedRecordPage>[0],
): PersistedEncryptedWalletBackupPreparedBuildRecord[] {
  const source = Array.from(input.records)
  if (source.length === 0 || source.length > ENCRYPTED_WALLET_BACKUP_PACK_APPEND_RECORD_MAX)
    throw new Error('backup pack append record count is invalid')
  const records: PersistedEncryptedWalletBackupPreparedBuildRecord[] = []
  let recordCanonicalBytes = 0
  let persistedRowBytes = 0
  for (const raw of source) {
    recordCanonicalBytes += requireAppendRawBytes(raw)
    requirePreflightCanonicalCapacity(records.length + 1, recordCanonicalBytes)
    const record = preparedBuildRecord(input.buildId, clonePrepared(raw))
    persistedRowBytes += persistedAppendRowBytes(record, input.packId, 0)
    if (persistedRowBytes > ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES)
      throw new Error('backup pack persisted rows exceed the limit')
    records.push(record)
  }
  return records
}

function requireAppendRawBytes(raw: PersistedPreparedEncryptedWalletBackupRecord): number {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !(raw.canonicalRecord instanceof Uint8Array) ||
    !(raw.canonicalManifestEntry instanceof Uint8Array) ||
    !(raw.authenticationTag instanceof Uint8Array)
  )
    throw new Error('persisted prepared backup record is invalid')
  return raw.canonicalRecord.byteLength
}

function requirePreflightCanonicalCapacity(recordCount: number, recordCanonicalBytes: number) {
  if (
    canonicalChunkBytes(recordCount, recordCanonicalBytes) >
    ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES
  )
    throw new Error('backup pack canonical chunk exceeds the limit')
}

function preparedBuildRecord(
  buildId: string,
  prepared: PersistedPreparedEncryptedWalletBackupRecord,
): PersistedEncryptedWalletBackupPreparedBuildRecord {
  return Object.freeze({
    schemaVersion: 1,
    buildId,
    realm: prepared.realm,
    vaultId: prepared.vaultId,
    snapshotId: prepared.snapshotId,
    snapshotRevision: prepared.snapshotRevision,
    recordId: prepared.recordId,
    prepared,
  })
}

type ReadAndValidatePackInput = Readonly<{
  readonly store: EncryptedWalletBackupPackPersistenceStore
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly expectedBuildVersion: number
  readonly expectedPackVersion: number
  readonly requiredState: 'open' | 'frozen' | 'staged'
}>

async function readAndValidatePack(input: ReadAndValidatePackInput) {
  requireIdentifier(input.buildId, 'build id')
  requireIdentifier(input.packId, 'pack id')
  let afterRecordId: string | null = null
  let pack: PersistedEncryptedWalletBackupPackControl | undefined
  let build: PersistedEncryptedWalletBackupBuildCursor | undefined
  const rows: EncryptedWalletBackupPackRecordPageRow[] = []
  const records: Awaited<
    ReturnType<typeof rehydratePreparedEncryptedWalletBackupRecordBatch>
  >[number][] = []
  let pageReadCount = 0
  do {
    const page = await readPersistedPackPage(input, afterRecordId, rows.length)
    pack ??= page.pack
    build ??= page.build
    requireStablePackControls(build, pack, page)
    pageReadCount += 1
    const exactPage = appendValidatedPackPage(input, page, rows)
    afterRecordId = rows.at(-1)!.binding.recordId
    records.push(
      ...(await rehydratePreparedEncryptedWalletBackupRecordBatch({
        keyHandle: input.keyHandle,
        seed: input.seed,
        persisted: exactPage.map(({ prepared }) => prepared.prepared),
        snapshotStore: input.snapshotStore,
      })),
    )
    if (rows.length > page.pack.recordCount)
      throw new Error('backup pack record page exceeds the frozen count')
  } while (pack !== undefined && rows.length < pack.recordCount)
  const completePack = requireCompletePackRows(pack, rows)
  return { pack: completePack, rows, records, pageReadCount }
}

async function readPersistedPackPage(
  input: ReadAndValidatePackInput,
  afterRecordId: string | null,
  recordsRead: number,
) {
  return exactVersionTransaction(input.store, expectation(input), async (rawTransaction) => {
    const transaction = new AccountedTransaction(rawTransaction)
    const build = requireExistingBuild(await transaction.readBuildCursor(input.buildId), input)
    if (input.requiredState === 'open') requireOpenBuild(build, input.packId)
    else requireClosedBuild(build)
    const pack = requireExistingPack(
      await transaction.readPackControl(input.buildId, input.packId),
      input,
      input.requiredState,
    )
    const count = Math.min(
      ENCRYPTED_WALLET_BACKUP_PACK_READ_RECORD_MAX,
      pack.recordCount - recordsRead,
    )
    const rows = await transaction.readPackRecordPage(
      input.buildId,
      input.packId,
      afterRecordId,
      count,
    )
    return { build, pack, rows }
  })
}

function requireStablePackControls(
  build: PersistedEncryptedWalletBackupBuildCursor,
  pack: PersistedEncryptedWalletBackupPackControl,
  page: Awaited<ReturnType<typeof readPersistedPackPage>>,
) {
  if (!samePackControl(pack, page.pack) || !sameBuildCursor(build, page.build))
    throw new Error('backup pack control changed between pages')
}

function appendValidatedPackPage(
  input: ReadAndValidatePackInput,
  page: Awaited<ReturnType<typeof readPersistedPackPage>>,
  rows: EncryptedWalletBackupPackRecordPageRow[],
) {
  const expectedCount = Math.min(
    ENCRYPTED_WALLET_BACKUP_PACK_READ_RECORD_MAX,
    page.pack.recordCount - rows.length,
  )
  if (page.rows.length !== expectedCount) throw new Error('backup pack record page is short')
  const exactPage: EncryptedWalletBackupPackRecordPageRow[] = []
  for (const raw of page.rows) {
    const row = requirePageRow(raw, input, rows.length)
    const previous = rows.at(-1)?.binding.recordId
    if (previous !== undefined && row.binding.recordId <= previous)
      throw new Error('backup pack record order or uniqueness is invalid')
    rows.push(row)
    exactPage.push(row)
  }
  return exactPage
}

function requireCompletePackRows(
  pack: PersistedEncryptedWalletBackupPackControl | undefined,
  rows: readonly EncryptedWalletBackupPackRecordPageRow[],
) {
  if (pack === undefined || rows.length !== pack.recordCount)
    throw new Error('backup pack record count is invalid')
  if (pack.lastRecordId !== rows.at(-1)?.binding.recordId)
    throw new Error('backup pack last record is invalid')
  const persistedRowBytes = rows.reduce(
    (sum, row) =>
      sum +
      serializeEncryptedWalletBackupPackBinding(row.binding).byteLength +
      serializeEncryptedWalletBackupPreparedBuildRecord(row.prepared).byteLength,
    0,
  )
  if (persistedRowBytes !== pack.persistedRowBytes)
    throw new Error('backup pack persisted row byte count is invalid')
  return pack
}

async function readExactStagedObject(
  input: {
    store: EncryptedWalletBackupPackPersistenceStore
    keyHandle: EncryptedWalletBackupKeyHandle
    buildId: string
    packId: string
    snapshotId: string
    snapshotRevision: number
    expectedBuildVersion: number
    expectedPackVersion: number
  },
  seal: {
    recordCount: number
    canonicalBytes: number
    membershipDigest: string
  },
) {
  return exactVersionTransaction(input.store, expectation(input), async (rawTransaction) => {
    const transaction = new AccountedTransaction(rawTransaction)
    const build = requireExistingBuild(await transaction.readBuildCursor(input.buildId), input)
    const pack = requireExistingPack(
      await transaction.readPackControl(input.buildId, input.packId),
      input,
      'staged',
    )
    requireClosedBuild(build)
    requireFrozenSeal(pack, seal)
    const staged = await transaction.readStagedObject(input.buildId, input.packId)
    if (
      staged === null ||
      staged.snapshotId !== pack.snapshotId ||
      staged.snapshotRevision !== pack.snapshotRevision ||
      pack.stagedObjectId !== staged.objectId ||
      pack.stagedObjectDigest !== staged.digest
    )
      throw new Error('backup staged object link is invalid')
    return requireStagedObject(staged)
  })
}

function issuePreparedPackObject(
  input: {
    buildId: string
    packId: string
    keyHandle: EncryptedWalletBackupKeyHandle
    snapshotId: string
    snapshotRevision: number
  },
  chunk: PreparedEncryptedWalletBackupProofChunk,
  object: PreparedEncryptedWalletBackupObject,
  seal: Pick<PreparedPackObjectAuthority, 'recordCount' | 'canonicalBytes' | 'membershipDigest'>,
  pageReadCount: number,
) {
  return issuePreparedPackObjectWithAuthority(
    {
      buildId: input.buildId,
      packId: input.packId,
      ...scopeFromInput(input),
      ...seal,
    },
    chunk,
    object,
    pageReadCount,
  )
}

function issuePreparedPackObjectWithAuthority(
  authority: PreparedPackObjectAuthority,
  chunk: PreparedEncryptedWalletBackupProofChunk,
  object: PreparedEncryptedWalletBackupObject,
  pageReadCount: number,
) {
  const result = Object.freeze({
    buildId: authority.buildId,
    packId: authority.packId,
    chunk,
    object,
    pageReadCount,
  })
  preparedPackObjectAuthorities.set(result, {
    buildId: authority.buildId,
    packId: authority.packId,
    realm: authority.realm,
    vaultId: authority.vaultId,
    snapshotId: authority.snapshotId,
    snapshotRevision: authority.snapshotRevision,
    recordCount: authority.recordCount,
    canonicalBytes: authority.canonicalBytes,
    membershipDigest: authority.membershipDigest,
  })
  return result
}

function issueFrozenPack(
  input: {
    buildId: string
    packId: string
    keyHandle: EncryptedWalletBackupKeyHandle
    snapshotId: string
    snapshotRevision: number
  },
  chunk: PreparedEncryptedWalletBackupProofChunk,
  seal: Pick<PreparedPackObjectAuthority, 'recordCount' | 'canonicalBytes' | 'membershipDigest'>,
  pageReadCount: number,
): FrozenEncryptedWalletBackupPack {
  const frozen = Object.freeze({
    buildId: input.buildId,
    packId: input.packId,
    ...seal,
  })
  frozenPackAuthorities.set(frozen, {
    buildId: input.buildId,
    packId: input.packId,
    ...scopeFromInput(input),
    ...seal,
    keyHandle: input.keyHandle,
    chunk,
    pageReadCount,
  })
  return frozen
}

function issuePreparedPackObjectFromAuthority(
  authority: FrozenPackAuthority,
  object: PreparedEncryptedWalletBackupObject,
): PreparedEncryptedWalletBackupPackObject {
  return issuePreparedPackObjectWithAuthority(
    authority,
    authority.chunk,
    object,
    authority.pageReadCount,
  )
}

function wireObject(row: PersistedEncryptedWalletBackupStagedObject) {
  return {
    formatVersion: row.formatVersion,
    kindCode: row.kindCode,
    realm: row.realm,
    vaultId: row.vaultId,
    objectId: row.objectId,
    generation: row.generation,
    paddedLength: row.paddedLength,
    digest: row.digest,
    aad: row.aad.slice(),
    body: row.body.slice(),
  }
}

function computePackSeal(rows: readonly EncryptedWalletBackupPackRecordPageRow[]) {
  const recordCanonicalBytes = rows.reduce(
    (sum, row) => sum + row.prepared.prepared.canonicalRecord.byteLength,
    0,
  )
  return Object.freeze({
    recordCount: rows.length,
    canonicalBytes: canonicalChunkBytes(rows.length, recordCanonicalBytes),
    membershipDigest: bytesToHex(
      sha256(
        encodeCanonical([
          1,
          'encrypted-wallet-backup-pack-membership',
          rows.map((row) => [
            row.prepared.prepared.recordKindCode,
            hexBytes(row.binding.recordId),
            hexBytes(row.prepared.prepared.commitment),
          ]),
        ]),
      ),
    ),
  })
}

function canonicalChunkBytes(recordCount: number, recordBytes: number): number {
  return 3 + canonicalArrayHeaderBytes(recordCount) + recordBytes
}

function canonicalArrayHeaderBytes(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error('backup pack canonical array length is invalid')
  if (length < 24) return 1
  if (length <= 0xff) return 2
  if (length <= 0xffff) return 3
  return 5
}

function requireExpectedBuild(
  row: PersistedEncryptedWalletBackupBuildCursor | null,
  buildId: string,
  packId: string,
  expectedVersion: number,
  scope: EncryptedWalletBackupPackScope,
): PersistedEncryptedWalletBackupBuildCursor {
  if (row === null) {
    if (expectedVersion !== 0) throw new Error('backup build cursor version is stale')
    return Object.freeze({
      schemaVersion: 1,
      buildId,
      realm: scope.realm,
      vaultId: scope.vaultId,
      snapshotId: scope.snapshotId,
      snapshotRevision: scope.snapshotRevision,
      version: 0,
      nextRecordOrdinal: 0,
      openPackId: packId,
    })
  }
  const result = requireBuildCursor(row, { buildId, ...scope })
  if (result.version !== expectedVersion) throw new Error('backup build cursor version is stale')
  if (result.openPackId !== null && result.openPackId !== packId)
    throw new Error('backup build cursor belongs to another open pack')
  return result
}

function requireExpectedOpenPack(
  row: PersistedEncryptedWalletBackupPackControl | null,
  buildId: string,
  packId: string,
  expectedVersion: number,
  first: PersistedPreparedEncryptedWalletBackupRecord,
  scope: EncryptedWalletBackupPackScope,
): PersistedEncryptedWalletBackupPackControl {
  if (row === null) {
    if (expectedVersion !== 0) throw new Error('backup pack control version is stale')
    return Object.freeze({
      schemaVersion: 1,
      buildId,
      packId,
      realm: scope.realm,
      vaultId: scope.vaultId,
      version: 0,
      state: 'open',
      snapshotId: first.snapshotId,
      snapshotRevision: first.snapshotRevision,
      recordCount: 0,
      recordCanonicalBytes: 0,
      persistedRowBytes: 0,
      lastRecordId: null,
      canonicalBytes: canonicalChunkBytes(0, 0),
      membershipDigest: null,
      stagedObjectId: null,
      stagedObjectDigest: null,
    })
  }
  const result = requirePackControl(row, buildId, packId, scope)
  if (result.version !== expectedVersion) throw new Error('backup pack control version is stale')
  if (result.state !== 'open') throw new Error('backup pack is not open')
  if (result.snapshotId !== first.snapshotId || result.snapshotRevision !== first.snapshotRevision)
    throw new Error('backup pack snapshot changed')
  return result
}

function requireExistingBuild(
  row: PersistedEncryptedWalletBackupBuildCursor | null,
  input: {
    buildId: string
    expectedBuildVersion: number
    keyHandle?: EncryptedWalletBackupKeyHandle
    realm?: string
    vaultId?: string
    snapshotId: string
    snapshotRevision: number
  },
) {
  if (row === null) throw new Error('backup build cursor is missing')
  const result = requireBuildCursor(row, {
    buildId: input.buildId,
    ...scopeFromInput(input),
  })
  if (result.version !== input.expectedBuildVersion)
    throw new Error('backup build cursor version is stale')
  return result
}

function requireOpenBuild(build: PersistedEncryptedWalletBackupBuildCursor, packId: string) {
  if (build.openPackId !== packId)
    throw new Error('backup build cursor belongs to another open pack')
}

function requireClosedBuild(build: PersistedEncryptedWalletBackupBuildCursor) {
  if (build.openPackId !== null) throw new Error('backup build cursor still has an open pack')
}

function requireExistingPack(
  row: PersistedEncryptedWalletBackupPackControl | null,
  input: {
    packId: string
    buildId: string
    expectedPackVersion: number
    keyHandle?: EncryptedWalletBackupKeyHandle
    realm?: string
    vaultId?: string
    snapshotId: string
    snapshotRevision: number
  },
  state:
    | PersistedEncryptedWalletBackupPackControl['state']
    | readonly PersistedEncryptedWalletBackupPackControl['state'][],
) {
  if (row === null) throw new Error('backup pack control is missing')
  const result = requirePackControl(row, input.buildId, input.packId, scopeFromInput(input))
  if (result.version !== input.expectedPackVersion)
    throw new Error('backup pack control version is stale')
  const states = Array.isArray(state) ? state : [state]
  if (!states.includes(result.state)) throw new Error(`backup pack is not ${states.join(' or ')}`)
  return result
}

function requirePageRow(
  row: EncryptedWalletBackupPackRecordPageRow,
  input: {
    buildId: string
    packId: string
    keyHandle: EncryptedWalletBackupKeyHandle
    snapshotId: string
    snapshotRevision: number
  },
  ordinal: number,
) {
  if (typeof row !== 'object' || row === null || !hasExactKeys(row, ['binding', 'prepared']))
    throw new Error('backup pack record page row is invalid')
  const binding = requireBinding(row.binding)
  const prepared = requirePreparedBuildRecord(row.prepared)
  const scope = scopeFromInput(input)
  if (
    binding.schemaVersion !== 1 ||
    binding.buildId !== input.buildId ||
    binding.packId !== input.packId ||
    binding.realm !== scope.realm ||
    binding.vaultId !== scope.vaultId ||
    binding.snapshotId !== scope.snapshotId ||
    binding.snapshotRevision !== scope.snapshotRevision ||
    binding.ordinal !== ordinal ||
    prepared.schemaVersion !== 1 ||
    prepared.buildId !== input.buildId ||
    prepared.realm !== scope.realm ||
    prepared.vaultId !== scope.vaultId ||
    prepared.snapshotId !== scope.snapshotId ||
    prepared.snapshotRevision !== scope.snapshotRevision ||
    prepared.recordId !== binding.recordId ||
    prepared.prepared.recordId !== binding.recordId
  )
    throw new Error('backup pack record page row has a foreign identity')
  return { binding, prepared }
}

function requireFrozenSeal(
  pack: PersistedEncryptedWalletBackupPackControl,
  seal: {
    recordCount: number
    canonicalBytes: number
    membershipDigest: string
  },
) {
  if (
    pack.recordCount !== seal.recordCount ||
    pack.canonicalBytes !== seal.canonicalBytes ||
    pack.membershipDigest !== seal.membershipDigest
  )
    throw new Error('backup frozen pack seal is invalid')
}

function samePackControl(
  left: PersistedEncryptedWalletBackupPackControl,
  right: PersistedEncryptedWalletBackupPackControl,
) {
  return equalBytes(
    serializeEncryptedWalletBackupPackControl(left),
    serializeEncryptedWalletBackupPackControl(right),
  )
}

function sameBuildCursor(
  left: PersistedEncryptedWalletBackupBuildCursor,
  right: PersistedEncryptedWalletBackupBuildCursor,
) {
  return equalBytes(
    serializeEncryptedWalletBackupBuildCursor(left),
    serializeEncryptedWalletBackupBuildCursor(right),
  )
}

function requirePreparedPackObject(value: PreparedEncryptedWalletBackupPackObject) {
  const authority =
    typeof value === 'object' && value !== null
      ? preparedPackObjectAuthorities.get(value)
      : undefined
  if (authority === undefined) throw new Error('prepared backup pack object is invalid')
  return authority
}

function requireStagedObject(
  value: PersistedEncryptedWalletBackupStagedObject,
): PersistedEncryptedWalletBackupStagedObject {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'buildId',
      'packId',
      'snapshotId',
      'snapshotRevision',
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
    ]) ||
    value.schemaVersion !== 1 ||
    requireIdentifier(value.buildId, 'staged build id') !== value.buildId ||
    requireIdentifier(value.packId, 'staged pack id') !== value.packId ||
    !isBoundedText(value.snapshotId, 128) ||
    !Number.isSafeInteger(value.snapshotRevision) ||
    value.snapshotRevision < 0 ||
    value.formatVersion !== 1 ||
    value.kindCode !== 1 ||
    value.paddedLength !== 262_144 ||
    !isBoundedText(value.realm, 64) ||
    !isFingerprint(value.vaultId) ||
    !isFingerprint(value.digest) ||
    !/^[0-9a-f]{32}$/.test(value.objectId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !(value.aad instanceof Uint8Array) ||
    value.aad.byteLength < 1 ||
    value.aad.byteLength > 1_024 ||
    !(value.body instanceof Uint8Array) ||
    value.body.byteLength !== 262_172
  )
    throw new Error('persisted backup staged object is invalid')
  const digest = bytesToHex(
    sha256(concatBytes(uint32Bytes(value.aad.byteLength), value.aad, value.body)),
  )
  if (digest !== value.digest) throw new Error('persisted backup staged object digest is invalid')
  return Object.freeze({
    ...value,
    aad: value.aad.slice(),
    body: value.body.slice(),
  })
}

function sameStagedObject(
  left: PersistedEncryptedWalletBackupStagedObject,
  right: PersistedEncryptedWalletBackupStagedObject,
) {
  const exact = requireStagedObject(left)
  return (
    exact.buildId === right.buildId &&
    exact.packId === right.packId &&
    exact.snapshotId === right.snapshotId &&
    exact.snapshotRevision === right.snapshotRevision &&
    exact.objectId === right.objectId &&
    exact.digest === right.digest &&
    exact.generation === right.generation &&
    exact.formatVersion === right.formatVersion &&
    exact.kindCode === right.kindCode &&
    exact.realm === right.realm &&
    exact.vaultId === right.vaultId &&
    exact.paddedLength === right.paddedLength &&
    equalBytes(exact.aad, right.aad) &&
    equalBytes(exact.body, right.body)
  )
}

function requireSerializedPackPage(
  value: EncryptedWalletBackupPackSerializedPage,
  expectedCount: number,
  maximumBytes: number,
): readonly EncryptedWalletBackupPackRecordPageRow[] {
  validateEncryptedWalletBackupPackSerializedPageByteEvidence(value, expectedCount, maximumBytes)
  return Object.freeze(
    value.rows.map((row) =>
      Object.freeze({
        binding: deserializeEncryptedWalletBackupPackBinding(row.binding),
        prepared: deserializeEncryptedWalletBackupPreparedBuildRecord(row.prepared),
      }),
    ),
  )
}

export function validateEncryptedWalletBackupPackSerializedPageByteEvidence(
  value: EncryptedWalletBackupPackSerializedPage,
  expectedCount: number,
  maximumBytes: number,
): void {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > ENCRYPTED_WALLET_BACKUP_PACK_READ_RECORD_MAX ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES
  )
    throw new Error('backup pack serialized page bound is invalid')
  if (
    typeof value !== 'object' ||
    value === null ||
    !hasExactKeys(value, ['rows', 'serializedBytes']) ||
    !Array.isArray(value.rows) ||
    value.rows.length > expectedCount ||
    !Number.isSafeInteger(value.serializedBytes) ||
    value.serializedBytes < 0
  )
    throw new Error('backup pack serialized page is invalid')
  let exactBytes = 0
  for (const row of value.rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !hasExactKeys(row, ['binding', 'prepared']) ||
      !(row.binding instanceof Uint8Array) ||
      !(row.prepared instanceof Uint8Array)
    )
      throw new Error('backup pack serialized page row is invalid')
    exactBytes += row.binding.byteLength + row.prepared.byteLength
    if (exactBytes > maximumBytes)
      throw new Error('backup pack serialized page exceeds its byte limit')
  }
  if (exactBytes !== value.serializedBytes)
    throw new Error('backup pack serialized page byte evidence is invalid')
}

export function deserializeEncryptedWalletBackupPackBinding(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupPackBinding {
  const value = requireCanonicalRow(bytes, 10, 3)
  return Object.freeze(
    requireBinding({
      schemaVersion: 1,
      buildId: requireIdentifier(value[2], 'serialized build id'),
      packId: requireIdentifier(value[3], 'serialized pack id'),
      realm: requireIdentifier(value[4], 'serialized realm'),
      vaultId: bytesToHex(requireBytesValue(value[5])),
      snapshotId: requireIdentifier(value[6], 'serialized snapshot id'),
      snapshotRevision: requireVersion(value[7], 'serialized snapshot revision'),
      recordId: requireFingerprintValue(value[8], 'serialized record id'),
      ordinal: requireVersion(value[9], 'serialized ordinal'),
    }),
  )
}

export function deserializeEncryptedWalletBackupPreparedBuildRecord(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupPreparedBuildRecord {
  const value = requireCanonicalRow(bytes, 19, 2)
  return Object.freeze(
    requirePreparedBuildRecord({
      schemaVersion: 1,
      buildId: requireIdentifier(value[2], 'serialized build id'),
      realm: requireIdentifier(value[3], 'serialized realm'),
      vaultId: bytesToHex(requireBytesValue(value[4])),
      snapshotId: requireIdentifier(value[5], 'serialized snapshot id'),
      snapshotRevision: requireVersion(value[6], 'serialized snapshot revision'),
      recordId: requireFingerprintValue(value[7], 'serialized record id'),
      prepared: {
        schemaVersion: requireOne(value[8]),
        realm: requireIdentifier(value[9], 'serialized prepared realm'),
        vaultId: requireFingerprintValue(value[10], 'serialized prepared vault id'),
        snapshotId: requireIdentifier(value[11], 'serialized prepared snapshot id'),
        snapshotRevision: requireVersion(value[12], 'serialized prepared snapshot revision'),
        recordId: requireFingerprintValue(value[13], 'serialized prepared record id'),
        commitment: requireFingerprintValue(value[14], 'serialized prepared commitment'),
        recordKindCode: requireRecordKindCode(value[15]),
        canonicalRecord: requireBytesValue(value[16]).slice(),
        canonicalManifestEntry: requireBytesValue(value[17]).slice(),
        authenticationTag: requireBytesValue(value[18]).slice(),
      },
    }),
  )
}

function requireCanonicalRow(bytes: Uint8Array, length: number, kind: number): readonly unknown[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1)
    throw new Error('backup pack canonical row is invalid')
  const value = decode(bytes)
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value[0] !== 1 ||
    value[1] !== kind ||
    !equalBytes(bytes, encodeCanonical(value))
  )
    throw new Error('backup pack canonical row is invalid')
  return value
}

function requireBytesValue(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('backup pack canonical byte value is invalid')
  return value
}

export function serializeEncryptedWalletBackupBuildCursor(
  row: PersistedEncryptedWalletBackupBuildCursor,
) {
  const exact = requireBuildCursor(row, row)
  return encodeCanonical([
    1,
    0,
    exact.buildId,
    exact.realm,
    hexBytes(exact.vaultId),
    exact.snapshotId,
    exact.snapshotRevision,
    exact.version,
    exact.nextRecordOrdinal,
    exact.openPackId,
  ])
}

export function serializeEncryptedWalletBackupPackControl(
  row: PersistedEncryptedWalletBackupPackControl,
) {
  const exact = requirePackControl(row, row.buildId, row.packId)
  return encodeCanonical([
    1,
    1,
    exact.buildId,
    exact.packId,
    exact.realm,
    hexBytes(exact.vaultId),
    exact.snapshotId,
    exact.snapshotRevision,
    exact.version,
    exact.state,
    exact.recordCount,
    exact.recordCanonicalBytes,
    exact.persistedRowBytes,
    exact.lastRecordId,
    exact.canonicalBytes,
    exact.membershipDigest,
    exact.stagedObjectId,
    exact.stagedObjectDigest,
  ])
}

export function serializeEncryptedWalletBackupPreparedBuildRecord(
  row: PersistedEncryptedWalletBackupPreparedBuildRecord,
) {
  const exact = requirePreparedBuildRecord(row)
  const value = exact.prepared
  return encodeCanonical([
    1,
    2,
    exact.buildId,
    exact.realm,
    hexBytes(exact.vaultId),
    exact.snapshotId,
    exact.snapshotRevision,
    exact.recordId,
    value.schemaVersion,
    value.realm,
    value.vaultId,
    value.snapshotId,
    value.snapshotRevision,
    value.recordId,
    value.commitment,
    value.recordKindCode,
    value.canonicalRecord,
    value.canonicalManifestEntry,
    value.authenticationTag,
  ])
}

export function serializeEncryptedWalletBackupPackBinding(
  row: PersistedEncryptedWalletBackupPackBinding,
) {
  const exact = requireBinding(row)
  return encodeCanonical([
    1,
    3,
    exact.buildId,
    exact.packId,
    exact.realm,
    hexBytes(exact.vaultId),
    exact.snapshotId,
    exact.snapshotRevision,
    exact.recordId,
    exact.ordinal,
  ])
}

export function serializeEncryptedWalletBackupStagedObject(
  row: PersistedEncryptedWalletBackupStagedObject,
) {
  const exact = requireStagedObject(row)
  return encodeCanonical([
    1,
    4,
    exact.buildId,
    exact.packId,
    exact.snapshotId,
    exact.snapshotRevision,
    exact.formatVersion,
    exact.kindCode,
    exact.realm,
    exact.vaultId,
    exact.objectId,
    exact.generation,
    exact.paddedLength,
    exact.digest,
    exact.aad,
    exact.body,
  ])
}

function requireBuildCursor(
  row: PersistedEncryptedWalletBackupBuildCursor,
  expected: { buildId: string } & EncryptedWalletBackupPackScope,
) {
  if (
    !hasExactKeys(row, [
      'schemaVersion',
      'buildId',
      'realm',
      'vaultId',
      'snapshotId',
      'snapshotRevision',
      'version',
      'nextRecordOrdinal',
      'openPackId',
    ]) ||
    row.schemaVersion !== 1 ||
    row.buildId !== expected.buildId ||
    row.realm !== expected.realm ||
    row.vaultId !== expected.vaultId ||
    row.snapshotId !== expected.snapshotId ||
    row.snapshotRevision !== expected.snapshotRevision ||
    !isBoundedText(row.buildId, 128) ||
    !isBoundedText(row.realm, 64) ||
    !isFingerprint(row.vaultId) ||
    !isBoundedText(row.snapshotId, 128) ||
    !Number.isSafeInteger(row.snapshotRevision) ||
    row.snapshotRevision < 0 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    !Number.isSafeInteger(row.nextRecordOrdinal) ||
    row.nextRecordOrdinal < 0 ||
    (row.openPackId !== null && !isBoundedText(row.openPackId, 128))
  )
    throw new Error('persisted backup build cursor is invalid')
  return row
}

function requirePackControl(
  row: PersistedEncryptedWalletBackupPackControl,
  buildId: string,
  packId: string,
  scope?: EncryptedWalletBackupPackScope,
) {
  if (
    !hasExactKeys(row, [
      'schemaVersion',
      'buildId',
      'packId',
      'realm',
      'vaultId',
      'version',
      'state',
      'snapshotId',
      'snapshotRevision',
      'recordCount',
      'recordCanonicalBytes',
      'persistedRowBytes',
      'lastRecordId',
      'canonicalBytes',
      'membershipDigest',
      'stagedObjectId',
      'stagedObjectDigest',
    ]) ||
    row.schemaVersion !== 1 ||
    row.buildId !== buildId ||
    row.packId !== packId ||
    (scope !== undefined &&
      (row.realm !== scope.realm ||
        row.vaultId !== scope.vaultId ||
        row.snapshotId !== scope.snapshotId ||
        row.snapshotRevision !== scope.snapshotRevision)) ||
    !isBoundedText(row.buildId, 128) ||
    !isBoundedText(row.packId, 128) ||
    !isBoundedText(row.realm, 64) ||
    !isFingerprint(row.vaultId) ||
    !['open', 'frozen', 'staged'].includes(row.state) ||
    !isBoundedText(row.snapshotId, 128) ||
    !Number.isSafeInteger(row.snapshotRevision) ||
    row.snapshotRevision < 0 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    !Number.isSafeInteger(row.recordCount) ||
    (row.recordCount < 1 && row.version > 0) ||
    row.recordCount > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX ||
    !Number.isSafeInteger(row.recordCanonicalBytes) ||
    row.recordCanonicalBytes < 0 ||
    !Number.isSafeInteger(row.persistedRowBytes) ||
    row.persistedRowBytes < 0 ||
    row.persistedRowBytes > ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES ||
    row.canonicalBytes !== canonicalChunkBytes(row.recordCount, row.recordCanonicalBytes) ||
    !legalPackControlFields(row)
  )
    throw new Error('persisted backup pack control is invalid')
  return row
}

function requirePreparedBuildRecord(row: PersistedEncryptedWalletBackupPreparedBuildRecord) {
  if (
    !hasExactKeys(row, [
      'schemaVersion',
      'buildId',
      'realm',
      'vaultId',
      'snapshotId',
      'snapshotRevision',
      'recordId',
      'prepared',
    ]) ||
    row.schemaVersion !== 1 ||
    !isBoundedText(row.buildId, 128) ||
    !isBoundedText(row.realm, 64) ||
    !isFingerprint(row.vaultId) ||
    !isBoundedText(row.snapshotId, 128) ||
    !Number.isSafeInteger(row.snapshotRevision) ||
    row.snapshotRevision < 0 ||
    !isFingerprint(row.recordId) ||
    typeof row.prepared !== 'object' ||
    row.prepared === null ||
    row.prepared.recordId !== row.recordId ||
    row.prepared.realm !== row.realm ||
    row.prepared.vaultId !== row.vaultId ||
    row.prepared.snapshotId !== row.snapshotId ||
    row.prepared.snapshotRevision !== row.snapshotRevision
  )
    throw new Error('persisted backup prepared build record is invalid')
  return row
}

function requireBinding(row: PersistedEncryptedWalletBackupPackBinding) {
  if (
    !hasExactKeys(row, [
      'schemaVersion',
      'buildId',
      'packId',
      'realm',
      'vaultId',
      'snapshotId',
      'snapshotRevision',
      'recordId',
      'ordinal',
    ]) ||
    row.schemaVersion !== 1 ||
    !isBoundedText(row.buildId, 128) ||
    !isBoundedText(row.packId, 128) ||
    !isBoundedText(row.realm, 64) ||
    !isFingerprint(row.vaultId) ||
    !isBoundedText(row.snapshotId, 128) ||
    !Number.isSafeInteger(row.snapshotRevision) ||
    row.snapshotRevision < 0 ||
    !isFingerprint(row.recordId) ||
    !Number.isSafeInteger(row.ordinal) ||
    row.ordinal < 0
  )
    throw new Error('persisted backup pack binding is invalid')
  return row
}

function legalPackControlFields(row: PersistedEncryptedWalletBackupPackControl) {
  const lastRecordValid =
    row.recordCount === 0 ? row.lastRecordId === null : isFingerprint(row.lastRecordId)
  if (!lastRecordValid) return false
  switch (row.state) {
    case 'open':
      return (
        Number.isSafeInteger(row.canonicalBytes) &&
        (row.canonicalBytes as number) >= 4 &&
        (row.canonicalBytes as number) <= ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES &&
        row.membershipDigest === null &&
        row.stagedObjectId === null &&
        row.stagedObjectDigest === null
      )
    case 'frozen':
      return (
        validFrozenFields(row) && row.stagedObjectId === null && row.stagedObjectDigest === null
      )
    case 'staged':
      return (
        validFrozenFields(row) &&
        typeof row.stagedObjectId === 'string' &&
        /^[0-9a-f]{32}$/.test(row.stagedObjectId) &&
        isFingerprint(row.stagedObjectDigest)
      )
    default:
      return false
  }
}

function validFrozenFields(row: PersistedEncryptedWalletBackupPackControl) {
  return (
    row.recordCount >= 1 &&
    Number.isSafeInteger(row.canonicalBytes) &&
    (row.canonicalBytes as number) >= 1 &&
    (row.canonicalBytes as number) <= ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES &&
    isFingerprint(row.membershipDigest)
  )
}

function clonePrepared(
  row: PersistedPreparedEncryptedWalletBackupRecord,
): PersistedPreparedEncryptedWalletBackupRecord {
  return Object.freeze({
    ...row,
    canonicalRecord: row.canonicalRecord.slice(),
    canonicalManifestEntry: row.canonicalManifestEntry.slice(),
    authenticationTag: row.authenticationTag.slice(),
  })
}

function expectation(input: {
  buildId: string
  packId: string
  expectedBuildVersion: number
  expectedPackVersion: number
  keyHandle?: EncryptedWalletBackupKeyHandle
  realm?: string
  vaultId?: string
  snapshotId: string
  snapshotRevision: number
}): ExactVersionExpectation {
  const scope = scopeFromInput(input)
  return {
    buildId: requireIdentifier(input.buildId, 'build id'),
    buildVersion: requireVersion(input.expectedBuildVersion, 'build version'),
    packId: requireIdentifier(input.packId, 'pack id'),
    packVersion: requireVersion(input.expectedPackVersion, 'pack version'),
    ...scope,
  }
}

function scopeFromInput(input: {
  keyHandle?: EncryptedWalletBackupKeyHandle
  realm?: string
  vaultId?: string
  snapshotId: string
  snapshotRevision: number
}): EncryptedWalletBackupPackScope {
  const realm = input.keyHandle?.realm ?? input.realm
  const vaultId = input.keyHandle?.vaultId ?? input.vaultId
  if (!isBoundedText(realm, 64) || !isFingerprint(vaultId))
    throw new Error('backup pack vault scope is invalid')
  return Object.freeze({
    realm,
    vaultId,
    snapshotId: requireIdentifier(input.snapshotId, 'snapshot id'),
    snapshotRevision: requireVersion(input.snapshotRevision, 'snapshot revision'),
  })
}

function requireRecordScope(
  record: PersistedPreparedEncryptedWalletBackupRecord,
  input: {
    keyHandle: EncryptedWalletBackupKeyHandle
    snapshotId: string
    snapshotRevision: number
  },
): EncryptedWalletBackupPackScope {
  const scope = scopeFromInput(input)
  if (
    record.realm !== scope.realm ||
    record.vaultId !== scope.vaultId ||
    record.snapshotId !== scope.snapshotId ||
    record.snapshotRevision !== scope.snapshotRevision
  )
    throw new Error('backup pack record scope changed')
  return scope
}

function requireStrictlyIncreasingRecordIds(recordIds: readonly string[]) {
  for (let index = 0; index < recordIds.length; index += 1) {
    if (!isFingerprint(recordIds[index]!)) throw new Error('backup prepared record id is invalid')
    if (index > 0 && recordIds[index]! <= recordIds[index - 1]!)
      throw new Error('backup prepared record order or uniqueness is invalid')
  }
}

function requireOneSnapshot(records: readonly PersistedEncryptedWalletBackupPreparedBuildRecord[]) {
  const first = records[0]!.prepared
  if (
    records.some(
      ({ prepared }) =>
        prepared.snapshotId !== first.snapshotId ||
        prepared.snapshotRevision !== first.snapshotRevision,
    )
  )
    throw new Error('backup pack snapshot changed')
}

function requireIdentifier(value: unknown, name: string) {
  if (!isBoundedText(value, 128)) throw new Error(`backup pack ${name} is invalid`)
  return value
}

function requireVersion(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`backup pack ${name} is invalid`)
  return value as number
}

function requireOne(value: unknown): 1 {
  if (value !== 1) throw new Error('backup pack schema version is invalid')
  return 1
}

function requireFingerprintValue(value: unknown, name: string): string {
  if (!isFingerprint(value)) throw new Error(`backup pack ${name} is invalid`)
  return value
}

function requireRecordKindCode(value: unknown): 0 {
  if (value !== 0) throw new Error('backup pack record kind is invalid')
  return value
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value
  )
}

function hasExactKeys(value: object, expected: readonly string[]) {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function hexBytes(value: string) {
  if (!isFingerprint(value)) throw new Error('backup pack fingerprint is invalid')
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!
  return difference === 0
}

function concatBytes(...values: readonly Uint8Array[]) {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function uint32Bytes(value: number) {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}
