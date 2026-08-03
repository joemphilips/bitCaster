import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import * as Cashu from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode, encode, rfc8949EncodeOptions } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupFrozenSnapshotControl,
  prepareEncryptedWalletBackupProof,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
} from '../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'
import {
  sealPreparedEncryptedWalletBackupRecord,
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  appendEncryptedWalletBackupFrozenSnapshotProofPage,
  beginEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
  encodeEncryptedWalletBackupSnapshotPin,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX,
  validateEncryptedWalletBackupSnapshotSourcePinBinding,
  type EncryptedWalletBackupSnapshotPersistenceStore,
  type EncryptedWalletBackupSnapshotPersistenceTransaction,
  type EncryptedWalletBackupSnapshotPinIdentity,
  type EncryptedWalletBackupSnapshotSourceIdentity,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
  type PersistedEncryptedWalletBackupSnapshotPin,
} from '../src/encryptedWalletBackupSnapshotPersistence.ts'

type Vector = Readonly<{
  inputs: Readonly<{
    seedHex: string
    realm: string
    proof: Readonly<{
      mint: string
      unit: string
      counter: number
      keysetId: string
      amount: string
      signatureHex: string
      dleq: Readonly<{ e: string; s: string; r: string }>
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }>
  }>
  expected: Readonly<{ derivedSecretHex: string; proofIdHex: string; commitmentHex: string }>
}>

type Expectation = Readonly<{
  scope: Uint8Array
  expectedVersion: number
  reservedReadRows: number
  reservedReadBytes: number
  reservedWriteRows: number
  reservedWriteBytes: number
}>

type StoredPin = Readonly<{
  pin: Uint8Array
  source: EncryptedWalletBackupSnapshotSourceIdentity
  identity: EncryptedWalletBackupSnapshotPinIdentity
}>

type AdapterMode =
  | 'normal'
  | 'fail-pin'
  | 'no-callback'
  | 'twice'
  | 'substitute-result'
  | 'after-settlement'
  | 'reject-then-late'

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as Vector

const runtime = {
  subtle: webcrypto.subtle,
  getRandomValues: (target: Uint8Array) => webcrypto.getRandomValues(target),
}

test('a not-found control creates a bounded persisted snapshot row', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  const control = await controlFor(fixture.keyHandle, 'local-1')
  const snapshot = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  assert.equal(snapshot.generation, 1)
  assert.equal(snapshot.state, 'populating')
  assert.equal(snapshot.recordCount, 0)
  assert.equal(snapshot.canonicalPinBytes, 0)
  assert.equal(snapshot.sealRunRevision, 0)
  assert.equal(snapshot.recordSetRoot, null)
  assert.equal(Object.keys(snapshot).length, 17)
  assert.equal(store.last?.controlReads, 1)
  assert.equal(store.last?.sourceReads, 0)
  assert.equal(store.last?.pinWrites, 0)
  assert.equal(store.last?.rows, 2)
  assert.ok((store.last?.bytes ?? 0) <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES)
})

test('a proof append uses exact control, source, and pin reservations', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const control = await controlFor(fixture.keyHandle, 'append-1')
  const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const snapshot = await appendPage(store, control, fixture, current)
  assert.equal(snapshot.version, 2)
  assert.equal(snapshot.recordCount, 1)
  assert.equal(snapshot.canonicalPinBytes, store.firstPin().byteLength)
  assert.equal(store.last?.controlReads, 1)
  assert.equal(store.last?.sourceReads, 1)
  assert.equal(store.last?.pinWrites, 1)
  assert.equal(store.last?.rows, 4)
  assert.ok(store.last!.bytes <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES)
  assert.equal(store.pinCount(), 1)
})

test('the strict adapter rejects missing, stale, substituted, and failed source pins atomically', async () => {
  for (const fault of ['missing', 'stale', 'substituted', 'fail-pin'] as const) {
    const fixture = await proofFixture()
    const store = new StrictStore(fault === 'fail-pin' ? 'fail-pin' : 'normal')
    const control = await controlFor(fixture.keyHandle, `fault-${fault}`)
    if (fault !== 'missing') store.addSource(fixture.descriptor)
    if (fault === 'stale') store.mutateSource(fixture.descriptor)
    if (fault === 'substituted')
      store.substituteSource(fixture.descriptor, alternateDescriptor(fixture.descriptor))
    const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
    await assert.rejects(appendPage(store, control, fixture, current))
    assert.equal(store.controlCount(), 1)
    assert.equal(store.pinCount(), 0)
    assertPopulationTotals(store.controlSnapshot(`fault-${fault}`), 0, 0)
    assert.equal(store.last?.controlReads, 1)
    assert.equal(store.last?.sourceReads, 1)
  }
})

test('source mutation after authentication is rejected at the atomic pin', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const control = await controlFor(fixture.keyHandle, 'mutated-source')
  const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const preparedSnapshotStore = exactSnapshotStore(fixture.snapshot, () => {
    store.mutateSource(fixture.descriptor)
  })
  await assert.rejects(
    appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current,
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      preparedRecords: [fixture.persisted],
      preparedSnapshotStore,
    }),
  )
  assert.equal(store.controlCount(), 1)
  assert.equal(store.pinCount(), 0)
  assertPopulationTotals(store.controlSnapshot('mutated-source'), 0, 0)
})

test('stale controls, duplicate pins, and concurrent versions fully roll back', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const control = await controlFor(fixture.keyHandle, 'same-snapshot')
  const started = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const appended = await appendPage(store, control, fixture, started)
  await assert.rejects(appendPage(store, control, fixture, started), /control changed/)
  await assert.rejects(appendPage(store, control, fixture, appended), /pin is duplicated/)
  assert.equal(store.controlVersion('same-snapshot'), 2)
  assert.equal(store.pinCount(), 1)
  assertPopulationTotals(store.controlSnapshot('same-snapshot'), 1, appended.canonicalPinBytes)
})

test('separate record and commitment conflicts roll back successive appends', async () => {
  for (const conflict of [
    { name: 'a repeated record ID with a changed commitment', changed: 'commitment' },
    { name: 'a repeated commitment with a changed record ID', changed: 'record id' },
  ] as const) {
    const fixture = await proofFixture()
    const store = new StrictStore()
    const snapshotId = `unique-${conflict.changed}`
    const control = await controlFor(fixture.keyHandle, snapshotId)
    const source = fixture.descriptor
    const started = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
    const firstPin = pinForSource(started, source)
    store.addSource(source)
    const first = await appendRawPin(store, control, started, source, firstPin)
    const conflictingSource = changedSourceIdentity(source, conflict.changed)
    const conflictingPin = pinForSource(first, conflictingSource)
    store.addSource(conflictingSource)
    const pins = store.pinCount()
    const bytes = store.pinBytes()
    await assert.rejects(
      appendRawPin(store, control, first, conflictingSource, conflictingPin),
      /duplicated/,
    )
    assert.equal(store.pinCount(), pins)
    assert.equal(store.pinBytes(), bytes)
    assert.equal(store.controlVersion(snapshotId), first.version, conflict.name)
    assertPopulationTotals(store.controlSnapshot(snapshotId), 1, bytes)
  }
})

test('a proof can pin once in each distinct snapshot namespace', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const controlA = await controlFor(fixture.keyHandle, 'namespace-a')
  const controlB = await controlFor(fixture.keyHandle, 'namespace-b')
  await appendPage(
    store,
    controlA,
    fixture,
    await beginEncryptedWalletBackupFrozenSnapshot({ store, control: controlA }),
  )
  await appendPage(
    store,
    controlB,
    fixture,
    await beginEncryptedWalletBackupFrozenSnapshot({ store, control: controlB }),
  )
  assert.equal(store.pinCount(), 2)
  assert.throws(() => store.deletePreparedSource(fixture.descriptor), /deletion is blocked/)
})

test('a proof can pin once in each distinct snapshot revision', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const controlA = await controlFor(fixture.keyHandle, 'revision-namespace', 0)
  const controlB = await controlFor(fixture.keyHandle, 'revision-namespace', 1)
  const first = await beginEncryptedWalletBackupFrozenSnapshot({ store, control: controlA })
  const second = await beginEncryptedWalletBackupFrozenSnapshot({ store, control: controlB })
  await appendRawPin(
    store,
    controlA,
    first,
    fixture.descriptor,
    pinForSource(first, fixture.descriptor),
  )
  await appendRawPin(
    store,
    controlB,
    second,
    fixture.descriptor,
    pinForSource(second, fixture.descriptor),
  )
  assert.equal(store.pinCount(), 2)
})

test('successive proof pages accumulate exact control totals', async () => {
  const fixture = await proofPageFixture(2)
  const store = new StrictStore()
  for (const descriptor of fixture.descriptors) store.addSource(descriptor)
  const control = await controlFor(fixture.keyHandle, 'totals')
  const started = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const first = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store,
    control,
    current: started,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    preparedRecords: [fixture.records[0]!],
    preparedSnapshotStore: fixture.snapshotStore,
  })
  const second = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store,
    control,
    current: first,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    preparedRecords: [fixture.records[1]!],
    preparedSnapshotStore: fixture.snapshotStore,
  })
  assertPopulationTotals(first, 1, first.canonicalPinBytes)
  assertPopulationTotals(second, 2, store.pinBytes())
  assert.equal(second.sealRunRevision, 0)
})

test('transaction callbacks must be exact across resolve, reject, and late invocation faults', async () => {
  for (const mode of [
    'no-callback',
    'twice',
    'substitute-result',
    'after-settlement',
    'reject-then-late',
  ] as const) {
    const fixture = await proofFixture()
    const store = new StrictStore(mode)
    const control = await controlFor(fixture.keyHandle, `callback-${mode}`)
    const operation = beginEncryptedWalletBackupFrozenSnapshot({ store, control })
    if (mode === 'after-settlement') await operation
    else await assert.rejects(operation)
    await delay()
    if (mode === 'after-settlement' || mode === 'reject-then-late')
      assert.equal(store.lateErrors, 1)
    assert.equal(store.controlCount(), mode === 'after-settlement' ? 1 : 0)
  }
})

test('proof pages above 127 reject before prepared-source authentication or transactions', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  const control = await controlFor(fixture.keyHandle, 'too-many')
  let sourceStoreCalls = 0
  const preparedSnapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore = {
    async withCommittedPreparedRecordSnapshotBatch(_recordIds, _read) {
      sourceStoreCalls += 1
      throw new Error('source store must not run')
    },
  }
  const records = Array.from(
    { length: 128 },
    () => null,
  ) as unknown as PersistedPreparedEncryptedWalletBackupRecord[]
  const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const transactions = store.transactions
  await assert.rejects(
    appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current,
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      preparedRecords: records,
      preparedSnapshotStore,
    }),
    /capacity/,
  )
  assert.equal(sourceStoreCalls, 0)
  assert.equal(store.transactions, transactions)
})

test('the reservation ledger rejects under- and over-declaration without commit', async () => {
  for (const fault of ['under', 'over'] as const) {
    const fixture = await proofFixture()
    const store = new StrictStore()
    store.addSource(fixture.descriptor)
    const control = await controlFor(fixture.keyHandle, `ledger-${fault}`)
    const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
    store.reservationFault = fault
    await assert.rejects(appendPage(store, control, fixture, current))
    assert.equal(store.controlCount(), 1)
    assert.equal(store.pinCount(), 0)
  }
})

test('a maximum proof page uses one bounded transaction and batch callback', async () => {
  const fixture = await proofPageFixture(127)
  const store = new StrictStore()
  for (const descriptor of fixture.descriptors) store.addSource(descriptor)
  const control = await controlFor(fixture.keyHandle, 'maximum-page')
  const snapshot = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store,
    control,
    current: await beginEncryptedWalletBackupFrozenSnapshot({ store, control }),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    preparedRecords: fixture.records,
    preparedSnapshotStore: fixture.snapshotStore,
  })
  assert.equal(snapshot.version, 2)
  assert.equal(fixture.batchCalls, 1)
  assert.equal(store.last?.pinBatches, 1)
  assert.equal(store.last?.rows, 256)
  assert.ok(
    (store.last?.bytes ?? Infinity) <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES,
  )
  assert.equal(store.pinCount(), 127)
  assertPopulationTotals(snapshot, 127, store.pinBytes())
})

test('snapshot control and pin codecs reject invalid fields while accepting 128-character IDs', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const control = await controlFor(fixture.keyHandle, 's'.repeat(128))
  const snapshot = await appendPage(
    store,
    control,
    fixture,
    await beginEncryptedWalletBackupFrozenSnapshot({ store, control }),
  )
  const controlBytes = encodeEncryptedWalletBackupFrozenSnapshot(snapshot)
  assert.equal(decodeEncryptedWalletBackupFrozenSnapshot(controlBytes).snapshotId.length, 128)
  const pin = store.firstPin()
  assert.equal(decodeEncryptedWalletBackupSnapshotPin(pin).snapshotId.length, 128)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes)
  assertCodecRejects(decodeEncryptedWalletBackupSnapshotPin, pin)
  assertControlWireFieldRejections(controlBytes, pin)
  assertPinManifestEntryBytesRejections(pin)
  assert.throws(
    () => encodeEncryptedWalletBackupFrozenSnapshot({ ...snapshot, vaultId: 'g'.repeat(64) }),
    /invalid/,
  )
  await assert.rejects(controlFor(fixture.keyHandle, 'é'.repeat(65)))
  await assert.rejects(controlFor(fixture.keyHandle, 'bad\u0001id'))
  await assert.rejects(controlFor(fixture.keyHandle, '\ud800'))
  assertNewControlWireFieldsReject(controlBytes)
  assertEncodedRecordRejections(snapshot, pin)
})

function assertControlWireFieldRejections(controlBytes: Uint8Array, pin: Uint8Array): void {
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 4, 1)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 5, new Uint8Array(32))
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 7, 2)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 11, 'sealing')
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 11, 0)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 12, -1)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 12, 'wrong')
  assertCodecRejects(
    decodeEncryptedWalletBackupFrozenSnapshot,
    controlBytes,
    12,
    Number.MAX_SAFE_INTEGER + 1,
  )
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 13, -1)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 13, 'wrong')
  assertCodecRejects(
    decodeEncryptedWalletBackupFrozenSnapshot,
    controlBytes,
    13,
    Number.MAX_SAFE_INTEGER + 1,
  )
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 14, -1)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 14, 'wrong')
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 15, 0)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 16, 0)
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 6, new Uint8Array(32))
  assertCodecRejects(decodeEncryptedWalletBackupFrozenSnapshot, controlBytes, 1, 'UPPER')
  assertCodecRejects(decodeEncryptedWalletBackupSnapshotPin, pin, 5, 1)
}

function assertPinManifestEntryBytesRejections(pin: Uint8Array): void {
  const decoded = decodeEncryptedWalletBackupSnapshotPin(pin)
  for (const value of [
    'wrong',
    0,
    Number.MAX_SAFE_INTEGER + 1,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES + 1,
  ] as const)
    assertCodecRejects(decodeEncryptedWalletBackupSnapshotPin, pin, 10, value)
  const missing = decode(pin) as unknown[]
  missing.pop()
  assert.throws(() => decodeEncryptedWalletBackupSnapshotPin(encodeCanonical(missing)))
  for (const value of [
    'wrong',
    0,
    Number.MAX_SAFE_INTEGER + 1,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES + 1,
  ] as const)
    assert.throws(() =>
      encodeEncryptedWalletBackupSnapshotPin({
        ...decoded,
        canonicalManifestEntryBytes: value,
      } as never),
    )
  const incomplete = { ...decoded } as Record<string, unknown>
  delete incomplete.canonicalManifestEntryBytes
  assert.throws(() => encodeEncryptedWalletBackupSnapshotPin(incomplete as never))
}

test('source and pin manifest entry lengths must match', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  const control = await controlFor(fixture.keyHandle, 'pin-length')
  const snapshot = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const pin = pinForSource(snapshot, fixture.descriptor)
  const changed = decode(pin) as unknown[]
  changed[10] = (changed[10] as number) + 1
  assert.throws(
    () =>
      validateEncryptedWalletBackupSnapshotSourcePinBinding({
        sourceDescriptor: fixture.descriptor,
        pin: encodeCanonical(changed),
      }),
    /binding/,
  )
})

test('append rejects non-populating and overflowing current controls before a transaction', async () => {
  const fixture = await proofFixture()
  const store = new StrictStore()
  store.addSource(fixture.descriptor)
  const control = await controlFor(fixture.keyHandle, 'invalid-current')
  const current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  const transactions = store.transactions
  await assert.rejects(
    appendPage(store, control, fixture, { ...current, state: 'sealing' } as never),
  )
  await assert.rejects(
    appendPage(store, control, fixture, {
      ...current,
      recordCount: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
    } as never),
  )
  await assert.rejects(
    appendPage(store, control, fixture, {
      ...current,
      canonicalPinBytes: Number.MAX_SAFE_INTEGER,
    } as never),
  )
  assert.equal(store.transactions, transactions)
  assertPopulationTotals(store.controlSnapshot('invalid-current'), 0, 0)
})

function assertEncodedRecordRejections(
  snapshot: PersistedEncryptedWalletBackupFrozenSnapshot,
  pin: Uint8Array,
): void {
  assert.throws(
    () => encodeEncryptedWalletBackupFrozenSnapshot({ ...snapshot, version: 0 }),
    /invalid/,
  )
  assertNewControlObjectRejections(snapshot)
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        extra: true,
      } as unknown as PersistedEncryptedWalletBackupFrozenSnapshot),
    /invalid/,
  )
  const decodedPin = decodeEncryptedWalletBackupSnapshotPin(pin)
  assert.throws(
    () =>
      encodeEncryptedWalletBackupSnapshotPin({
        ...decodedPin,
        extra: true,
      } as unknown as PersistedEncryptedWalletBackupSnapshotPin),
    /invalid/,
  )
  assert.throws(
    () => encodeEncryptedWalletBackupSnapshotPin({ ...decodedPin, recordId: 'g'.repeat(64) }),
    /invalid/,
  )
}

function assertNewControlObjectRejections(
  snapshot: PersistedEncryptedWalletBackupFrozenSnapshot,
): void {
  assertMissingControlFields(snapshot)
  for (const [field, value] of [
    ['state', 0],
    ['recordCount', 'wrong'],
    ['canonicalPinBytes', 'wrong'],
    ['sealRunRevision', 'wrong'],
    ['recordSetRoot', 'wrong'],
  ] as const) {
    assert.throws(
      () => encodeEncryptedWalletBackupFrozenSnapshot({ ...snapshot, [field]: value } as never),
      /invalid/,
    )
  }
  assertInvalidControlValues(snapshot)
}

function assertMissingControlFields(snapshot: PersistedEncryptedWalletBackupFrozenSnapshot): void {
  for (const field of [
    'state',
    'recordCount',
    'canonicalPinBytes',
    'sealRunRevision',
    'recordSetRoot',
  ] as const) {
    const incomplete = { ...snapshot } as Record<string, unknown>
    delete incomplete[field]
    assert.throws(() => encodeEncryptedWalletBackupFrozenSnapshot(incomplete as never), /invalid/)
  }
}

function assertInvalidControlValues(snapshot: PersistedEncryptedWalletBackupFrozenSnapshot): void {
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        state: 'sealing',
      } as unknown as PersistedEncryptedWalletBackupFrozenSnapshot),
    /invalid/,
  )
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        recordCount: -1,
      } as PersistedEncryptedWalletBackupFrozenSnapshot),
    /invalid/,
  )
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        canonicalPinBytes: Number.MAX_SAFE_INTEGER + 1,
      } as PersistedEncryptedWalletBackupFrozenSnapshot),
    /invalid/,
  )
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        sealRunRevision: -1,
      } as PersistedEncryptedWalletBackupFrozenSnapshot),
    /invalid/,
  )
  assert.throws(
    () =>
      encodeEncryptedWalletBackupFrozenSnapshot({
        ...snapshot,
        state: 'sealed',
        sealRunRevision: 1,
      }),
    /invalid/,
  )
}

function assertCodecRejects(
  decodeValue: (value: Uint8Array) => unknown,
  value: Uint8Array,
  index?: number,
  replacement?: unknown,
): void {
  const raw = decode(value) as unknown[]
  if (index === undefined) raw.push(true)
  else raw[index] = replacement
  assert.throws(() => decodeValue(encodeCanonical(raw)))
}

function assertNewControlWireFieldsReject(value: Uint8Array): void {
  for (const index of [11, 12, 13, 14]) {
    const raw = decode(value) as unknown[]
    raw.splice(index, 1)
    assert.throws(() => decodeEncryptedWalletBackupFrozenSnapshot(encodeCanonical(raw)))
  }
}

function assertPopulationTotals(
  snapshot: PersistedEncryptedWalletBackupFrozenSnapshot,
  recordCount: number,
  canonicalPinBytes: number,
): void {
  assert.equal(snapshot.state, 'populating')
  assert.equal(snapshot.recordCount, recordCount)
  assert.equal(snapshot.canonicalPinBytes, canonicalPinBytes)
  assert.equal(snapshot.sealRunRevision, 0)
}

async function appendPage(
  store: StrictStore,
  control: Awaited<ReturnType<typeof controlFor>>,
  fixture: Awaited<ReturnType<typeof proofFixture>>,
  current: PersistedEncryptedWalletBackupFrozenSnapshot,
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  return appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store,
    control,
    current,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    preparedRecords: [fixture.persisted],
    preparedSnapshotStore: exactSnapshotStore(fixture.snapshot),
  })
}

async function appendRawPin(
  store: StrictStore,
  control: Awaited<ReturnType<typeof controlFor>>,
  current: PersistedEncryptedWalletBackupFrozenSnapshot,
  source: Uint8Array,
  pin: Uint8Array,
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(control)
  const expectedControl = encodeEncryptedWalletBackupFrozenSnapshot(current)
  const next = Object.freeze({
    ...current,
    recordCount: current.recordCount + 1,
    canonicalPinBytes: current.canonicalPinBytes + pin.byteLength,
    version: current.version + 1,
  })
  const nextControl = encodeEncryptedWalletBackupFrozenSnapshot(next)
  const expected = Object.freeze({
    scope,
    expectedVersion: current.version,
    reservedReadRows: 2,
    reservedReadBytes: scope.byteLength + expectedControl.byteLength + source.byteLength,
    reservedWriteRows: 2,
    reservedWriteBytes: nextControl.byteLength + pin.byteLength,
  })
  return store.withExactVersionTransaction(expected, async (transaction) => {
    assert.ok(equalBytes(await transaction.readSnapshotControl(scope), expectedControl))
    await transaction.writeSnapshotControl(nextControl)
    await transaction.insertSnapshotPins({ sourceDescriptors: [source], pins: [pin] })
    return next
  }) as Promise<PersistedEncryptedWalletBackupFrozenSnapshot>
}

function pinForSource(
  snapshot: PersistedEncryptedWalletBackupFrozenSnapshot,
  descriptor: Uint8Array,
): Uint8Array {
  const source = decodeEncryptedWalletBackupPreparedSourceDescriptor(descriptor)
  return encodeEncryptedWalletBackupSnapshotPin({
    schemaVersion: 1,
    realm: source.realm,
    vaultId: source.vaultId,
    snapshotId: snapshot.snapshotId,
    snapshotRevision: snapshot.snapshotRevision,
    recordKindCode: source.recordKindCode,
    recordId: source.recordId,
    commitment: source.commitment,
    sourceBodyReference: source.bodyReference,
    sourceRevision: source.revision,
    canonicalManifestEntryBytes: source.canonicalManifestEntryBytes,
  })
}

function changedSourceIdentity(
  descriptor: Uint8Array,
  field: 'record id' | 'commitment',
): Uint8Array {
  const raw = decode(descriptor) as unknown[]
  const index = field === 'record id' ? 7 : 8
  const value = raw[index] as Uint8Array
  const changed = value.slice()
  changed[0] = changed[0]! ^ 1
  raw[index] = changed
  return encodeCanonical(raw)
}

class StrictStore implements EncryptedWalletBackupSnapshotPersistenceStore {
  readonly controls = new Map<string, Uint8Array>()
  readonly sources = new Map<string, Uint8Array>()
  readonly pins = new Map<string, StoredPin>()
  readonly pinnedRecordIds = new Set<string>()
  readonly pinnedCommitments = new Set<string>()
  readonly mode: AdapterMode
  last: Readonly<{
    controlReads: number
    sourceReads: number
    pinWrites: number
    pinBatches: number
    rows: number
    bytes: number
  }> | null = null
  lateErrors = 0
  transactions = 0
  reservationFault: 'under' | 'over' | null = null

  constructor(mode: AdapterMode = 'normal') {
    this.mode = mode
  }

  addSource(descriptor: Uint8Array): void {
    this.sources.set(sourceKey(descriptor), descriptor.slice())
  }

  mutateSource(descriptor: Uint8Array): void {
    const raw = decode(descriptor) as unknown[]
    raw[5] = (raw[5] as number) + 1
    this.sources.set(sourceKey(descriptor), encodeCanonical(raw))
  }

  substituteSource(descriptor: Uint8Array, replacement: Uint8Array): void {
    this.sources.set(sourceKey(descriptor), replacement.slice())
  }

  deletePreparedSource(descriptor: Uint8Array): void {
    const source = decodeEncryptedWalletBackupPreparedSourceDescriptor(descriptor)
    const identity = sourceIdentityKey(source)
    if ([...this.pins.values()].some((pin) => sourceIdentityKey(pin.source) === identity))
      throw new Error('prepared source deletion is blocked by a committed pin')
    this.sources.delete(sourceKey(descriptor))
  }

  controlCount(): number {
    return this.controls.size
  }

  pinCount(): number {
    return this.pins.size
  }

  firstPin(): Uint8Array {
    const value = this.pins.values().next().value
    if (value === undefined) throw new Error('pin is missing')
    return value.pin.slice()
  }

  controlVersion(snapshotId: string): number {
    return this.controlSnapshot(snapshotId).version
  }

  controlSnapshot(snapshotId: string): PersistedEncryptedWalletBackupFrozenSnapshot {
    for (const value of this.controls.values()) {
      const control = decodeEncryptedWalletBackupFrozenSnapshot(value)
      if (control.snapshotId === snapshotId) return control
    }
    throw new Error('control is missing')
  }

  pinBytes(): number {
    return sum([...this.pins.values()].map((entry) => entry.pin))
  }

  async withExactVersionTransaction<T>(
    expected: Expectation,
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    this.transactions += 1
    const declared = this.declaredReservation(expected)
    reserveBeforeBuffers(declared)
    if (this.mode === 'no-callback') return Object.freeze({})
    const transaction = this.transaction(declared)
    if (this.mode === 'reject-then-late') return this.rejectThenCall(use, transaction)
    try {
      const result = await use(transaction)
      if (this.mode === 'twice') await use(transaction)
      if (this.mode === 'substitute-result') return Object.freeze({})
      if (this.mode === 'after-settlement') this.callLate(use, transaction)
      this.commit(transaction)
      return result
    } catch (error) {
      this.last = transaction.counts()
      throw error
    }
  }

  private transaction(expected: Expectation): StrictTransaction {
    return new StrictTransaction(this, expected)
  }

  private declaredReservation(expected: Expectation): Expectation {
    if (this.reservationFault === null) return expected
    const delta = this.reservationFault === 'under' ? -1 : 1
    return Object.freeze({ ...expected, reservedWriteBytes: expected.reservedWriteBytes + delta })
  }

  private commit(transaction: StrictTransaction): void {
    transaction.finish()
    this.requireAvailablePinIndexes(transaction)
    if (transaction.control !== null)
      this.controls.set(hex(transaction.scope), transaction.control.slice())
    for (const [key, value] of transaction.pendingPins) {
      const stored: StoredPin = Object.freeze({
        pin: value.pin.slice(),
        source: value.source,
        identity: value.identity,
      })
      this.pins.set(key, stored)
      this.pinnedRecordIds.add(recordIdPinKey(value.identity))
      this.pinnedCommitments.add(commitmentPinKey(value.identity))
    }
    this.last = transaction.counts()
  }

  private requireAvailablePinIndexes(transaction: StrictTransaction): void {
    for (const value of transaction.pendingPins.values()) {
      if (
        this.pinnedRecordIds.has(recordIdPinKey(value.identity)) ||
        this.pinnedCommitments.has(commitmentPinKey(value.identity))
      )
        throw new Error('backup snapshot pin is duplicated')
    }
  }

  private rejectThenCall<T>(
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
    transaction: StrictTransaction,
  ): Promise<never> {
    this.callLate(use, transaction)
    return Promise.reject(new Error('adapter rejected'))
  }

  private callLate<T>(
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
    transaction: StrictTransaction,
  ): void {
    setTimeout(() => {
      void use(transaction).catch(() => {
        this.lateErrors += 1
      })
    }, 0)
  }
}

class StrictTransaction implements EncryptedWalletBackupSnapshotPersistenceTransaction {
  readonly scope: Uint8Array
  readonly expected: Expectation
  readonly pendingPins = new Map<string, StoredPin>()
  readonly pendingRecordIds = new Set<string>()
  readonly pendingCommitments = new Set<string>()
  control: Uint8Array | null
  private readonly store: StrictStore
  private readonly initialControlBytes: number
  private readonly ledger: ReservationLedger
  private controlReads = 0
  private sourceReads = 0
  private sourceReadBytes = 0
  private pinWrites = 0
  private pinBatches = 0

  constructor(store: StrictStore, expected: Expectation) {
    this.store = store
    this.expected = expected
    this.scope = expected.scope
    this.control = store.controls.get(hex(expected.scope)) ?? null
    this.initialControlBytes = this.control?.byteLength ?? 0
    this.ledger = new ReservationLedger(expected)
  }

  async readSnapshotControl(scope: Uint8Array): Promise<Uint8Array | null> {
    if (!equalBytes(scope, this.scope)) throw new Error('control scope changed')
    this.ledger.read(this.scope.byteLength + this.initialControlBytes)
    this.controlReads += 1
    return this.control?.slice() ?? null
  }

  async insertSnapshotControl(control: Uint8Array): Promise<void> {
    this.writeControl(control)
  }

  async writeSnapshotControl(control: Uint8Array): Promise<void> {
    this.writeControl(control)
  }

  async insertSnapshotPins(
    input: Readonly<{ sourceDescriptors: readonly Uint8Array[]; pins: readonly Uint8Array[] }>,
  ): Promise<void> {
    if (input.sourceDescriptors.length !== input.pins.length) throw new Error('pin count changed')
    this.pinBatches += 1
    const rows = input.sourceDescriptors.map((source, index) =>
      this.pin(source, input.pins[index]!),
    )
    if (this.store.mode === 'fail-pin') throw new Error('pin write failed')
    for (const row of rows) this.pendingPins.set(row.key, row.value)
  }

  finish(): void {
    this.ledger.complete()
    const counts = this.counts()
    if (counts.controlReads !== 1 || counts.sourceReads !== this.pinWrites)
      throw new Error('adapter read count is invalid')
    if (counts.rows !== this.expected.reservedReadRows + this.expected.reservedWriteRows)
      throw new Error('adapter row reservation is invalid')
    if (counts.bytes !== this.expected.reservedReadBytes + this.expected.reservedWriteBytes)
      throw new Error('adapter byte reservation is invalid')
  }

  counts(): Readonly<{
    controlReads: number
    sourceReads: number
    pinWrites: number
    pinBatches: number
    rows: number
    bytes: number
  }> {
    const pinBytes = [...this.pendingPins.values()].map((entry) => entry.pin)
    const controlBytes = this.control?.byteLength ?? 0
    return Object.freeze({
      controlReads: this.controlReads,
      sourceReads: this.sourceReads,
      pinWrites: this.pinWrites,
      pinBatches: this.pinBatches,
      rows: this.controlReads + this.sourceReads + (this.control === null ? 0 : 1) + this.pinWrites,
      bytes:
        this.scope.byteLength +
        this.initialControlBytes +
        this.sourceReadBytes +
        controlBytes +
        sum(pinBytes),
    })
  }

  private writeControl(value: Uint8Array): void {
    this.ledger.write(value.byteLength)
    this.control = value
  }

  private pin(
    source: Uint8Array,
    pin: Uint8Array,
  ): Readonly<{
    key: string
    value: Readonly<{ pin: Uint8Array; source: EncryptedWalletBackupSnapshotSourceIdentity }>
  }> {
    this.ledger.read(source.byteLength)
    this.sourceReads += 1
    this.sourceReadBytes += source.byteLength
    const binding = validateEncryptedWalletBackupSnapshotSourcePinBinding({
      sourceDescriptor: source,
      pin,
    })
    const current = this.store.sources.get(sourceKey(source))
    if (current === undefined) throw new Error('prepared source is missing')
    if (!equalBytes(current, source)) throw new Error('prepared source descriptor changed')
    const key = `${hex(this.scope)}:${binding.pin.recordId}:${binding.pin.commitment}`
    const recordIdKey = recordIdPinKey(binding.pin)
    const commitmentKey = commitmentPinKey(binding.pin)
    if (
      this.store.pinnedRecordIds.has(recordIdKey) ||
      this.store.pinnedCommitments.has(commitmentKey) ||
      this.pendingRecordIds.has(recordIdKey) ||
      this.pendingCommitments.has(commitmentKey)
    )
      throw new Error('backup snapshot pin is duplicated')
    this.ledger.write(pin.byteLength)
    this.pinWrites += 1
    this.pendingRecordIds.add(recordIdKey)
    this.pendingCommitments.add(commitmentKey)
    return Object.freeze({
      key,
      value: Object.freeze({ pin, source: binding.source, identity: binding.pin }),
    })
  }
}

function reserveBeforeBuffers(expected: Expectation): void {
  const rows = expected.reservedReadRows + expected.reservedWriteRows
  const bytes = expected.reservedReadBytes + expected.reservedWriteBytes
  if (
    !(expected.scope instanceof Uint8Array) ||
    rows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX ||
    bytes > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES
  )
    throw new Error('adapter reservation is invalid')
}

class ReservationLedger {
  private readRows: number
  private readBytes: number
  private writeRows: number
  private writeBytes: number

  constructor(expected: Expectation) {
    this.readRows = expected.reservedReadRows
    this.readBytes = expected.reservedReadBytes
    this.writeRows = expected.reservedWriteRows
    this.writeBytes = expected.reservedWriteBytes
  }

  read(bytes: number): void {
    this.debit('read', bytes)
  }

  write(bytes: number): void {
    this.debit('write', bytes)
  }

  complete(): void {
    if (
      this.readRows !== 0 ||
      this.readBytes !== 0 ||
      this.writeRows !== 0 ||
      this.writeBytes !== 0
    )
      throw new Error('adapter reservation is over-declared')
  }

  private debit(kind: 'read' | 'write', bytes: number): void {
    if (kind === 'read') {
      if (this.readRows < 1 || this.readBytes < bytes)
        throw new Error('adapter reservation is under-declared')
      this.readRows -= 1
      this.readBytes -= bytes
      return
    }
    if (this.writeRows < 1 || this.writeBytes < bytes)
      throw new Error('adapter reservation is under-declared')
    this.writeRows -= 1
    this.writeBytes -= bytes
  }
}

async function controlFor(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  snapshotId: string,
  snapshotRevision = 0,
) {
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/head',
    issuedAtUnixSeconds: 1,
    expiresAtUnixSeconds: 2,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime,
  })
  const headEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  return prepareEncryptedWalletBackupFrozenSnapshotControl({
    keyHandle,
    headEvidence,
    snapshotNonce: '22'.repeat(16),
    snapshotId,
    snapshotRevision,
  })
}

async function proofFixture() {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime,
  })
  const snapshot = preparedSnapshot()
  const persisted = await prepareFixtureRecord(keyHandle, seed, snapshot)
  return Object.freeze({
    keyHandle,
    seed,
    snapshot,
    persisted,
    descriptor: encodeEncryptedWalletBackupPreparedSourceDescriptor(persisted),
  })
}

function preparedSnapshot(): EncryptedWalletBackupPreparedRecordSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: 'proof-snapshot',
    snapshotRevision: 1,
    recordId: vector.expected.proofIdHex,
    commitment: vector.expected.commitmentHex,
    recordKindCode: 0,
  })
}

async function prepareFixtureRecord(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  seed: Uint8Array,
  snapshot: EncryptedWalletBackupPreparedRecordSnapshot,
): Promise<PersistedPreparedEncryptedWalletBackupRecord> {
  const proof = vector.inputs.proof
  const record = await prepareEncryptedWalletBackupProof({
    keyHandle,
    seed,
    mint: proof.mint,
    unit: proof.unit,
    counter: proof.counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret: vector.expected.derivedSecretHex,
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
      async withCommittedProofSnapshot(_id, read) {
        return read(proofSnapshot(snapshot))
      },
    },
  })
  const persisted = await sealPreparedEncryptedWalletBackupRecord({
    keyHandle,
    seed,
    record,
    snapshotStore: exactSingleSnapshotStore(snapshot),
  })
  return persisted
}

async function proofPageFixture(count: number) {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime,
  })
  const snapshots = new Map<string, EncryptedWalletBackupPreparedRecordSnapshot>()
  const records: PersistedPreparedEncryptedWalletBackupRecord[] = []
  for (let counter = 0; counter < count; counter += 1) {
    const prepared = await prepareCounterProof(
      keyHandle,
      seed,
      vector.inputs.proof.counter + counter,
      snapshots,
    )
    records.push(
      await sealPreparedEncryptedWalletBackupRecord({
        keyHandle,
        seed,
        record: prepared,
        snapshotStore: pageSnapshotStore(snapshots),
      }),
    )
  }
  let batchCalls = 0
  const snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore = {
    async withCommittedPreparedRecordSnapshotBatch(ids, read) {
      batchCalls += 1
      return read(ids.map((id) => snapshots.get(id)!))
    },
  }
  return Object.freeze({
    seed,
    keyHandle,
    records: Object.freeze(records),
    descriptors: Object.freeze(records.map(encodeEncryptedWalletBackupPreparedSourceDescriptor)),
    snapshotStore,
    get batchCalls() {
      return batchCalls
    },
  })
}

async function prepareCounterProof(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  seed: Uint8Array,
  counter: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
) {
  const proof = vector.inputs.proof
  const secret = counterSecret(seed, proof.keysetId, counter)
  const recordId = counterRecordId(seed, proof, secret)
  const commitment = counterCommitment(proof, secret, counter)
  const snapshot = Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: 'proof-page',
    snapshotRevision: 1,
    recordId,
    commitment,
    recordKindCode: 0 as const,
  })
  snapshots.set(recordId, snapshot)
  return prepareEncryptedWalletBackupProof({
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

function pageSnapshotStore(
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot(id, read) {
      return read(snapshots.get(id)!)
    },
  }
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
      openOrderCollateral: 'absent',
      outbox: 'absent',
      retryCursor: 'absent',
      replayTombstone: 'absent',
      dependentWork: 'absent',
    },
    derivationLocator: 'committed' as const,
  })
}

function exactSingleSnapshotStore(
  snapshot: EncryptedWalletBackupPreparedRecordSnapshot,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot(_id, read) {
      return read(snapshot)
    },
  }
}

function exactSnapshotStore(
  snapshot: EncryptedWalletBackupPreparedRecordSnapshot,
  afterRead?: () => void,
): EncryptedWalletBackupPreparedRecordSnapshotBatchStore {
  return {
    async withCommittedPreparedRecordSnapshotBatch(_ids, read) {
      const value = read([snapshot])
      afterRead?.()
      return value
    },
  }
}

function alternateDescriptor(descriptor: Uint8Array): Uint8Array {
  const raw = decode(descriptor) as unknown[]
  const bodyReference = raw[4] as Uint8Array
  bodyReference[0] = bodyReference[0]! ^ 1
  return encodeCanonical(raw)
}

function recordIdPinKey(value: EncryptedWalletBackupSnapshotPinIdentity): string {
  return `${value.realm}:${value.vaultId}:${value.snapshotId}:${value.snapshotRevision}:${value.recordKindCode}:${value.recordId}`
}

function commitmentPinKey(value: EncryptedWalletBackupSnapshotPinIdentity): string {
  return `${value.realm}:${value.vaultId}:${value.snapshotId}:${value.snapshotRevision}:${value.recordKindCode}:${value.commitment}`
}

function sourceKey(value: Uint8Array): string {
  return sourceIdentityKey(decodeEncryptedWalletBackupPreparedSourceDescriptor(value))
}

function sourceIdentityKey(source: EncryptedWalletBackupSnapshotSourceIdentity): string {
  return `${source.realm}:${source.vaultId}:${source.recordId}:${source.commitment}:${source.bodyReference}:${source.revision}`
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) throw new Error('hex is invalid')
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
}

function sum(values: readonly Uint8Array[]): number {
  return values.reduce((total, value) => total + value.byteLength, 0)
}

function hex(value: Uint8Array): string {
  return bytesToHex(value)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((item, index) => item === right[index])
}

async function delay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
