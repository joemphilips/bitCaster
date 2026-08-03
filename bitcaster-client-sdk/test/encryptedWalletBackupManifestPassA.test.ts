import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode } from 'cborg'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'
import {
  decodeEncryptedWalletBackupManifestPassAResult,
  encodeEncryptedWalletBackupManifestPassAResult,
  measureEncryptedWalletBackupManifestPageCbor,
  planEncryptedWalletBackupManifestPassA,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_PAGE_MAX_BYTES,
  type EncryptedWalletBackupManifestPassAResultStore,
} from '../src/encryptedWalletBackupManifestPassA.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'
import {
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
  encodeEncryptedWalletBackupSnapshotPin,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
} from '../src/encryptedWalletBackupSnapshotPersistence.ts'
import {
  type EncryptedWalletBackupFrozenSnapshotSealStore,
  type EncryptedWalletBackupFrozenSnapshotSealTransaction,
} from '../src/encryptedWalletBackupSnapshotSeal.ts'

test('Pass-A plans empty and bounded inventory pages', async () => {
  for (const count of [0, 1, 511, 512, 513]) {
    const pins = pinsFor(count, 1)
    const store = new PassAStore(sealedControl(count, sum(pins)), pins)
    const result = await planEncryptedWalletBackupManifestPassA({
      store,
      control: issuedControl(),
      current: store.current,
    })
    assert.equal(result.recordCount, count)
    assert.equal(result.pageCount, count === 0 ? 0 : Math.ceil(count / 512))
    assert.equal(result.totalCanonicalManifestEntryBytes, count)
    assert.equal(store.proofBodyReads, 0)
    assert.ok(store.maximumRows <= 256)
    assert.ok(store.maximumBytes <= 1_048_576)
  }
})

test('Pass-A sizing equals canonical CBOR at integer and array-header edges', () => {
  for (const entryCount of [23, 24, 255, 256]) {
    for (const pageIndex of [23, 24, 255, 256, 1023, 1024]) {
      for (const pageCount of [23, 24, 255, 256, 1023, 1024]) {
        const entries = Array.from({ length: entryCount }, (_, index) => [index, 'entry'])
        const encodedEntries = entries.map((entry) => encodeCanonical(entry))
        const exact = encodeCanonical([1, 2, 24, new Uint8Array(16), pageIndex, pageCount, entries])
        assert.equal(
          measureEncryptedWalletBackupManifestPageCbor({
            generation: 24,
            pageIndex,
            pageCount,
            entryCount,
            canonicalEntryBytes: sum(encodedEntries),
          }),
          exact.byteLength,
        )
      }
    }
  }
})

test('Pass-A rejects singleton pages that exceed the canonical page capacity', async () => {
  const entryBytes = ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_PAGE_MAX_BYTES
  for (const count of [1, 2]) {
    const pins = pinsFor(count, entryBytes)
    const store = new PassAStore(sealedControl(count, sum(pins)), pins)
    await assert.rejects(
      planEncryptedWalletBackupManifestPassA({
        store,
        control: issuedControl(),
        current: store.current,
      }),
      /entry exceeds page capacity/,
    )
    assert.equal(store.result, null)
  }
})

test('Pass-A enforces the 1,024-page boundary without proof bodies', async () => {
  const entryBytes = 65_000
  const acceptedPins = pinsFor(1_024, entryBytes)
  const accepted = new PassAStore(sealedControl(1_024, sum(acceptedPins)), acceptedPins)
  const result = await planEncryptedWalletBackupManifestPassA({
    store: accepted,
    control: issuedControl(),
    current: accepted.current,
  })
  assert.equal(result.pageCount, 1_024)
  const rejectedPins = pinsFor(1_025, entryBytes)
  const rejected = new PassAStore(sealedControl(1_025, sum(rejectedPins)), rejectedPins)
  await assert.rejects(
    planEncryptedWalletBackupManifestPassA({
      store: rejected,
      control: issuedControl(),
      current: rejected.current,
    }),
    /page count exceeds/,
  )
  assert.equal(rejected.proofBodyReads, 0)
})

test('Pass-A result codec is strict and exact retries are idempotent', async () => {
  const pins = pinsFor(2, 7)
  const store = new PassAStore(sealedControl(2, sum(pins)), pins)
  const first = await planEncryptedWalletBackupManifestPassA({
    store,
    control: issuedControl(),
    current: store.current,
  })
  const encoded = encodeEncryptedWalletBackupManifestPassAResult(first)
  const decoded = decodeEncryptedWalletBackupManifestPassAResult(encoded)
  assert.equal(decoded.pageCount, 1)
  assert.equal(decoded.boundaries[0]?.canonicalEntryBytes, 14)
  assert.equal(
    first.sealedControlDigest,
    bytesToHex(sha256(encodeEncryptedWalletBackupFrozenSnapshot(store.current))),
  )
  await planEncryptedWalletBackupManifestPassA({
    store,
    control: issuedControl(),
    current: store.current,
  })
  assert.equal(store.inserts, 1)
  const raw = decode(encoded) as unknown[]
  raw[15] = 2
  assert.throws(() => decodeEncryptedWalletBackupManifestPassAResult(encodeCanonical(raw)))
})

test('Pass-A rejects early, reordered, duplicate, foreign, missing, extra, and stale scans', async () => {
  const pins = pinsFor(2, 1)
  for (const mode of [
    'empty',
    'reordered',
    'duplicate',
    'foreign',
    'missing',
    'extra',
    'stale',
  ] as const) {
    const store = new PassAStore(sealedControl(2, sum(pins)), pins, mode)
    await assert.rejects(
      planEncryptedWalletBackupManifestPassA({
        store,
        control: issuedControl(),
        current: store.current,
      }),
    )
    assert.equal(store.result, null)
  }
})

test('Pass-A strict result codec rejects invalid realm and snapshot identifiers', async () => {
  const pins = pinsFor(1, 1)
  const store = new PassAStore(sealedControl(1, sum(pins)), pins)
  const result = await planEncryptedWalletBackupManifestPassA({
    store,
    control: issuedControl(),
    current: store.current,
  })
  const raw = decode(encodeEncryptedWalletBackupManifestPassAResult(result)) as unknown[]
  raw[2] = 'not a realm'
  assert.throws(() => decodeEncryptedWalletBackupManifestPassAResult(encodeCanonical(raw)))
  raw[2] = result.realm
  raw[4] = ''
  assert.throws(() => decodeEncryptedWalletBackupManifestPassAResult(encodeCanonical(raw)))
})

test('Pass-A rejects conflicting, stale, and late-fault result transactions atomically', async () => {
  const pins = pinsFor(1, 1)
  const conflict = new PassAStore(sealedControl(1, sum(pins)), pins)
  conflict.result = new Uint8Array([1])
  await assert.rejects(
    planEncryptedWalletBackupManifestPassA({
      store: conflict,
      control: issuedControl(),
      current: conflict.current,
    }),
    /conflicts/,
  )
  for (const resultMode of ['stale-control', 'late-fault'] as const) {
    const store = new PassAStore(sealedControl(1, sum(pins)), pins)
    store.resultMode = resultMode
    await assert.rejects(
      planEncryptedWalletBackupManifestPassA({
        store,
        control: issuedControl(),
        current: store.current,
      }),
    )
    assert.equal(store.result, null)
    assert.equal(store.inserts, 0)
  }
})

test('Pass-A rejects canonical pin-byte mismatch and retries a failed final persistence from zero', async () => {
  const pins = pinsFor(2, 1)
  const mismatch = new PassAStore(sealedControl(2, sum(pins) + 1), pins)
  await assert.rejects(
    planEncryptedWalletBackupManifestPassA({
      store: mismatch,
      control: issuedControl(),
      current: mismatch.current,
    }),
    /scan totals/,
  )
  const retry = new PassAStore(sealedControl(2, sum(pins)), pins)
  retry.resultMode = 'insert-fault'
  await assert.rejects(
    planEncryptedWalletBackupManifestPassA({
      store: retry,
      control: issuedControl(),
      current: retry.current,
    }),
  )
  const firstScanCalls = retry.scanCalls
  assert.equal(retry.result, null, 'failed transaction must not persist a partial result')
  retry.resultMode = null
  await planEncryptedWalletBackupManifestPassA({
    store: retry,
    control: issuedControl(),
    current: retry.current,
  })
  assert.ok(retry.scanCalls > firstScanCalls)
})

test('Pass-A rejects invalid result transaction callbacks without partial insertion', async () => {
  const pins = pinsFor(1, 1)
  for (const resultMode of ['no-callback', 'twice', 'substitution'] as const) {
    const store = new PassAStore(sealedControl(1, sum(pins)), pins)
    store.resultMode = resultMode
    await assert.rejects(
      planEncryptedWalletBackupManifestPassA({
        store,
        control: issuedControl(),
        current: store.current,
      }),
      /callback is invalid/,
    )
    assert.equal(store.result, null)
    assert.equal(store.inserts, 0)
  }
})

test(
  'Pass-A streams the maximum inventory in bounded bytewise keyset pages',
  { skip: process.env.BITCASTER_LARGE_BACKUP_CONFORMANCE !== '1' },
  async () => {
    const pinBytes = pinAt(0, 1).byteLength
    const current = sealedControl(
      ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
      pinBytes * ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
    )
    const store = new GeneratedPassAStore(current, ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX, 1)
    const control = issuedControl()
    const result = await planEncryptedWalletBackupManifestPassA({ store, control, current })
    const expectedPages = Math.ceil(ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX / 255) + 1
    const expectedBytes =
      encodeEncryptedWalletBackupFrozenSnapshotScope(control).byteLength +
      encodeEncryptedWalletBackupFrozenSnapshot(current).byteLength +
      pinKey(pinAt(0, 1)).byteLength +
      pinBytes * 255
    assert.equal(result.pageCount, 1_024)
    assert.equal(result.boundaries.length, 1_024)
    assert.equal(store.scanCalls, expectedPages)
    assert.equal(store.generatedPins, ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX)
    assert.equal(store.maximumRows, 256)
    assert.equal(store.maximumBytes, expectedBytes)
    assert.equal(store.proofBodyReads, 0)
    assert.equal(store.lastResultExpected?.reservedReadRows, 2)
    assert.equal(store.lastResultExpected?.reservedWriteRows, 1)
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
      snapshotId: 'pass-a-test',
      snapshotRevision: 0,
    }),
  )
}

function sealedControl(
  recordCount: number,
  canonicalPinBytes: number,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    realm: 'backup.example.test',
    vaultId: '11'.repeat(32),
    enrollmentEpoch: 1,
    parentGeneration: null,
    parentManifestDigest: null,
    parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
    generation: 1,
    snapshotNonce: '22'.repeat(16),
    snapshotId: 'pass-a-test',
    snapshotRevision: 0,
    state: 'sealed' as const,
    recordCount,
    canonicalPinBytes,
    sealRunRevision: 1,
    recordSetRoot: '33'.repeat(32),
    version: 2,
  })
}

function pinsFor(count: number, entryBytes: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => pinAt(index, entryBytes))
}

function pinAt(index: number, entryBytes: number): Uint8Array {
  return encodeEncryptedWalletBackupSnapshotPin({
    schemaVersion: 1,
    realm: 'backup.example.test',
    vaultId: '11'.repeat(32),
    snapshotId: 'pass-a-test',
    snapshotRevision: 0,
    recordKindCode: 0,
    recordId: index.toString(16).padStart(64, '0'),
    commitment: (index + 1_000_000).toString(16).padStart(64, '0'),
    sourceBodyReference: (index + 1).toString(16).padStart(64, '0'),
    sourceRevision: 0,
    canonicalManifestEntryBytes: entryBytes,
  })
}

class PassAStore
  implements
    EncryptedWalletBackupFrozenSnapshotSealStore,
    EncryptedWalletBackupManifestPassAResultStore
{
  control: Uint8Array
  result: Uint8Array | null = null
  readonly pins: readonly Uint8Array[]
  readonly mode:
    | 'empty'
    | 'reordered'
    | 'duplicate'
    | 'foreign'
    | 'missing'
    | 'extra'
    | 'stale'
    | null
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot
  maximumRows = 0
  maximumBytes = 0
  inserts = 0
  proofBodyReads = 0
  scanCalls = 0
  lastResultExpected:
    | Parameters<
        EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
      >[0]
    | null = null
  resultMode:
    | 'insert-fault'
    | 'no-callback'
    | 'twice'
    | 'substitution'
    | 'stale-control'
    | 'late-fault'
    | null = null

  constructor(
    current: PersistedEncryptedWalletBackupFrozenSnapshot,
    pins: readonly Uint8Array[],
    mode:
      | 'empty'
      | 'reordered'
      | 'duplicate'
      | 'foreign'
      | 'missing'
      | 'extra'
      | 'stale'
      | null = null,
  ) {
    this.current = current
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
    if (this.mode === 'stale') this.control = new Uint8Array([1])
    if (!equalBytes(this.control, expected.expectedControl)) throw new Error('control changed')
    this.scanCalls += 1
    const rows = this.page(expected.exclusiveAfter, expected.reservedPinRows)
    const fixedBytes =
      expected.scope.byteLength +
      expected.expectedControl.byteLength +
      (expected.exclusiveAfter?.byteLength ?? 0)
    this.maximumRows = Math.max(this.maximumRows, 1 + rows.length)
    this.maximumBytes = Math.max(this.maximumBytes, fixedBytes + sum(rows))
    return use(Object.freeze({ control: this.control.slice(), pins: rows }))
  }

  async withManifestPassAResultTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
    >[0],
    use: (
      transaction: Parameters<
        EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
      >[1] extends (transaction: infer U) => Promise<unknown>
        ? U
        : never,
    ) => Promise<T>,
  ): Promise<unknown> {
    this.requireResultReservation(expected)
    this.lastResultExpected = expected
    if (this.resultMode === 'stale-control') this.control = new Uint8Array([1])
    if (!equalBytes(this.control, expected.expectedControl)) throw new Error('control changed')
    if (this.resultMode === 'no-callback') return Object.freeze({})
    let candidate: Uint8Array | null = null
    const transaction = {
      control: this.control.slice(),
      result: this.result?.slice() ?? null,
      insertResult: async (next: Uint8Array) => {
        if (this.resultMode === 'insert-fault') throw new Error('insert fault')
        if (next.byteLength > expected.reservedWriteBytes)
          throw new Error('write reservation is invalid')
        if (this.result !== null || candidate !== null) throw new Error('result exists')
        candidate = next.slice()
      },
    }
    const result = await use(transaction)
    if (this.resultMode === 'twice') await use(transaction)
    if (this.resultMode === 'substitution') return Object.freeze({})
    if (this.resultMode === 'late-fault') throw new Error('late transaction fault')
    if (candidate !== null) {
      this.result = candidate
      this.inserts += 1
    }
    return result
  }

  private requireResultReservation(
    expected: Parameters<
      EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
    >[0],
  ): void {
    const minimumReadBytes =
      expected.scope.byteLength + expected.expectedControl.byteLength + 65_536
    if (
      expected.reservedReadRows !== 2 ||
      expected.reservedWriteRows !== 1 ||
      expected.reservedReadBytes < minimumReadBytes ||
      expected.reservedWriteBytes < 1 ||
      expected.reservedReadBytes + expected.reservedWriteBytes > 1_048_576
    )
      throw new Error('result reservation is invalid')
  }

  protected page(after: Uint8Array | null, limit: number): Uint8Array[] {
    if (this.mode === 'empty') return []
    const rows = this.pins
      .filter((pin) => after === null || compareBytes(pinKey(pin), after) > 0)
      .slice(0, limit)
      .map((pin) => pin.slice())
    if (this.mode === 'missing') rows.pop()
    if (this.mode === 'extra' && limit > 0) rows.push(this.pins[0]!.slice())
    if (this.mode === 'duplicate' && rows[0] !== undefined) rows.push(rows[0].slice())
    if (this.mode === 'reordered') rows.reverse()
    if (this.mode === 'foreign' && rows[0] !== undefined) {
      const pin = decode(rows[0]) as unknown[]
      pin[1] = 'foreign.example.test'
      rows[0] = encodeCanonical(pin)
    }
    return rows
  }
}

class GeneratedPassAStore extends PassAStore {
  generatedPins = 0
  readonly #count: number
  readonly #entryBytes: number

  constructor(
    current: PersistedEncryptedWalletBackupFrozenSnapshot,
    count: number,
    entryBytes: number,
  ) {
    super(current, [])
    this.#count = count
    this.#entryBytes = entryBytes
  }

  protected override page(after: Uint8Array | null, limit: number): Uint8Array[] {
    const start = after === null ? 0 : cursorRecordIndex(after) + 1
    const count = Math.max(0, Math.min(limit, this.#count - start))
    this.generatedPins += count
    return Array.from({ length: count }, (_, offset) => pinAt(start + offset, this.#entryBytes))
  }
}

function cursorRecordIndex(value: Uint8Array): number {
  const raw = decode(value)
  if (!Array.isArray(raw) || !(raw[1] instanceof Uint8Array)) throw new Error('cursor is invalid')
  let index = 0
  for (const byte of raw[1]) index = index * 256 + byte
  if (!Number.isSafeInteger(index)) throw new Error('cursor is invalid')
  return index
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
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}
