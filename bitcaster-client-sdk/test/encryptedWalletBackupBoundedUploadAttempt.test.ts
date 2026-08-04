import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareBoundedEncryptedWalletBackupManifestTarget,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupManifestTarget,
} from '../src/encryptedWalletBackup.ts'
import { issueBoundedManifestTargetCapabilityForTest } from '../src/encryptedWalletBackupManifestTargetAuthority.ts'
import {
  ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  claimBoundedEncryptedWalletBackupUploadAttempt,
  measureEncryptedWalletBackupUploadBatchRecordBytes,
  planAndSealBoundedEncryptedWalletBackupUploadBatch,
  rehydrateEncryptedWalletBackupUploadBatch,
  runBoundedEncryptedWalletBackupUploadCycle,
  sealBoundedEncryptedWalletBackupUploadAttempt,
  sealOrRehydrateEncryptedWalletBackupCasAttempt,
  type EncryptedWalletBackupActiveUploadAttemptRecord,
  type EncryptedWalletBackupBoundedUploadObjectSource,
  type EncryptedWalletBackupUploadBatchRecord,
  type EncryptedWalletBackupUploadAttemptCursorStore,
  type EncryptedWalletBackupCoordinatorStore,
  type EncryptedWalletBackupSyncAttemptRecord,
} from '../src/encryptedWalletBackupSync.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import { encryptedWalletBackupObjectDigest } from '../src/encryptedWalletBackupObjectDigest.ts'
import {
  decodeEncryptedWalletBackupUploadCursor,
  encodeEncryptedWalletBackupUploadCursor,
} from '../src/encryptedWalletBackupUploadPlanningPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'

type Mode =
  | 'normal'
  | 'missing-attempt'
  | 'missing-cursor'
  | 'changed-target'
  | 'changed-cursor'
  | 'foreign'
  | 'omitted'
  | 'repeated'
  | 'substituted'
  | 'thenable'
  | 'over-return'
  | 'deferred'
  | 'claim-deferred'
  | 'reservation-mismatch'
  | 'batch-uncertain'
  | 'batch-deferred'
  | 'batch-repeated'
  | 'batch-substituted'
  | 'batch-unknown'
  | 'batch-thrown'

type BoundedManifestPageAadContext = Readonly<{
  snapshotId: string
  snapshotRevision: number
  sealedControlDigest: string
  resultDigest: string
  pageCount: number
  pageAadIndexByObjectId: ReadonlyMap<string, number>
}>

const BOUNDED_MANIFEST_PAGE_AAD_CONTEXTS = new WeakMap<
  EncryptedWalletBackupKeyHandle,
  BoundedManifestPageAadContext
>()

test('bounded upload attempt atomically seals a non-empty target and its pages cursor', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const originalHead = fixture.target.wire.canonicalHead.slice()
  const originalReferences = fixture.target.wire.canonicalReferenceSet.slice()
  fixture.target.wire.canonicalHead[0]! ^= 1
  fixture.target.wire.canonicalReferenceSet[0]! ^= 1
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '11'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  assert.equal(claim.record.targetManifestDigest, fixture.target.head.manifestDigest)
  assert.equal(equalBytes(claim.record.canonicalTargetHead, originalHead), true)
  assert.equal(equalBytes(claim.record.canonicalTargetReferenceSet, originalReferences), true)
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
  assert.equal(store.reservation?.readRows, 2)
  assert.equal(store.reservation?.writeRows, 2)
  assert.equal(store.reservation?.readBytes, 1_048_576)
  assert.equal(store.reservation?.writeBytes, 1_048_576)
  const cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'pages')
  assert.equal(cursor.nextPageIndex, 0)
  assert.equal(cursor.nextBatchOrdinal, 0)
  assert.equal(cursor.version, 1)
  assert.equal(cursor.targetManifestDigest, fixture.target.head.manifestDigest)
})

test('bounded upload attempt atomically seals an empty target and its complete cursor', async () => {
  const fixture = await boundedTargetFixture(true)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '22'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'complete')
  assert.equal(cursor.exclusiveChunkObjectId, null)
})

test('bounded upload planning reads the persisted page then chunk and completes atomically', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '23'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const batch = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim,
    keyHandle: fixture.keyHandle,
    store,
    source: boundedObjectSource(fixture.keyHandle, (query) => {
      assert.equal(query.maximumRows, 1)
      assert.equal(query.maximumBytes, 1_048_576)
    }),
  })
  assert.equal(batch?.record.items.length, 2)
  assert.equal(batch?.record.items[0]?.objectId, objectIdFor(1))
  assert.equal(batch?.record.items[1]?.objectId, objectIdFor(33))
  const expectedPut = encodeCanonicalBackupCbor([
    1,
    'object-put',
    hexToBytes('23'.repeat(16)),
    2,
    fixture.keyHandle.realm,
    hexToBytes(fixture.keyHandle.vaultId),
    hexToBytes(objectIdFor(1)),
    1,
    65_536,
    hexToBytes(batch!.record.items[0]!.objectDigest),
    boundedObjectAad(fixture.keyHandle, 2, objectIdFor(1), 65_536),
    new Uint8Array(65_564),
  ])
  assert.equal(equalBytes(batch!.record.items[0]!.canonicalPutPayload!, expectedPut), true)
  const cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'complete')
  assert.equal(cursor.nextBatchOrdinal, 1)
  assert.equal(cursor.version, 2)
  assert.equal(store.batchReservation?.readRows, 3)
  assert.equal(store.batchReservation?.writeRows, 3)
  assert.equal(store.batchReservation?.readBytes, 1_048_576)
  assert.equal(store.batchReservation?.writeBytes, 1_048_576)
  store.acknowledgeActiveBatch(claim.record.attemptId)
  const restarted = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(
    await planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim: restarted!,
      keyHandle: fixture.keyHandle,
      store,
      source: boundedObjectSource(fixture.keyHandle),
    }),
    null,
  )
})

test('bounded upload planning rejects a source object that exceeds its byte reservation', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '24'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const source = boundedObjectSource(fixture.keyHandle)
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim,
      keyHandle: fixture.keyHandle,
      store,
      source: {
        async readManifestPageObject(input) {
          const object = await source.readManifestPageObject(input)
          return { ...object, body: new Uint8Array(1_048_576) }
        },
        readProofChunkObject: source.readProofChunkObject,
      },
    }),
    /bounded upload object exceeds its source reservation/,
  )
  assert.equal(store.batches.size, 0)
  assert.equal(
    decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!).version,
    1,
  )
})

test('bounded upload planning rejects a manifest page AAD with the wrong target index', async () => {
  const fixture = await boundedTargetFixture(false, {
    pageCount: 2,
    chunkCount: 1,
    pageAadIndexForPage: (pageIndex, pageCount) => pageCount - pageIndex - 1,
  })
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '25'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim,
      keyHandle: fixture.keyHandle,
      store,
      source: boundedObjectSource(fixture.keyHandle),
    }),
    /backup object PUT digest is invalid/,
  )
  assert.equal(store.batches.size, 0)
  assert.equal(
    decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!).version,
    1,
  )
})

test('bounded upload planning advances 16 pages and five chunks in canonical bounded batches', async () => {
  const fixture = await boundedTargetFixture(false, { pageCount: 16, chunkCount: 5 })
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '26'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  let sourceReads = 0
  const source = boundedObjectSource(fixture.keyHandle, () => {
    sourceReads += 1
  })
  const first = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim,
    keyHandle: fixture.keyHandle,
    store,
    source,
  })
  assert.equal(first?.record.items.length, 15)
  assert.equal(first?.record.repackedChunkCount, 0)
  assert.deepEqual(
    first!.record.items.map((item) => item.objectId),
    Array.from({ length: 15 }, (_value, index) => objectIdFor(index + 1)),
  )
  assert.ok(first!.record.uploadedBytes <= ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX)
  assert.ok(
    measureEncryptedWalletBackupUploadBatchRecordBytes(first!.record) <=
      ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  )
  assert.equal(sourceReads, 15)
  let cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'pages')
  assert.equal(cursor.nextPageIndex, 15)
  assert.equal(cursor.exclusiveChunkObjectId, null)
  assert.equal(cursor.nextBatchOrdinal, 1)
  assert.equal(cursor.version, 2)

  store.acknowledgeActiveBatch(claim.record.attemptId)
  const secondClaim = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.notEqual(secondClaim, null)
  const second = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim: secondClaim!,
    keyHandle: fixture.keyHandle,
    store,
    source,
  })
  assert.equal(second?.record.items.length, 4)
  assert.equal(second?.record.repackedChunkCount, 3)
  assert.deepEqual(
    second!.record.items.map((item) => item.objectId),
    [objectIdFor(16), objectIdFor(33), objectIdFor(34), objectIdFor(35)],
  )
  assert.ok(second!.record.uploadedBytes <= ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX)
  assert.ok(
    measureEncryptedWalletBackupUploadBatchRecordBytes(second!.record) <=
      ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  )
  assert.equal(sourceReads, 19)
  cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'chunks')
  assert.equal(cursor.nextPageIndex, 16)
  assert.equal(cursor.exclusiveChunkObjectId, objectIdFor(35))
  assert.equal(cursor.nextBatchOrdinal, 2)
  assert.equal(cursor.version, 3)

  store.acknowledgeActiveBatch(claim.record.attemptId)
  const thirdClaim = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.notEqual(thirdClaim, null)
  const third = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim: thirdClaim!,
    keyHandle: fixture.keyHandle,
    store,
    source,
  })
  assert.equal(third?.record.items.length, 2)
  assert.equal(third?.record.repackedChunkCount, 2)
  assert.ok(third!.record.uploadedBytes <= ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX)
  assert.ok(
    measureEncryptedWalletBackupUploadBatchRecordBytes(third!.record) <=
      ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  )
  assert.equal(sourceReads, 21)
  cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'complete')
  assert.equal(cursor.nextPageIndex, 16)
  assert.equal(cursor.exclusiveChunkObjectId, objectIdFor(37))
  assert.equal(cursor.nextBatchOrdinal, 3)
  assert.equal(cursor.version, 4)
})

test('bounded upload planning cannot replace an active batch before acknowledgement', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '29'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  let sourceReads = 0
  const source = boundedObjectSource(fixture.keyHandle, () => {
    sourceReads += 1
  })
  const input = { claim, keyHandle: fixture.keyHandle, store, source }
  const first = await planAndSealBoundedEncryptedWalletBackupUploadBatch(input)
  const cursor = store.cursors.get(claim.record.attemptId)!.slice()
  assert.equal(first?.record.batchId, store.attempts.get(claim.record.attemptId)?.activeBatchId)
  assert.equal(sourceReads, 2)
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch(input),
    /already has an active batch/,
  )
  assert.equal(sourceReads, 2)
  assert.equal(store.batches.size, 1)
  assert.equal(equalBytes(store.cursors.get(claim.record.attemptId)!, cursor), true)
  assert.equal(store.attempts.get(claim.record.attemptId)?.activeBatchId, first?.record.batchId)
})

test('near-maximum target authority progresses across cycles without source rereads', async () => {
  const fixture = await boundedTargetFixture(false, { pageCount: 255, chunkCount: 1 })
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '2a'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  assert.ok(
    claim.record.canonicalTargetHead.byteLength +
      claim.record.canonicalTargetReferenceSet.byteLength +
      claim.record.canonicalInheritedReferenceSet.byteLength >
      16 * 1_024,
  )
  let current = claim
  let cycles = 0
  let sourceReads = 0
  const sourceObjectIds = new Set<string>()
  const source = boundedObjectSource(fixture.keyHandle, (input) => {
    sourceReads += 1
    sourceObjectIds.add(input.objectId)
  })
  while (cycles < 64) {
    const batch = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim: current,
      keyHandle: fixture.keyHandle,
      store,
      source,
    })
    assert.notEqual(batch, null)
    assert.ok(
      measureEncryptedWalletBackupUploadBatchRecordBytes(batch!.record) <=
        ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
    )
    cycles += 1
    store.acknowledgeActiveBatch(current.record.attemptId)
    const cursor = decodeEncryptedWalletBackupUploadCursor(
      store.cursors.get(current.record.attemptId)!,
    )
    if (cursor.phase === 'complete') break
    const next = await claimBoundedEncryptedWalletBackupUploadAttempt({
      ownerId: 'owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store,
    })
    assert.notEqual(next, null)
    current = next!
  }
  assert.ok(cycles < 64)
  assert.equal(sourceReads, 256)
  assert.equal(sourceObjectIds.size, 256)
})

test('bounded upload planning rejects a source body tampered after its target digest', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '27'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const source = boundedObjectSource(fixture.keyHandle)
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim,
      keyHandle: fixture.keyHandle,
      store,
      source: {
        async readManifestPageObject(input) {
          const object = await source.readManifestPageObject(input)
          const body = object.body.slice()
          body[0]! ^= 1
          return { ...object, body }
        },
        readProofChunkObject: source.readProofChunkObject,
      },
    }),
    /backup object PUT digest is invalid/,
  )
  assert.equal(store.batches.size, 0)
  assert.equal(store.attempts.get(claim.record.attemptId)?.activeBatchId, null)
  assert.deepEqual(store.attempts.get(claim.record.attemptId)?.batchIds, [])
  assert.equal(
    decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!).version,
    1,
  )
})

test('bounded upload planning rolls back hostile transaction callbacks', async (t) => {
  for (const mode of [
    'batch-repeated',
    'batch-substituted',
    'batch-unknown',
    'batch-thrown',
  ] as const) {
    await t.test(mode, async () => {
      const fixture = await boundedTargetFixture(false)
      const store = new AtomicAttemptCursorStore(mode)
      const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
        attemptId: '28'.repeat(16),
        ownerId: 'owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        target: fixture.target,
        store,
      })
      await assert.rejects(
        planAndSealBoundedEncryptedWalletBackupUploadBatch({
          claim,
          keyHandle: fixture.keyHandle,
          store,
          source: boundedObjectSource(fixture.keyHandle),
        }),
      )
      assert.equal(store.batches.size, 0)
      assert.equal(store.attempts.get(claim.record.attemptId)?.activeBatchId, null)
      assert.deepEqual(store.attempts.get(claim.record.attemptId)?.batchIds, [])
      assert.equal(
        decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!).version,
        1,
      )
    })
  }
})

test('bounded upload planning accepts a callback in a Promise microtask before settlement', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore('batch-deferred')
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '28'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const batch = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
    claim,
    keyHandle: fixture.keyHandle,
    store,
    source: boundedObjectSource(fixture.keyHandle),
  })
  assert.equal(batch?.record.items.length, 2)
})

test('bounded upload planning rehydrates an exact batch after an uncertain commit', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore('batch-uncertain')
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '25'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const input = {
    claim,
    keyHandle: fixture.keyHandle,
    store,
    source: boundedObjectSource(fixture.keyHandle),
  }
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch(input),
    /uncertain batch commit/,
  )
  assert.equal(store.batches.size, 1)
  const batchId = [...store.batches.keys()][0]!
  const fresh = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(fresh?.record.activeBatchId, batchId)
  const rehydratedFromStore = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(
    isDeepStrictEqual(rehydratedFromStore.record.items, store.batches.get(batchId)?.items),
    true,
    'rehydrated upload items must match the persisted batch',
  )
  let freshClaimSourceReads = 0
  await assert.rejects(
    planAndSealBoundedEncryptedWalletBackupUploadBatch({
      claim: fresh!,
      keyHandle: fixture.keyHandle,
      store,
      source: boundedObjectSource(fixture.keyHandle, () => {
        freshClaimSourceReads += 1
      }),
    }),
    /already has an active batch/,
  )
  assert.equal(freshClaimSourceReads, 0)
  const rehydrated = await planAndSealBoundedEncryptedWalletBackupUploadBatch(input)
  assert.equal(rehydrated?.record.batchId, batchId)
  assert.equal(rehydrated?.record.items.length, 2)
})

test('bounded upload attempt retries exactly and the paired claim API restarts it', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const input = {
    attemptId: '33'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  }
  const first = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  const retry = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  assert.equal(first.record.attemptId, retry.record.attemptId)
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
  const restarted = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(restarted?.record.attemptId, first.record.attemptId)
  await assert.rejects(
    sealBoundedEncryptedWalletBackupUploadAttempt({ ...input, attemptId: '34'.repeat(16) }),
    /live backup upload attempt already exists/,
  )
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
})

test('bounded paired claim rejects missing, malformed, and mismatched cursor callbacks', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of ['missing', 'malformed', 'mismatched'] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore('normal')
      const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
        attemptId: '35'.repeat(16),
        ownerId: 'owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        target: fixture.target,
        store,
      })
      if (mode === 'missing') store.cursors.delete(sealed.record.attemptId)
      if (mode === 'malformed') store.cursors.set(sealed.record.attemptId, new Uint8Array([1]))
      if (mode === 'mismatched') {
        const cursor = decodeEncryptedWalletBackupUploadCursor(
          store.cursors.get(sealed.record.attemptId)!,
        )
        store.cursors.set(
          sealed.record.attemptId,
          encodeEncryptedWalletBackupUploadCursor({
            ...cursor,
            targetManifestDigest: '00'.repeat(32),
          }),
        )
      }
      await assert.rejects(
        claimBoundedEncryptedWalletBackupUploadAttempt({
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store,
        }),
      )
    })
  }
})

test('bounded paired claim accepts a callback in a Promise microtask before settlement', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore('claim-deferred')
  const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '35'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const claimed = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(claimed?.record.attemptId, sealed.record.attemptId)
})

test('bounded paired claim rejects forged page, chunk, and complete cursor positions', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of ['pages', 'chunks', 'complete'] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore()
      const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
        attemptId: '37'.repeat(16),
        ownerId: 'owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        target: fixture.target,
        store,
      })
      const initial = decodeEncryptedWalletBackupUploadCursor(
        store.cursors.get(sealed.record.attemptId)!,
      )
      const forged =
        mode === 'pages'
          ? { ...initial, nextPageIndex: 1 }
          : mode === 'chunks'
            ? {
                ...initial,
                phase: 'chunks' as const,
                nextPageIndex: 0,
                exclusiveChunkObjectId: null,
              }
            : {
                ...initial,
                phase: 'complete' as const,
                nextPageIndex: 1,
                exclusiveChunkObjectId: '88'.repeat(16),
              }
      store.cursors.set(
        sealed.record.attemptId,
        encodeEncryptedWalletBackupUploadCursor(forged as never),
      )
      await assert.rejects(
        claimBoundedEncryptedWalletBackupUploadAttempt({
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store,
        }),
        /bounded upload cursor position is invalid/,
      )
    })
  }
})

test('a non-empty bounded upload claim cannot authorize a premature CAS', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '36'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  await assert.rejects(
    sealOrRehydrateEncryptedWalletBackupCasAttempt({
      claim,
      keyHandle: fixture.keyHandle,
      store: store as never,
    }),
    /bounded upload cursor is not complete/,
  )
})

test('bounded upload cycle rehydrates an active uncertain batch and replays its exact bytes', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  let sourceReads = 0
  const source = boundedObjectSource(fixture.keyHandle, () => {
    sourceReads += 1
  })
  const firstPutPayloads: Uint8Array[] = []
  let replay = false
  await assert.rejects(
    runBoundedUploadCycleForTest({
      fixture,
      store,
      source,
      remote: {
        async putObject(input) {
          firstPutPayloads.push(input.canonicalPutPayload.slice())
          if (!replay) throw new Error('remote PUT outcome is unknown')
          return { status: 'already-stored' as const }
        },
      },
    }),
    /remote PUT outcome is unknown/,
  )
  const batchId = store.attempts.get('61'.repeat(16))?.activeBatchId
  assert.notEqual(batchId, null)
  const persistedPayloads = store.batches
    .get(batchId!)!
    .items.map((item) => item.canonicalPutPayload!)
  assert.equal(sourceReads, 2)
  assert.equal(firstPutPayloads.length, 2)
  assert.equal(
    firstPutPayloads.every((payload) =>
      persistedPayloads.some((sealed) => equalBytes(sealed, payload)),
    ),
    true,
  )

  replay = true
  const result = await runBoundedUploadCycleForTest({
    fixture,
    store,
    initialAttempt: null,
    source,
    remote: {
      async putObject(input) {
        assert.equal(
          persistedPayloads.some((payload) => equalBytes(payload, input.canonicalPutPayload)),
          true,
        )
        return { status: 'already-stored' as const }
      },
    },
  })
  assert.equal(result.state, 'cas-sealed')
  assert.equal(sourceReads, 2)
  assert.equal(store.attempts.get('61'.repeat(16))?.activeBatchId, null)
})

test('bounded upload cycle validates the attempt once and execution before each PUT', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const result = await runBoundedUploadCycleForTest({ fixture, store })
  assert.equal(result.state, 'cas-sealed')
  assertBoundedUploadCycleCallShape(store, { combinedAttemptBatchValidation: 2, total: 9 })
})

test('bounded upload cycle journals CAS only after every bounded batch is acknowledged', async () => {
  const fixture = await boundedTargetFixture(false, { pageCount: 16, chunkCount: 5 })
  const store = new AtomicAttemptCursorStore()
  const first = await runBoundedUploadCycleForTest({ fixture, store })
  assert.equal(first.state, 'upload-pending')
  assert.equal(store.casAttempts.size, 0)
  const second = await runBoundedUploadCycleForTest({ fixture, store, initialAttempt: null })
  assert.equal(second.state, 'upload-pending')
  assert.equal(store.casAttempts.size, 0)
  const third = await runBoundedUploadCycleForTest({ fixture, store, initialAttempt: null })
  assert.equal(third.state, 'cas-sealed')
  assert.equal(store.casAttempts.size, 1)
})

test('a bounded upload cycle sends four PUTs concurrently and never five', async () => {
  const fixture = await boundedTargetFixture(false, { pageCount: 1, chunkCount: 3 })
  const store = new AtomicAttemptCursorStore()
  const release = deferred<void>()
  let putCalls = 0
  let inFlight = 0
  let maximumInFlight = 0
  const cycle = runBoundedUploadCycleForTest({
    fixture,
    store,
    remote: {
      async putObject() {
        putCalls += 1
        inFlight += 1
        maximumInFlight = Math.max(maximumInFlight, inFlight)
        await release.promise
        inFlight -= 1
        return { status: 'stored' as const }
      },
    },
  })
  await waitForPutCalls(() => putCalls)
  assert.equal(putCalls, 4)
  assert.equal(maximumInFlight, 4)
  release.resolve()
  const result = await cycle
  assert.equal(result.state, 'cas-sealed')
  assert.equal(putCalls, 4)
  assert.equal(maximumInFlight, 4)
  assertBoundedUploadCycleCallShape(store, { combinedAttemptBatchValidation: 4, total: 11 })
})

test('fixed 54,000-proof workload executes 249 current objects in 45 bounded cycles', async () => {
  const pageCount = 142
  const chunkCount = 107
  const objectCount = pageCount + chunkCount
  const batchCount = 45
  const fixture = await boundedTargetFixture(false, {
    pageCount,
    chunkCount,
    proofCount: 54_000,
  })
  const store = new AtomicAttemptCursorStore()
  let sourceReads = 0
  const sourceObjectIds = new Set<string>()
  const source = boundedObjectSource(fixture.keyHandle, (input) => {
    sourceReads += 1
    sourceObjectIds.add(input.objectId)
  })

  for (let cycleIndex = 0; cycleIndex < batchCount; cycleIndex += 1) {
    const result = await runBoundedUploadCycleForTest({
      fixture,
      store,
      initialAttempt: cycleIndex === 0 ? undefined : null,
      source,
    })
    assert.equal(result.state, cycleIndex === batchCount - 1 ? 'cas-sealed' : 'upload-pending')
  }

  assert.equal(sourceReads, objectCount)
  assert.equal(sourceObjectIds.size, objectCount)
  assert.equal(store.batches.size, batchCount)
  const attempt = store.attempts.get('61'.repeat(16))
  assert.notEqual(attempt, undefined)
  const batchIds = new Set(store.batches.keys())
  assert.equal(attempt!.batchIds.length, batchCount)
  assert.deepEqual([...attempt!.batchIds].sort(), [...batchIds].sort())
  assert.equal(attempt!.activeBatchId, null)
  assert.equal(attempt!.lifecycle, 'cas-journaled')
  assert.notEqual(attempt!.casAttemptId, null)
  assert.equal(store.casAttempts.size, 1)
  assert.equal(store.casAttempts.has(attempt!.casAttemptId!), true)
  assert.equal(
    [...store.batches.values()].every(
      (batch) =>
        batch.state === 'finalized' &&
        batch.items.length <= 16 &&
        batch.uploadedBytes <= ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX &&
        measureEncryptedWalletBackupUploadBatchRecordBytes(batch) <=
          ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX &&
        batch.repackedChunkCount <= 4,
    ),
    true,
  )
  assert.deepEqual(store.methodCalls, {
    pairedAttemptClaim: 45,
    pairedAttemptSeal: 1,
    batchCursorSeal: 45,
    initialAttemptValidation: 45,
    activeBatchRead: 0,
    executionClaim: 45,
    combinedAttemptBatchValidation: 249,
    acknowledgementTransition: 45,
    casSeal: 1,
  })
  assert.equal(
    Object.values(store.methodCalls).reduce((total, calls) => total + calls, 0),
    476,
  )
})

test('derived 3,000-CTF-proof capacity fixture stays within bounded upload capacity', async () => {
  const fixture = await boundedTargetFixture(false, {
    pageCount: 15,
    chunkCount: 7,
    proofCount: 3_000,
  })
  const head = decode(fixture.target.wire.canonicalHead) as unknown[]
  assert.equal(head[11], 2_818_664)
  assert.equal(15 + 7, 22)
  const store = new AtomicAttemptCursorStore()
  let cycles = 0
  let result: Awaited<ReturnType<typeof runBoundedUploadCycleForTest>>
  do {
    result = await runBoundedUploadCycleForTest({
      fixture,
      store,
      initialAttempt: cycles === 0 ? undefined : null,
    })
    cycles += 1
  } while (result.state === 'upload-pending' && cycles < 64)
  assert.equal(result.state, 'cas-sealed')
  assert.ok(cycles <= 64)
})

test('bounded upload attempt rejects incomplete, changed, foreign, and malformed atomic callbacks', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of [
    'missing-attempt',
    'missing-cursor',
    'changed-target',
    'changed-cursor',
    'foreign',
    'omitted',
    'repeated',
    'substituted',
    'thenable',
    'over-return',
    'reservation-mismatch',
  ] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore(mode)
      await assert.rejects(
        sealBoundedEncryptedWalletBackupUploadAttempt({
          attemptId: '44'.repeat(16),
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          target: fixture.target,
          store,
        }),
      )
      assert.equal(store.attempts.size, 0)
      assert.equal(store.cursors.size, 0)
    })
  }
})

test('bounded upload attempt accepts a callback in a Promise microtask before settlement', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore('deferred')
  const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '44'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  assert.equal(sealed.record.attemptId, '44'.repeat(16))
})

test('bounded upload attempt rejects a legacy head', async () => {
  const fixture = await boundedTargetFixture(false)
  await assert.rejects(
    sealBoundedEncryptedWalletBackupUploadAttempt({
      attemptId: '55'.repeat(16),
      ownerId: 'owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      target: fixture.target.head as never,
      store: new AtomicAttemptCursorStore(),
    }),
    /bounded upload attempt target is invalid/,
  )
})

class AtomicAttemptCursorStore implements EncryptedWalletBackupUploadAttemptCursorStore {
  readonly attempts = new Map<string, EncryptedWalletBackupActiveUploadAttemptRecord>()
  readonly cursors = new Map<string, Uint8Array>()
  readonly batches = new Map<string, EncryptedWalletBackupUploadBatchRecord>()
  readonly casAttempts = new Map<string, EncryptedWalletBackupSyncAttemptRecord>()
  readonly methodCalls = {
    pairedAttemptClaim: 0,
    pairedAttemptSeal: 0,
    batchCursorSeal: 0,
    initialAttemptValidation: 0,
    activeBatchRead: 0,
    executionClaim: 0,
    combinedAttemptBatchValidation: 0,
    acknowledgementTransition: 0,
    casSeal: 0,
  }
  reservation:
    | Parameters<
        EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
      >[0]['reservation']
    | null = null
  batchReservation:
    | Parameters<
        EncryptedWalletBackupUploadAttemptCursorStore['sealUploadBatchAndAdvanceCursor']
      >[0]['reservation']
    | null = null
  readonly mode: Mode
  private uncertainBatchCommitRejected = false

  constructor(mode: Mode = 'normal') {
    this.mode = mode
  }

  async sealActiveUploadAttemptAndCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
    seal: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
      cursor: Uint8Array | null
    }) => T,
  ): Promise<T> {
    this.methodCalls.pairedAttemptSeal += 1
    this.reservation = input.reservation
    if (this.mode === 'reservation-mismatch') {
      this.reservation = { ...input.reservation, readRows: 1 } as never
      throw new Error('reservation mismatch')
    }
    if (this.mode === 'omitted') return {} as T
    const existingAttempt = this.attempts.get(input.candidate.attemptId) ?? null
    const existingCursor = this.cursors.get(input.candidate.attemptId)?.slice() ?? null
    if (
      existingAttempt === null &&
      [...this.attempts.values()].some(
        (value) =>
          value.realm === input.candidate.realm && value.vaultId === input.candidate.vaultId,
      )
    ) {
      throw new Error('live backup upload attempt already exists')
    }
    const expectedAttempt = this.record(input)
    const attempt = existingAttempt ?? expectedAttempt
    const cursor = existingCursor ?? input.initialCursor.slice()
    if (
      existingAttempt !== null &&
      (!isDeepStrictEqual(existingAttempt, expectedAttempt) || !equalBytes(existingCursor!, cursor))
    ) {
      throw new Error('backup upload attempt conflicts with different content')
    }
    const beforeAttempts = new Map(this.attempts)
    const beforeCursors = new Map(this.cursors)
    if (existingAttempt === null) this.attempts.set(attempt.attemptId, attempt)
    if (existingCursor === null) this.cursors.set(attempt.attemptId, cursor)
    try {
      const committed = this.committed(attempt, cursor)
      if (this.mode === 'deferred')
        return Promise.resolve()
          .then(() => seal(committed))
          .catch((error: unknown) => {
            this.restore(beforeAttempts, beforeCursors)
            throw error
          })
      const result = seal(committed)
      if (this.mode === 'repeated') seal(committed)
      if (this.mode === 'over-return') {
        this.restore(beforeAttempts, beforeCursors)
        return Object.freeze({ ...result }) as T
      }
      return result
    } catch (error) {
      this.restore(beforeAttempts, beforeCursors)
      throw error
    }
  }

  async claimActiveUploadAttemptAndCursor<T>(
    _input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[0],
    claim: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[1],
  ): Promise<T> {
    this.methodCalls.pairedAttemptClaim += 1
    const record = [...this.attempts.values()][0] ?? null
    const cursor = record === null ? null : (this.cursors.get(record.attemptId)?.slice() ?? null)
    const committed = { attempt: record, cursor }
    if (this.mode === 'claim-deferred') return Promise.resolve().then(() => claim(committed))
    return claim(committed)
  }

  async sealUploadBatchAndAdvanceCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealUploadBatchAndAdvanceCursor']
    >[0],
    seal: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealUploadBatchAndAdvanceCursor']
    >[1],
  ): Promise<T> {
    this.methodCalls.batchCursorSeal += 1
    this.batchReservation = input.reservation
    const current = this.attempts.get(input.claim.attemptId)
    const cursor = this.cursors.get(input.claim.attemptId)
    const existingBatch = this.batches.get(input.batch.batchId)
    if (
      current !== undefined &&
      cursor !== undefined &&
      existingBatch !== undefined &&
      equalBytes(cursor, input.nextCursor) &&
      isDeepStrictEqual(existingBatch, input.batch) &&
      current.activeBatchId === input.batch.batchId &&
      current.batchIds.includes(input.batch.batchId)
    ) {
      return seal({
        attempt: structuredClone(current),
        cursor: cursor.slice(),
        batch: structuredClone(existingBatch),
      })
    }
    if (current === undefined || cursor === undefined || !equalBytes(cursor, input.expectedCursor))
      throw new Error('cursor is stale')
    if (current.activeBatchId !== null) throw new Error('active batch must be acknowledged')
    const next = Object.freeze({
      ...current,
      batchIds: Object.freeze(
        current.batchIds.includes(input.batch.batchId)
          ? [...current.batchIds]
          : [...current.batchIds, input.batch.batchId],
      ),
      activeBatchId: input.batch.batchId,
    })
    const before = {
      attempt: current,
      cursor: cursor.slice(),
      batch: this.batches.get(input.batch.batchId),
    }
    this.attempts.set(next.attemptId, next)
    this.cursors.set(next.attemptId, input.nextCursor.slice())
    this.batches.set(input.batch.batchId, structuredClone(input.batch))
    const rollback = () => {
      this.attempts.set(before.attempt.attemptId, before.attempt)
      this.cursors.set(before.attempt.attemptId, before.cursor)
      if (before.batch === undefined) this.batches.delete(input.batch.batchId)
      else this.batches.set(input.batch.batchId, before.batch)
    }
    const committed = {
      attempt: structuredClone(next),
      cursor: input.nextCursor.slice(),
      batch: structuredClone(input.batch),
    }
    try {
      if (this.mode === 'batch-uncertain' && !this.uncertainBatchCommitRejected) {
        this.uncertainBatchCommitRejected = true
        return Promise.reject(new Error('uncertain batch commit'))
      }
      if (this.mode === 'batch-deferred')
        return Promise.resolve()
          .then(() => seal(committed))
          .catch((error: unknown) => {
            rollback()
            throw error
          })
      if (this.mode === 'batch-repeated') {
        const result = seal(committed)
        seal(committed)
        return result
      }
      if (this.mode === 'batch-substituted')
        return seal({
          ...committed,
          batch: { ...committed.batch, targetManifestDigest: '00'.repeat(32) },
        })
      if (this.mode === 'batch-unknown') return seal({ ...committed, unexpected: null } as never)
      if (this.mode === 'batch-thrown') throw new Error('batch callback failed')
      return seal(committed)
    } catch (error) {
      rollback()
      throw error
    }
  }

  async validateUploadAttemptClaim<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (record: EncryptedWalletBackupActiveUploadAttemptRecord) => T,
  ): Promise<T> {
    this.methodCalls.initialAttemptValidation += 1
    const current = this.attempts.get(claim.attemptId)
    if (current === undefined || !isDeepStrictEqual(current, claim))
      throw new Error('stale upload attempt claim')
    return read(structuredClone(current))
  }
  async readUploadBatch<T>(
    batchId: string,
    read: (record: EncryptedWalletBackupUploadBatchRecord) => T,
  ): Promise<T> {
    this.methodCalls.activeBatchRead += 1
    const batch = this.batches.get(batchId)
    if (batch === undefined) throw new Error('batch is absent')
    return read(structuredClone(batch))
  }
  async claimUploadBatchExecution<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    batch: EncryptedWalletBackupUploadBatchRecord,
    _leaseDurationMilliseconds: number,
    commit: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord
      batch: EncryptedWalletBackupUploadBatchRecord
    }) => T,
  ): Promise<T> {
    this.methodCalls.executionClaim += 1
    const current = this.batches.get(batch.batchId)
    if (
      current === undefined ||
      !isDeepStrictEqual(this.attempts.get(claim.attemptId), claim) ||
      !isDeepStrictEqual(current, batch)
    ) {
      throw new Error('stale upload execution claim')
    }
    const next = structuredClone({
      ...current,
      state: 'put-uncertain' as const,
      executionEpoch: current.executionEpoch + 1,
      executionLeaseExpiresAtUnixMilliseconds: 1_700_000_060_000,
    })
    this.batches.set(next.batchId, next)
    return commit({ attempt: structuredClone(claim), batch: structuredClone(next) })
  }
  async validateUploadBatchExecution<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    batch: EncryptedWalletBackupUploadBatchRecord,
    read: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord
      batch: EncryptedWalletBackupUploadBatchRecord
    }) => T,
  ): Promise<T> {
    this.methodCalls.combinedAttemptBatchValidation += 1
    const current = this.batches.get(batch.batchId)
    if (
      current === undefined ||
      !isDeepStrictEqual(this.attempts.get(claim.attemptId), claim) ||
      !isDeepStrictEqual(current, batch)
    ) {
      throw new Error('stale upload execution validation')
    }
    return read({ attempt: structuredClone(claim), batch: structuredClone(current) })
  }
  async transitionUploadBatch<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    expected: EncryptedWalletBackupUploadBatchRecord,
    next: EncryptedWalletBackupUploadBatchRecord,
    commit: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord
      batch: EncryptedWalletBackupUploadBatchRecord
    }) => T,
  ): Promise<T> {
    this.methodCalls.acknowledgementTransition += 1
    const current = this.batches.get(expected.batchId)
    const attempt = this.attempts.get(claim.attemptId)
    if (
      current === undefined ||
      attempt === undefined ||
      !isDeepStrictEqual(attempt, claim) ||
      !isDeepStrictEqual(current, expected)
    ) {
      throw new Error('stale upload batch transition')
    }
    const committedAttempt = Object.freeze({
      ...attempt,
      activeBatchId: next.state === 'acknowledged' ? null : attempt.activeBatchId,
    })
    this.attempts.set(committedAttempt.attemptId, committedAttempt)
    this.batches.set(next.batchId, structuredClone(next))
    return commit({ attempt: structuredClone(committedAttempt), batch: structuredClone(next) })
  }
  async fenceUploadAttemptForAbort<T>(): Promise<T> {
    throw new Error('unused')
  }
  async completeUploadAttemptAbort<T>(): Promise<T> {
    throw new Error('unused')
  }

  async sealOrReadLinkedCasAttempt<T>(
    claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    candidate: EncryptedWalletBackupSyncAttemptRecord,
    commit: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord
      batches: readonly EncryptedWalletBackupUploadBatchRecord[]
      casAttempts: readonly EncryptedWalletBackupSyncAttemptRecord[]
    }) => T,
  ): Promise<T> {
    this.methodCalls.casSeal += 1
    const attempt = this.attempts.get(claim.attemptId)
    if (
      attempt === undefined ||
      !isDeepStrictEqual(attempt, claim) ||
      attempt.activeBatchId !== null
    )
      throw new Error('CAS handoff has an active batch')
    const rows = [...this.batches.values()].filter((batch) => batch.attemptId === claim.attemptId)
    if (rows.some((batch) => batch.state !== 'acknowledged' && batch.state !== 'finalized'))
      throw new Error('CAS handoff has an unacknowledged batch')
    const casAttempt = this.casAttempts.get(candidate.attemptId) ?? structuredClone(candidate)
    this.casAttempts.set(casAttempt.attemptId, casAttempt)
    const finalizedRows = rows.map((batch) =>
      structuredClone({ ...batch, state: 'finalized' as const }),
    )
    for (const batch of finalizedRows) this.batches.set(batch.batchId, batch)
    const committedAttempt = Object.freeze({
      ...attempt,
      casAttemptId: casAttempt.attemptId,
      lifecycle: 'cas-journaled' as const,
    })
    this.attempts.set(committedAttempt.attemptId, committedAttempt)
    return commit({
      attempt: structuredClone(committedAttempt),
      batches: finalizedRows,
      casAttempts: [structuredClone(casAttempt)],
    })
  }
  async readLinkedCasAttempts<T>(): Promise<T> {
    throw new Error('unused')
  }
  async validateLinkedCasAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async transitionLinkedCasAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async completeLinkedCasAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async exhaustLinkedCasAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async resumeLinkedCasAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async completeForkCleanup<T>(): Promise<T> {
    throw new Error('unused')
  }

  acknowledgeActiveBatch(attemptId: string): void {
    const current = this.attempts.get(attemptId)
    if (current === undefined || current.activeBatchId === null)
      throw new Error('active batch is required')
    const batch = this.batches.get(current.activeBatchId)
    if (batch === undefined) throw new Error('active batch is absent')
    this.batches.set(
      batch.batchId,
      structuredClone({
        ...batch,
        state: 'acknowledged' as const,
        executionLeaseExpiresAtUnixMilliseconds: null,
        items: batch.items.map((item) => ({ ...item, canonicalPutPayload: null })),
      }),
    )
    this.attempts.set(
      attemptId,
      Object.freeze({
        ...current,
        activeBatchId: null,
      }),
    )
  }

  private record(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
  ): EncryptedWalletBackupActiveUploadAttemptRecord {
    return Object.freeze({
      ...structuredClone(input.candidate),
      ownerEpoch: 1,
      leaseExpiresAtUnixMilliseconds: 1_700_000_060_000,
      batchIds: Object.freeze([]),
      activeBatchId: null,
      casAttemptId: null,
      lifecycle: 'active',
    })
  }

  private committed(
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
    cursor: Uint8Array,
  ): { attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null; cursor: Uint8Array | null } {
    switch (this.mode) {
      case 'normal':
      case 'repeated':
      case 'over-return':
      case 'deferred':
      case 'claim-deferred':
      case 'batch-uncertain':
      case 'batch-deferred':
      case 'batch-repeated':
      case 'batch-substituted':
      case 'batch-unknown':
      case 'batch-thrown':
        return { attempt: structuredClone(attempt), cursor: cursor.slice() }
      case 'substituted':
        return Object.assign(Object.create({ cursor: cursor.slice() }), {
          attempt: structuredClone(attempt),
        }) as {
          attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
          cursor: Uint8Array | null
        }
      case 'thenable':
        return Object.assign(
          { attempt: structuredClone(attempt), cursor: cursor.slice() },
          { then() {} },
        )
      case 'missing-attempt':
        return { attempt: null, cursor: cursor.slice() }
      case 'missing-cursor':
        return { attempt: structuredClone(attempt), cursor: null }
      case 'changed-target':
        return {
          attempt: { ...attempt, targetManifestDigest: '00'.repeat(32) },
          cursor: cursor.slice(),
        }
      case 'changed-cursor': {
        const changed = cursor.slice()
        changed[changed.byteLength - 1]! ^= 1
        return { attempt: structuredClone(attempt), cursor: changed }
      }
      case 'foreign':
        return { attempt: { ...attempt, vaultId: '00'.repeat(32) }, cursor: cursor.slice() }
      case 'omitted':
      case 'reservation-mismatch':
        throw new Error('unreachable')
    }
  }

  private restore(
    attempts: ReadonlyMap<string, EncryptedWalletBackupActiveUploadAttemptRecord>,
    cursors: ReadonlyMap<string, Uint8Array>,
  ): void {
    this.attempts.clear()
    this.cursors.clear()
    for (const [key, value] of attempts) this.attempts.set(key, value)
    for (const [key, value] of cursors) this.cursors.set(key, value)
  }
}

function assertBoundedUploadCycleCallShape(
  store: AtomicAttemptCursorStore,
  input: Readonly<{ combinedAttemptBatchValidation: number; total: number }>,
): void {
  assert.deepEqual(store.methodCalls, {
    pairedAttemptClaim: 1,
    pairedAttemptSeal: 1,
    batchCursorSeal: 1,
    initialAttemptValidation: 1,
    activeBatchRead: 0,
    executionClaim: 1,
    combinedAttemptBatchValidation: input.combinedAttemptBatchValidation,
    acknowledgementTransition: 1,
    casSeal: 1,
  })
  assert.equal(
    Object.values(store.methodCalls).reduce((total, calls) => total + calls, 0),
    input.total,
  )
}

async function runBoundedUploadCycleForTest(input: {
  readonly fixture: Awaited<ReturnType<typeof boundedTargetFixture>>
  readonly store: AtomicAttemptCursorStore
  readonly initialAttempt?: Parameters<
    typeof runBoundedEncryptedWalletBackupUploadCycle
  >[0]['initialAttempt']
  readonly source?: EncryptedWalletBackupBoundedUploadObjectSource
  readonly remote?: Parameters<typeof runBoundedEncryptedWalletBackupUploadCycle>[0]['remote']
}) {
  return runBoundedEncryptedWalletBackupUploadCycle({
    initialAttempt:
      input.initialAttempt === undefined
        ? { attemptId: '61'.repeat(16), target: input.fixture.target }
        : input.initialAttempt,
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: input.fixture.keyHandle,
    store: input.store as unknown as EncryptedWalletBackupUploadAttemptCursorStore &
      EncryptedWalletBackupCoordinatorStore,
    source: input.source ?? boundedObjectSource(input.fixture.keyHandle),
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    objectUrl: (objectId) => `https://backup.example.test/v1/vault/objects/${objectId}`,
    remote:
      input.remote ??
      ({
        async putObject() {
          return { status: 'stored' as const }
        },
      } satisfies Parameters<typeof runBoundedEncryptedWalletBackupUploadCycle>[0]['remote']),
    signal: AbortSignal.timeout(60_000),
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(value) {
        return webcrypto.getRandomValues(value)
      },
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function waitForPutCalls(read: () => number): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (read() >= 4) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('four concurrent PUTs did not start')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

function objectIdFor(value: number): string {
  return value.toString(16).padStart(32, '0')
}

function boundedObjectDigest(
  keyHandle: EncryptedWalletBackupKeyHandle,
  kindCode: 1 | 2,
  objectId: string,
  paddedLength: 65_536 | 262_144,
): string {
  const aad = boundedObjectAad(keyHandle, kindCode, objectId, paddedLength)
  const body = new Uint8Array(kindCode === 2 ? 65_564 : 262_172)
  return bytesToHex(encryptedWalletBackupObjectDigest(aad, body))
}

function boundedObjectAad(
  keyHandle: EncryptedWalletBackupKeyHandle,
  kindCode: 1 | 2,
  objectId: string,
  paddedLength: 65_536 | 262_144,
): Uint8Array {
  if (kindCode === 1) {
    return encodeCanonicalBackupCbor([
      1,
      kindCode,
      keyHandle.realm,
      hexToBytes(keyHandle.vaultId),
      hexToBytes(objectId),
      1,
      paddedLength,
    ])
  }
  const context = BOUNDED_MANIFEST_PAGE_AAD_CONTEXTS.get(keyHandle)
  const pageIndex = context?.pageAadIndexByObjectId.get(objectId)
  if (context === undefined || pageIndex === undefined) {
    throw new Error('bounded manifest page AAD context is absent')
  }
  return encodeCanonicalBackupCbor([
    1,
    'encrypted-wallet-backup-manifest-page-aad',
    2,
    keyHandle.realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(objectId),
    1,
    paddedLength,
    context.snapshotId,
    context.snapshotRevision,
    hexToBytes(context.sealedControlDigest),
    hexToBytes(context.resultDigest),
    pageIndex,
    context.pageCount,
    new Uint8Array(32).fill(0x18),
  ])
}

function boundedObjectSource(
  keyHandle: EncryptedWalletBackupKeyHandle,
  inspect?: (query: Readonly<{ maximumRows: 1; maximumBytes: 1_048_576 }>) => void,
): EncryptedWalletBackupBoundedUploadObjectSource {
  const object = (kindCode: 1 | 2, objectId: string, paddedLength: 65_536 | 262_144) =>
    Object.freeze({
      formatVersion: 1 as const,
      kindCode,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      objectId,
      generation: 1,
      paddedLength,
      digest: boundedObjectDigest(keyHandle, kindCode, objectId, paddedLength),
      aad: boundedObjectAad(keyHandle, kindCode, objectId, paddedLength),
      body: new Uint8Array(kindCode === 2 ? 65_564 : 262_172),
    })
  return {
    async readManifestPageObject(input) {
      inspect?.(input)
      return object(2, input.objectId, 65_536)
    },
    async readProofChunkObject(input) {
      inspect?.(input)
      return object(1, input.objectId, 262_144)
    },
  }
}

async function boundedTargetFixture(
  empty: boolean,
  counts?: Readonly<{
    pageCount: number
    chunkCount: number
    proofCount?: number
    pageAadIndexForPage?: (pageIndex: number, pageCount: number) => number
  }>,
): Promise<{
  keyHandle: EncryptedWalletBackupKeyHandle
  target: PreparedEncryptedWalletBackupManifestTarget
}> {
  const seed = new Uint8Array(64).fill(empty ? 7 : 8)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'backup.example.test',
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues: (value) => webcrypto.getRandomValues(value),
    },
  })
  const control = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce: '22'.repeat(16),
      snapshotId: empty ? 'empty' : 'pages',
      snapshotRevision: 1,
    },
  )
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues: (value) => webcrypto.getRandomValues(value),
    },
    signal: AbortSignal.timeout(60_000),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  const pageCount = empty ? 0 : (counts?.pageCount ?? 1)
  const chunkCount = empty ? 0 : (counts?.chunkCount ?? 1)
  const pageObjectIds = Array.from({ length: pageCount }, (_value, index) => objectIdFor(index + 1))
  BOUNDED_MANIFEST_PAGE_AAD_CONTEXTS.set(
    keyHandle,
    Object.freeze({
      snapshotId: empty ? 'empty' : 'pages',
      snapshotRevision: 1,
      sealedControlDigest: '16'.repeat(32),
      resultDigest: '17'.repeat(32),
      pageCount,
      pageAadIndexByObjectId: new Map(
        pageObjectIds.map((objectId, pageIndex) => [
          objectId,
          counts?.pageAadIndexForPage?.(pageIndex, pageCount) ?? pageIndex,
        ]),
      ),
    }),
  )
  const pages = Array.from({ length: pageCount }, (_value, index) => {
    const objectId = pageObjectIds[index]!
    return {
      formatVersion: 1 as const,
      kindCode: 2 as const,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      objectId,
      generation: 1,
      paddedLength: 65_536 as const,
      digest: boundedObjectDigest(keyHandle, 2, objectId, 65_536),
    }
  })
  const firstChunkObjectId = Math.max(33, pageCount + 1)
  const chunkReferences = Array.from({ length: chunkCount }, (_value, index) => {
    const objectId = objectIdFor(index + firstChunkObjectId)
    return {
      objectId,
      digest: boundedObjectDigest(keyHandle, 1, objectId, 262_144),
    }
  })
  const target = prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle,
    capability: issueBoundedManifestTargetCapabilityForTest({
      keyHandle,
      control,
      parentEvidence,
      pages,
      chunkReferences,
      proofCount: counts?.proofCount ?? Math.max(pageCount, chunkCount),
    }),
  })
  return { keyHandle, target }
}
