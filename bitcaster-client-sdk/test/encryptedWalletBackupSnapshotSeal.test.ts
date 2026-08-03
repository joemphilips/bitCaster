import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'
import {
  decodeEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupSnapshotPin,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
} from '../src/encryptedWalletBackupSnapshotPersistence.ts'
import {
  sealEncryptedWalletBackupFrozenSnapshot,
  startEncryptedWalletBackupFrozenSnapshotSeal,
  encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX,
  type EncryptedWalletBackupFrozenSnapshotSealStore,
  type EncryptedWalletBackupFrozenSnapshotSealTransaction,
} from '../src/encryptedWalletBackupSnapshotSeal.ts'

test('a bounded seal streams 0, 1, 511, 512, and 513 canonical pins', async () => {
  for (const count of [0, 1, 511, 512, 513]) {
    const current = controlRow(count)
    const pins = pinsFor(count)
    current.canonicalPinBytes = sum(pins)
    const store = new SealStore(current, pins)
    const sealed = await sealEncryptedWalletBackupFrozenSnapshot({
      store,
      control: issuedControl(),
      current,
    })
    assert.equal(sealed.state, 'sealed')
    assert.equal(sealed.recordCount, count)
    assert.equal(sealed.canonicalPinBytes, sum(pins))
    assert.equal(sealed.sealRunRevision, 1)
    assert.equal(sealed.recordSetRoot?.length, 64)
    assert.deepEqual(decodeEncryptedWalletBackupFrozenSnapshot(store.control), sealed)
    assert.equal(
      store.pageCalls,
      Math.ceil(count / ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX) + 1,
    )
    assert.ok(store.maximumRows <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX)
    assert.ok(store.maximumBytes <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES)
  }
})

test('a restart gets a new run while retaining its stable logical root', async () => {
  const current = controlRow(3)
  const pins = pinsFor(3)
  current.canonicalPinBytes = sum(pins)
  const firstStore = new SealStore(current, pins)
  const first = await sealEncryptedWalletBackupFrozenSnapshot({
    store: firstStore,
    control: issuedControl(),
    current,
  })
  const restarting = Object.freeze({
    ...current,
    state: 'sealing' as const,
    sealRunRevision: 1,
    version: 2,
  })
  const restartStore = new SealStore(restarting, pins)
  const sealing = await startEncryptedWalletBackupFrozenSnapshotSeal({
    store: restartStore,
    control: issuedControl(),
    current: restarting,
  })
  assert.equal(sealing.sealRunRevision, 2)
  const second = await sealEncryptedWalletBackupFrozenSnapshot({
    store: new SealStore(sealing, pins),
    control: issuedControl(),
    current: sealing,
  })
  assert.equal(first.recordSetRoot, second.recordSetRoot)
})

test('the logical root binds the exact source body and revision', async () => {
  const pins = pinsFor(1)
  const changed = encodeEncryptedWalletBackupSnapshotPin({
    schemaVersion: 1,
    realm: 'backup.example.test',
    vaultId: '11'.repeat(32),
    snapshotId: 'seal-test',
    snapshotRevision: 0,
    recordKindCode: 0,
    recordId: '00'.repeat(32),
    commitment: 'aa'.repeat(32),
    sourceBodyReference: 'ff'.repeat(32),
    sourceRevision: 1,
  })
  const first = await sealFixture(pins)
  const second = await sealFixture([changed])
  assert.notEqual(first.recordSetRoot, second.recordSetRoot)
})

test('the seal rejects corrupt order, totals, later pins, and callback faults', async () => {
  const current = controlRow(2)
  const pins = pinsFor(2)
  current.canonicalPinBytes = sum(pins)
  for (const mode of ['unordered', 'later-pin', 'twice', 'no-callback'] as const) {
    await assert.rejects(
      sealEncryptedWalletBackupFrozenSnapshot({
        store: new SealStore(current, pins, mode),
        control: issuedControl(),
        current,
      }),
    )
  }
  const shortControl = controlRow(1)
  shortControl.canonicalPinBytes = pins[0]!.byteLength
  await assert.rejects(
    sealEncryptedWalletBackupFrozenSnapshot({
      store: new SealStore(shortControl, pins),
      control: issuedControl(),
      current: shortControl,
    }),
    /totals/,
  )
})

test('the seal rejects malformed, foreign, and duplicate pins', async () => {
  const valid = pinsFor(1)[0]!
  const foreign = encodeEncryptedWalletBackupSnapshotPin({
    ...decodeEncryptedWalletBackupSnapshotPin(valid),
    vaultId: 'ff'.repeat(32),
  })
  for (const pins of [[new Uint8Array([0xff])], [foreign], [valid, valid]]) {
    const current = controlRow(pins.length)
    current.canonicalPinBytes = sum(pins)
    await assert.rejects(
      sealEncryptedWalletBackupFrozenSnapshot({
        store: new SealStore(current, pins),
        control: issuedControl(),
        current,
      }),
    )
  }
})

test('1,024 compact root metadata entries remain below 64 KiB', () => {
  const leaves = Array.from({ length: 1_024 }, () => ({
    entryCount: 512,
    canonicalBindingBytes: Number.MAX_SAFE_INTEGER,
    leafDigest: '00'.repeat(32),
  }))
  const bytes = encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({
    recordCount: 524_288,
    canonicalPinBytes: Number.MAX_SAFE_INTEGER,
    leaves,
  })
  assert.ok(bytes.byteLength < 65_536)
  assert.throws(() =>
    encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({
      recordCount: 513,
      canonicalPinBytes: 1,
      leaves: [{ ...leaves[0]! }, { ...leaves[1]!, entryCount: 2 }],
    }),
  )
})

test('root metadata rejects open object shapes and invalid partitions', () => {
  const leaf = { entryCount: 1, canonicalBindingBytes: 1, leafDigest: '00'.repeat(32) }
  const valid = { recordCount: 1, canonicalPinBytes: 1, leaves: [leaf] }
  assert.doesNotThrow(() => encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata(valid))
  assert.throws(() =>
    encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({ ...valid, extra: true } as never),
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({
      ...valid,
      leaves: [{ ...leaf, extra: true } as never],
    }),
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({
      ...valid,
      leaves: [{ entryCount: 2, canonicalBindingBytes: 1, leafDigest: '00'.repeat(32) }],
    }),
  )
})

test(
  'the maximum inventory uses a linear bounded keyset scan',
  { skip: process.env.BITCASTER_LARGE_BACKUP_CONFORMANCE !== '1' },
  async () => {
    const current = controlRow(ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX)
    current.canonicalPinBytes = pinAt(0).byteLength * ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX
    const store = new GeneratedSealStore(current, ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX)
    const sealed = await sealEncryptedWalletBackupFrozenSnapshot({
      store,
      control: issuedControl(),
      current,
    })
    assert.equal(sealed.state, 'sealed')
    assert.equal(store.generatedPins, ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX)
    assert.equal(
      store.pageCalls,
      Math.ceil(
        ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX /
          ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX,
      ) + 1,
    )
    assert.ok(store.maximumRows <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX)
    assert.ok(store.maximumBytes <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES)
  },
)

function issuedControl() {
  return issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    Object.freeze({
      realm: 'backup.example.test',
      vaultId: '11'.repeat(32),
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce: '22'.repeat(16),
      snapshotId: 'seal-test',
      snapshotRevision: 0,
    }),
  )
}

function controlRow(recordCount: number): PersistedEncryptedWalletBackupFrozenSnapshot & {
  canonicalPinBytes: number
} {
  return {
    schemaVersion: 1,
    realm: 'backup.example.test',
    vaultId: '11'.repeat(32),
    enrollmentEpoch: 1,
    parentGeneration: null,
    parentManifestDigest: null,
    parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
    generation: 1,
    snapshotNonce: '22'.repeat(16),
    snapshotId: 'seal-test',
    snapshotRevision: 0,
    state: 'populating',
    recordCount,
    canonicalPinBytes: 0,
    sealRunRevision: 0,
    recordSetRoot: null,
    version: 1,
  }
}

function pinsFor(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => pinAt(index))
}

function pinAt(index: number): Uint8Array {
  return encodeEncryptedWalletBackupSnapshotPin({
    schemaVersion: 1,
    realm: 'backup.example.test',
    vaultId: '11'.repeat(32),
    snapshotId: 'seal-test',
    snapshotRevision: 0,
    recordKindCode: 0,
    recordId: index.toString(16).padStart(64, '0'),
    commitment: 'aa'.repeat(32),
    sourceBodyReference: (index + 1).toString(16).padStart(64, '0'),
    sourceRevision: 0,
  })
}

async function sealFixture(
  pins: readonly Uint8Array[],
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const current = controlRow(pins.length)
  current.canonicalPinBytes = sum(pins)
  return sealEncryptedWalletBackupFrozenSnapshot({
    store: new SealStore(current, pins),
    control: issuedControl(),
    current,
  })
}

class SealStore implements EncryptedWalletBackupFrozenSnapshotSealStore {
  control: Uint8Array
  protected readonly pins: readonly Uint8Array[]
  readonly mode: 'unordered' | 'later-pin' | 'twice' | 'no-callback' | null
  maximumRows = 0
  maximumBytes = 0
  pageCalls = 0

  constructor(
    current: PersistedEncryptedWalletBackupFrozenSnapshot,
    pins: readonly Uint8Array[],
    mode: 'unordered' | 'later-pin' | 'twice' | 'no-callback' | null = null,
  ) {
    this.control = encodeEncryptedWalletBackupFrozenSnapshot(current)
    this.pins = [...pins].sort(compareBytes)
    this.mode = mode
  }

  async withSnapshotSealTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupFrozenSnapshotSealStore['withSnapshotSealTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupFrozenSnapshotSealTransaction) => Promise<T>,
  ): Promise<unknown> {
    const fixedRows = 1 + (expected.nextControl === null ? 0 : 1)
    const fixedBytes =
      expected.scope.byteLength +
      expected.expectedControl.byteLength +
      (expected.nextControl?.byteLength ?? 0) +
      (expected.exclusiveAfter?.byteLength ?? 0)
    if (
      fixedRows + expected.reservedPinRows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX ||
      fixedBytes + expected.reservedPinBytes >
        ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES
    )
      throw new Error('reservation exceeds its capacity')
    if (!equalBytes(this.control, expected.expectedControl)) throw new Error('control changed')
    if (this.mode === 'no-callback') return Object.freeze({})
    if (expected.reservedPinRows > 0) this.pageCalls += 1
    const pins = this.page(expected.exclusiveAfter, expected.reservedPinRows)
    if (this.mode === 'unordered') pins.reverse()
    if (pins.length > expected.reservedPinRows || sum(pins) > expected.reservedPinBytes)
      throw new Error('actual scan debit exceeds its reservation')
    this.maximumRows = Math.max(this.maximumRows, fixedRows + pins.length)
    this.maximumBytes = Math.max(this.maximumBytes, fixedBytes + sum(pins))
    const transaction = Object.freeze({ control: this.control.slice(), pins })
    const result = await use(transaction)
    if (this.mode === 'twice') await use(transaction)
    if (expected.nextControl !== null) this.control = expected.nextControl.slice()
    return result
  }

  protected page(after: Uint8Array | null, limit: number): Uint8Array[] {
    const rows = this.pins
      .filter((pin) => after === null || compareBytes(pinKey(pin), after) > 0)
      .slice(0, limit)
    if (this.mode === 'later-pin' && limit === 1) rows.push(this.pins[0]!.slice())
    return rows.map((pin) => pin.slice())
  }
}

class GeneratedSealStore extends SealStore {
  generatedPins = 0
  readonly #count: number

  constructor(current: PersistedEncryptedWalletBackupFrozenSnapshot, count: number) {
    super(current, [])
    this.#count = count
  }

  protected override page(after: Uint8Array | null, limit: number): Uint8Array[] {
    const start = after === null ? 0 : cursorRecordIndex(after) + 1
    const count = Math.max(0, Math.min(limit, this.#count - start))
    this.generatedPins += count
    return Array.from({ length: count }, (_, offset) => pinAt(start + offset))
  }
}

function cursorRecordIndex(value: Uint8Array): number {
  const raw = decode(value)
  if (!Array.isArray(raw) || !(raw[1] instanceof Uint8Array)) throw new Error('cursor is invalid')
  let result = 0
  for (const byte of raw[1]) result = result * 256 + byte
  if (!Number.isSafeInteger(result)) throw new Error('cursor is invalid')
  return result
}

function pinKey(value: Uint8Array): Uint8Array {
  const raw = decode(value) as unknown[]
  return encodeCanonical([raw[5], raw[6], raw[7]])
}

function sum(values: readonly Uint8Array[]): number {
  return values.reduce((total, value) => total + value.byteLength, 0)
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const count = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < count; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.byteLength - right.byteLength
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((item, index) => item === right[index])
}
