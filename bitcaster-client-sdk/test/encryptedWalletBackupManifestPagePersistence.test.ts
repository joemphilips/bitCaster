import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  decodeEncryptedWalletBackupManifestPageCursor,
  decodeEncryptedWalletBackupManifestPageRow,
  encodeEncryptedWalletBackupManifestPageCursor,
  encodeEncryptedWalletBackupManifestPageRow,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_CURSOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES,
  persistNextEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupManifestPagePersistenceStore,
  type EncryptedWalletBackupManifestPagePersistenceTransaction,
} from '../src/encryptedWalletBackupManifestPagePersistence.ts'
import * as manifestPagePersistence from '../src/encryptedWalletBackupManifestPagePersistence.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'
import {
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupManifestPage,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  readAuthenticatedEncryptedWalletBackupManifestPageReference,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupRuntime,
} from '../src/encryptedWalletBackup.ts'
import {
  finalizeBoundedEncryptedWalletBackupManifestTarget,
  type EncryptedWalletBackupManifestFinalizationState,
  type EncryptedWalletBackupManifestTargetFinalizationStore,
} from '../src/encryptedWalletBackupManifestTargetFinalization.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'
import { encodeEncryptedWalletBackupFrozenSnapshot } from '../src/encryptedWalletBackupSnapshotPersistence.ts'
import {
  decodeEncryptedWalletBackupManifestPassAResult,
  encodeEncryptedWalletBackupManifestPassAResult,
} from '../src/encryptedWalletBackupManifestPassA.ts'
import {
  bytesEqual,
  onePageManifestFixture,
  twoPageManifestFixture,
} from './helpers/encryptedWalletBackupManifestFixture.ts'

type BackupVector = Readonly<{
  readonly inputs: Readonly<{ readonly realm: string }>
  readonly expected: Readonly<{
    readonly vaultIdHex: string
    readonly manifestPassBCursorCborHex: string
    readonly manifestPassBPageRowEncodedLength: number
    readonly manifestPassBPageRowDigestHex: string
    readonly manifestPassBPageRowSha256Hex: string
  }>
}>

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as BackupVector

test('Pass-B cursor codec round-trips its explicit absent prior page', () => {
  const cursor = {
    schemaVersion: 1 as const,
    realm: 'production',
    vaultId: '11'.repeat(32),
    snapshotId: 'snapshot-a',
    snapshotRevision: 1,
    sealedControlDigest: '22'.repeat(32),
    sealedControlVersion: 1,
    passAResultDigest: '33'.repeat(32),
    generation: 1,
    snapshotNonce: '44'.repeat(16),
    nextPageIndex: 0,
    exclusiveSourcePinKey: { state: 'absent' as const },
    cumulativeEntryCount: 0,
    cumulativeCanonicalEntryBytes: 0,
    version: 1,
    priorPageRowDigest: { state: 'absent' as const },
  }
  const decoded = decodeEncryptedWalletBackupManifestPageCursor(
    encodeEncryptedWalletBackupManifestPageCursor(cursor),
  )
  assert.equal(decoded.nextPageIndex, 0)
  assert.equal(decoded.priorPageRowDigest.state, 'absent')
})

test('Pass-B persisted cursor and page-row vectors are canonical and reproducible', () => {
  const cursor = manifestPassBVectorCursor()
  const cursorBytes = hexToBytes(vector.expected.manifestPassBCursorCborHex)
  const decodedCursor = decode(cursorBytes)
  assert.equal(Array.isArray(decodedCursor), true)
  assert.equal(decodedCursor[0], 1)
  assert.equal(decodedCursor[1], 'encrypted-wallet-backup-manifest-pass-b-cursor')
  assert.equal(decodedCursor[2], vector.inputs.realm)
  assert.equal(bytesToHex(decodedCursor[3] as Uint8Array), vector.expected.vaultIdHex)
  assert.equal(decodedCursor[4], 'test-snapshot')
  assert.equal(decodedCursor[11], 0)
  assert.equal((decodedCursor[12] as unknown[])[0], 0)
  assert.equal((decodedCursor[16] as unknown[])[0], 0)
  assert.equal(
    bytesToHex(encodeCanonical(cursorWire(cursor))),
    vector.expected.manifestPassBCursorCborHex,
  )
  assert.equal(
    bytesToHex(encodeEncryptedWalletBackupManifestPageCursor(cursor)),
    vector.expected.manifestPassBCursorCborHex,
  )

  const row = manifestPassBVectorRow()
  const body = pageRowWire(row)
  const rowBytes = encodeCanonical([...body, hexToBytes(row.rowDigest)])
  const decodedRow = decode(rowBytes)
  assert.equal(Array.isArray(decodedRow), true)
  assert.equal(decodedRow[0], 1)
  assert.equal(decodedRow[1], 'encrypted-wallet-backup-manifest-page')
  assert.equal(decodedRow[2], vector.inputs.realm)
  assert.equal(bytesToHex(decodedRow[3] as Uint8Array), vector.expected.vaultIdHex)
  assert.equal(decodedRow[4], 'test-snapshot')
  assert.equal(decodedRow[11], 0)
  assert.equal(decodedRow[12], 1)
  assert.equal((decodedRow[13] as unknown[])[0], 1)
  assert.equal((decodedRow[14] as unknown[])[9] instanceof Uint8Array, true)
  assert.equal(
    ((decodedRow[14] as unknown[])[9] as Uint8Array).byteLength,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  )
  assert.equal(
    bytesToHex(decodedRow[15] as Uint8Array),
    vector.expected.manifestPassBPageRowDigestHex,
  )
  assert.equal(rowBytes.byteLength, vector.expected.manifestPassBPageRowEncodedLength)
  assert.equal(bytesToHex(sha256(rowBytes)), vector.expected.manifestPassBPageRowSha256Hex)
  const decodedBySdk = decodeEncryptedWalletBackupManifestPageRow(rowBytes)
  assert.equal(decodedBySdk.snapshotId, 'test-snapshot')
  assert.equal(decodedBySdk.object.body.byteLength, ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES)
  assert.equal(
    bytesEqual(encodeEncryptedWalletBackupManifestPageRow(row), rowBytes),
    true,
    'production page-row encoder did not reproduce the fixed vector',
  )
})

test('Pass-B cursor and page row codecs reject noncanonical and inconsistent bytes', () => {
  const cursor = cursorFixture()
  const encoded = encodeEncryptedWalletBackupManifestPageCursor(cursor)
  assert.throws(
    () => decodeEncryptedWalletBackupManifestPageCursor(new Uint8Array([...encoded, 0])),
    /cursor is invalid/,
  )
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageCursor({ ...cursor, unexpected: true }),
    /cursor is invalid/,
  )
  const row = pageRowFixture()
  const decoded = decodeEncryptedWalletBackupManifestPageRow(
    encodeEncryptedWalletBackupManifestPageRow(row),
  )
  assert.equal(decoded.object.body.byteLength, ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES)
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageRow({ ...row, pageIndex: 1 }),
    /page row is invalid/,
  )
  assert.throws(
    () =>
      decodeEncryptedWalletBackupManifestPageRow(
        new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES + 1),
      ),
    /page row is invalid/,
  )
})

test('Pass-B cursor and complete page-row byte caps accept their maximum fixtures', () => {
  const cursor = maximumCursorFixture()
  const encodedCursor = encodeEncryptedWalletBackupManifestPageCursor(cursor)
  assert.equal(
    encodedCursor.byteLength <= ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_CURSOR_MAX_BYTES,
    true,
  )
  assert.equal(decodeEncryptedWalletBackupManifestPageCursor(encodedCursor).snapshotId.length, 128)
  assert.throws(
    () => decodeEncryptedWalletBackupManifestPageCursor(new Uint8Array(2_049)),
    /cursor is invalid/,
  )
  const row = maximumPageRowFixture()
  const encodedRow = encodeEncryptedWalletBackupManifestPageRow(row)
  assert.equal(encodedRow.byteLength <= ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES, true)
  assert.equal(decodeEncryptedWalletBackupManifestPageRow(encodedRow).object.aad.byteLength, 4_096)
  const oneByteOver = new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES + 1)
  oneByteOver.set(encodedRow)
  assert.throws(
    () => decodeEncryptedWalletBackupManifestPageRow(oneByteOver),
    /page row is invalid/,
  )
})

test('an empty authenticated snapshot persists completion without page randomness', async () => {
  const fixture = await emptyFixture()
  const store = new EmptyPageStore(fixture.control, fixture.result)
  const result = await persistNextEncryptedWalletBackupManifestPage({
    store,
    sourceStore: unusedSourceStore,
    stagedPackProvider: unusedPackProvider,
    snapshotStore: unusedSnapshotStore,
    control: fixture.issued,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    runtime: noRandomness,
  })
  assert.equal(result.state, 'completed')
  assert.equal(store.pages, 0)
  assert.equal(store.cursor === null, false)
  assert.equal(store.reservations, 1)
  const repeat = await persistNextEncryptedWalletBackupManifestPage({
    store,
    sourceStore: unusedSourceStore,
    stagedPackProvider: unusedPackProvider,
    snapshotStore: unusedSnapshotStore,
    control: fixture.issued,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    runtime: noRandomness,
  })
  assert.equal(repeat.state, 'completed')
  assert.equal(store.pages, 0)
})

test('empty completion rejects missing, repeated, and substituted transaction callbacks', async () => {
  const fixture = await emptyFixture()
  for (const mode of ['missing', 'repeated', 'substituted'] as const) {
    const store = new EmptyPageStore(fixture.control, fixture.result, mode)
    await assert.rejects(
      persistNextEncryptedWalletBackupManifestPage({
        store,
        sourceStore: unusedSourceStore,
        stagedPackProvider: unusedPackProvider,
        snapshotStore: unusedSnapshotStore,
        control: fixture.issued,
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        runtime: noRandomness,
      }),
      /callback is invalid/,
    )
    assert.equal(store.cursor, null)
    assert.equal(store.pages, 0)
  }
})

test('a real one-page snapshot inserts its exact page and advances the cursor atomically', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result)
  const result = await persistOnePage(fixture, store, randomness())
  assert.equal(result.state, 'page')
  assert.equal(result.recovered, false)
  assert.equal(store.currentPage, null)
  assert.equal(store.priorPage === null, false)
  assert.equal(store.priorPage!.byteLength, 66_388)
  assertOnePageRows(fixture, store)
  assertOnePageReservation(store)
})

test('a throwing page transaction rolls back and retry builds a fresh page', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result, 'throw')
  const random = randomness()
  await assert.rejects(persistOnePage(fixture, store, random), /transaction failed/)
  assert.equal(store.cursor, null)
  assert.equal(store.priorPage, null)
  assert.equal(fixture.sourceCalls.count, 1)
  const firstRandomCalls = random.calls
  store.mode = 'normal'
  const retry = await persistOnePage(fixture, store, random)
  assert.equal(retry.state, 'page')
  assert.equal(retry.recovered, false)
  assert.equal(fixture.sourceCalls.count, 2)
  assert.equal(random.calls > firstRandomCalls, true)
})

test('a committed page recovers after its transaction response rejects without rejoining', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result, 'commit-reject')
  const random = randomness()
  const result = await persistOnePage(fixture, store, random)
  assert.equal(result.state, 'page')
  assert.equal(result.recovered, true)
  assert.equal(
    readPreparedEncryptedWalletBackupObject(result.page).body.byteLength,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  )
  assert.equal(fixture.sourceCalls.count, 1)
  assert.equal(fixture.packCalls.count, 1)
  assert.equal(random.calls, 2)
  assert.deepEqual(store.stateReadLimits, [
    { maximumRows: 5, maximumBytes: 1_048_576 },
    { maximumRows: 5, maximumBytes: 1_048_576 },
  ])
  assertOnePageRows(fixture, store)
})

test('uncertain commit recovery rejects a rewritten cursor source pin', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(
    fixture.persistedControl,
    fixture.result,
    'commit-reject-forged-pin',
  )
  await assert.rejects(persistOnePage(fixture, store, randomness()), /transaction response failed/)
  assert.equal(fixture.sourceCalls.count, 1)
  assert.equal(store.priorPage === null, false)
})

test('invalid page transaction callbacks reject and leave the page state absent', async () => {
  for (const mode of ['missing', 'repeated', 'substituted', 'throw'] as const) {
    const fixture = await onePageManifestFixture()
    const store = new OnePageStore(fixture.persistedControl, fixture.result, mode)
    await assert.rejects(
      persistOnePage(fixture, store, randomness()),
      /callback is invalid|transaction failed/,
    )
    assert.equal(store.cursor, null)
    assert.equal(store.priorPage, null)
  }
})

test('a callback invoked after settlement is rejected without a second commit', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result, 'late')
  const result = await persistOnePage(fixture, store, randomness())
  assert.equal(result.state, 'page')
  await store.waitForLateCallback()
  assert.match(store.lateCallbackError?.message ?? '', /callback is invalid/)
  assert.equal(store.insertCalls, 1)
  assertOnePageRows(fixture, store)
})

test('a fresh process advances from its authenticated prior page to page one', async () => {
  const fixture = await twoPageManifestFixture()
  const first = new OnePageStore(fixture.persistedControl, fixture.result)
  const initial = await persistOnePage(fixture, first, randomness())
  assert.equal(initial.state, 'page')
  const resumed = await restartFixture(fixture)
  const store = new OnePageStore(fixture.persistedControl, fixture.result)
  store.cursor = first.cursor!.slice()
  store.priorPage = first.priorPage!.slice()
  const next = await persistOnePage(resumed, store, randomness())
  assert.equal(next.state, 'page')
  assert.equal(next.recovered, false)
  assertTwoPageContinuation(fixture, store)
  const completed = await persistOnePage(resumed, store, noRandomness)
  assert.equal(completed.state, 'completed')
})

test('prior-page tampering rejects before source join and page randomness', async () => {
  for (const tamper of priorPageTamperers) {
    const { fixture, store } = await persistedFirstPage()
    tamper(store)
    await assertNextPageRejectsBeforeWork(fixture, store)
  }
})

test('rewritten unkeyed row and cursor pins fail before source join and randomness', async () => {
  const { fixture, store } = await persistedFirstPage()
  const row = decodeEncryptedWalletBackupManifestPageRow(store.priorPage!)
  const lastPinKey = new Uint8Array([...row.sourceEvidence.lastPinKey, 255])
  replacePriorPage(store, (current) =>
    rowWithDigest({
      ...current,
      sourceEvidence: { ...current.sourceEvidence, lastPinKey },
    }),
  )
  replaceCursor(store, (cursor) => ({
    ...cursor,
    exclusiveSourcePinKey: { state: 'present' as const, value: lastPinKey },
  }))
  await assertNextPageRejectsBeforeWork(fixture, store)
})

test('cursor, control, and Pass-A tampering rejects before page randomness', async () => {
  for (const tamper of cursorAndContextTamperers) {
    const { fixture, store } = await persistedFirstPage()
    tamper(store)
    await assertNextPageRejectsBeforeWork(fixture, store)
  }
})

test('an occupied current page slot rejects before source join and randomness', async () => {
  const fixture = await twoPageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result)
  store.currentPage = new Uint8Array([1])
  await assertNextPageRejectsBeforeWork(fixture, store)
})

test('state reads reserve five rows and one MiB before buffers are exposed', async () => {
  const fixture = await onePageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result, 'state-over-limit')
  const random = randomness()
  await assert.rejects(persistOnePage(fixture, store, random), /state read exceeded its capacity/)
  assert.deepEqual(store.stateReadLimits, [{ maximumRows: 5, maximumBytes: 1_048_576 }])
  assert.equal(fixture.sourceCalls.count, 0)
  assert.equal(random.calls, 0)
})

test('Pass-B codecs reject hostile cursor and page-row encodings', () => {
  const cursor = cursorFixture()
  const row = pageRowFixture()
  assert.throws(
    () =>
      encodeEncryptedWalletBackupManifestPageCursor({
        ...cursor,
        exclusiveSourcePinKey: { state: 'absent', value: new Uint8Array([1]) },
      } as never),
    /cursor is invalid/,
  )
  assert.throws(
    () =>
      decodeEncryptedWalletBackupManifestPageCursor(
        new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES + 1),
      ),
    /cursor is invalid/,
  )
  assert.throws(
    () =>
      decodeEncryptedWalletBackupManifestPageRow(
        new Uint8Array([...encodeEncryptedWalletBackupManifestPageRow(row), 0]),
      ),
    /page row is invalid/,
  )
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageRow({ ...row, rowDigest: '00'.repeat(32) }),
    /page row is invalid/,
  )
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageRow({ ...row, unexpected: true } as never),
    /page row is invalid/,
  )
})

test('Pass-B encoders reject inherited fields and substituted own fields', () => {
  const cursor = cursorFixture()
  const row = pageRowFixture()
  const cursorWithInheritedSnapshotId = substituteOwnField(cursor, 'snapshotId')
  const rowWithInheritedSnapshotId = substituteOwnField(row, 'snapshotId')
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageCursor(cursorWithInheritedSnapshotId),
    /cursor is invalid/,
  )
  assert.throws(
    () => encodeEncryptedWalletBackupManifestPageRow(rowWithInheritedSnapshotId),
    /page row is invalid/,
  )
})

test('Pass-B persistence exposes no target, upload, network, deletion, eviction, or spend API', () => {
  for (const name of Object.keys(manifestPagePersistence))
    assert.equal(/target|upload|network|delete|evict|spend/i.test(name), false, name)
})

test('bounded finalization accepts complete ordered pages and rejects incomplete or unordered scans', async () => {
  const fixture = await completedFinalizationFixture()
  const target = await finalizeBoundedEncryptedWalletBackupManifestTarget({
    ...fixture.input,
    store: new FinalizationStore(fixture.state, fixture.rows),
  })
  assert.equal(target.head.proofCount, 2)
  assert.equal(target.head.objectCount >= 3, true)
  const originLostKey = await createEncryptedWalletBackupKeyHandle({
    seed: fixture.input.seed,
    realm: fixture.input.keyHandle.realm,
    runtime: noRandomness,
  })
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: originLostKey,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: randomness(),
    signal: AbortSignal.timeout(60_000),
  })
  const authenticated = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: originLostKey,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'found' as const, enrollmentEpoch: 1, head: target.wire }
      },
    },
  })
  const reference = readAuthenticatedEncryptedWalletBackupManifestPageReference({
    headEvidence: authenticated,
    pageIndex: 0,
  })
  const persisted = decodeEncryptedWalletBackupManifestPageRow(fixture.rows[0]!)
  assert.equal(reference.objectId, persisted.object.objectId)
  const page = await decryptEncryptedWalletBackupManifestPage({
    keyHandle: originLostKey,
    seed: fixture.input.seed,
    object: persisted.object,
    headEvidence: authenticated,
  })
  assert.equal(page.entries.length > 0, true)
  const reconstructed = await finalizeBoundedEncryptedWalletBackupManifestTarget({
    ...fixture.input,
    store: new FinalizationStore(fixture.state, fixture.rows),
  })
  assert.equal(bytesEqual(target.wire.canonicalHead, reconstructed.wire.canonicalHead), true)
  assert.equal(
    bytesEqual(target.wire.canonicalReferenceSet, reconstructed.wire.canonicalReferenceSet),
    true,
  )

  for (const rows of [
    fixture.rows.slice(0, 1),
    [fixture.rows[0]!, fixture.rows[0]!],
    [...fixture.rows].reverse(),
    [...fixture.rows, fixture.rows[1]!],
  ]) {
    await assert.rejects(
      finalizeBoundedEncryptedWalletBackupManifestTarget({
        ...fixture.input,
        store: new FinalizationStore(fixture.state, rows),
      }),
      /coverage|order|extra/,
    )
  }
})

test('bounded finalization requires reservation, an exact final exhaustion read, and page endpoints', async () => {
  const fixture = await completedFinalizationFixture()
  const store = new FinalizationStore(fixture.state, fixture.rows)
  await finalizeBoundedEncryptedWalletBackupManifestTarget({ ...fixture.input, store })
  assert.equal(
    store.reads.every((read) => read.maximumRows <= 256 && read.maximumBytes === 1_048_576),
    true,
  )
  assert.equal(store.reads.at(-1)?.exclusivePageIndex, 1)

  const changed = fixture.rows[1]!.slice()
  changed[changed.byteLength - 1] ^= 1
  await assert.rejects(
    finalizeBoundedEncryptedWalletBackupManifestTarget({
      ...fixture.input,
      store: new FinalizationStore(fixture.state, [fixture.rows[0]!, changed]),
    }),
    /page row is invalid/,
  )
})

test('bounded finalization rejects a mismatched cursor row-digest tail after scanning', async () => {
  const fixture = await completedFinalizationFixture()
  const cursor = decodeEncryptedWalletBackupManifestPageCursor(fixture.state.cursor)
  const state = {
    control: fixture.state.control,
    passAResult: fixture.state.passAResult,
    cursor: encodeEncryptedWalletBackupManifestPageCursor({
      ...cursor,
      priorPageRowDigest: { state: 'present' as const, value: new Uint8Array(32) },
    }),
  }
  const store = new FinalizationStore({ ...fixture.state, cursor: state.cursor }, fixture.rows)
  await assert.rejects(
    finalizeBoundedEncryptedWalletBackupManifestTarget({ ...fixture.input, store }),
    /cursor is invalid/,
  )
  assert.equal(store.reads.at(-1)?.exclusivePageIndex, 1)
})

test('bounded finalization rejects a mismatched cursor source-pin tail after scanning', async () => {
  const fixture = await completedFinalizationFixture()
  const cursor = decodeEncryptedWalletBackupManifestPageCursor(fixture.state.cursor)
  const state = {
    control: fixture.state.control,
    passAResult: fixture.state.passAResult,
    cursor: encodeEncryptedWalletBackupManifestPageCursor({
      ...cursor,
      exclusiveSourcePinKey: { state: 'present' as const, value: new Uint8Array([255]) },
    }),
  }
  const store = new FinalizationStore({ ...fixture.state, cursor: state.cursor }, fixture.rows)
  await assert.rejects(
    finalizeBoundedEncryptedWalletBackupManifestTarget({ ...fixture.input, store }),
    /cursor is invalid/,
  )
  assert.equal(store.reads.at(-1)?.exclusivePageIndex, 1)
})

test('bounded finalization rejects finalization state with unknown or inherited required fields', async () => {
  const fixture = await completedFinalizationFixture()
  const finalizationState = {
    control: fixture.state.control,
    passAResult: fixture.state.passAResult,
    cursor: fixture.state.cursor,
  }
  const unknownFieldState = { ...finalizationState, unexpected: true }
  const inheritedControlState = Object.assign(
    Object.create({ control: finalizationState.control }),
    { passAResult: finalizationState.passAResult, cursor: finalizationState.cursor },
  )
  for (const state of [unknownFieldState, inheritedControlState]) {
    await assert.rejects(
      finalizeBoundedEncryptedWalletBackupManifestTarget({
        ...fixture.input,
        store: new UncheckedFinalizationStore(state, fixture.state, fixture.rows),
      }),
      /finalization state is invalid/,
    )
  }
})

test('bounded finalization supports an empty completed snapshot and rejects stale control state', async () => {
  const fixture = await emptyFixture()
  const pageStore = new EmptyPageStore(fixture.control, fixture.result)
  await persistNextEncryptedWalletBackupManifestPage({
    store: pageStore,
    sourceStore: unusedSourceStore,
    stagedPackProvider: unusedPackProvider,
    snapshotStore: unusedSnapshotStore,
    control: fixture.issued,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    runtime: noRandomness,
  })
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: randomness(),
    signal: AbortSignal.timeout(60_000),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  const state = {
    control: fixture.control,
    passAResult: fixture.result,
    cursor: pageStore.cursor!,
    currentPage: null,
    priorPage: null,
  }
  const target = await finalizeBoundedEncryptedWalletBackupManifestTarget({
    store: new FinalizationStore(state as never, []),
    control: fixture.issued,
    parentEvidence,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
  })
  assert.equal(target.head.objectCount, 0)
  await assert.rejects(
    finalizeBoundedEncryptedWalletBackupManifestTarget({
      store: new FinalizationStore({ ...state, control: new Uint8Array([1]) } as never, []),
      control: fixture.issued,
      parentEvidence,
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
    }),
    /invalid|foreign|incomplete/,
  )
})

async function persistedFirstPage() {
  const fixture = await twoPageManifestFixture()
  const store = new OnePageStore(fixture.persistedControl, fixture.result)
  await persistOnePage(fixture, store, randomness())
  return { fixture, store }
}

async function completedFinalizationFixture() {
  const fixture = await twoPageManifestFixture()
  const first = new OnePageStore(fixture.persistedControl, fixture.result)
  const runtime = randomness()
  await persistOnePage(fixture, first, runtime)
  const firstRow = first.priorPage!.slice()
  const resumed = await restartFixture(fixture)
  const second = new OnePageStore(fixture.persistedControl, fixture.result)
  second.cursor = first.cursor!.slice()
  second.priorPage = first.priorPage!.slice()
  await persistOnePage(resumed, second, runtime)
  const secondRow = second.priorPage!.slice()
  await persistOnePage(resumed, second, noRandomness)
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: resumed.keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: randomness(),
    signal: AbortSignal.timeout(60_000),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: resumed.keyHandle,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  return {
    input: {
      control: resumed.control,
      parentEvidence,
      keyHandle: resumed.keyHandle,
      seed: resumed.seed,
    },
    state: {
      control: second.control.slice(),
      passAResult: second.passAResult.slice(),
      cursor: second.cursor!.slice(),
      currentPage: null,
      priorPage: second.priorPage!.slice(),
    },
    rows: [firstRow, secondRow],
  }
}

class FinalizationStore implements EncryptedWalletBackupManifestTargetFinalizationStore {
  readonly reads: Array<{ exclusivePageIndex: number; maximumRows: number; maximumBytes: number }> =
    []
  readonly state: {
    control: Uint8Array
    passAResult: Uint8Array
    cursor: Uint8Array
    currentPage: Uint8Array | null
    priorPage: Uint8Array
  }
  readonly rows: readonly Uint8Array[]
  constructor(
    state: {
      control: Uint8Array
      passAResult: Uint8Array
      cursor: Uint8Array
      currentPage: Uint8Array | null
      priorPage: Uint8Array
    },
    rows: readonly Uint8Array[],
  ) {
    this.state = state
    this.rows = rows
  }
  async readManifestFinalizationState(input: {
    scope: Uint8Array
    maximumRows: number
    maximumBytes: number
  }) {
    assert.equal(input.maximumRows, 3)
    assert.equal(input.maximumBytes, 1_048_576)
    return {
      control: this.state.control.slice(),
      passAResult: this.state.passAResult.slice(),
      cursor: this.state.cursor.slice(),
    }
  }
  async readManifestFinalizationRows(input: {
    scope: Uint8Array
    exclusivePageIndex: number
    maximumRows: number
    maximumBytes: number
  }) {
    this.reads.push({
      exclusivePageIndex: input.exclusivePageIndex,
      maximumRows: input.maximumRows,
      maximumBytes: input.maximumBytes,
    })
    const values = this.rows.slice(input.exclusivePageIndex + 1)
    const output: Uint8Array[] = []
    let bytes = 0
    for (const value of values) {
      if (output.length === input.maximumRows || bytes + value.byteLength > input.maximumBytes)
        break
      output.push(value.slice())
      bytes += value.byteLength
    }
    return output
  }
}

class UncheckedFinalizationStore extends FinalizationStore {
  readonly finalizationState: unknown
  constructor(
    finalizationState: unknown,
    state: ConstructorParameters<typeof FinalizationStore>[0],
    rows: readonly Uint8Array[],
  ) {
    super(state, rows)
    this.finalizationState = finalizationState
  }
  override async readManifestFinalizationState(): Promise<EncryptedWalletBackupManifestFinalizationState> {
    return this.finalizationState as EncryptedWalletBackupManifestFinalizationState
  }
}

async function restartFixture(fixture: Awaited<ReturnType<typeof twoPageManifestFixture>>) {
  return {
    ...fixture,
    control: issueEncryptedWalletBackupFrozenSnapshotControl({}, fixture.authority),
    keyHandle: await createEncryptedWalletBackupKeyHandle({
      seed: fixture.seed,
      realm: fixture.realm,
      runtime: noRandomness,
    }),
  }
}

function assertTwoPageContinuation(
  fixture: Awaited<ReturnType<typeof twoPageManifestFixture>>,
  store: OnePageStore,
): void {
  const page = decodeEncryptedWalletBackupManifestPageRow(store.priorPage!)
  const cursor = decodeEncryptedWalletBackupManifestPageCursor(store.cursor!)
  assert.equal(page.pageIndex, 1)
  assert.equal(page.pageCount, 2)
  assert.equal(cursor.nextPageIndex, 2)
  assert.equal(cursor.cumulativeEntryCount, fixture.current.recordCount)
  assert.equal(
    cursor.cumulativeCanonicalEntryBytes,
    decodeEncryptedWalletBackupManifestPassAResult(fixture.result).totalCanonicalManifestEntryBytes,
  )
  assert.equal(cursor.exclusiveSourcePinKey.state, 'present')
  assert.equal(bytesEqual(cursor.exclusiveSourcePinKey.value, page.sourceEvidence.lastPinKey), true)
  assert.equal(bytesEqual(page.sourceEvidence.firstPinKey, fixture.pinKeys[1]!), true)
  assert.equal(bytesEqual(page.sourceEvidence.lastPinKey, fixture.pinKeys[1]!), true)
  assert.equal(compareBytes(page.sourceEvidence.firstPinKey, fixture.pinKeys[0]!) > 0, true)
}

async function assertNextPageRejectsBeforeWork(
  fixture: Awaited<ReturnType<typeof twoPageManifestFixture>>,
  store: OnePageStore,
): Promise<void> {
  const sourceCalls = fixture.sourceCalls.count
  const random = randomness()
  await assert.rejects(persistOnePage(fixture, store, random))
  assert.equal(fixture.sourceCalls.count, sourceCalls)
  assert.equal(random.calls, 0)
}

function replacePriorPage(
  store: OnePageStore,
  change: (row: ReturnType<typeof decodeEncryptedWalletBackupManifestPageRow>) => unknown,
): void {
  store.priorPage = encodeEncryptedWalletBackupManifestPageRow(
    change(decodeEncryptedWalletBackupManifestPageRow(store.priorPage!)) as never,
  )
}

function replacePriorPageUnchecked(
  store: OnePageStore,
  change: (row: ReturnType<typeof decodeEncryptedWalletBackupManifestPageRow>) => unknown,
): void {
  const row = change(decodeEncryptedWalletBackupManifestPageRow(store.priorPage!)) as ReturnType<
    typeof decodeEncryptedWalletBackupManifestPageRow
  >
  store.priorPage = encodeCanonical([...pageRowWire(row), hexToBytes(row.rowDigest)])
}

function replaceCursor(
  store: OnePageStore,
  change: (cursor: ReturnType<typeof decodeEncryptedWalletBackupManifestPageCursor>) => unknown,
): void {
  store.cursor = encodeEncryptedWalletBackupManifestPageCursor(
    change(decodeEncryptedWalletBackupManifestPageCursor(store.cursor!)) as never,
  )
}

function rowWithDigest(row: ReturnType<typeof decodeEncryptedWalletBackupManifestPageRow>) {
  return {
    ...row,
    rowDigest: bytesToHex(sha256(encodeCanonical(pageRowWire(row)))),
  }
}

const priorPageTamperers: readonly ((store: OnePageStore) => void)[] = [
  (store) => replacePriorPageUnchecked(store, (row) => ({ ...row, rowDigest: '00'.repeat(32) })),
  (store) =>
    replacePriorPageUnchecked(store, (row) => ({
      ...row,
      object: { ...row.object, body: changedBytes(row.object.body) },
    })),
  (store) =>
    replacePriorPageUnchecked(store, (row) => ({
      ...row,
      object: { ...row.object, digest: '00'.repeat(32) },
    })),
  (store) => replacePriorPageUnchecked(store, (row) => ({ ...row, pageIndex: 1 })),
  (store) => replacePriorPageUnchecked(store, (row) => ({ ...row, pageCount: 1 })),
  (store) =>
    replacePriorPageUnchecked(store, (row) => ({
      ...row,
      sourceEvidence: {
        ...row.sourceEvidence,
        lastPinKey: new Uint8Array([...row.sourceEvidence.lastPinKey, 0]),
      },
    })),
  (store) =>
    replaceCursor(store, (cursor) => ({
      ...cursor,
      priorPageRowDigest: {
        state: 'present',
        value: changedBytes(
          cursor.priorPageRowDigest.state === 'present'
            ? cursor.priorPageRowDigest.value
            : new Uint8Array(32),
        ),
      },
    })),
]

const cursorAndContextTamperers: readonly ((store: OnePageStore) => void)[] = [
  (store) => replaceCursor(store, (cursor) => ({ ...cursor, realm: 'other' })),
  (store) => replaceCursor(store, (cursor) => ({ ...cursor, cumulativeEntryCount: 0 })),
  (store) => replaceCursor(store, (cursor) => ({ ...cursor, version: cursor.version + 1 })),
  (store) => replaceCursor(store, (cursor) => ({ ...cursor, nextPageIndex: 0 })),
  (store) => {
    store.control = changedBytes(store.control)
  },
  (store) => {
    store.passAResult = changedBytes(store.passAResult)
  },
]

function changedBytes(value: Uint8Array): Uint8Array {
  const changed = value.slice()
  changed[changed.byteLength - 1]! ^= 1
  return changed
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}

async function persistOnePage(
  fixture: Awaited<ReturnType<typeof onePageManifestFixture>>,
  store: OnePageStore,
  runtime: EncryptedWalletBackupRuntime,
) {
  return persistNextEncryptedWalletBackupManifestPage({
    store,
    sourceStore: fixture.sourceStore,
    stagedPackProvider: fixture.stagedPackProvider,
    snapshotStore: fixture.snapshotStore,
    control: fixture.control,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    runtime,
  })
}

function randomness(): EncryptedWalletBackupRuntime & { calls: number } {
  let calls = 0
  return {
    subtle: webcrypto.subtle,
    get calls() {
      return calls
    },
    getRandomValues(target) {
      calls += 1
      target.fill(calls)
      return target
    },
  }
}

function assertOnePageRows(
  fixture: Awaited<ReturnType<typeof onePageManifestFixture>>,
  store: OnePageStore,
): void {
  const page = decodeEncryptedWalletBackupManifestPageRow(store.priorPage!)
  const cursor = decodeEncryptedWalletBackupManifestPageCursor(store.cursor!)
  assert.equal(page.pageIndex, 0)
  assert.equal(page.pageCount, 1)
  assert.equal(page.sourceEvidence.entryCount, 1)
  assert.equal(page.sourceEvidence.canonicalEntryBytes, fixture.entryBytes)
  assert.equal(cursor.nextPageIndex, 1)
  assert.equal(cursor.cumulativeEntryCount, 1)
  assert.equal(cursor.cumulativeCanonicalEntryBytes, fixture.entryBytes)
  assert.equal(cursor.exclusiveSourcePinKey.state, 'present')
  assert.equal(bytesEqual(cursor.exclusiveSourcePinKey.value, page.sourceEvidence.lastPinKey), true)
  assert.equal(cursor.priorPageRowDigest.state, 'present')
  assert.equal(cursor.priorPageRowDigest.value.byteLength, 32)
}

function assertOnePageReservation(store: OnePageStore): void {
  const expected = store.lastReservation!
  assert.equal(expected.reservedReadRows, 3)
  assert.equal(expected.reservedWriteRows, 2)
  assert.equal(expected.reservedReadBytes > 0, true)
  assert.equal(expected.reservedWriteBytes > 0, true)
  assert.equal(expected.reservedReadBytes + expected.reservedWriteBytes <= 1_048_576, true)
}

function cursorFixture() {
  return {
    schemaVersion: 1 as const,
    realm: 'production',
    vaultId: '11'.repeat(32),
    snapshotId: 'snapshot-a',
    snapshotRevision: 1,
    sealedControlDigest: '22'.repeat(32),
    sealedControlVersion: 1,
    passAResultDigest: '33'.repeat(32),
    generation: 1,
    snapshotNonce: '44'.repeat(16),
    nextPageIndex: 0,
    exclusiveSourcePinKey: { state: 'absent' as const },
    cumulativeEntryCount: 0,
    cumulativeCanonicalEntryBytes: 0,
    version: 1,
    priorPageRowDigest: { state: 'absent' as const },
  }
}

function manifestPassBVectorCursor() {
  return {
    ...cursorFixture(),
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    snapshotId: 'test-snapshot',
    sealedControlDigest: '22'.repeat(32),
    passAResultDigest: '11'.repeat(32),
    snapshotNonce: '21'.repeat(16),
  }
}

function pageRowFixture() {
  const body = new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES)
  const row = {
    schemaVersion: 1 as const,
    realm: 'production',
    vaultId: '11'.repeat(32),
    snapshotId: 'snapshot-a',
    snapshotRevision: 1,
    sealedControlDigest: '22'.repeat(32),
    sealedControlVersion: 1,
    passAResultDigest: '33'.repeat(32),
    generation: 1,
    snapshotNonce: '44'.repeat(16),
    pageIndex: 0,
    pageCount: 1,
    sourceEvidence: {
      entryCount: 1,
      canonicalEntryBytes: 1,
      firstPinKey: new Uint8Array([1]),
      lastPinKey: new Uint8Array([1]),
    },
    object: {
      formatVersion: 1 as const,
      kindCode: 2 as const,
      realm: 'production',
      vaultId: '11'.repeat(32),
      objectId: '55'.repeat(16),
      generation: 1,
      paddedLength: 65_536 as const,
      digest: '66'.repeat(32),
      aad: new Uint8Array([1]),
      body,
    },
    rowDigest: '',
  }
  const wire = [
    1,
    'encrypted-wallet-backup-manifest-page',
    row.realm,
    hexToBytes(row.vaultId),
    row.snapshotId,
    row.snapshotRevision,
    hexToBytes(row.sealedControlDigest),
    row.sealedControlVersion,
    hexToBytes(row.passAResultDigest),
    row.generation,
    hexToBytes(row.snapshotNonce),
    row.pageIndex,
    row.pageCount,
    [
      row.sourceEvidence.entryCount,
      row.sourceEvidence.canonicalEntryBytes,
      row.sourceEvidence.firstPinKey,
      row.sourceEvidence.lastPinKey,
    ],
    [
      row.object.formatVersion,
      row.object.kindCode,
      row.object.realm,
      hexToBytes(row.object.vaultId),
      hexToBytes(row.object.objectId),
      row.object.generation,
      row.object.paddedLength,
      hexToBytes(row.object.digest),
      row.object.aad,
      row.object.body,
    ],
  ]
  const encoded = encodeEncryptedWalletBackupManifestPageRow({
    ...row,
    rowDigest: bytesToHex(sha256(encodeCanonical(wire))),
  })
  const decoded = decodeEncryptedWalletBackupManifestPageRow(encoded)
  return decoded
}

function manifestPassBVectorRow() {
  const row = pageRowFixture()
  const base = {
    ...row,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    snapshotId: 'test-snapshot',
    sealedControlDigest: '22'.repeat(32),
    passAResultDigest: '11'.repeat(32),
    snapshotNonce: '21'.repeat(16),
    object: {
      ...row.object,
      realm: vector.inputs.realm,
      vaultId: vector.expected.vaultIdHex,
    },
  }
  return {
    ...base,
    rowDigest: bytesToHex(sha256(encodeCanonical(pageRowWire(base)))),
  }
}

function cursorWire(cursor: ReturnType<typeof manifestPassBVectorCursor>): unknown[] {
  return [
    1,
    'encrypted-wallet-backup-manifest-pass-b-cursor',
    cursor.realm,
    hexToBytes(cursor.vaultId),
    cursor.snapshotId,
    cursor.snapshotRevision,
    hexToBytes(cursor.sealedControlDigest),
    cursor.sealedControlVersion,
    hexToBytes(cursor.passAResultDigest),
    cursor.generation,
    hexToBytes(cursor.snapshotNonce),
    cursor.nextPageIndex,
    [0],
    cursor.cumulativeEntryCount,
    cursor.cumulativeCanonicalEntryBytes,
    cursor.version,
    [0],
  ]
}

function substituteOwnField<T extends Record<string, unknown>>(value: T, field: keyof T): T {
  const inherited = { [field]: value[field] }
  const substituted = { ...value, unexpected: true }
  delete substituted[field]
  return Object.assign(Object.create(inherited), substituted) as T
}

function maximumCursorFixture() {
  return {
    ...cursorFixture(),
    realm: 'a'.repeat(64),
    snapshotId: 's'.repeat(128),
    snapshotRevision: Number.MAX_SAFE_INTEGER,
    sealedControlVersion: Number.MAX_SAFE_INTEGER,
    generation: Number.MAX_SAFE_INTEGER,
    nextPageIndex: Number.MAX_SAFE_INTEGER,
    exclusiveSourcePinKey: { state: 'present' as const, value: new Uint8Array(1_024) },
    cumulativeEntryCount: Number.MAX_SAFE_INTEGER,
    cumulativeCanonicalEntryBytes: Number.MAX_SAFE_INTEGER,
    version: Number.MAX_SAFE_INTEGER,
    priorPageRowDigest: { state: 'present' as const, value: new Uint8Array(32) },
  }
}

function maximumPageRowFixture() {
  const base = pageRowFixture()
  const row = {
    ...base,
    realm: 'a'.repeat(64),
    snapshotId: 's'.repeat(128),
    snapshotRevision: Number.MAX_SAFE_INTEGER,
    sealedControlVersion: Number.MAX_SAFE_INTEGER,
    generation: Number.MAX_SAFE_INTEGER,
    pageIndex: Number.MAX_SAFE_INTEGER - 1,
    pageCount: Number.MAX_SAFE_INTEGER,
    sourceEvidence: {
      entryCount: Number.MAX_SAFE_INTEGER,
      canonicalEntryBytes: Number.MAX_SAFE_INTEGER,
      firstPinKey: new Uint8Array(1_024),
      lastPinKey: new Uint8Array(1_024).fill(255),
    },
    object: {
      ...base.object,
      realm: 'a'.repeat(64),
      generation: Number.MAX_SAFE_INTEGER,
      aad: new Uint8Array(4_096),
    },
  }
  return decodeEncryptedWalletBackupManifestPageRow(
    encodeEncryptedWalletBackupManifestPageRow({
      ...row,
      rowDigest: bytesToHex(sha256(encodeCanonical(pageRowWire(row)))),
    }),
  )
}

function pageRowWire(row: ReturnType<typeof pageRowFixture>): unknown[] {
  return [
    1,
    'encrypted-wallet-backup-manifest-page',
    row.realm,
    hexToBytes(row.vaultId),
    row.snapshotId,
    row.snapshotRevision,
    hexToBytes(row.sealedControlDigest),
    row.sealedControlVersion,
    hexToBytes(row.passAResultDigest),
    row.generation,
    hexToBytes(row.snapshotNonce),
    row.pageIndex,
    row.pageCount,
    [
      row.sourceEvidence.entryCount,
      row.sourceEvidence.canonicalEntryBytes,
      row.sourceEvidence.firstPinKey,
      row.sourceEvidence.lastPinKey,
    ],
    [
      row.object.formatVersion,
      row.object.kindCode,
      row.object.realm,
      hexToBytes(row.object.vaultId),
      hexToBytes(row.object.objectId),
      row.object.generation,
      row.object.paddedLength,
      hexToBytes(row.object.digest),
      row.object.aad,
      row.object.body,
    ],
  ]
}

const noRandomness: EncryptedWalletBackupRuntime = {
  subtle: webcrypto.subtle,
  getRandomValues() {
    throw new Error('randomness reached')
  },
}

const unusedSourceStore = {
  async readSourcePage(): Promise<never> {
    throw new Error('source reached')
  },
}
const unusedPackProvider = {
  async rehydrateStagedPack(): Promise<never> {
    throw new Error('pack reached')
  },
}
const unusedSnapshotStore = {
  async withCommittedPreparedRecordSnapshotBatch(): Promise<never> {
    throw new Error('snapshot reached')
  },
}

async function emptyFixture() {
  const seed = new Uint8Array(64).fill(7)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'backup.example.test',
    runtime: noRandomness,
  })
  const issued = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm: 'backup.example.test',
      vaultId: keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce: '22'.repeat(16),
      snapshotId: 'empty',
      snapshotRevision: 1,
    },
  )
  const current = {
    schemaVersion: 1 as const,
    realm: 'backup.example.test',
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    parentGeneration: null,
    parentManifestDigest: null,
    parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
    generation: 1,
    snapshotNonce: '22'.repeat(16),
    snapshotId: 'empty',
    snapshotRevision: 1,
    state: 'sealed' as const,
    recordCount: 0,
    canonicalPinBytes: 0,
    sealRunRevision: 1,
    recordSetRoot: '33'.repeat(32),
    version: 2,
  }
  const control = encodeEncryptedWalletBackupFrozenSnapshot(current)
  const result = encodeEncryptedWalletBackupManifestPassAResult({
    schemaVersion: 1,
    realm: current.realm,
    vaultId: current.vaultId,
    snapshotId: current.snapshotId,
    snapshotRevision: current.snapshotRevision,
    sealedControlVersion: current.version,
    sealRunRevision: current.sealRunRevision,
    sealedControlDigest: bytesToHex(sha256(control)),
    recordSetRoot: current.recordSetRoot,
    generation: current.generation,
    snapshotNonce: current.snapshotNonce,
    recordCount: 0,
    canonicalPinBytes: 0,
    totalCanonicalManifestEntryBytes: 0,
    pageCount: 0,
    boundaries: [],
  })
  return { issued, control, result, seed, keyHandle }
}

class EmptyPageStore implements EncryptedWalletBackupManifestPagePersistenceStore {
  cursor: Uint8Array | null = null
  pages = 0
  reservations = 0
  control: Uint8Array
  passAResult: Uint8Array
  readonly mode: 'normal' | 'missing' | 'repeated' | 'substituted'

  constructor(
    control: Uint8Array,
    passAResult: Uint8Array,
    mode: 'normal' | 'missing' | 'repeated' | 'substituted' = 'normal',
  ) {
    this.control = control
    this.passAResult = passAResult
    this.mode = mode
  }
  async readManifestPageState(_input?: unknown) {
    return {
      control: this.control.slice(),
      passAResult: this.passAResult.slice(),
      cursor: this.cursor?.slice() ?? null,
      currentPage: null,
      priorPage: null,
    }
  }
  async withManifestPageTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore['withManifestPageTransaction']
    >[0],
    use: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore['withManifestPageTransaction']
    >[1],
  ): Promise<unknown> {
    this.reservations += 1
    if (this.mode === 'missing') return Object.freeze({})
    const state = await this.readManifestPageState(expected.scope)
    let next: Uint8Array | null = null
    const value = await use({
      ...state,
      insertPageAndAdvance: async () => {
        this.pages += 1
      },
      completeEmptyCursor: async (cursor) => {
        next = cursor.slice()
      },
    })
    if (this.mode === 'repeated')
      await use({
        ...state,
        insertPageAndAdvance: async () => {
          this.pages += 1
        },
        completeEmptyCursor: async (cursor) => {
          next = cursor.slice()
        },
      })
    if (this.mode === 'substituted') return Object.freeze({})
    if (next !== null) this.cursor = next
    return value
  }
}

type OnePageMode =
  | 'normal'
  | 'missing'
  | 'repeated'
  | 'substituted'
  | 'throw'
  | 'commit-reject'
  | 'commit-reject-forged-pin'
  | 'late'
  | 'state-over-limit'

class OnePageStore implements EncryptedWalletBackupManifestPagePersistenceStore {
  cursor: Uint8Array | null = null
  currentPage: Uint8Array | null = null
  priorPage: Uint8Array | null = null
  insertCalls = 0
  stateReadLimits: Array<{ maximumRows: number; maximumBytes: number }> = []
  lateCallbackError: Error | null = null
  lastReservation:
    | Parameters<
        EncryptedWalletBackupManifestPagePersistenceStore['withManifestPageTransaction']
      >[0]
    | null = null
  mode: OnePageMode
  control: Uint8Array
  passAResult: Uint8Array
  #late: Promise<void> | null = null

  constructor(control: Uint8Array, passAResult: Uint8Array, mode: OnePageMode = 'normal') {
    this.control = control.slice()
    this.passAResult = passAResult.slice()
    this.mode = mode
  }

  async readManifestPageState(
    input: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore['readManifestPageState']
    >[0],
  ) {
    this.stateReadLimits.push({
      maximumRows: input.maximumRows,
      maximumBytes: input.maximumBytes,
    })
    if (this.mode === 'state-over-limit') throw new Error('state read exceeded its capacity')
    return this.state()
  }

  private state() {
    return {
      control: this.control.slice(),
      passAResult: this.passAResult.slice(),
      cursor: this.cursor?.slice() ?? null,
      currentPage: this.currentPage?.slice() ?? null,
      priorPage: this.priorPage?.slice() ?? null,
    }
  }

  async withManifestPageTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore['withManifestPageTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupManifestPagePersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    this.lastReservation = expected
    if (this.mode === 'missing') return Object.freeze({})
    const pending = this.pendingTransaction()
    if (this.mode === 'throw') throw new Error('transaction failed')
    const value = await use(pending.transaction)
    if (this.mode === 'repeated') await use(pending.transaction)
    if (this.mode === 'substituted') return Object.freeze({})
    this.commit(pending)
    if (this.mode === 'commit-reject') throw new Error('transaction response failed')
    if (this.mode === 'commit-reject-forged-pin') {
      this.rewriteCursorPin()
      throw new Error('transaction response failed')
    }
    if (this.mode === 'late') this.deferLateCallback(use, pending.transaction)
    return value
  }

  async waitForLateCallback(): Promise<void> {
    await this.#late
  }

  private pendingTransaction() {
    let page: Uint8Array | null = null
    let cursor: Uint8Array | null = null
    const state = {
      control: this.control.slice(),
      passAResult: this.passAResult.slice(),
      cursor: this.cursor?.slice() ?? null,
      currentPage: this.currentPage?.slice() ?? null,
      priorPage: this.priorPage?.slice() ?? null,
    }
    return {
      transaction: {
        ...state,
        insertPageAndAdvance: async (input) => {
          page = input.page.slice()
          cursor = input.cursor.slice()
        },
        completeEmptyCursor: async (input) => {
          cursor = input.slice()
        },
      },
      page: () => page,
      cursor: () => cursor,
    }
  }

  private commit(pending: ReturnType<OnePageStore['pendingTransaction']>): void {
    const page = pending.page()
    const cursor = pending.cursor()
    if (page !== null) {
      this.priorPage = page
      this.insertCalls += 1
    }
    if (cursor !== null) this.cursor = cursor
  }

  private rewriteCursorPin(): void {
    const cursor = decodeEncryptedWalletBackupManifestPageCursor(this.cursor!)
    this.cursor = encodeEncryptedWalletBackupManifestPageCursor({
      ...cursor,
      exclusiveSourcePinKey: { state: 'present', value: new Uint8Array([255]) },
    })
  }

  private deferLateCallback<T>(
    use: (transaction: EncryptedWalletBackupManifestPagePersistenceTransaction) => Promise<T>,
    transaction: EncryptedWalletBackupManifestPagePersistenceTransaction,
  ): void {
    this.#late = new Promise((resolve) => {
      setTimeout(() => {
        void use(transaction).catch((error: unknown) => {
          this.lateCallbackError =
            error instanceof Error ? error : new Error('late callback failed')
          resolve()
        })
      }, 0)
    })
  }
}
