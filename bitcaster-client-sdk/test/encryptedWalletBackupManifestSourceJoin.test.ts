import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import * as Cashu from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encode, rfc8949EncodeOptions } from 'cborg'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupManifestPage,
  prepareEncryptedWalletBackupProof,
  type EncryptedWalletBackupKeyHandle,
} from '../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import {
  readEncryptedWalletBackupManifestPassABoundary,
  readEncryptedWalletBackupManifestEntryCapability,
  registerEncryptedWalletBackupManifestPassABoundaries,
} from '../src/encryptedWalletBackupManifestPageAuthority.ts'
import {
  joinEncryptedWalletBackupManifestSourcePage,
  measureEncryptedWalletBackupManifestSourceJoinRow,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES,
  type EncryptedWalletBackupManifestSourceJoinRow,
} from '../src/encryptedWalletBackupManifestSourceJoin.ts'
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  finalManifestEntryBytes,
  measureFinalManifestEntryBytes,
} from '../src/encryptedWalletBackupManifestPageAuthority.ts'
import {
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupSnapshotPin,
} from '../src/encryptedWalletBackupSnapshotPersistence.ts'
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
} from '../src/encryptedWalletBackupPackPersistence.ts'

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
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
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
  expected: { derivedSecretHex: string; proofIdHex: string; commitmentHex: string }
}

const runtime = {
  subtle: webcrypto.subtle,
  getRandomValues(target: Uint8Array) {
    throw new Error(`source join called randomness for ${target.byteLength} bytes`)
  },
}

test('source join rejects a 256-row physical page before authentication', async () => {
  const fixture = await sourceFixture()
  const rows = Array.from({ length: 256 }, () => copyRow(fixture.row))
  let requested = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage(_after, limit, maxBytes) {
          requested = limit
          assert.equal(maxBytes, ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES)
          return { rows, serializedBytes: sourceBytes(rows) }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          throw new Error('pack provider reached')
        },
      },
      boundary: boundaryFor(fixture, 256, 256 * fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: fixture.snapshotStore,
      exclusiveAfter: null,
    }),
    /source page is invalid/,
  )
  assert.equal(requested, 255)
})

test('source join rejects byte-limit and keyset-order failures before staged-pack access', async () => {
  const fixture = await sourceFixture()
  for (const fault of ['bytes', 'order'] as const) {
    let packCalls = 0
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            if (fault === 'bytes') {
              return {
                rows: [copyRow(fixture.row)],
                serializedBytes:
                  ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES + 1,
              }
            }
            return {
              rows: [copyRow(fixture.row), copyRow(fixture.row)],
              serializedBytes: sourceBytes([copyRow(fixture.row), copyRow(fixture.row)]),
            }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            packCalls += 1
            throw new Error('pack provider reached')
          },
        },
        boundary: boundaryFor(
          fixture,
          fault === 'bytes' ? 1 : 2,
          (fault === 'bytes' ? 1 : 2) * fixture.entryBytes,
        ),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /source page is invalid|keyset order is invalid/,
    )
    assert.equal(packCalls, 0)
  }
})

test('source join rejects under-reported, over-reported, and oversized application bytes', async () => {
  const fixture = await sourceFixture()
  const exact = sourceBytes([fixture.row])
  for (const bytes of [exact - 1, exact + 1, 1_048_577]) {
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            return { rows: [copyRow(fixture.row)], serializedBytes: bytes }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            throw new Error('reached')
          },
        },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /source page is invalid/,
    )
  }
})

test('source join rejects one measured source row above 1 MiB before authentication', async () => {
  const fixture = await sourceFixture()
  const row = copyRow(fixture.row)
  ;(row.prepared as { canonicalRecord: Uint8Array }).canonicalRecord = new Uint8Array(1_048_576)
  assert.ok(measureEncryptedWalletBackupManifestSourceJoinRow(row) > 1_048_576)
  let snapshotCalls = 0
  let packCalls = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage() {
          return { rows: [row], serializedBytes: 1_048_576 }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          packCalls += 1
          throw new Error('reached')
        },
      },
      boundary: boundaryFor(fixture, 1, fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: {
        async withCommittedPreparedRecordSnapshotBatch(ids, read) {
          snapshotCalls += 1
          return fixture.snapshotStore.withCommittedPreparedRecordSnapshotBatch(ids, read)
        },
      },
      exclusiveAfter: null,
    }),
    /source page is invalid/,
  )
  assert.equal(snapshotCalls, 0)
  assert.equal(packCalls, 0)
})

test('source join rejects exact pin and prepared-body substitutions before capability issue', async () => {
  const fixture = await sourceFixture()
  for (const fault of ['pin', 'body', 'revision'] as const) {
    const row = copyRow(fixture.row)
    if (fault === 'pin') row.pin[row.pin.byteLength - 1]! ^= 1
    if (fault === 'body') row.prepared.canonicalRecord[0]! ^= 1
    if (fault === 'revision') row.prepared.snapshotRevision += 1
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            return { rows: [row], serializedBytes: sourceBytes([row]) }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            throw new Error('pack provider reached')
          },
        },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /binding is invalid|capability|snapshot/,
    )
  }
})

test('source join issues ordered capabilities from an SDK-rehydrated staged pack', async () => {
  const fixture = await sourceFixture()
  const staged = await stagedPackFixture(fixture, [fixture.row], 'build-a', 'pack-a')
  let packCalls = 0
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage(after, limit) {
        assert.equal(after, null)
        assert.equal(limit, 1)
        const rows = [copyRow(fixture.row)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: {
      async rehydrateStagedPack(input) {
        assert.equal(input.buildId, 'build-a')
        assert.equal(input.packId, 'pack-a')
        packCalls += 1
        return staged.rehydrate()
      },
    },
    boundary: boundaryFor(fixture, 1, fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.equal(packCalls, 1)
  assert.equal(result.entries.length, 1)
  assert.equal(result.evidence.firstPinKey?.byteLength, result.evidence.lastPinKey?.byteLength)
  assert.equal(
    bytesEqual(
      readEncryptedWalletBackupManifestEntryCapability(result.entries[0]!),
      staged.expectedEntry(fixture.row),
    ),
    true,
    'source join capability bytes changed',
  )
})

test('source join capabilities prepare their exact manifest page', async () => {
  const fixture = await sourceFixture()
  const staged = await stagedPackFixture(fixture, [fixture.row], 'build-a', 'pack-a')
  const boundary = boundaryFor(fixture, 1, fixture.entryBytes)
  const joined = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage() {
        const rows = [copyRow(fixture.row)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
    boundary,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  const page = await prepareEncryptedWalletBackupManifestPage({
    keyHandle: fixture.keyHandle,
    boundary,
    entries: joined.entries,
    runtime: { subtle: webcrypto.subtle, getRandomValues: (target) => target.fill(7) },
  })
  assert.equal(page.kindCode, 2)
  assert.equal(page.generation, 1)
})

test('source join streams 256 exact rows as 255+1 and preserves output pin-key order', async () => {
  const fixture = await sourcePageFixture(256)
  const staged = await stagedPackFixture(fixture, fixture.rows, 'build-a', 'pack-a')
  const limits: number[] = []
  const cursors: Array<Uint8Array | null> = []
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage(after, limit) {
        limits.push(limit)
        cursors.push(after?.slice() ?? null)
        const start =
          after === null ? 0 : fixture.pinKeys.findIndex((key) => bytesEqual(key, after)) + 1
        const rows = fixture.rows.slice(start, start + limit).map(copyRow)
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
    boundary: boundaryFor(fixture, fixture.rows.length, fixture.rows.length * fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.deepEqual(limits, [255, 1])
  assert.equal(cursors[0], null)
  assert.equal(bytesEqual(cursors[1]!, fixture.pinKeys[254]!), true, 'physical cursor changed')
  assert.equal(
    bytesEqual(result.evidence.firstPinKey!, fixture.pinKeys[0]!),
    true,
    'first pin key changed',
  )
  assert.equal(
    bytesEqual(result.evidence.lastPinKey!, fixture.pinKeys[255]!),
    true,
    'last pin key changed',
  )
  assert.equal(result.entries.length, 256)
  for (let index = 0; index < result.entries.length; index += 1) {
    assert.equal(
      bytesEqual(
        readEncryptedWalletBackupManifestEntryCapability(result.entries[index]!),
        staged.expectedEntry(fixture.rows[index]!),
      ),
      true,
      'source join output order changed',
    )
  }
})

test('source join rejects SDK-issued wrong build or pack before entry issue', async () => {
  const fixture = await sourceFixture()
  for (const [buildId, packId] of [
    ['build-b', 'pack-a'],
    ['build-a', 'pack-b'],
  ]) {
    const staged = await stagedPackFixture(fixture, [fixture.row], buildId, packId)
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            const rows = [copyRow(fixture.row)]
            return { rows, serializedBytes: sourceBytes(rows) }
          },
        },
        stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /staged pack identity is invalid/,
    )
  }
})

test('source join rejects a substituted Pass-A scope before pack access', async () => {
  const fixture = await sourceFixture()
  let packCalls = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage() {
          const rows = [copyRow(fixture.row)]
          return { rows, serializedBytes: sourceBytes(rows) }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          packCalls += 1
          throw new Error('reached')
        },
      },
      boundary: boundaryFor({ ...fixture, vaultId: '00'.repeat(32) }, 1, fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: fixture.snapshotStore,
      exclusiveAfter: null,
    }),
    /source scope is invalid/,
  )
  assert.equal(packCalls, 0)
})

test('source join processes distinct real staged packs sequentially in source order', async () => {
  const fixture = await sourcePageFixture(2)
  const first = { ...fixture.rows[0]!, buildId: 'build-a', packId: 'pack-a' }
  const second = { ...fixture.rows[1]!, buildId: 'build-b', packId: 'pack-b' }
  const stages = new Map([
    ['build-a:pack-a', await stagedPackFixture(fixture, [first], first.buildId, first.packId)],
    ['build-b:pack-b', await stagedPackFixture(fixture, [second], second.buildId, second.packId)],
  ])
  let inFlight = 0
  let maximumInFlight = 0
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage() {
        const rows = [copyRow(first), copyRow(second)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: {
      async rehydrateStagedPack(input) {
        inFlight += 1
        maximumInFlight = Math.max(maximumInFlight, inFlight)
        try {
          return await stages.get(`${input.buildId}:${input.packId}`)!.rehydrate()
        } finally {
          inFlight -= 1
        }
      },
    },
    boundary: boundaryFor(fixture, 2, 2 * fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.equal(maximumInFlight, 1)
  assertJoinedSourceOrder(result.entries, stages, first, second)
})

function assertJoinedSourceOrder(
  entries: readonly EncryptedWalletBackupManifestEntryCapability[],
  stages: ReadonlyMap<string, Awaited<ReturnType<typeof stagedPackFixture>>>,
  first: EncryptedWalletBackupManifestSourceJoinRow,
  second: EncryptedWalletBackupManifestSourceJoinRow,
): void {
  for (const [index, key, row, message] of [
    [0, 'build-a:pack-a', first, 'first source entry changed'],
    [1, 'build-b:pack-b', second, 'second source entry changed'],
  ] as const) {
    assert.equal(
      bytesEqual(
        readEncryptedWalletBackupManifestEntryCapability(entries[index]!),
        stages.get(key)!.expectedEntry(row),
      ),
      true,
      message,
    )
  }
}

async function sourceFixture() {
  const page = await sourcePageFixture(1)
  return Object.freeze({ ...page, row: page.rows[0]! })
}

async function sourcePageFixture(count: number) {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime,
  })
  const snapshots = new Map<string, EncryptedWalletBackupPreparedRecordSnapshot>()
  const rows: EncryptedWalletBackupManifestSourceJoinRow[] = []
  for (let index = 0; index < count; index += 1) {
    const row = await sourceRow(keyHandle, seed, index, snapshots)
    rows.push(row)
  }
  rows.sort((left, right) => comparePinKeys(pinKey(left.pin), pinKey(right.pin)))
  const snapshot = snapshots.get(rows[0]!.prepared.recordId)!
  const prepared = rows[0]!.prepared
  return Object.freeze({
    seed,
    keyHandle,
    snapshot,
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

async function sourceRow(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  seed: Uint8Array,
  index: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): Promise<EncryptedWalletBackupManifestSourceJoinRow> {
  const proof = vector.inputs.proof
  const counter = proof.counter + index
  const secret = counterSecret(seed, proof.keysetId, counter)
  const snapshot = sourceSnapshot(seed, proof, secret, counter)
  snapshots.set(snapshot.recordId, snapshot)
  const prepared = await prepareSourceRecord(keyHandle, seed, counter, secret, snapshots)
  return Object.freeze({ pin: sourcePin(prepared), prepared, buildId: 'build-a', packId: 'pack-a' })
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
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
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

function boundaryFor(
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

function copyRow(
  row: EncryptedWalletBackupManifestSourceJoinRow,
): EncryptedWalletBackupManifestSourceJoinRow {
  return {
    ...row,
    pin: row.pin.slice(),
    prepared: structuredClone(row.prepared) as PersistedPreparedEncryptedWalletBackupRecord,
  }
}

async function stagedPackFixture(
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

async function prepareStagedPackObject(
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
    this.requireVersions(expected)
    return use(this.transaction())
  }

  private requireVersions(
    expected: Parameters<
      EncryptedWalletBackupPackPersistenceStore['withExactVersionTransaction']
    >[0],
  ): void {
    if (
      (this.build?.version ?? 0) !== expected.buildVersion ||
      (this.pack?.version ?? 0) !== expected.packVersion
    )
      throw new Error('mini pack store version is stale')
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

function sourceBytes(rows: readonly EncryptedWalletBackupManifestSourceJoinRow[]): number {
  return rows.reduce(
    (total, row) => total + measureEncryptedWalletBackupManifestSourceJoinRow(row),
    0,
  )
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'))
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
