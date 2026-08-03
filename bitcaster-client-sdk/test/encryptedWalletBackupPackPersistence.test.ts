import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import * as Cashu from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encode, rfc8949EncodeOptions } from 'cborg'
import { deriveDurableCustodyProofId, deriveDurableCustodyScopeId } from '../src/durableCustody.ts'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupProof,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRuntime,
} from '../src/encryptedWalletBackup.ts'
import {
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES,
  appendEncryptedWalletBackupPreparedRecordPage,
  freezeEncryptedWalletBackupPack,
  measureEncryptedWalletBackupPackTransaction,
  prepareEncryptedWalletBackupFrozenPackObject,
  prepareEncryptedWalletBackupFrozenPackObjectImmediately,
  rehydrateEncryptedWalletBackupStagedPackObject,
  stageEncryptedWalletBackupPackObject,
  validateEncryptedWalletBackupPackSerializedPageByteEvidence,
  deserializeEncryptedWalletBackupPackBinding,
  deserializeEncryptedWalletBackupPreparedBuildRecord,
  type EncryptedWalletBackupPackPersistenceStore,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type EncryptedWalletBackupPackRecordPageRow,
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackBinding,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupStagedObject,
} from '../src/encryptedWalletBackupPackPersistence.ts'

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  inputs: {
    seedHex: string
    proof: {
      mint: string
      unit: string
      keysetId: string
      amount: string
      counter: number
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
}

const SEED = fromHex(vector.inputs.seedHex)

test('pack persistence counts updated rows as both reads and writes at the 1 MiB boundary', () => {
  const half = new Uint8Array(ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES / 2)
  assert.equal(
    measureEncryptedWalletBackupPackTransaction({
      readRows: [half],
      writtenRows: [half],
    }),
    ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
  )
  assert.throws(
    () =>
      measureEncryptedWalletBackupPackTransaction({
        readRows: [half],
        writtenRows: [half, Uint8Array.of(0)],
      }),
    /transaction exceeds the aggregate serialized byte limit/,
  )
})

test('serialized page byte evidence rejects overflow before row decoding', () => {
  for (const size of [
    ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES - 1,
    ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
  ]) {
    validateEncryptedWalletBackupPackSerializedPageByteEvidence(
      {
        rows: [{ binding: Uint8Array.of(0), prepared: new Uint8Array(size - 1) }],
        serializedBytes: size,
      },
      1,
      ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
    )
  }
  assert.throws(
    () =>
      validateEncryptedWalletBackupPackSerializedPageByteEvidence(
        {
          rows: [
            {
              binding: Uint8Array.of(0),
              prepared: new Uint8Array(ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES),
            },
          ],
          serializedBytes: ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES + 1,
        },
        1,
        ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
      ),
    /exceeds its byte limit/,
  )
})

test('exact-version transaction rejects missing, repeated, and substituted callbacks', async () => {
  const fixture = await preparedFixture(1)
  for (const mode of ['never', 'double', 'substituted'] as const) {
    const store = new MemoryPackStore()
    store.callbackMode = mode
    const before = store.snapshot()
    await assert.rejects(appendPage(fixture, store, fixture.records, 0, 0), /callback|exact/)
    assertStoreSnapshot(store, before)
  }
})

test('exact-version transactions preserve callback result and atomicity across microtasks', async () => {
  const fixture = await preparedFixture(1)
  const store = new MemoryPackStore()
  store.callbackMode = 'deferred'
  store.crossMicrotask = true
  const appended = await appendPage(fixture, store, fixture.records, 0, 0)

  assert.equal(appended.packControl.version, 1)
  assert.equal(store.build?.version, 1)
  assert.equal(store.pack?.version, 1)
  assert.equal(store.prepared.size, 1)
  assert.equal(store.bindings.size, 1)
  const frozen = await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, fixture.keyHandle, 1, 1),
  })
  const prepared = await preparePack(fixture, store, fixture.keyHandle, 2, 2)
  const staged = await stageEncryptedWalletBackupPackObject({
    store,
    prepared,
    expectedBuildVersion: 2,
    expectedPackVersion: 2,
  })

  assert.equal(frozen.packControl.state, 'frozen')
  assert.equal(staged.idempotent, false)
  assert.equal(store.staged.size, 1)
})

test('prepared snapshot batches reject missing, repeated, deferred, and substituted callbacks', async () => {
  const fixture = await preparedFixture(1)
  for (const mode of ['never', 'double', 'deferred', 'substituted'] as const) {
    const snapshotStore = maliciousBatchSnapshotStore(fixture.snapshotStore, mode)
    await assert.rejects(
      appendEncryptedWalletBackupPreparedRecordPage({
        ...packInput({ ...fixture, snapshotStore }, new MemoryPackStore(), fixture.keyHandle, 0, 0),
        records: fixture.records,
      }),
      /snapshot batch callback|synchronous and exact/,
    )
  }
})

test('append authenticates and persists one synchronous caller-owned snapshot', async () => {
  const fixture = await preparedFixture(3)
  const records = fixture.records.slice(0, 2).map((row) => structuredClone(row))
  const expected = records.map((row) => structuredClone(row))
  const snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore = {
    withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      const pending = fixture.snapshotStore.withCommittedPreparedRecordSnapshotBatch(
        recordIds,
        read,
      )
      records[0]!.canonicalRecord[0]! ^= 1
      records.push(structuredClone(fixture.records[2]!))
      return pending
    },
  }
  const store = new MemoryPackStore()
  await appendEncryptedWalletBackupPreparedRecordPage({
    ...packInput({ ...fixture, snapshotStore }, store, fixture.keyHandle, 0, 0),
    records,
  })
  assert.equal(store.prepared.size, 2)
  assert.equal(
    isDeepStrictEqual(
      [...store.prepared.values()].map(({ prepared }) => prepared),
      expected,
    ),
    true,
    'append persisted bytes outside its authenticated input snapshot',
  )
})

test('one key handle imports its preparation HMAC key once', async () => {
  const counter = { hmacImports: 0, hmacVerifications: 0 }
  const fixture = await preparedFixture(3, 0, countingHmacRuntime(counter))
  const store = new MemoryPackStore()
  assert.equal(counter.hmacImports, 1)
  const oversized = {
    ...structuredClone(fixture.records[0]!),
    canonicalRecord: new Uint8Array(245_760),
  }
  await assert.rejects(
    appendPage(fixture, store, [oversized], 0, 0),
    /canonical chunk exceeds the limit/,
  )
  assert.equal(counter.hmacVerifications, 0)
  await appendPage(fixture, store, fixture.records, 0, 0)
  await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, fixture.keyHandle, 1, 1),
  })
  assert.equal(counter.hmacImports, 1)
})

test('append stores normalized rows once and exact-CAS advances compact controls', async () => {
  const fixture = await preparedFixture(3)
  const store = new MemoryPackStore()
  await assert.rejects(
    appendPage(fixture, store, new Array(257).fill(fixture.records[0]!), 0, 0),
    /append record count/,
  )

  const first = await appendPage(fixture, store, fixture.records.slice(0, 2), 0, 0)
  assert.ok(first.transactionBytes > 0)
  assert.equal(first.packControl.recordCount, 2)
  assert.equal(store.prepared.size, 2)
  assert.equal(store.bindings.size, 2)
  assert.equal('records' in first.packControl, false)
  assert.equal('canonicalRecord' in first.buildCursor, false)
  assert.equal(store.expectations[0]!.realm, fixture.realm)
  assert.equal(store.expectations[0]!.vaultId, fixture.keyHandle.vaultId)
  assert.equal(store.expectations[0]!.snapshotId, 'pack-snapshot')
  assert.equal(store.expectations[0]!.snapshotRevision, 1)
  for (const row of [
    first.buildCursor,
    first.packControl,
    ...store.prepared.values(),
    ...store.bindings.values(),
  ]) {
    assert.equal(row.realm, fixture.realm)
    assert.equal(row.vaultId, fixture.keyHandle.vaultId)
    assert.equal(row.snapshotId, 'pack-snapshot')
    assert.equal(row.snapshotRevision, 1)
  }

  const second = await appendPage(fixture, store, fixture.records.slice(2), 1, 1)
  assert.equal(second.packControl.recordCount, 3)
  assert.equal(store.prepared.size, 3)
  await assert.rejects(appendPage(fixture, store, fixture.records.slice(2), 1, 1), /stale/)

  const rollbackStore = new MemoryPackStore()
  const before = rollbackStore.snapshot()
  rollbackStore.failAfterFirstInsert = true
  const extra = await preparedFixture(1, 1_000)
  await assert.rejects(
    appendPage(extra, rollbackStore, extra.records, 0, 0),
    /injected transaction failure/,
  )
  assertStoreSnapshot(rollbackStore, before)

  const duplicatePreparedStore = new MemoryPackStore()
  const record = fixture.records[0]!
  duplicatePreparedStore.prepared.set(`build-a:${record.recordId}`, {
    schemaVersion: 1,
    buildId: 'build-a',
    realm: fixture.realm,
    vaultId: fixture.keyHandle.vaultId,
    snapshotId: 'pack-snapshot',
    snapshotRevision: 1,
    recordId: record.recordId,
    prepared: structuredClone(record),
  })
  await assert.rejects(
    appendPage(fixture, duplicatePreparedStore, [record], 0, 0),
    /unique build\/record/,
  )

  const duplicateBindingStore = new MemoryPackStore()
  duplicateBindingStore.bindings.set(`build-a:pack-a:${record.recordId}`, {
    schemaVersion: 1,
    buildId: 'build-a',
    packId: 'pack-a',
    realm: fixture.realm,
    vaultId: fixture.keyHandle.vaultId,
    snapshotId: 'pack-snapshot',
    snapshotRevision: 1,
    recordId: record.recordId,
    ordinal: 0,
  })
  await assert.rejects(
    appendPage(fixture, duplicateBindingStore, [record], 0, 0),
    /unique build\/pack\/record/,
  )
  assert.equal(duplicateBindingStore.prepared.size, 0)
})

test('fake adapter stops canonical row acquisition at maxBytes before decoding', async () => {
  const fixture = await preparedFixture(3)
  const store = new MemoryPackStore()
  await appendPage(fixture, store, fixture.records, 0, 0)
  const binding = [...store.bindings.values()].sort((left, right) =>
    left.recordId.localeCompare(right.recordId),
  )[0]!
  const firstRowBytes =
    serializeEncryptedWalletBackupPackBinding(binding).byteLength +
    serializeEncryptedWalletBackupPreparedBuildRecord(
      store.prepared.get(`${binding.buildId}:${binding.recordId}`)!,
    ).byteLength
  store.pageRowsConsidered = 0
  store.pageRowsCopied = 0
  const page = (await store.withExactVersionTransaction(
    {
      buildId: 'build-a',
      buildVersion: 1,
      packId: 'pack-a',
      packVersion: 1,
      realm: fixture.realm,
      vaultId: fixture.keyHandle.vaultId,
      snapshotId: 'pack-snapshot',
      snapshotRevision: 1,
    },
    async (transaction) =>
      transaction.readPackRecordPage('build-a', 'pack-a', null, 256, firstRowBytes),
  )) as { rows: readonly unknown[]; serializedBytes: number }
  assert.equal(page.rows.length, 1)
  assert.equal(page.serializedBytes, firstRowBytes)
  assert.equal(store.pageRowsConsidered, 2)
  assert.equal(store.pageRowsCopied, 1)
})

test('append rejects unfreezable canonical and persisted-row growth before writes', async () => {
  const fixture = await preparedFixture(2)
  for (const limit of ['canonical', 'persisted'] as const) {
    const store = new MemoryPackStore()
    await appendPage(fixture, store, fixture.records.slice(0, 1), 0, 0)
    const pack = structuredClone(store.pack!)
    if (limit === 'canonical') {
      pack.recordCanonicalBytes = 245_756
      pack.canonicalBytes = 245_760
    } else {
      pack.persistedRowBytes = ENCRYPTED_WALLET_BACKUP_PACK_PERSISTED_ROW_MAX_BYTES
    }
    store.pack = pack
    const before = store.snapshot()
    await assert.rejects(
      appendPage(fixture, store, fixture.records.slice(1), 1, 1),
      /canonical chunk|persisted rows/,
    )
    assertStoreSnapshot(store, before)
  }
})

test('freeze and restart revalidate exact order, identity, count, bytes, and digest', async () => {
  const fixture = await preparedFixture(3)
  const store = new MemoryPackStore()
  await appendPage(fixture, store, fixture.records, 0, 0)

  const restartedHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: fixture.realm,
    runtime: cryptoRuntime(),
  })
  const frozen = await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, restartedHandle, 1, 1),
  })
  assert.equal(frozen.packControl.state, 'frozen')
  assert.equal(frozen.packControl.recordCount, 3)
  assert.ok((frozen.packControl.canonicalBytes ?? 0) > 0)
  assert.match(frozen.packControl.membershipDigest ?? '', /^[0-9a-f]{64}$/)

  const exactBuild = store.build!
  store.build = { ...exactBuild, snapshotId: 'foreign-snapshot' }
  await assert.rejects(preparePack(fixture, store, restartedHandle, 2, 2), /build cursor/)
  store.build = exactBuild
  const exactPack = store.pack!
  store.pack = { ...exactPack, realm: 'foreign-realm' }
  await assert.rejects(preparePack(fixture, store, restartedHandle, 2, 2), /pack control/)
  store.pack = exactPack

  for (const field of ['recordCount', 'canonicalBytes', 'membershipDigest'] as const) {
    const original = store.pack!
    store.pack = structuredClone(original)
    if (field === 'recordCount') store.pack.recordCount += 1
    if (field === 'canonicalBytes') store.pack.canonicalBytes! += 1
    if (field === 'membershipDigest') store.pack.membershipDigest = 'ff'.repeat(32)
    await assert.rejects(
      preparePack(fixture, store, restartedHandle, 2, 2),
      /count|seal|short|control is invalid/,
    )
    store.pack = original
  }

  for (const mode of [
    'reverse',
    'duplicate',
    'cross-build',
    'cross-pack',
    'cross-realm',
    'cross-snapshot',
  ] as const) {
    store.pageMutation = mode
    await assert.rejects(
      preparePack(fixture, store, restartedHandle, 2, 2),
      /order|uniqueness|foreign identity/,
    )
  }
  store.pageMutation = null

  const firstKey = [...store.prepared.keys()][0]!
  const exact = store.prepared.get(firstKey)!
  for (const mutate of [
    (row: PersistedEncryptedWalletBackupPreparedBuildRecord) =>
      (row.prepared.canonicalRecord[0]! ^= 1),
    (row: PersistedEncryptedWalletBackupPreparedBuildRecord) =>
      (row.prepared.authenticationTag[0]! ^= 1),
  ]) {
    const changed = structuredClone(exact)
    mutate(changed)
    store.prepared.set(firstKey, changed)
    store.preparedBytes.set(firstKey, serializeEncryptedWalletBackupPreparedBuildRecord(changed))
    await assert.rejects(preparePack(fixture, store, restartedHandle, 2, 2))
    store.prepared.set(firstKey, exact)
    store.preparedBytes.set(firstKey, serializeEncryptedWalletBackupPreparedBuildRecord(exact))
  }
})

test('freeze and stage failures roll back every normalized row and control', async () => {
  const fixture = await preparedFixture(2)
  const store = new MemoryPackStore()
  await appendPage(fixture, store, fixture.records, 0, 0)
  const beforeFreeze = store.snapshot()
  store.failOnPackWrite = true
  await assert.rejects(
    freezeEncryptedWalletBackupPack({
      ...packInput(fixture, store, fixture.keyHandle, 1, 1),
    }),
    /pack-control write failure/,
  )
  assertStoreSnapshot(store, beforeFreeze)
  store.failOnPackWrite = false
  const frozen = await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, fixture.keyHandle, 1, 1),
  })
  const prepared = await prepareEncryptedWalletBackupFrozenPackObjectImmediately({
    frozenPack: frozen.frozenPack,
    generation: 1,
    runtime: deterministicRuntime(7),
  })
  const beforeStage = store.snapshot()
  store.failOnStagedInsert = true
  await assert.rejects(
    stageEncryptedWalletBackupPackObject({
      store,
      prepared,
      expectedBuildVersion: 2,
      expectedPackVersion: 2,
    }),
    /staged-object write failure/,
  )
  assertStoreSnapshot(store, beforeStage)
})

test('512 frozen records use exactly two keyset pages and staging is immutable/idempotent', async () => {
  const fixture = await preparedFixture(512)
  const store = new MemoryPackStore()
  await appendPage(fixture, store, fixture.records.slice(0, 256), 0, 0)
  await appendPage(fixture, store, fixture.records.slice(256), 1, 1)

  store.pageLimits.length = 0
  const frozen = await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, fixture.keyHandle, 2, 2),
  })
  assert.equal(frozen.pageReadCount, 2)
  assert.deepEqual(store.pageLimits, [256, 256])

  for (const mutation of ['pack', 'build'] as const) {
    const exactBuild = structuredClone(store.build)
    const exactPack = structuredClone(store.pack)
    store.pageLimits.length = 0
    store.controlMutationAfterFirstPage = mutation
    store.aliasControlRows = true
    await assert.rejects(
      preparePack(fixture, store, fixture.keyHandle, 3, 3),
      /changed between pages/,
    )
    store.build = exactBuild
    store.pack = exactPack
  }
  store.controlMutationAfterFirstPage = null
  store.aliasControlRows = false

  store.shortPage = true
  await assert.rejects(preparePack(fixture, store, fixture.keyHandle, 3, 3), /record page is short/)
  store.shortPage = false

  store.pageLimits.length = 0
  const abandonedAfterEncrypt = await prepareEncryptedWalletBackupFrozenPackObjectImmediately({
    frozenPack: frozen.frozenPack,
    generation: 1,
    runtime: deterministicRuntime(11),
  })
  assert.deepEqual(store.pageLimits, [])
  const restartedKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: fixture.realm,
    runtime: cryptoRuntime(),
  })
  const preparedAfterRestart = await preparePack(
    fixture,
    store,
    restartedKeyHandle,
    3,
    3,
    deterministicRuntime(22),
  )
  assert.equal(abandonedAfterEncrypt.pageReadCount, 2)
  assert.deepEqual(store.pageLimits, [256, 256])

  const staged = await stageEncryptedWalletBackupPackObject({
    store,
    prepared: preparedAfterRestart,
    expectedBuildVersion: 3,
    expectedPackVersion: 3,
  })
  assert.equal(staged.idempotent, false)
  assert.equal(store.staged.size, 1)
  assert.equal(staged.stagedObject.realm, fixture.realm)
  assert.equal(staged.stagedObject.vaultId, fixture.keyHandle.vaultId)
  assert.equal(staged.stagedObject.snapshotId, 'pack-snapshot')
  assert.equal(staged.stagedObject.snapshotRevision, 1)
  assert.equal('prepared' in staged.stagedObject, false)
  assert.equal('bindings' in staged.stagedObject, false)

  const storedBodyByte = [...store.staged.values()][0]!.body[0]
  staged.stagedObject.body[0]! ^= 1
  assert.equal([...store.staged.values()][0]!.body[0], storedBodyByte)

  const postStageKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: fixture.realm,
    runtime: cryptoRuntime(),
  })
  const rehydrated = await rehydrateEncryptedWalletBackupStagedPackObject({
    ...packInput(fixture, store, postStageKeyHandle, 4, 4),
  })
  const retry = await stageEncryptedWalletBackupPackObject({
    store,
    prepared: rehydrated,
    expectedBuildVersion: 4,
    expectedPackVersion: 4,
  })
  assert.equal(retry.idempotent, true)

  const stagedKey = 'build-a:pack-a'
  const exactStaged = store.staged.get(stagedKey)!
  store.staged.set(stagedKey, {
    ...exactStaged,
    snapshotId: 'foreign-snapshot',
  })
  await assert.rejects(
    rehydrateEncryptedWalletBackupStagedPackObject({
      ...packInput(fixture, store, postStageKeyHandle, 4, 4),
    }),
    /staged object link/,
  )
  store.staged.set(stagedKey, exactStaged)
  const tamperedStaged = structuredClone(exactStaged)
  tamperedStaged.body[20]! ^= 1
  store.staged.set(stagedKey, tamperedStaged)
  await assert.rejects(
    rehydrateEncryptedWalletBackupStagedPackObject({
      ...packInput(fixture, store, postStageKeyHandle, 4, 4),
    }),
    /staged object|data object/,
  )
  store.staged.set(stagedKey, exactStaged)
  await assert.rejects(
    stageEncryptedWalletBackupPackObject({
      store,
      prepared: abandonedAfterEncrypt,
      expectedBuildVersion: 4,
      expectedPackVersion: 4,
    }),
    /conflicts/,
  )
})

test('fresh process rehydrates staged bytes against independent committed snapshots', async () => {
  const fixture = await preparedFixture(3)
  const store = new MemoryPackStore()
  await appendPage(fixture, store, fixture.records, 0, 0)
  const frozen = await freezeEncryptedWalletBackupPack({
    ...packInput(fixture, store, fixture.keyHandle, 1, 1),
  })
  const prepared = await prepareEncryptedWalletBackupFrozenPackObjectImmediately({
    frozenPack: frozen.frozenPack,
    generation: 1,
    runtime: deterministicRuntime(44),
  })
  const staged = await stageEncryptedWalletBackupPackObject({
    store,
    prepared,
    expectedBuildVersion: 2,
    expectedPackVersion: 2,
  })
  const childResult = runStagedRestartChild(store, fixture, {})
  assert.equal(childResult.status, 0, childResult.stderr || childResult.stdout)
  const recovered = JSON.parse(childResult.stdout) as {
    objectId: string
    digest: string
  }
  assert.equal(recovered.objectId, staged.stagedObject.objectId)
  assert.equal(recovered.digest, staged.stagedObject.digest)
  assert.notEqual(runStagedRestartChild(store, fixture, { tamperCiphertext: true }).status, 0)
  assert.notEqual(runStagedRestartChild(store, fixture, { staleSnapshot: true }).status, 0)
})

test('pack persistence source has no upload, restore, manifest, or network surface', async () => {
  const source = await readFile(
    new URL('../src/encryptedWalletBackupPackPersistence.ts', import.meta.url),
    'utf8',
  )
  assert.equal(
    /\b(?:fetch|XMLHttpRequest|WebSocket|upload|restore|manifest)\b/i.test(source),
    false,
  )
})

async function appendPage(
  fixture: PreparedFixture,
  store: MemoryPackStore,
  records: readonly PersistedPreparedEncryptedWalletBackupRecord[],
  expectedBuildVersion: number,
  expectedPackVersion: number,
) {
  return appendEncryptedWalletBackupPreparedRecordPage({
    ...packInput(fixture, store, fixture.keyHandle, expectedBuildVersion, expectedPackVersion),
    records,
  })
}

function packInput(
  fixture: PreparedFixture,
  store: MemoryPackStore,
  keyHandle: EncryptedWalletBackupKeyHandle,
  expectedBuildVersion: number,
  expectedPackVersion: number,
) {
  return {
    store,
    keyHandle,
    seed: SEED,
    snapshotStore: fixture.snapshotStore,
    buildId: 'build-a',
    packId: 'pack-a',
    snapshotId: 'pack-snapshot',
    snapshotRevision: 1,
    expectedBuildVersion,
    expectedPackVersion,
  }
}

function preparePack(
  fixture: PreparedFixture,
  store: MemoryPackStore,
  keyHandle: EncryptedWalletBackupKeyHandle,
  expectedBuildVersion: number,
  expectedPackVersion: number,
  runtime = deterministicRuntime(33),
) {
  return prepareEncryptedWalletBackupFrozenPackObject({
    ...packInput(fixture, store, keyHandle, expectedBuildVersion, expectedPackVersion),
    generation: 1,
    runtime,
  })
}

interface PreparedFixture {
  readonly realm: string
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly records: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly snapshots: readonly EncryptedWalletBackupPreparedRecordSnapshot[]
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore &
    EncryptedWalletBackupPreparedRecordSnapshotBatchStore
}

async function preparedFixture(
  count: number,
  counterOffset = 0,
  runtime = cryptoRuntime(),
): Promise<PreparedFixture> {
  const realm = 'pack-persistence-test'
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
    runtime,
  })
  const snapshots = new Map<string, EncryptedWalletBackupPreparedRecordSnapshot>()
  const records: PersistedPreparedEncryptedWalletBackupRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const counter = vector.inputs.proof.counter + counterOffset + index
    const prepared = await prepareProof(keyHandle, counter, snapshots)
    const authority = snapshots.get(prepared.proofId)!
    records.push(
      await sealPreparedEncryptedWalletBackupRecord({
        keyHandle,
        seed: SEED,
        record: prepared,
        snapshotStore: exactSnapshotStore(snapshots),
      }),
    )
    assert.equal(authority.recordId, prepared.proofId)
  }
  records.sort((left, right) => left.recordId.localeCompare(right.recordId))
  return {
    realm,
    keyHandle,
    records,
    snapshots: [...snapshots.values()].map((row) => structuredClone(row)),
    snapshotStore: exactSnapshotStore(snapshots),
  }
}

async function prepareProof(
  keyHandle: EncryptedWalletBackupKeyHandle,
  counter: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
) {
  const proof = vector.inputs.proof
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (index: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(SEED, proof.keysetId)
  const secret = bytesToHex(derive(counter).secret)
  const recordId = deriveDurableCustodyProofId({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: keyHandle.vaultId,
    }),
    normalizedMint: proof.mint,
    unit: proof.unit,
    keysetId: proof.keysetId,
    secret,
  })
  const commitment = bytesToHex(
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
  const snapshot: EncryptedWalletBackupPreparedRecordSnapshot = {
    schemaVersion: 1,
    snapshotId: 'pack-snapshot',
    snapshotRevision: 1,
    recordId,
    commitment,
    recordKindCode: 0,
  }
  snapshots.set(recordId, snapshot)
  return prepareEncryptedWalletBackupProof({
    keyHandle,
    seed: SEED,
    mint: proof.mint,
    unit: proof.unit,
    counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret,
      C: proof.signatureHex,
      dleq: { ...proof.dleq },
    },
    proofKind: 'ordinary',
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: proof.createdAtUnixSeconds,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
    proofSnapshotStore: {
      async withCommittedProofSnapshot(expectedRecordId, read) {
        const expected = snapshots.get(expectedRecordId)
        if (expected === undefined) throw new Error('missing prepared proof snapshot')
        return read({
          schemaVersion: 1,
          snapshotId: expected.snapshotId,
          revision: expected.snapshotRevision,
          proofId: expected.recordId,
          proofCommitment: expected.commitment,
          proofKind: 'ordinary',
          ctfMetadata: null,
          terminalOperationId: null,
          conditionalKeysetEvidence: null,
          provenance: 'wallet-seed',
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
        })
      },
    },
  })
}

function exactSnapshotStore(
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): EncryptedWalletBackupPreparedRecordSnapshotStore &
  EncryptedWalletBackupPreparedRecordSnapshotBatchStore {
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      const snapshot = snapshots.get(recordId)
      if (snapshot === undefined) throw new Error('missing prepared record snapshot')
      return read(structuredClone(snapshot))
    },
    async withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      return read(
        recordIds.map((recordId) => {
          const snapshot = snapshots.get(recordId)
          if (snapshot === undefined) throw new Error('missing prepared record snapshot')
          return structuredClone(snapshot)
        }),
      )
    },
  }
}

function maliciousBatchSnapshotStore(
  base: EncryptedWalletBackupPreparedRecordSnapshotBatchStore &
    EncryptedWalletBackupPreparedRecordSnapshotStore,
  mode: Exclude<TransactionCallbackMode, 'exact'>,
): EncryptedWalletBackupPreparedRecordSnapshotBatchStore &
  EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    withCommittedPreparedRecordSnapshot: base.withCommittedPreparedRecordSnapshot.bind(base),
    async withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      let rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[] | undefined
      const capture = base.withCommittedPreparedRecordSnapshotBatch(recordIds, (value) => {
        rows = structuredClone(value)
        return true
      })
      void capture
      if (rows === undefined) throw new Error('snapshot capture was deferred')
      if (mode === 'never') return Object.freeze({ skipped: true })
      if (mode === 'deferred') return Promise.resolve().then(() => read(rows!))
      const result = read(rows)
      if (mode === 'double') read(rows)
      if (mode === 'substituted') return Object.freeze({ substituted: true })
      return result
    },
  }
}

type PageMutation =
  | 'reverse'
  | 'duplicate'
  | 'cross-build'
  | 'cross-pack'
  | 'cross-realm'
  | 'cross-snapshot'
  | null
type TransactionCallbackMode = 'exact' | 'never' | 'double' | 'deferred' | 'substituted'

class MemoryPackStore implements EncryptedWalletBackupPackPersistenceStore {
  build: PersistedEncryptedWalletBackupBuildCursor | null = null
  pack: PersistedEncryptedWalletBackupPackControl | null = null
  prepared = new Map<string, PersistedEncryptedWalletBackupPreparedBuildRecord>()
  bindings = new Map<string, PersistedEncryptedWalletBackupPackBinding>()
  preparedBytes = new Map<string, Uint8Array>()
  bindingBytes = new Map<string, Uint8Array>()
  staged = new Map<string, PersistedEncryptedWalletBackupStagedObject>()
  pageLimits: number[] = []
  pageMutation: PageMutation = null
  failAfterFirstInsert = false
  failOnPackWrite = false
  failOnStagedInsert = false
  callbackMode: TransactionCallbackMode = 'exact'
  crossMicrotask = false
  controlMutationAfterFirstPage: 'pack' | 'build' | null = null
  aliasControlRows = false
  pageRowsConsidered = 0
  pageRowsCopied = 0
  shortPage = false
  expectations: Array<{
    realm: string
    vaultId: string
    snapshotId: string
    snapshotRevision: number
  }> = []

  async withExactVersionTransaction<T>(
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
  ): Promise<unknown> {
    this.expectations.push({
      realm: expected.realm,
      vaultId: expected.vaultId,
      snapshotId: expected.snapshotId,
      snapshotRevision: expected.snapshotRevision,
    })
    if ((this.build?.version ?? 0) !== expected.buildVersion)
      throw new Error('fake build version is stale')
    if ((this.pack?.version ?? 0) !== expected.packVersion)
      throw new Error('fake pack version is stale')
    const working = this.transactionSnapshot()
    let inserts = 0
    const transaction: EncryptedWalletBackupPackPersistenceTransaction = {
      readBuildCursor: async (buildId) =>
        (await this.transactionBoundary(), working.build?.buildId === buildId)
          ? this.aliasControlRows
            ? working.build
            : structuredClone(working.build)
          : null,
      readPackControl: async (buildId, packId) =>
        (await this.transactionBoundary(),
        working.pack?.buildId === buildId && working.pack.packId === packId)
          ? this.aliasControlRows
            ? working.pack
            : structuredClone(working.pack)
          : null,
      readPackRecordPage: async (buildId, packId, afterRecordId, limit, maxBytes) => {
        await this.transactionBoundary()
        this.pageLimits.push(limit)
        const candidates = [...working.bindings.values()]
          .filter(
            (binding) =>
              binding.buildId === buildId &&
              binding.packId === packId &&
              (afterRecordId === null || binding.recordId > afterRecordId),
          )
          .sort((left, right) => left.recordId.localeCompare(right.recordId))
        const serialized: Array<{
          binding: Uint8Array
          prepared: Uint8Array
        }> = []
        let serializedBytes = 0
        for (const row of candidates) {
          if (serialized.length === limit) break
          this.pageRowsConsidered += 1
          const binding = working.bindingBytes.get(`${row.buildId}:${row.packId}:${row.recordId}`)!
          const prepared = working.preparedBytes.get(`${row.buildId}:${row.recordId}`)!
          if (serializedBytes + binding.byteLength + prepared.byteLength > maxBytes) break
          serialized.push({
            binding: binding.slice(),
            prepared: prepared.slice(),
          })
          serializedBytes += binding.byteLength + prepared.byteLength
          this.pageRowsCopied += 1
        }
        const exact = mutateSerializedPage(serialized, this.pageMutation)
        if (this.shortPage && exact.length > 0) exact.pop()
        serializedBytes = exact.reduce(
          (sum, row) => sum + row.binding.byteLength + row.prepared.byteLength,
          0,
        )
        if (serializedBytes > maxBytes) throw new Error('fake serialized page exceeds maxBytes')
        if (this.pageLimits.length === 1) {
          if (this.controlMutationAfterFirstPage === 'pack' && working.pack)
            Object.assign(working.pack, {
              lastRecordId: 'ff'.repeat(32),
            })
          if (this.controlMutationAfterFirstPage === 'build' && working.build)
            Object.assign(working.build, {
              nextRecordOrdinal: working.build.nextRecordOrdinal + 1,
            })
        }
        return { rows: exact, serializedBytes }
      },
      readStagedObject: async (buildId, packId) => {
        await this.transactionBoundary()
        const row = working.staged.get(`${buildId}:${packId}`)
        return row === undefined ? null : structuredClone(row)
      },
      insertPreparedRecord: async (row) => {
        await this.transactionBoundary()
        const key = `${row.buildId}:${row.recordId}`
        if (working.prepared.has(key)) throw new Error('unique build/record constraint')
        const exact = structuredClone(row)
        working.prepared.set(key, exact)
        working.preparedBytes.set(key, serializeEncryptedWalletBackupPreparedBuildRecord(exact))
        if (this.failAfterFirstInsert && ++inserts === 1)
          throw new Error('injected transaction failure')
      },
      insertPackBinding: async (row) => {
        await this.transactionBoundary()
        const key = `${row.buildId}:${row.packId}:${row.recordId}`
        if (working.bindings.has(key)) throw new Error('unique build/pack/record constraint')
        const exact = structuredClone(row)
        working.bindings.set(key, exact)
        working.bindingBytes.set(key, serializeEncryptedWalletBackupPackBinding(exact))
      },
      writeBuildCursor: async (row) => {
        await this.transactionBoundary()
        working.build = structuredClone(row)
      },
      writePackControl: async (row) => {
        await this.transactionBoundary()
        if (this.failOnPackWrite) throw new Error('injected pack-control write failure')
        working.pack = structuredClone(row)
      },
      insertStagedObject: async (row) => {
        await this.transactionBoundary()
        if (this.failOnStagedInsert) throw new Error('injected staged-object write failure')
        const key = `${row.buildId}:${row.packId}`
        if (working.staged.has(key)) throw new Error('unique staged object constraint')
        working.staged.set(key, structuredClone(row))
      },
    }
    if (this.callbackMode === 'never') return Object.freeze({ skipped: true })
    if (this.callbackMode === 'deferred') {
      await Promise.resolve()
      const result = await use(transaction)
      this.restore(working)
      return result
    }
    const result = await use(transaction)
    if (this.callbackMode === 'double') await use(transaction)
    if (this.callbackMode === 'substituted') return Object.freeze({ substituted: true })
    this.restore(working)
    return result
  }

  snapshot() {
    return {
      build: structuredClone(this.build),
      pack: structuredClone(this.pack),
      prepared: structuredClone(this.prepared),
      bindings: structuredClone(this.bindings),
      preparedBytes: structuredClone(this.preparedBytes),
      bindingBytes: structuredClone(this.bindingBytes),
      staged: structuredClone(this.staged),
    }
  }

  private transactionSnapshot() {
    return {
      build: this.build === null ? null : structuredClone(this.build),
      pack: this.pack === null ? null : structuredClone(this.pack),
      prepared: new Map(this.prepared),
      bindings: new Map(this.bindings),
      preparedBytes: new Map(this.preparedBytes),
      bindingBytes: new Map(this.bindingBytes),
      staged: new Map(this.staged),
    }
  }

  private async transactionBoundary(): Promise<void> {
    if (this.crossMicrotask) await Promise.resolve()
  }

  restore(value: ReturnType<MemoryPackStore['snapshot']>) {
    this.build = value.build
    this.pack = value.pack
    this.prepared = value.prepared
    this.bindings = value.bindings
    this.preparedBytes = value.preparedBytes
    this.bindingBytes = value.bindingBytes
    this.staged = value.staged
  }
}

function mutateSerializedPage(
  rows: Array<{ binding: Uint8Array; prepared: Uint8Array }>,
  mode: PageMutation,
) {
  if (mode === null) return rows
  const structured = rows.map((row) => ({
    binding: deserializeEncryptedWalletBackupPackBinding(row.binding),
    prepared: deserializeEncryptedWalletBackupPreparedBuildRecord(row.prepared),
  }))
  return mutatePage(structured, mode).map((row) => ({
    binding: serializeEncryptedWalletBackupPackBinding(row.binding),
    prepared: serializeEncryptedWalletBackupPreparedBuildRecord(row.prepared),
  }))
}

function mutatePage(
  rows: EncryptedWalletBackupPackRecordPageRow[],
  mode: PageMutation,
): EncryptedWalletBackupPackRecordPageRow[] {
  if (mode === null || rows.length === 0) return rows
  if (mode === 'reverse') return rows.reverse()
  if (mode === 'duplicate' && rows.length > 1) rows[1] = structuredClone(rows[0]!)
  if (mode === 'cross-build') rows[0]!.binding = { ...rows[0]!.binding, buildId: 'foreign' }
  if (mode === 'cross-pack') rows[0]!.binding = { ...rows[0]!.binding, packId: 'foreign' }
  if (mode === 'cross-realm') rows[0]!.binding = { ...rows[0]!.binding, realm: 'foreign-realm' }
  if (mode === 'cross-snapshot')
    rows[0]!.binding = { ...rows[0]!.binding, snapshotId: 'foreign-snapshot' }
  return rows
}

function assertStoreSnapshot(
  store: MemoryPackStore,
  expected: ReturnType<MemoryPackStore['snapshot']>,
) {
  assert.equal(
    isDeepStrictEqual(store.snapshot(), expected),
    true,
    'fake pack transaction did not roll back exactly',
  )
}

function deterministicRuntime(fill: number): EncryptedWalletBackupRuntime {
  let call = 0
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      target.fill(fill + call++)
      return target
    },
  }
}

function runStagedRestartChild(
  store: MemoryPackStore,
  fixture: PreparedFixture,
  options: Readonly<{
    tamperCiphertext?: boolean
    staleSnapshot?: boolean
  }>,
) {
  const staged = structuredClone([...store.staged.values()][0]!)
  if (options.tamperCiphertext) staged.body[20]! ^= 1
  const snapshots = fixture.snapshots.map((row) => structuredClone(row))
  if (options.staleSnapshot) snapshots[0]!.snapshotRevision += 1
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./encryptedWalletBackupPackPersistenceChild.ts', import.meta.url)),
    ],
    {
      input: JSON.stringify({
        seed: [...SEED],
        realm: fixture.realm,
        build: store.build,
        pack: store.pack,
        rows: [...store.bindings.values()]
          .sort((left, right) => left.recordId.localeCompare(right.recordId))
          .map((binding) => ({
            recordId: binding.recordId,
            binding: [...serializeEncryptedWalletBackupPackBinding(binding)],
            prepared: [
              ...serializeEncryptedWalletBackupPreparedBuildRecord(
                store.prepared.get(`${binding.buildId}:${binding.recordId}`)!,
              ),
            ],
          })),
        snapshots,
        staged: {
          ...staged,
          aad: [...staged.aad],
          body: [...staged.body],
        },
      }),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
    },
  )
}

function cryptoRuntime(): EncryptedWalletBackupRuntime {
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      return webcrypto.getRandomValues(target)
    },
  }
}

function countingHmacRuntime(counter: {
  hmacImports: number
  hmacVerifications: number
}): EncryptedWalletBackupRuntime {
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property === 'importKey') {
        return async (...args: Parameters<SubtleCrypto['importKey']>) => {
          const algorithm = args[2]
          if (
            typeof algorithm === 'object' &&
            algorithm !== null &&
            'name' in algorithm &&
            algorithm.name === 'HMAC'
          )
            counter.hmacImports += 1
          return target.importKey(...args)
        }
      }
      if (property === 'verify') {
        return async (...args: Parameters<SubtleCrypto['verify']>) => {
          const algorithm = args[0]
          if (
            (typeof algorithm === 'string' && algorithm === 'HMAC') ||
            (typeof algorithm === 'object' &&
              algorithm !== null &&
              'name' in algorithm &&
              algorithm.name === 'HMAC')
          )
            counter.hmacVerifications += 1
          return target.verify(...args)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SubtleCrypto
  return {
    subtle,
    getRandomValues(target) {
      return webcrypto.getRandomValues(target)
    },
  }
}

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16))
}
