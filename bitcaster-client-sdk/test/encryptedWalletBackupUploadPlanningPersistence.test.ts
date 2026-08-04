import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  decodeEncryptedWalletBackupUploadCursor,
  encodeEncryptedWalletBackupUploadCursor,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_CURSOR_MAX_BYTES,
  type PersistedEncryptedWalletBackupUploadCursor,
} from '../src/encryptedWalletBackupUploadPlanningPersistence.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'

test('upload cursor codec round-trips immutable nullable values', () => {
  const encoded = encodeEncryptedWalletBackupUploadCursor(cursorFixture())
  const decoded = decodeEncryptedWalletBackupUploadCursor(encoded)
  assert.equal(decoded.phase, 'pages')
  assert.equal(decoded.exclusiveChunkObjectId, null)
  assert.equal(Object.isFrozen(decoded), true)
})

test('upload cursor codec uses deterministic canonical CBOR', () => {
  const cursor = cursorFixture({ phase: 'chunks', exclusiveChunkObjectId: 'cc'.repeat(16) })
  const encoded = encodeEncryptedWalletBackupUploadCursor(cursor)
  assert.equal(bytesEqual(encoded, encodeEncryptedWalletBackupUploadCursor(cursor)), true)
  const wire = decode(encoded) as unknown[]
  assert.equal(wire[0], 1)
  assert.equal(wire[1], 'encrypted-wallet-backup-upload-cursor')
  assert.equal(bytesToHex(wire[3] as Uint8Array), cursor.vaultId)
  assert.equal(bytesEqual(encoded, encodeCanonical(wire)), true)
})

test('upload cursor codec reproduces its fixed compatibility vector', () => {
  assert.equal(
    bytesToHex(encodeEncryptedWalletBackupUploadCursor(cursorFixture())),
    UPLOAD_CURSOR_VECTOR_HEX,
  )
})

test('upload cursor codec accepts bounded numeric boundaries', () => {
  const cursor = cursorFixture({
    realm: `a${'z'.repeat(62)}a`,
    nextPageIndex: 1_024,
    nextBatchOrdinal: 64,
    version: 65,
    exclusiveChunkObjectId: 'cc'.repeat(16),
    phase: 'chunks',
  })
  const decoded = decodeEncryptedWalletBackupUploadCursor(
    encodeEncryptedWalletBackupUploadCursor(cursor),
  )
  assert.equal(decoded.nextPageIndex, 1_024)
  assert.equal(decoded.nextBatchOrdinal, 64)
  assert.equal(decoded.version, 65)
})

test('upload cursor codec rejects numeric values one above each boundary', () => {
  const cursor = cursorFixture()
  for (const [field, replacement] of [
    ['nextPageIndex', 1_025],
    ['nextBatchOrdinal', 65],
    ['version', 66],
  ] as const) {
    assert.throws(() =>
      encodeEncryptedWalletBackupUploadCursor({ ...cursor, [field]: replacement } as never),
    )
  }
  const wire = decode(encodeEncryptedWalletBackupUploadCursor(cursor)) as unknown[]
  for (const [index, replacement] of [
    [7, 1_025],
    [9, 65],
    [10, 66],
  ] as const) {
    const malformed = [...wire]
    malformed[index] = replacement
    assert.throws(() => decodeEncryptedWalletBackupUploadCursor(encodeCanonical(malformed)))
  }
})

test('upload cursor requires no exclusive chunk object during pages', () => {
  const cursor = { ...cursorFixture(), exclusiveChunkObjectId: 'cc'.repeat(16) }
  assert.throws(() => encodeEncryptedWalletBackupUploadCursor(cursor as never))
  const wire = decode(encodeEncryptedWalletBackupUploadCursor(cursorFixture())) as unknown[]
  wire[8] = new Uint8Array(16)
  assert.throws(() => decodeEncryptedWalletBackupUploadCursor(encodeCanonical(wire)))
})

test('upload cursor codec rejects one byte above its record cap', () => {
  assert.throws(
    () =>
      decodeEncryptedWalletBackupUploadCursor(
        new Uint8Array(ENCRYPTED_WALLET_BACKUP_UPLOAD_CURSOR_MAX_BYTES + 1),
      ),
    /upload cursor is invalid/,
  )
})

test('upload cursor codec rejects truncated, trailing, and noncanonical CBOR', () => {
  const encoded = encodeEncryptedWalletBackupUploadCursor(cursorFixture())
  assert.throws(() =>
    decodeEncryptedWalletBackupUploadCursor(encoded.subarray(0, encoded.length - 1)),
  )
  assert.throws(() => decodeEncryptedWalletBackupUploadCursor(new Uint8Array([...encoded, 0])))
  assert.throws(() =>
    decodeEncryptedWalletBackupUploadCursor(
      new Uint8Array([0x98, encoded[0]!, ...encoded.subarray(1)]),
    ),
  )
})

test('upload cursor encode rejects unknown, inherited, and every malformed field', () => {
  const value = cursorFixture()
  assert.throws(() =>
    encodeEncryptedWalletBackupUploadCursor({ ...value, unexpected: true } as never),
  )
  const inherited = Object.create({ inherited: true })
  Object.assign(inherited, value)
  assert.throws(() => encodeEncryptedWalletBackupUploadCursor(inherited))
  for (const [field, replacement] of malformedFields()) {
    assert.throws(() =>
      encodeEncryptedWalletBackupUploadCursor({ ...value, [field]: replacement } as never),
    )
  }
  const wire = decode(encodeEncryptedWalletBackupUploadCursor(value)) as unknown[]
  for (const [index, replacement] of malformedWireFields()) {
    const malformed = [...wire]
    malformed[index] = replacement
    assert.throws(() => decodeEncryptedWalletBackupUploadCursor(encodeCanonical(malformed)))
  }
})

test('upload cursor contains no proof, body, request, or reference data', () => {
  const decoded = decodeEncryptedWalletBackupUploadCursor(
    encodeEncryptedWalletBackupUploadCursor(cursorFixture({ phase: 'complete' })),
  )
  for (const name of ['body', 'proof', 'canonicalPutPayload', 'request', 'references'] as const) {
    assert.equal(Object.hasOwn(decoded, name), false)
  }
  for (const name of ['body', 'proof', 'canonicalPutPayload', 'request', 'references'] as const) {
    assert.throws(() =>
      encodeEncryptedWalletBackupUploadCursor({ ...cursorFixture(), [name]: [] } as never),
    )
  }
})

type CursorBase = Omit<
  PersistedEncryptedWalletBackupUploadCursor,
  'phase' | 'exclusiveChunkObjectId'
>
type PagesOverrides = Partial<CursorBase> &
  Readonly<{ readonly phase?: 'pages'; readonly exclusiveChunkObjectId?: null }>
type OtherPhaseOverrides = Partial<CursorBase> &
  Readonly<{
    readonly phase: 'chunks' | 'complete'
    readonly exclusiveChunkObjectId?: string | null
  }>

function cursorFixture(overrides?: PagesOverrides): PersistedEncryptedWalletBackupUploadCursor
function cursorFixture(overrides: OtherPhaseOverrides): PersistedEncryptedWalletBackupUploadCursor
function cursorFixture(
  overrides: PagesOverrides | OtherPhaseOverrides = {},
): PersistedEncryptedWalletBackupUploadCursor {
  const base: CursorBase = {
    schemaVersion: 1,
    realm: 'production',
    vaultId: '11'.repeat(32),
    targetManifestDigest: 'aa'.repeat(32),
    attemptId: 'bb'.repeat(16),
    nextPageIndex: 0,
    nextBatchOrdinal: 0,
    version: 1,
  }
  if (overrides.phase === 'chunks' || overrides.phase === 'complete') {
    return {
      ...base,
      ...overrides,
      phase: overrides.phase,
      exclusiveChunkObjectId: overrides.exclusiveChunkObjectId ?? null,
    }
  }
  return { ...base, ...overrides, phase: 'pages', exclusiveChunkObjectId: null }
}

function malformedFields(): readonly [string, unknown][] {
  return [
    ['schemaVersion', 2],
    ['realm', 'Upper'],
    ['vaultId', '11'],
    ['targetManifestDigest', 'aa'],
    ['attemptId', 'bb'],
    ['phase', 'other'],
    ['nextPageIndex', -1],
    ['exclusiveChunkObjectId', 'cc'],
    ['nextBatchOrdinal', -1],
    ['version', 0],
  ]
}

function malformedWireFields(): readonly [number, unknown][] {
  return [
    [0, 2],
    [2, 'Upper'],
    [3, new Uint8Array(1)],
    [4, new Uint8Array(1)],
    [5, new Uint8Array(1)],
    [6, 'other'],
    [7, -1],
    [8, new Uint8Array(1)],
    [9, -1],
    [10, 0],
  ]
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const UPLOAD_CURSOR_VECTOR_HEX =
  '8b017825656e637279707465642d77616c6c65742d6261636b75702d75706c6f61642d637572736f726a70726f64756374696f6e582011111111111111111111111111111111111111111111111111111111111111115820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa50bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb65706167657300f60001'
