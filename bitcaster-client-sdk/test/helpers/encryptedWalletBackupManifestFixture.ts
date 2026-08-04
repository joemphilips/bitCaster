import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as Cashu from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encode, rfc8949EncodeOptions } from 'cborg'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupProof,
  type EncryptedWalletBackupKeyHandle,
} from '../../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../../src/durableCustody.ts'
import {
  finalManifestEntryBytes,
  measureFinalManifestEntryBytes,
  readEncryptedWalletBackupManifestPassABoundary,
  registerEncryptedWalletBackupManifestPassABoundaries,
} from '../../src/encryptedWalletBackupManifestPageAuthority.ts'
import {
  encodeEncryptedWalletBackupManifestPassAResult,
  measureEncryptedWalletBackupManifestPageCbor,
} from '../../src/encryptedWalletBackupManifestPassA.ts'
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  appendEncryptedWalletBackupPreparedRecordPage,
  freezeEncryptedWalletBackupPack,
  prepareEncryptedWalletBackupFrozenPackObject,
  rehydrateEncryptedWalletBackupStagedPackObject,
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  stageEncryptedWalletBackupPackObject,
  type EncryptedWalletBackupPackPersistenceStore,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackBinding,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupStagedObject,
} from '../../src/encryptedWalletBackupPackPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../../src/encryptedWalletBackupSnapshotAuthority.ts'
import {
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupSnapshotPin,
} from '../../src/encryptedWalletBackupSnapshotPersistence.ts'
import {
  measureEncryptedWalletBackupManifestSourceJoinRow,
  type EncryptedWalletBackupManifestSourceJoinRow,
} from '../../src/encryptedWalletBackupManifestSourceJoin.ts'

type StagedPackBase = Readonly<{
  store: MiniPackStore
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  buildId: string
  packId: string
  snapshotId: string
  snapshotRevision: number
}>

const vector = JSON.parse(
  await readFile(
    new URL('../../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  inputs: {
    seedHex: string
    realm: string
    proof: {
      mint: string
      unit: string
      counter: number
      keysetId: string
      amount: string
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
}

const runtime = {
  subtle: webcrypto.subtle,
  getRandomValues(target: Uint8Array) {
    throw new Error(`source join called randomness for ${target.byteLength} bytes`)
  },
}

export async function sourceFixture() {
  const page = await sourcePageFixture(1)
  return Object.freeze({ ...page, row: page.rows[0]! })
}

export async function sourcePageFixture(count: number) {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime,
  })
  const snapshots = new Map<string, EncryptedWalletBackupPreparedRecordSnapshot>()
  const rows: EncryptedWalletBackupManifestSourceJoinRow[] = []
  for (let index = 0; index < count; index += 1)
    rows.push(await sourceRow(keyHandle, seed, index, snapshots))
  rows.sort((left, right) => comparePinKeys(pinKey(left.pin), pinKey(right.pin)))
  const prepared = rows[0]!.prepared
  return Object.freeze({
    seed,
    keyHandle,
    snapshot: snapshots.get(prepared.recordId)!,
    rows: Object.freeze(rows),
    pinKeys: Object.freeze(rows.map((row) => pinKey(row.pin))),
    realm: prepared.realm,
    vaultId: prepared.vaultId,
    entryBytes: measureFinalManifestEntryBytes(prepared.canonicalManifestEntry),
    snapshotStore: {
      async withCommittedPreparedRecordSnapshotBatch(ids, read) {
        return read(ids.map((id) => snapshots.get(id)!))
      },
    },
  })
}

export async function onePageManifestFixture() {
  return manifestPageFixture(1)
}

export async function twoPageManifestFixture() {
  return manifestPageFixture(2)
}

async function manifestPageFixture(count: number) {
  const source = await sourcePageFixture(count)
  const authority = {
    realm: source.realm,
    vaultId: source.vaultId,
    enrollmentEpoch: 1,
    parentGeneration: null,
    parentManifestDigest: null,
    parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
    generation: 1,
    snapshotNonce: '22'.repeat(16),
    snapshotId: source.snapshot.snapshotId,
    snapshotRevision: source.snapshot.snapshotRevision,
  }
  const control = issueEncryptedWalletBackupFrozenSnapshotControl({}, authority)
  const current = Object.freeze({
    schemaVersion: 1 as const,
    ...authority,
    state: 'sealed' as const,
    recordCount: count,
    canonicalPinBytes: source.rows.reduce((total, row) => total + row.pin.byteLength, 0),
    sealRunRevision: 1,
    recordSetRoot: '33'.repeat(32),
    version: 2,
  })
  const persistedControl = encodeEncryptedWalletBackupFrozenSnapshot(current)
  const result = encodeEncryptedWalletBackupManifestPassAResult({
    schemaVersion: 1,
    realm: current.realm,
    vaultId: current.vaultId,
    snapshotId: current.snapshotId,
    snapshotRevision: current.snapshotRevision,
    sealedControlVersion: current.version,
    sealRunRevision: current.sealRunRevision,
    sealedControlDigest: bytesToHex(sha256(persistedControl)),
    recordSetRoot: current.recordSetRoot,
    generation: current.generation,
    snapshotNonce: current.snapshotNonce,
    recordCount: current.recordCount,
    canonicalPinBytes: current.canonicalPinBytes,
    totalCanonicalManifestEntryBytes: source.rows.reduce(
      (total, row) => total + measureFinalManifestEntryBytes(row.prepared.canonicalManifestEntry),
      0,
    ),
    pageCount: count,
    boundaries: source.rows.map((row) => ({
      entryCount: 1,
      canonicalEntryBytes: measureFinalManifestEntryBytes(row.prepared.canonicalManifestEntry),
      plannedCanonicalPageBytes: measureEncryptedWalletBackupManifestPageCbor({
        generation: current.generation,
        pageIndex: 1_023,
        pageCount: 1_024,
        entryCount: 1,
        canonicalEntryBytes: measureFinalManifestEntryBytes(row.prepared.canonicalManifestEntry),
      }),
    })),
  })
  const staged = await stagedPackFixture(source, source.rows, 'build-a', 'pack-a')
  const sourceCalls = { count: 0 }
  const packCalls = { count: 0 }
  return Object.freeze({
    ...source,
    authority,
    control,
    current,
    persistedControl,
    result,
    sourceCalls,
    packCalls,
    sourceStore: {
      async readSourcePage(after: Uint8Array | null, limit: number) {
        sourceCalls.count += 1
        const index =
          after === null ? -1 : source.pinKeys.findIndex((key) => bytesEqual(key, after))
        const start = index + 1
        if (limit !== 1 || (after !== null && index < 0))
          throw new Error('fixture source page is invalid')
        const rows = source.rows.slice(start, start + limit).map(copyRow)
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: {
      async rehydrateStagedPack() {
        packCalls.count += 1
        return staged.rehydrate()
      },
    },
  })
}

export function boundaryFor(
  fixture: Awaited<ReturnType<typeof sourceFixture>>,
  entryCount: number,
  canonicalEntryBytes: number,
) {
  const result = {}
  registerEncryptedWalletBackupManifestPassABoundaries({
    result,
    resultDigest: '00'.repeat(32),
    realm: fixture.realm,
    vaultId: fixture.vaultId,
    snapshotId: 'source-join-snapshot',
    snapshotRevision: 1,
    sealedControlVersion: 1,
    sealRunRevision: 1,
    sealedControlDigest: '00'.repeat(32),
    generation: 1,
    snapshotNonce: '00'.repeat(16),
    boundaries: [
      { entryCount, canonicalEntryBytes, plannedCanonicalPageBytes: canonicalEntryBytes + 32 },
    ],
  })
  return readEncryptedWalletBackupManifestPassABoundary(result, 0)
}

export function copyRow(
  row: EncryptedWalletBackupManifestSourceJoinRow,
): EncryptedWalletBackupManifestSourceJoinRow {
  return {
    ...row,
    pin: row.pin.slice(),
    prepared: structuredClone(row.prepared) as PersistedPreparedEncryptedWalletBackupRecord,
  }
}

export async function stagedPackFixture(
  fixture: Awaited<ReturnType<typeof sourcePageFixture>>,
  rows: readonly EncryptedWalletBackupManifestSourceJoinRow[],
  buildId: string,
  packId: string,
) {
  const store = new MiniPackStore()
  const base: StagedPackBase = {
    store,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    buildId,
    packId,
    snapshotId: fixture.snapshot.snapshotId,
    snapshotRevision: fixture.snapshot.snapshotRevision,
  }
  const versions = await appendStagedPackRows(base, rows)
  const frozen = await freezeEncryptedWalletBackupPack({
    ...base,
    expectedBuildVersion: versions.buildVersion,
    expectedPackVersion: versions.packVersion,
  })
  const prepared = await prepareStagedPackObject(base, frozen)
  const staged = await stageEncryptedWalletBackupPackObject({
    store,
    prepared,
    expectedBuildVersion: frozen.buildCursor.version,
    expectedPackVersion: frozen.packControl.version,
  })
  return stagedPackHandle(base, staged)
}

export function sourceBytes(rows: readonly EncryptedWalletBackupManifestSourceJoinRow[]): number {
  return rows.reduce(
    (total, row) => total + measureEncryptedWalletBackupManifestSourceJoinRow(row),
    0,
  )
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

function sourceRow(
  keyHandle: EncryptedWalletBackupKeyHandle,
  seed: Uint8Array,
  index: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): Promise<EncryptedWalletBackupManifestSourceJoinRow> {
  const proof = vector.inputs.proof
  const counter = proof.counter + index
  const secret = counterSecret(seed, proof.keysetId, counter)
  const snapshot = sourceSnapshot(seed, proof, secret, counter)
  snapshots.set(snapshot.recordId, snapshot)
  return prepareSourceRecord(keyHandle, seed, counter, secret, snapshots).then((prepared) =>
    Object.freeze({ pin: sourcePin(prepared), prepared, buildId: 'build-a', packId: 'pack-a' }),
  )
}

function sourceSnapshot(
  seed: Uint8Array,
  proof: (typeof vector)['inputs']['proof'],
  secret: string,
  counter: number,
): EncryptedWalletBackupPreparedRecordSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: 'source-join-snapshot',
    snapshotRevision: 1,
    recordId: counterRecordId(seed, proof, secret),
    commitment: counterCommitment(proof, secret, counter),
    recordKindCode: 0,
  })
}

async function prepareSourceRecord(
  keyHandle: EncryptedWalletBackupKeyHandle,
  seed: Uint8Array,
  counter: number,
  secret: string,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
) {
  const proof = vector.inputs.proof
  const record = await prepareEncryptedWalletBackupProof({
    keyHandle,
    seed,
    mint: proof.mint,
    unit: proof.unit,
    counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret,
      C: proof.signatureHex,
      dleq: proof.dleq,
    },
    proofKind: 'ordinary',
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: proof.createdAtUnixSeconds,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
    proofSnapshotStore: {
      async withCommittedProofSnapshot(id, read) {
        return read(proofSnapshot(snapshots.get(id)!))
      },
    },
  })
  return sealPreparedEncryptedWalletBackupRecord({
    keyHandle,
    seed,
    record,
    snapshotStore: {
      async withCommittedPreparedRecordSnapshot(id, read) {
        return read(snapshots.get(id)!)
      },
    },
  })
}

function sourcePin(prepared: PersistedPreparedEncryptedWalletBackupRecord): Uint8Array {
  const source = decodeEncryptedWalletBackupPreparedSourceDescriptor(
    encodeEncryptedWalletBackupPreparedSourceDescriptor(prepared),
  )
  return encodeEncryptedWalletBackupSnapshotPin({
    schemaVersion: 1,
    realm: source.realm,
    vaultId: source.vaultId,
    snapshotId: prepared.snapshotId,
    snapshotRevision: prepared.snapshotRevision,
    recordKindCode: 0,
    recordId: source.recordId,
    commitment: source.commitment,
    sourceBodyReference: source.bodyReference,
    sourceRevision: source.revision,
    canonicalManifestEntryBytes: source.canonicalManifestEntryBytes,
  })
}

async function appendStagedPackRows(
  base: StagedPackBase,
  rows: readonly EncryptedWalletBackupManifestSourceJoinRow[],
) {
  let buildVersion = 0
  let packVersion = 0
  for (let start = 0; start < rows.length; start += 127) {
    const appended = await appendEncryptedWalletBackupPreparedRecordPage({
      ...base,
      expectedBuildVersion: buildVersion,
      expectedPackVersion: packVersion,
      records: rows
        .slice(start, start + 127)
        .map((row) => row.prepared)
        .sort((left, right) => left.recordId.localeCompare(right.recordId)),
    })
    buildVersion = appended.buildCursor.version
    packVersion = appended.packControl.version
  }
  return { buildVersion, packVersion }
}

function prepareStagedPackObject(
  base: StagedPackBase,
  frozen: Awaited<ReturnType<typeof freezeEncryptedWalletBackupPack>>,
) {
  return prepareEncryptedWalletBackupFrozenPackObject({
    ...base,
    expectedBuildVersion: frozen.buildCursor.version,
    expectedPackVersion: frozen.packControl.version,
    generation: 1,
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
  })
}

function stagedPackHandle(
  base: StagedPackBase,
  staged: Awaited<ReturnType<typeof stageEncryptedWalletBackupPackObject>>,
) {
  return Object.freeze({
    async rehydrate() {
      return rehydrateEncryptedWalletBackupStagedPackObject({
        ...base,
        expectedBuildVersion: staged.buildCursor.version,
        expectedPackVersion: staged.packControl.version,
      })
    },
    expectedEntry(row: EncryptedWalletBackupManifestSourceJoinRow) {
      return finalManifestEntryBytes(
        row.prepared.canonicalManifestEntry,
        fromHex(staged.stagedObject.objectId),
        fromHex(staged.stagedObject.digest),
      )
    },
  })
}

class MiniPackStore implements EncryptedWalletBackupPackPersistenceStore {
  build: PersistedEncryptedWalletBackupBuildCursor | null = null
  pack: PersistedEncryptedWalletBackupPackControl | null = null
  prepared = new Map<string, PersistedEncryptedWalletBackupPreparedBuildRecord>()
  bindings = new Map<string, PersistedEncryptedWalletBackupPackBinding>()
  staged = new Map<string, PersistedEncryptedWalletBackupStagedObject>()
  async withExactVersionTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupPackPersistenceStore['withExactVersionTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupPackPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    if (
      (this.build?.version ?? 0) !== expected.buildVersion ||
      (this.pack?.version ?? 0) !== expected.packVersion
    )
      throw new Error('mini pack store version is stale')
    return use(this.transaction())
  }
  private transaction(): EncryptedWalletBackupPackPersistenceTransaction {
    return {
      readBuildCursor: async (buildId) =>
        this.build?.buildId === buildId ? structuredClone(this.build) : null,
      readPackControl: async (buildId, packId) =>
        this.pack?.buildId === buildId && this.pack.packId === packId
          ? structuredClone(this.pack)
          : null,
      readPackRecordPage: (buildId, packId, after, limit, maxBytes) =>
        this.readPage(buildId, packId, after, limit, maxBytes),
      readStagedObject: async (buildId, packId) => {
        const value = this.staged.get(`${buildId}:${packId}`)
        return value === undefined ? null : structuredClone(value)
      },
      insertPreparedRecord: async (row) => {
        this.prepared.set(`${row.buildId}:${row.recordId}`, structuredClone(row))
      },
      insertPackBinding: async (row) => {
        this.bindings.set(`${row.buildId}:${row.packId}:${row.recordId}`, structuredClone(row))
      },
      writeBuildCursor: async (row) => {
        this.build = structuredClone(row)
      },
      writePackControl: async (row) => {
        this.pack = structuredClone(row)
      },
      insertStagedObject: async (row) => {
        this.staged.set(`${row.buildId}:${row.packId}`, structuredClone(row))
      },
    }
  }
  private async readPage(
    buildId: string,
    packId: string,
    after: string | null,
    limit: number,
    maxBytes: number,
  ) {
    const rows = [...this.bindings.values()]
      .filter(
        (row) =>
          row.buildId === buildId &&
          row.packId === packId &&
          (after === null || row.recordId > after),
      )
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .slice(0, limit)
      .map((binding) => ({
        binding: serializeEncryptedWalletBackupPackBinding(binding),
        prepared: serializeEncryptedWalletBackupPreparedBuildRecord(
          this.prepared.get(`${binding.buildId}:${binding.recordId}`)!,
        ),
      }))
    const serializedBytes = rows.reduce(
      (total, row) => total + row.binding.byteLength + row.prepared.byteLength,
      0,
    )
    if (serializedBytes > maxBytes) throw new Error('mini pack page exceeds max bytes')
    return { rows, serializedBytes }
  }
}

function pinKey(pin: Uint8Array): Uint8Array {
  const decoded = decodeEncryptedWalletBackupSnapshotPin(pin)
  return encode(
    [decoded.recordKindCode, fromHex(decoded.recordId), fromHex(decoded.commitment)],
    rfc8949EncodeOptions,
  )
}
function comparePinKeys(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}
function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'))
}
function counterSecret(seed: Uint8Array, keysetId: string, counter: number): string {
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (index: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, keysetId)
  return bytesToHex(derive(counter).secret)
}
function counterRecordId(
  seed: Uint8Array,
  proof: (typeof vector)['inputs']['proof'],
  secret: string,
): string {
  return deriveDurableCustodyProofId({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(seed),
    }),
    normalizedMint: proof.mint,
    unit: proof.unit,
    keysetId: proof.keysetId,
    secret,
  })
}
function counterCommitment(
  proof: (typeof vector)['inputs']['proof'],
  secret: string,
  counter: number,
): string {
  return bytesToHex(
    sha256(
      encode(
        [
          1,
          'proof-record-commitment',
          proof.mint,
          proof.unit,
          [2, proof.keysetId],
          proof.amount,
          new TextEncoder().encode(secret),
          fromHex(proof.signatureHex),
          [fromHex(proof.dleq.e), fromHex(proof.dleq.s), fromHex(proof.dleq.r)],
          counter,
          0,
          null,
          proof.createdAtUnixSeconds,
          proof.updatedAtUnixSeconds,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  )
}
function proofSnapshot(snapshot: EncryptedWalletBackupPreparedRecordSnapshot) {
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.snapshotRevision,
    proofId: snapshot.recordId,
    proofCommitment: snapshot.commitment,
    proofKind: 'ordinary' as const,
    ctfMetadata: null,
    terminalOperationId: null,
    conditionalKeysetEvidence: null,
    provenance: 'wallet-seed' as const,
    operationBinding: 'terminally-unlinked' as const,
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: {
      openOrderCollateral: 'absent' as const,
      outbox: 'absent' as const,
      retryCursor: 'absent' as const,
      replayTombstone: 'absent' as const,
      dependentWork: 'absent' as const,
    },
    derivationLocator: 'committed' as const,
  })
}
