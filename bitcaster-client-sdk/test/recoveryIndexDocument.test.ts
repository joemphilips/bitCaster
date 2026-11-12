import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { decode, decodeFirst, encode, rfc8949EncodeOptions } from 'cborg'
import {
  RECOVERY_INDEX_DOCUMENT_BYTES_MAX,
  RECOVERY_INDEX_MINTS_MAX,
  RecoveryIndexCapacityError,
  RecoveryIndexFormatError,
  deriveRecoveryIndexKeys,
  isRecoveryIndexDocumentSize,
  mergeRecoveryIndex,
  mergeRecoveryIndexEntries,
  openRecoveryIndexDocument,
  pendingRecoveryIndexEntries,
  sealRecoveryIndexDocument,
  type RecoveryIndexEntry,
  type RecoveryIndexKeys,
} from '../src/recoveryIndexDocument.ts'

interface DocumentVector {
  readonly name: string
  readonly context: string
  readonly writtenVersion: number
  readonly nonce: string
  readonly mints: readonly string[]
  readonly entries?: readonly RecoveryIndexEntry[]
  readonly entryRule?: {
    readonly mintUrl: string
    readonly keysetIdLabelPrefix: string
    readonly count: number
  }
  readonly cborLength: number
  readonly plaintextLength: number
  readonly documentLength: number
  readonly cborSha256: string
  readonly documentSha256: string
  readonly cbor?: string
  readonly document?: string
}

interface VectorFile {
  readonly seed: string
  readonly keys: readonly {
    readonly context: string
    readonly encryptionKey: string
    readonly locatorSecretKey: string
    readonly locatorPublicKey: string
  }[]
  readonly documents: readonly DocumentVector[]
  readonly invalidDocuments: readonly {
    readonly name: string
    readonly context: string
    readonly storeVersion: number
    readonly document: string
    readonly reason: string
  }[]
}

const VECTORS = JSON.parse(
  readFileSync(new URL('./fixtures/recovery-index-v1.json', import.meta.url), 'utf8'),
) as VectorFile
const SEED = hexToBytes(VECTORS.seed)
const OTHER_SEED = new Uint8Array(64).fill(9)
const CONTEXT = 'bitcaster-test'
const KEYS = deriveRecoveryIndexKeys(SEED, CONTEXT)
const HEADER = concatBytes(utf8ToBytes('CASHURI'), Uint8Array.of(1, 1))
const NONCE = hexToBytes('000102030405060708090a0b')
const MINT = 'https://mint.example.com'
const OTHER_MINT = 'https://other.example.com'

function keysetId(label: string): string {
  return `01${bytesToHex(sha256(utf8ToBytes(label)))}`
}

function bytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The entries of a vector, in canonical order. */
function vectorEntries(vector: DocumentVector): readonly RecoveryIndexEntry[] {
  const rule = vector.entryRule
  const entries =
    rule === undefined
      ? vector.entries!
      : Array.from({ length: rule.count }, (_, index) => ({
          kind: 'regular' as const,
          mintUrl: rule.mintUrl,
          keysetId: keysetId(`${rule.keysetIdLabelPrefix}${index}`),
        }))
  return [...entries].sort(
    (left, right) =>
      bytewise(left.mintUrl, right.mintUrl) || bytewise(left.keysetId, right.keysetId),
  )
}

/** Seal a vector with the SDK writer, and return the document and its CBOR map. */
function sealVector(vector: DocumentVector): { document: Uint8Array; cbor: Uint8Array } {
  const keys = deriveRecoveryIndexKeys(SEED, vector.context)
  const document = sealRecoveryIndexDocument({
    keys,
    entries: vectorEntries(vector),
    writtenVersion: vector.writtenVersion,
    randomBytes: () => hexToBytes(vector.nonce),
  })
  const plaintext = chacha20poly1305(keys.encryptionKey, hexToBytes(vector.nonce), HEADER).decrypt(
    document.subarray(21),
  )
  return { document, cbor: plaintext.subarray(0, vector.cborLength) }
}

const STRICT_CBOR = {
  strict: true,
  rejectDuplicateMapKeys: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowBigInt: false,
} as const

function regular(label: string, mintUrl = MINT): RecoveryIndexEntry {
  return { kind: 'regular', mintUrl, keysetId: keysetId(label) }
}

function conditional(label: string, mintUrl = MINT): RecoveryIndexEntry {
  return {
    kind: 'conditional',
    mintUrl,
    keysetId: keysetId(label),
    conditionId: bytesToHex(sha256(utf8ToBytes(`condition ${label}`))),
    outcomeCollectionId: bytesToHex(sha256(utf8ToBytes(`collection ${label}`))),
  }
}

/** A small deterministic CBOR writer for hand-made test plaintexts. */
const cbor = {
  head(major: number, value: number): Uint8Array {
    if (value < 24) return Uint8Array.of((major << 5) | value)
    if (value < 0x100) return Uint8Array.of((major << 5) | 24, value)
    if (value < 0x10000) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff)
    throw new Error('test CBOR value is too large')
  },
  uint: (value: number) => cbor.head(0, value),
  text: (value: string) => concatBytes(cbor.head(3, utf8ToBytes(value).length), utf8ToBytes(value)),
  bytes: (value: Uint8Array) => concatBytes(cbor.head(2, value.length), value),
  array: (...items: Uint8Array[]) => concatBytes(cbor.head(4, items.length), ...items),
  map: (...pairs: Uint8Array[]) => concatBytes(cbor.head(5, pairs.length / 2), ...pairs),
}

/** The CBOR map of ADR-051 with one regular entry of `MINT`. */
function plainMap(
  overrides: {
    readonly version?: Uint8Array
    readonly ver?: Uint8Array
    readonly mints?: Uint8Array
    readonly entries?: Uint8Array
  } = {},
): Uint8Array {
  return cbor.map(
    cbor.text('v'),
    overrides.version ?? cbor.uint(1),
    cbor.text('ver'),
    overrides.ver ?? cbor.uint(1),
    cbor.text('mints'),
    overrides.mints ?? cbor.array(cbor.text(MINT)),
    cbor.text('entries'),
    overrides.entries ??
      cbor.array(cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(keysetId('a'))))),
  )
}

function padTo(bytes: Uint8Array, size: number): Uint8Array {
  const padded = new Uint8Array(size)
  padded.set(bytes)
  return padded
}

/** Seal a hand-made plaintext with the cipher directly, not with the SDK writer. */
function sealRaw(
  plaintext: Uint8Array,
  options: { readonly keys?: RecoveryIndexKeys; readonly header?: Uint8Array } = {},
): Uint8Array {
  const header = options.header ?? HEADER
  const sealed = chacha20poly1305((options.keys ?? KEYS).encryptionKey, NONCE, header).encrypt(
    plaintext,
  )
  return concatBytes(header, NONCE, sealed)
}

function refusal(action: () => unknown, reason: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RecoveryIndexFormatError, 'the reader refuses with a format error')
    assert.equal(error.reason, reason)
    return true
  })
}

function open(document: Uint8Array, storeVersion = 1) {
  return openRecoveryIndexDocument({ keys: KEYS, document, storeVersion })
}

test('the keys of each realm match the golden vectors', () => {
  for (const vector of VECTORS.keys) {
    const keys = deriveRecoveryIndexKeys(SEED, vector.context)
    assert.equal(bytesToHex(keys.encryptionKey), vector.encryptionKey, vector.context)
    assert.equal(bytesToHex(keys.locatorSecretKey), vector.locatorSecretKey, vector.context)
    assert.equal(keys.locatorPublicKey, vector.locatorPublicKey, vector.context)
  }
  // Each realm gives other keys.
  assert.equal(new Set(VECTORS.keys.map(({ locatorPublicKey }) => locatorPublicKey)).size, 4)
})

test('the key derivation refuses a seed that is not 64 bytes and a context out of range', () => {
  assert.throws(() => deriveRecoveryIndexKeys(new Uint8Array(32), CONTEXT), /seed/)
  assert.throws(() => deriveRecoveryIndexKeys(SEED, ''), /context/)
  assert.throws(() => deriveRecoveryIndexKeys(SEED, 'x'.repeat(65)), /context/)
  assert.throws(() => deriveRecoveryIndexKeys(SEED, '\ud800'), /context/)
  assert.equal(deriveRecoveryIndexKeys(SEED, 'x'.repeat(64)).locatorPublicKey.length, 64)
})

test('the writer gives the golden documents, and the reader gives back their entries', () => {
  assert.ok(
    VECTORS.documents.some(
      ({ documentLength }) => documentLength === RECOVERY_INDEX_DOCUMENT_BYTES_MAX,
    ),
  )
  for (const vector of VECTORS.documents) {
    const keys = deriveRecoveryIndexKeys(SEED, vector.context)
    const document = sealRecoveryIndexDocument({
      keys,
      entries: vectorEntries(vector),
      writtenVersion: vector.writtenVersion,
      randomBytes: () => hexToBytes(vector.nonce),
    })
    assert.equal(document.length, vector.documentLength, vector.name)
    assert.equal(bytesToHex(sha256(document)), vector.documentSha256, vector.name)
    if (vector.document !== undefined) {
      assert.ok(bytesToHex(document) === vector.document, vector.name)
    }
    const plaintext = chacha20poly1305(
      keys.encryptionKey,
      hexToBytes(vector.nonce),
      HEADER,
    ).decrypt(document.subarray(21))
    assert.equal(plaintext.length, vector.plaintextLength, vector.name)
    assert.equal(bytesToHex(sha256(plaintext.subarray(0, vector.cborLength))), vector.cborSha256)
    assert.ok(plaintext.subarray(vector.cborLength).every((byte) => byte === 0))

    const entries = openRecoveryIndexDocument({
      keys,
      document,
      storeVersion: vector.writtenVersion,
    })
    assert.ok(isDeepStrictEqual(entries, vectorEntries(vector)), vector.name)
  }
})

test('an independent CBOR library reads each golden map and encodes it to the same bytes', () => {
  for (const vector of VECTORS.documents) {
    const { cbor } = sealVector(vector)
    assert.equal(bytesToHex(sha256(cbor)), vector.cborSha256, vector.name)
    if (vector.cbor !== undefined) assert.ok(bytesToHex(cbor) === vector.cbor, vector.name)
    const map = decode(cbor, STRICT_CBOR) as {
      readonly v: number
      readonly ver: number
      readonly mints: readonly string[]
      readonly entries: readonly (readonly [number, Uint8Array, Uint8Array?, Uint8Array?])[]
    }
    assert.deepEqual(Object.keys(map), ['v', 'ver', 'mints', 'entries'], vector.name)
    assert.equal(map.v, 1)
    assert.equal(map.ver, vector.writtenVersion)
    assert.deepEqual(map.mints, vector.mints)
    const read = map.entries.map(([mintIndex, keyset, conditionId, outcomeCollectionId]) =>
      conditionId === undefined
        ? { kind: 'regular', mintUrl: map.mints[mintIndex], keysetId: bytesToHex(keyset) }
        : {
            kind: 'conditional',
            mintUrl: map.mints[mintIndex],
            keysetId: bytesToHex(keyset),
            conditionId: bytesToHex(conditionId),
            outcomeCollectionId: bytesToHex(outcomeCollectionId!),
          },
    )
    assert.ok(isDeepStrictEqual(read, vectorEntries(vector)), vector.name)
    // RFC 8949 deterministic encoding by another encoder gives the same bytes.
    assert.ok(
      bytesToHex(encode(map, rfc8949EncodeOptions)) === bytesToHex(cbor),
      `${vector.name}: the deterministic encodings differ`,
    )
  }
})

test('the reader refuses each invalid golden document with its reason', () => {
  assert.equal(VECTORS.invalidDocuments.length, 9)
  for (const vector of VECTORS.invalidDocuments) {
    assert.throws(
      () =>
        openRecoveryIndexDocument({
          keys: deriveRecoveryIndexKeys(SEED, vector.context),
          document: hexToBytes(vector.document),
          storeVersion: vector.storeVersion,
        }),
      (error: unknown) =>
        error instanceof RecoveryIndexFormatError && error.reason === vector.reason,
      vector.name,
    )
  }
})

test('an independent CBOR library confirms that the invalid encodings are not deterministic', () => {
  const keys = deriveRecoveryIndexKeys(SEED, 'bitcaster-test')
  const encodings = VECTORS.invalidDocuments.filter(({ reason }) => reason === 'encoding')
  assert.equal(encodings.length, 2)
  for (const vector of encodings) {
    const document = hexToBytes(vector.document)
    const plaintext = chacha20poly1305(
      keys.encryptionKey,
      document.subarray(9, 21),
      document.subarray(0, 9),
    ).decrypt(document.subarray(21))
    let canonical = false
    try {
      const [value, rest] = decodeFirst(plaintext, STRICT_CBOR)
      const consumed = plaintext.subarray(0, plaintext.length - rest.length)
      canonical = bytesToHex(encode(value, rfc8949EncodeOptions)) === bytesToHex(consumed)
    } catch {
      // A strict decoder refuses an argument that is longer than necessary.
    }
    assert.equal(canonical, false, vector.name)
  }
})

test('the writer refuses an all-zero nonce from its random source', () => {
  assert.throws(
    () =>
      sealRecoveryIndexDocument({
        keys: KEYS,
        entries: [regular('a')],
        writtenVersion: 1,
        randomBytes: (length) => new Uint8Array(length),
      }),
    /nonce/,
  )
})

test('the envelope binds the realm, the seed key, and the stored version', () => {
  const document = sealRecoveryIndexDocument({
    keys: KEYS,
    entries: [regular('a')],
    writtenVersion: 4,
  })
  assert.equal(open(document, 4).length, 1)
  // A document of another realm or another seed does not open.
  refusal(
    () =>
      openRecoveryIndexDocument({
        keys: deriveRecoveryIndexKeys(SEED, 'bitcaster-local'),
        document,
        storeVersion: 4,
      }),
    'authentication',
  )
  refusal(
    () =>
      openRecoveryIndexDocument({
        keys: deriveRecoveryIndexKeys(OTHER_SEED, CONTEXT),
        document,
        storeVersion: 4,
      }),
    'authentication',
  )
  // A store cannot serve an old document as a new version.
  refusal(() => open(document, 5), 'stored-version')
  // The tag covers the header and the ciphertext.
  const flipped = document.slice()
  flipped[30] = flipped[30]! ^ 1
  refusal(() => open(flipped, 4), 'authentication')
})

test('the reader refuses a wrong magic, a newer version, a wrong cipher, a zero nonce, and a wrong size', () => {
  const good = sealRaw(padTo(plainMap(), 4096))
  assert.equal(open(good).length, 1)

  const magic = good.slice()
  magic[0] = 'D'.charCodeAt(0)
  refusal(() => open(magic), 'magic')
  const version = good.slice()
  version[7] = 2
  refusal(() => open(version), 'unsupported-version')
  const cipher = good.slice()
  cipher[8] = 0
  refusal(() => open(cipher), 'unsupported-cipher')
  const zeroNonce = good.slice()
  zeroNonce.fill(0, 9, 21)
  refusal(() => open(zeroNonce), 'nonce')
  refusal(() => open(concatBytes(good, Uint8Array.of(0))), 'size')
  refusal(() => open(good.subarray(0, good.length - 1)), 'size')
  refusal(() => open(good.subarray(0, 8)), 'size')
  assert.equal(isRecoveryIndexDocumentSize(4133), true)
  assert.equal(isRecoveryIndexDocumentSize(RECOVERY_INDEX_DOCUMENT_BYTES_MAX), true)
  assert.equal(isRecoveryIndexDocumentSize(2048 + 37), false)
  assert.equal(isRecoveryIndexDocumentSize(131072 + 37), false)
})

test('the reader refuses padding that is not zero or not minimal', () => {
  const nonZero = padTo(plainMap(), 4096)
  nonZero[4095] = 1
  refusal(() => open(sealRaw(nonZero)), 'padding')
  // The map fits 4 KiB, so an 8 KiB ciphertext is not minimal.
  refusal(() => open(sealRaw(padTo(plainMap(), 8192))), 'padding')
})

test('the reader refuses CBOR that is not deterministic', () => {
  const nonMinimalInteger = plainMap({ version: Uint8Array.of(0x18, 0x01) })
  refusal(() => open(sealRaw(padTo(nonMinimalInteger, 4096))), 'encoding')
  const nonMinimalLength = concatBytes(Uint8Array.of(0xb8, 0x04), plainMap().subarray(1))
  refusal(() => open(sealRaw(padTo(nonMinimalLength, 4096))), 'encoding')
  const indefinite = plainMap({
    mints: concatBytes(Uint8Array.of(0x9f), cbor.text(MINT), Uint8Array.of(0xff)),
  })
  refusal(() => open(sealRaw(padTo(indefinite, 4096))), 'encoding')
  const keysOutOfOrder = cbor.map(
    cbor.text('ver'),
    cbor.uint(1),
    cbor.text('v'),
    cbor.uint(1),
    cbor.text('mints'),
    cbor.array(cbor.text(MINT)),
    cbor.text('entries'),
    cbor.array(cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(keysetId('a'))))),
  )
  refusal(() => open(sealRaw(padTo(keysOutOfOrder, 4096))), 'encoding')
})

test('the reader refuses an unknown version, a wrong key set, and a wrong type', () => {
  refusal(() => open(sealRaw(padTo(plainMap({ version: cbor.uint(2) }), 4096))), 'content')
  refusal(() => open(sealRaw(padTo(plainMap({ ver: cbor.uint(0) }), 4096), {}), 0), 'content')
  refusal(() => open(sealRaw(padTo(plainMap({ ver: cbor.text('1') }), 4096))), 'content')
  // A tag is well-formed CBOR, but no field of the index has one.
  refusal(() => open(sealRaw(padTo(plainMap({ ver: Uint8Array.of(0xc1, 0x01) }), 4096))), 'content')
  const missing = cbor.map(
    cbor.text('v'),
    cbor.uint(1),
    cbor.text('ver'),
    cbor.uint(1),
    cbor.text('mints'),
    cbor.array(cbor.text(MINT)),
  )
  refusal(() => open(sealRaw(padTo(missing, 4096))), 'content')
  const unknown = cbor.map(
    cbor.text('v'),
    cbor.uint(1),
    cbor.text('ver'),
    cbor.uint(1),
    cbor.text('mints'),
    cbor.array(cbor.text(MINT)),
    cbor.text('extras'),
    cbor.uint(0),
  )
  refusal(() => open(sealRaw(padTo(unknown, 4096))), 'content')
  refusal(() => open(sealRaw(padTo(cbor.array(cbor.uint(1)), 4096))), 'content')
})

test('the reader refuses a byte order mark before a map key', () => {
  const bomKey = cbor.map(
    cbor.text('v'),
    cbor.uint(1),
    cbor.text('ver'),
    cbor.uint(1),
    cbor.text('mints'),
    cbor.array(cbor.text(MINT)),
    cbor.text('\ufeffentries'),
    cbor.array(cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(keysetId('a'))))),
  )
  refusal(() => open(sealRaw(padTo(bomKey, 4096))), 'content')
})

test('the reader refuses wrong mints and entries', () => {
  const id = (label: string) => cbor.bytes(hexToBytes(keysetId(label)))
  const [first, second] = [keysetId('a'), keysetId('b')].sort()
  const cases: Record<string, Uint8Array> = {
    'no mint': plainMap({ mints: cbor.array() }),
    'nine mints': plainMap({
      mints: cbor.array(
        ...Array.from({ length: 9 }, (_, index) => cbor.text(`https://m${index}.example.com`)),
      ),
    }),
    'mints out of order': plainMap({
      mints: cbor.array(cbor.text(OTHER_MINT), cbor.text(MINT)),
      entries: cbor.array(cbor.array(cbor.uint(0), id('a')), cbor.array(cbor.uint(1), id('b'))),
    }),
    'trailing slash': plainMap({ mints: cbor.array(cbor.text(`${MINT}/`)) }),
    'default port': plainMap({ mints: cbor.array(cbor.text(`${MINT}:443`)) }),
    query: plainMap({ mints: cbor.array(cbor.text(`${MINT}?a=1`)) }),
    'percent escape': plainMap({ mints: cbor.array(cbor.text(`${MINT}/%41`)) }),
    'upper-case host': plainMap({ mints: cbor.array(cbor.text('https://Mint.example.com')) }),
    // A decoder that drops a leading byte order mark would read a second encoding of one value.
    'byte order mark before a mint URL': plainMap({
      mints: cbor.array(cbor.text(`\ufeff${MINT}`)),
    }),
    'unused mint': plainMap({ mints: cbor.array(cbor.text(MINT), cbor.text(OTHER_MINT)) }),
    'no entry': plainMap({ entries: cbor.array() }),
    'mint index out of range': plainMap({ entries: cbor.array(cbor.array(cbor.uint(1), id('a'))) }),
    'entry of length 3': plainMap({
      entries: cbor.array(cbor.array(cbor.uint(0), id('a'), cbor.bytes(new Uint8Array(32)))),
    }),
    'keyset id version 00': plainMap({
      entries: cbor.array(cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(`00${'ab'.repeat(32)}`)))),
    }),
    'short keyset id': plainMap({
      entries: cbor.array(cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(`00${'ab'.repeat(7)}`)))),
    }),
    'short condition id': plainMap({
      entries: cbor.array(
        cbor.array(
          cbor.uint(0),
          id('a'),
          cbor.bytes(new Uint8Array(31)),
          cbor.bytes(new Uint8Array(32)),
        ),
      ),
    }),
    'duplicate entry': plainMap({
      entries: cbor.array(
        cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(first!))),
        cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(first!))),
      ),
    }),
    'entries out of order': plainMap({
      entries: cbor.array(
        cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(second!))),
        cbor.array(cbor.uint(0), cbor.bytes(hexToBytes(first!))),
      ),
    }),
  }
  for (const [name, map] of Object.entries(cases)) {
    assert.throws(
      () => open(sealRaw(padTo(map, 4096))),
      (error: unknown) => error instanceof RecoveryIndexFormatError && error.reason === 'content',
      name,
    )
  }
})

test('the 64 KiB step holds 467 conditional entries with eight mints of the largest size', () => {
  const mints = Array.from(
    { length: RECOVERY_INDEX_MINTS_MAX },
    (_, index) => `https://m${index}.example/${'p'.repeat(2048 - 'https://m0.example/'.length)}`,
  )
  assert.ok(mints.every((mint) => utf8ToBytes(mint).length === 2048))
  const entries = Array.from({ length: 467 }, (_, index) =>
    conditional(`entry ${index}`, mints[index % mints.length]),
  )
  const document = sealRecoveryIndexDocument({
    keys: KEYS,
    entries,
    writtenVersion: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(document.length, RECOVERY_INDEX_DOCUMENT_BYTES_MAX)
  assert.equal(
    openRecoveryIndexDocument({ keys: KEYS, document, storeVersion: Number.MAX_SAFE_INTEGER })
      .length,
    467,
  )
})

test('the writer refuses more than eight mints and a map above 64 KiB', () => {
  assert.throws(
    () =>
      sealRecoveryIndexDocument({
        keys: KEYS,
        entries: Array.from({ length: 9 }, (_, index) =>
          regular('a', `https://m${index}.example.com`),
        ),
        writtenVersion: 1,
      }),
    (error: unknown) => error instanceof RecoveryIndexCapacityError && error.reason === 'mints',
  )
  assert.throws(
    () =>
      sealRecoveryIndexDocument({
        keys: KEYS,
        entries: Array.from({ length: 700 }, (_, index) => conditional(`entry ${index}`)),
        writtenVersion: 1,
      }),
    (error: unknown) => error instanceof RecoveryIndexCapacityError && error.reason === 'size',
  )
})

test('the writer refuses an entry that is not canonical or that repeats a keyset', () => {
  const write = (entries: readonly RecoveryIndexEntry[]) =>
    sealRecoveryIndexDocument({ keys: KEYS, entries, writtenVersion: 1 })
  assert.throws(() => write([regular('a', `${MINT}/`)]), /mint URL/)
  assert.throws(() => write([{ ...regular('a'), keysetId: `00${'ab'.repeat(7)}` }]), /keyset/)
  assert.throws(() => write([{ ...regular('a'), keysetId: keysetId('a').toUpperCase() }]), /keyset/)
  assert.throws(() => write([regular('a'), regular('a')]), /repeats/)
  assert.throws(
    () => write([regular('a'), { ...conditional('x'), keysetId: keysetId('a') }]),
    /repeats/,
  )
  assert.throws(() => write([]), /entry/)
})

/** A deterministic generator of small entry sets over two mints and few keysets. */
function entrySets(count: number): RecoveryIndexEntry[][] {
  let state = 12345
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state
  }
  return Array.from({ length: count }, () => {
    const set = new Map<string, RecoveryIndexEntry>()
    const size = next() % 6
    for (let index = 0; index < size; index += 1) {
      const mintUrl = next() % 2 === 0 ? MINT : OTHER_MINT
      const label = String(next() % 8)
      // The form of a keyset follows its label, so two sets never conflict.
      const entry = Number(label) % 2 === 0 ? regular(label, mintUrl) : conditional(label, mintUrl)
      set.set(`${entry.mintUrl} ${entry.keysetId}`, entry)
    }
    return [...set.values()]
  })
}

function sameEntries(left: readonly RecoveryIndexEntry[], right: readonly RecoveryIndexEntry[]) {
  return isDeepStrictEqual(left, right)
}

test('the merge is the union of the entries, and it is idempotent, commutative, and associative', () => {
  const sets = entrySets(24)
  for (const a of sets) {
    const once = mergeRecoveryIndexEntries([], a).entries
    assert.ok(sameEntries(mergeRecoveryIndexEntries(once, once).entries, once), 'idempotent')
    for (const b of sets) {
      const ab = mergeRecoveryIndexEntries(a, b)
      assert.equal(ab.conflicts.length, 0)
      const keys = new Set([...a, ...b].map((entry) => `${entry.mintUrl} ${entry.keysetId}`))
      assert.equal(ab.entries.length, keys.size, 'union')
      assert.ok(
        [...a, ...b].every((entry) =>
          ab.entries.some((merged) => isDeepStrictEqual(merged, entry)),
        ),
      )
      assert.ok(sameEntries(ab.entries, mergeRecoveryIndexEntries(b, a).entries), 'commutative')
      for (const c of sets.slice(0, 6)) {
        const left = mergeRecoveryIndexEntries(ab.entries, c).entries
        const right = mergeRecoveryIndexEntries(a, mergeRecoveryIndexEntries(b, c).entries).entries
        assert.ok(sameEntries(left, right), 'associative')
      }
    }
  }
})

test('a merge conflict keeps the value that the mint keys verify, or the stored value', async () => {
  const stored = conditional('a')
  const added: RecoveryIndexEntry = { kind: 'regular', mintUrl: MINT, keysetId: stored.keysetId }
  const pure = mergeRecoveryIndexEntries([stored], [added, regular('b')])
  assert.equal(pure.conflicts.length, 1)
  assert.ok(isDeepStrictEqual(pure.conflicts[0], { stored, added }))

  const verifiedAdded = await mergeRecoveryIndex({
    stored: [stored],
    added: [added],
    verifyEntry: async (entry) => entry.kind === 'regular',
  })
  assert.ok(sameEntries(verifiedAdded, [added]))
  const verifiedStored = await mergeRecoveryIndex({
    stored: [stored],
    added: [added],
    verifyEntry: async (entry) => entry.kind === 'conditional',
  })
  assert.ok(sameEntries(verifiedStored, [stored]))
  const mintDown = await mergeRecoveryIndex({
    stored: [stored],
    added: [added],
    verifyEntry: async () => {
      throw new Error('mint unreachable')
    },
  })
  assert.ok(sameEntries(mintDown, [stored]))
  const neither = await mergeRecoveryIndex({
    stored: [stored, regular('c')],
    added: [added],
    verifyEntry: async () => false,
  })
  assert.ok(sameEntries(neither, [regular('c')]))
})

test('a pending keyset is a local keyset that the read document does not list', () => {
  const listed = [regular('a'), conditional('b')]
  const local = [regular('a'), conditional('b'), conditional('c'), regular('a', OTHER_MINT)]
  assert.ok(
    sameEntries(pendingRecoveryIndexEntries(local, listed), [
      conditional('c'),
      regular('a', OTHER_MINT),
    ]),
  )
  assert.equal(pendingRecoveryIndexEntries(listed, listed).length, 0)
})
