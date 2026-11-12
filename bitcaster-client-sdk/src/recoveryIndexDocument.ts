import { deriveConditionalKeysetId, deriveKeysetId } from '@cashu/cashu-ts'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes as secureRandomBytes } from '@noble/ciphers/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { canonicalizeMintIdentityUrl } from './tokenImportValidation.ts'

/**
 * The encrypted recovery index of ADR-051: the keys, the document format, and
 * the merge. The index lists the keysets that one seed used, with no counter
 * value. This module does no I/O, and it does not depend on the store.
 */

export const RECOVERY_INDEX_KEY_DOMAIN = 'Cashu_Recovery_Index_v1'
export const RECOVERY_INDEX_MAGIC = 'CASHURI'
export const RECOVERY_INDEX_FORMAT_VERSION = 0x01
export const RECOVERY_INDEX_CIPHER_CHACHA20_POLY1305 = 0x01
export const RECOVERY_INDEX_CONTEXT_BYTES_MAX = 64
export const RECOVERY_INDEX_PLAINTEXT_BYTES_MIN = 4_096
export const RECOVERY_INDEX_PLAINTEXT_BYTES_MAX = 65_536
const HEADER_BYTES = 9
const NONCE_BYTES = 12
const TAG_BYTES = 16
const ENVELOPE_BYTES = HEADER_BYTES + NONCE_BYTES + TAG_BYTES
export const RECOVERY_INDEX_DOCUMENT_BYTES_MIN = RECOVERY_INDEX_PLAINTEXT_BYTES_MIN + ENVELOPE_BYTES
export const RECOVERY_INDEX_DOCUMENT_BYTES_MAX = RECOVERY_INDEX_PLAINTEXT_BYTES_MAX + ENVELOPE_BYTES
export const RECOVERY_INDEX_MINTS_MAX = 8
export const RECOVERY_INDEX_MINT_URL_BYTES_MAX = 2_048
const KEYSET_ID = /^01[0-9a-f]{64}$/
const HASH = /^[0-9a-f]{64}$/
const HEADER = concatBytes(
  utf8ToBytes(RECOVERY_INDEX_MAGIC),
  Uint8Array.of(RECOVERY_INDEX_FORMAT_VERSION, RECOVERY_INDEX_CIPHER_CHACHA20_POLY1305),
)
const MAP_KEYS = ['v', 'ver', 'mints', 'entries'] as const
/** The argument bytes of a CBOR head by its additional information value. */
const ARGUMENT_BYTES: Readonly<Partial<Record<number, number>>> = { 24: 1, 25: 2, 26: 4, 27: 8 }

export interface RecoveryIndexKeys {
  /** The ChaCha20-Poly1305 key of the document. */
  readonly encryptionKey: Uint8Array
  /** The BIP340 secret key that signs store requests. */
  readonly locatorSecretKey: Uint8Array
  /** The BIP340 x-only public key, 64 lowercase hexadecimal characters. It names the document. */
  readonly locatorPublicKey: string
}

export interface RecoveryIndexRegularEntry {
  readonly kind: 'regular'
  readonly mintUrl: string
  readonly keysetId: string
}

/** A NUT-CTF keyset. Its keyset id commits to the condition and the outcome collection. */
export interface RecoveryIndexConditionalEntry {
  readonly kind: 'conditional'
  readonly mintUrl: string
  readonly keysetId: string
  readonly conditionId: string
  readonly outcomeCollectionId: string
}

export type RecoveryIndexEntry = RecoveryIndexRegularEntry | RecoveryIndexConditionalEntry

/** The mint keys of one keyset, to verify an entry against its keyset id (NUT-01, NUT-02). */
export interface RecoveryIndexKeysetAuthority {
  readonly id: string
  readonly unit: string
  readonly keys: Readonly<Record<string, string>>
  readonly inputFeePpk: number
  readonly finalExpiry: number | null
}

export type RecoveryIndexFormatErrorReason =
  | 'size'
  | 'magic'
  | 'unsupported-version'
  | 'unsupported-cipher'
  | 'nonce'
  | 'authentication'
  | 'encoding'
  | 'padding'
  | 'content'
  | 'stored-version'

/** The reader refused a document. A client that cannot decode the document never overwrites it. */
export class RecoveryIndexFormatError extends Error {
  readonly reason: RecoveryIndexFormatErrorReason

  constructor(reason: RecoveryIndexFormatErrorReason) {
    super(`recovery index document is invalid (${reason})`)
    this.name = 'RecoveryIndexFormatError'
    this.reason = reason
  }
}

/** The entries need more than 8 mints or more than the 64 KiB step. The client does not write them. */
export class RecoveryIndexCapacityError extends Error {
  readonly reason: 'mints' | 'size'

  constructor(reason: 'mints' | 'size') {
    super(`recovery index is over its cap (${reason})`)
    this.name = 'RecoveryIndexCapacityError'
    this.reason = reason
  }
}

/** A document is 2^k + 37 bytes, with k from 12 to 16. */
export function isRecoveryIndexDocumentSize(bytes: number): boolean {
  for (
    let size = RECOVERY_INDEX_PLAINTEXT_BYTES_MIN;
    size <= RECOVERY_INDEX_PLAINTEXT_BYTES_MAX;
    size *= 2
  ) {
    if (bytes === size + ENVELOPE_BYTES) return true
  }
  return false
}

/** The UTF-8 bytes of a context (the realm): 1 to 64 bytes of well-formed text. */
export function requireRecoveryIndexContext(context: string): Uint8Array {
  if (typeof context !== 'string') throw new Error('recovery index context is invalid')
  const bytes = utf8ToBytes(context)
  if (
    bytes.length < 1 ||
    bytes.length > RECOVERY_INDEX_CONTEXT_BYTES_MAX ||
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== context
  ) {
    throw new Error('recovery index context is invalid')
  }
  return bytes
}

/**
 * The ADR-051 keys, in the NUT-13 version `01` construction:
 * `message(type) = domain || len(context) || context || type`, the encryption
 * key `HMAC_SHA256(seed, message(0x00))`, and the locator scalar
 * `HMAC_SHA256(seed, message(0x01)) mod N`.
 */
export function deriveRecoveryIndexKeys(seed: Uint8Array, context: string): RecoveryIndexKeys {
  if (!(seed instanceof Uint8Array) || seed.length !== 64) {
    throw new Error('recovery index seed must be the 64-byte BIP-39 seed')
  }
  const contextBytes = requireRecoveryIndexContext(context)
  const message = (type: number) =>
    concatBytes(
      utf8ToBytes(RECOVERY_INDEX_KEY_DOMAIN),
      Uint8Array.of(contextBytes.length),
      contextBytes,
      Uint8Array.of(type),
    )
  const scalar = bytesToNumberBE(hmac(sha256, seed, message(0x01))) % secp256k1.Point.Fn.ORDER
  if (scalar === 0n) throw new Error('recovery index locator scalar is zero')
  const locatorSecretKey = numberToBytesBE(scalar, 32)
  return Object.freeze({
    encryptionKey: hmac(sha256, seed, message(0x00)),
    locatorSecretKey,
    locatorPublicKey: bytesToHex(schnorr.getPublicKey(locatorSecretKey)),
  })
}

export function recoveryIndexEntryKey(entry: RecoveryIndexEntry): string {
  return `${entry.mintUrl} ${entry.keysetId}`
}

/** Encrypt the entries as the document of store version `writtenVersion`. */
export function sealRecoveryIndexDocument(input: {
  readonly keys: RecoveryIndexKeys
  readonly entries: readonly RecoveryIndexEntry[]
  readonly writtenVersion: number
  /** The nonce source. The default is the platform CSPRNG. */
  readonly randomBytes?: (length: number) => Uint8Array
}): Uint8Array {
  const plaintext = encodePlaintext(input.entries, requireVersion(input.writtenVersion))
  const nonce = (input.randomBytes ?? secureRandomBytes)(NONCE_BYTES)
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES || isZero(nonce)) {
    throw new Error('recovery index nonce is invalid')
  }
  const sealed = chacha20poly1305(input.keys.encryptionKey, nonce, HEADER).encrypt(plaintext)
  return concatBytes(HEADER, nonce, sealed)
}

/**
 * Decrypt and read one document strictly. `storeVersion` is the version that
 * the store reported; a document written for another version is refused.
 */
export function openRecoveryIndexDocument(input: {
  readonly keys: RecoveryIndexKeys
  readonly document: Uint8Array
  readonly storeVersion: number
}): readonly RecoveryIndexEntry[] {
  const document = input.document
  if (!(document instanceof Uint8Array) || document.length < HEADER_BYTES) {
    throw new RecoveryIndexFormatError('size')
  }
  if (!equalBytes(document.subarray(0, 7), HEADER.subarray(0, 7))) {
    throw new RecoveryIndexFormatError('magic')
  }
  // The version comes before the size, so a later format with other sizes asks for an update.
  if (document[7] !== RECOVERY_INDEX_FORMAT_VERSION) {
    throw new RecoveryIndexFormatError('unsupported-version')
  }
  if (document[8] !== RECOVERY_INDEX_CIPHER_CHACHA20_POLY1305) {
    throw new RecoveryIndexFormatError('unsupported-cipher')
  }
  if (!isRecoveryIndexDocumentSize(document.length)) throw new RecoveryIndexFormatError('size')
  const nonce = document.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES)
  if (isZero(nonce)) throw new RecoveryIndexFormatError('nonce')
  let plaintext: Uint8Array
  try {
    plaintext = chacha20poly1305(input.keys.encryptionKey, nonce, HEADER).decrypt(
      document.subarray(HEADER_BYTES + NONCE_BYTES),
    )
  } catch {
    throw new RecoveryIndexFormatError('authentication')
  }
  const decoded = decodePlaintext(plaintext)
  if (decoded.writtenVersion !== input.storeVersion) {
    throw new RecoveryIndexFormatError('stored-version')
  }
  return decoded.entries
}

export interface RecoveryIndexEntryConflict {
  readonly stored: RecoveryIndexEntry
  readonly added: RecoveryIndexEntry
}

/**
 * The union of two entry lists by `(mint URL, keyset id)`, in canonical
 * order. Two entries for one keyset with another form or identity conflict:
 * the result keeps the stored entry and reports the conflict.
 */
export function mergeRecoveryIndexEntries(
  stored: readonly RecoveryIndexEntry[],
  added: readonly RecoveryIndexEntry[],
): {
  readonly entries: readonly RecoveryIndexEntry[]
  readonly conflicts: readonly RecoveryIndexEntryConflict[]
} {
  const merged = new Map<string, RecoveryIndexEntry>()
  const conflicts: RecoveryIndexEntryConflict[] = []
  for (const value of [...stored, ...added]) {
    const entry = requireEntry(value)
    const key = recoveryIndexEntryKey(entry)
    const existing = merged.get(key)
    if (existing === undefined) merged.set(key, entry)
    else if (!sameEntry(existing, entry)) conflicts.push({ stored: existing, added: entry })
  }
  return { entries: sortEntries([...merged.values()]), conflicts }
}

/**
 * The ADR-051 merge with conflict resolution. For a conflict, the result keeps
 * the value that `verifyEntry` accepts with the mint keys. When the check
 * fails (for example the mint does not answer), it keeps the stored value.
 */
export async function mergeRecoveryIndex(input: {
  readonly stored: readonly RecoveryIndexEntry[]
  readonly added: readonly RecoveryIndexEntry[]
  readonly verifyEntry: (entry: RecoveryIndexEntry) => Promise<boolean>
}): Promise<readonly RecoveryIndexEntry[]> {
  const { entries, conflicts } = mergeRecoveryIndexEntries(input.stored, input.added)
  if (conflicts.length === 0) return entries
  const merged = new Map(entries.map((entry) => [recoveryIndexEntryKey(entry), entry]))
  for (const conflict of conflicts) {
    let storedValid: boolean
    let addedValid: boolean
    try {
      storedValid = (await input.verifyEntry(conflict.stored)) === true
      addedValid = (await input.verifyEntry(conflict.added)) === true
    } catch {
      continue
    }
    const key = recoveryIndexEntryKey(conflict.stored)
    if (storedValid) continue
    if (addedValid) merged.set(key, conflict.added)
    else merged.delete(key)
  }
  return sortEntries([...merged.values()])
}

/** The local keysets that the read document does not list (ADR-051 "Upload"). */
export function pendingRecoveryIndexEntries(
  local: readonly RecoveryIndexEntry[],
  listed: readonly RecoveryIndexEntry[],
): readonly RecoveryIndexEntry[] {
  const listedKeys = new Set(listed.map((entry) => recoveryIndexEntryKey(requireEntry(entry))))
  return sortEntries(
    local.map(requireEntry).filter((entry) => !listedKeys.has(recoveryIndexEntryKey(entry))),
  )
}

/** Whether the mint keys of a keyset derive the keyset id of the entry, with its identity. */
export function recoveryIndexEntryMatchesKeyset(
  entry: RecoveryIndexEntry,
  keyset: RecoveryIndexKeysetAuthority,
): boolean {
  const checked = requireEntry(entry)
  if (keyset.id !== checked.keysetId) return false
  const fee = keyset.inputFeePpk === 0 ? {} : { input_fee_ppk: keyset.inputFeePpk }
  try {
    switch (checked.kind) {
      case 'regular':
        return (
          deriveKeysetId(
            { ...keyset.keys },
            {
              unit: keyset.unit,
              versionByte: 1,
              ...fee,
              ...(keyset.finalExpiry === null ? {} : { expiry: keyset.finalExpiry }),
            },
          ) === checked.keysetId
        )
      case 'conditional':
        return (
          deriveConditionalKeysetId({
            keys: { ...keyset.keys },
            unit: keyset.unit,
            ...fee,
            ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
            conditionId: checked.conditionId,
            outcomeCollectionId: checked.outcomeCollectionId,
          }) === checked.keysetId
        )
      default:
        return assertNever(checked)
    }
  } catch {
    return false
  }
}

function encodePlaintext(
  values: readonly RecoveryIndexEntry[],
  writtenVersion: number,
): Uint8Array {
  const entries = sortEntries(values.map(requireEntry))
  if (entries.length === 0) throw new Error('recovery index needs an entry')
  for (let index = 1; index < entries.length; index += 1) {
    if (recoveryIndexEntryKey(entries[index - 1]!) === recoveryIndexEntryKey(entries[index]!)) {
      throw new Error('recovery index entry repeats a keyset')
    }
  }
  const mints = [...new Set(entries.map(({ mintUrl }) => mintUrl))]
  if (mints.length > RECOVERY_INDEX_MINTS_MAX) throw new RecoveryIndexCapacityError('mints')
  const encoded = concatBytes(
    head(5, MAP_KEYS.length),
    text('v'),
    head(0, 1),
    text('ver'),
    head(0, writtenVersion),
    text('mints'),
    head(4, mints.length),
    ...mints.map(text),
    text('entries'),
    head(4, entries.length),
    ...entries.map((entry) => encodeEntry(entry, mints.indexOf(entry.mintUrl))),
  )
  if (encoded.length > RECOVERY_INDEX_PLAINTEXT_BYTES_MAX)
    throw new RecoveryIndexCapacityError('size')
  const plaintext = new Uint8Array(paddedSize(encoded.length))
  plaintext.set(encoded)
  return plaintext
}

function encodeEntry(entry: RecoveryIndexEntry, mintIndex: number): Uint8Array {
  switch (entry.kind) {
    case 'regular':
      return concatBytes(head(4, 2), head(0, mintIndex), bytes(hexToBytes(entry.keysetId)))
    case 'conditional':
      return concatBytes(
        head(4, 4),
        head(0, mintIndex),
        bytes(hexToBytes(entry.keysetId)),
        bytes(hexToBytes(entry.conditionId)),
        bytes(hexToBytes(entry.outcomeCollectionId)),
      )
    default:
      return assertNever(entry)
  }
}

/** The smallest power of two of at least 4 KiB that holds the map. */
function paddedSize(length: number): number {
  let size = RECOVERY_INDEX_PLAINTEXT_BYTES_MIN
  while (size < length) size *= 2
  return size
}

/** Deterministic CBOR head (RFC 8949, section 4.2.1): the shortest argument. */
function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value)
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value)
  if (value < 0x10000) return Uint8Array.of((major << 5) | 25, value >>> 8, value & 0xff)
  const view = (size: number) => new DataView(new ArrayBuffer(size))
  if (value < 0x1_0000_0000) {
    const argument = view(4)
    argument.setUint32(0, value)
    return concatBytes(Uint8Array.of((major << 5) | 26), new Uint8Array(argument.buffer))
  }
  const argument = view(8)
  argument.setBigUint64(0, BigInt(value))
  return concatBytes(Uint8Array.of((major << 5) | 27), new Uint8Array(argument.buffer))
}

function text(value: string): Uint8Array {
  const encoded = utf8ToBytes(value)
  return concatBytes(head(3, encoded.length), encoded)
}

function bytes(value: Uint8Array): Uint8Array {
  return concatBytes(head(2, value.length), value)
}

function decodePlaintext(plaintext: Uint8Array): {
  readonly writtenVersion: number
  readonly entries: readonly RecoveryIndexEntry[]
} {
  const reader = new StrictCborReader(plaintext)
  const fields = readTopLevelMap(reader)
  const end = reader.offset
  if (
    !plaintext.subarray(end).every((byte) => byte === 0) ||
    plaintext.length !== paddedSize(end)
  ) {
    throw new RecoveryIndexFormatError('padding')
  }
  return fields
}

function readTopLevelMap(reader: StrictCborReader): {
  readonly writtenVersion: number
  readonly entries: readonly RecoveryIndexEntry[]
} {
  const count = reader.expect(5)
  if (count !== MAP_KEYS.length) throw content()
  let previousKey: Uint8Array | null = null
  let writtenVersion: number | null = null
  let mints: readonly string[] | null = null
  let entries: readonly RecoveryIndexEntry[] | null = null
  let formatVersion: number | null = null
  for (let index = 0; index < count; index += 1) {
    const keyStart = reader.offset
    const key = reader.text()
    const encodedKey = reader.bytesFrom(keyStart)
    // Deterministic CBOR orders map keys bytewise by their encodings, with no duplicate.
    if (previousKey !== null && compareBytes(previousKey, encodedKey) >= 0) {
      throw new RecoveryIndexFormatError('encoding')
    }
    previousKey = encodedKey
    switch (key) {
      case 'v':
        formatVersion = reader.expect(0)
        break
      case 'ver':
        writtenVersion = reader.expect(0)
        break
      case 'mints':
        mints = readMints(reader)
        break
      case 'entries':
        if (mints === null) throw content()
        entries = readEntries(reader, mints)
        break
      default:
        throw content()
    }
  }
  if (
    formatVersion !== 1 ||
    writtenVersion === null ||
    writtenVersion < 1 ||
    mints === null ||
    entries === null
  ) {
    throw content()
  }
  return { writtenVersion, entries }
}

function readMints(reader: StrictCborReader): readonly string[] {
  const count = reader.expect(4)
  if (count < 1 || count > RECOVERY_INDEX_MINTS_MAX) throw content()
  const mints: string[] = []
  for (let index = 0; index < count; index += 1) {
    const mint = reader.text()
    if (!isCanonicalMintUrl(mint) || (index > 0 && !(mints[index - 1]! < mint))) throw content()
    mints.push(mint)
  }
  return mints
}

function readEntries(
  reader: StrictCborReader,
  mints: readonly string[],
): readonly RecoveryIndexEntry[] {
  const count = reader.expect(4)
  if (count < 1) throw content()
  const entries: RecoveryIndexEntry[] = []
  const used = new Set<number>()
  let previous: { readonly mintIndex: number; readonly keysetId: string } | null = null
  for (let index = 0; index < count; index += 1) {
    const length = reader.expect(4)
    if (length !== 2 && length !== 4) throw content()
    const mintIndex = reader.expect(0)
    const mintUrl = mints[mintIndex]
    const keysetId = bytesToHex(reader.byteString())
    if (mintUrl === undefined || !KEYSET_ID.test(keysetId)) throw content()
    if (
      previous !== null &&
      (mintIndex < previous.mintIndex ||
        (mintIndex === previous.mintIndex && !(previous.keysetId < keysetId)))
    ) {
      throw content()
    }
    previous = { mintIndex, keysetId }
    used.add(mintIndex)
    if (length === 2) {
      entries.push(Object.freeze({ kind: 'regular', mintUrl, keysetId }))
      continue
    }
    const conditionId = bytesToHex(reader.byteString())
    const outcomeCollectionId = bytesToHex(reader.byteString())
    if (!HASH.test(conditionId) || !HASH.test(outcomeCollectionId)) throw content()
    entries.push(
      Object.freeze({ kind: 'conditional', mintUrl, keysetId, conditionId, outcomeCollectionId }),
    )
  }
  // Each mint names at least one entry, so the entries fix the mint list.
  if (used.size !== mints.length) throw content()
  return Object.freeze(entries)
}

/** A reader of the CBOR subset of the index: unsigned integers, strings, arrays, and maps. */
class StrictCborReader {
  offset = 0
  private readonly input: Uint8Array

  constructor(input: Uint8Array) {
    this.input = input
  }

  /** Read a head of one major type and return its argument. */
  expect(major: number): number {
    const item = this.head()
    if (item.major !== major) throw content()
    return item.value
  }

  text(): string {
    const length = this.expect(3)
    try {
      // Keep a leading byte order mark, so that one text has one encoding.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.take(length))
    } catch (error) {
      if (error instanceof RecoveryIndexFormatError) throw error
      throw new RecoveryIndexFormatError('encoding')
    }
  }

  byteString(): Uint8Array {
    return this.take(this.expect(2))
  }

  bytesFrom(start: number): Uint8Array {
    return this.input.slice(start, this.offset)
  }

  private head(): { readonly major: number; readonly value: number } {
    const first = this.take(1)[0]!
    const major = first >>> 5
    const additional = first & 0x1f
    if (additional < 24) return { major, value: additional }
    const size = ARGUMENT_BYTES[additional]
    // 28 to 30 are reserved, and 31 is an indefinite length.
    if (size === undefined) throw new RecoveryIndexFormatError('encoding')
    const argument = this.take(size)
    let value = 0n
    for (const byte of argument) value = (value << 8n) | BigInt(byte)
    const minimum = size === 1 ? 24n : 1n << BigInt(4 * size)
    if (value < minimum) throw new RecoveryIndexFormatError('encoding')
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw content()
    return { major, value: Number(value) }
  }

  private take(length: number): Uint8Array {
    if (length > this.input.length - this.offset) throw new RecoveryIndexFormatError('encoding')
    const taken = this.input.subarray(this.offset, this.offset + length)
    this.offset += length
    return taken
  }
}

function requireEntry(value: RecoveryIndexEntry): RecoveryIndexEntry {
  if (typeof value !== 'object' || value === null)
    throw new Error('recovery index entry is invalid')
  if (!isCanonicalMintUrl(value.mintUrl))
    throw new Error('recovery index mint URL is not canonical')
  if (typeof value.keysetId !== 'string' || !KEYSET_ID.test(value.keysetId)) {
    throw new Error('recovery index keyset id must be a NUT-02 version 01 id')
  }
  switch (value.kind) {
    case 'regular':
      return Object.freeze({ kind: 'regular', mintUrl: value.mintUrl, keysetId: value.keysetId })
    case 'conditional':
      if (
        typeof value.conditionId !== 'string' ||
        !HASH.test(value.conditionId) ||
        typeof value.outcomeCollectionId !== 'string' ||
        !HASH.test(value.outcomeCollectionId)
      ) {
        throw new Error('recovery index condition identity is invalid')
      }
      return Object.freeze({
        kind: 'conditional',
        mintUrl: value.mintUrl,
        keysetId: value.keysetId,
        conditionId: value.conditionId,
        outcomeCollectionId: value.outcomeCollectionId,
      })
    default:
      return assertNever(value)
  }
}

/** ADR-051 canonical mint URL: origin and path, no trailing slash, query, fragment, or escape. */
function isCanonicalMintUrl(value: unknown): value is string {
  if (typeof value !== 'string' || utf8ToBytes(value).length > RECOVERY_INDEX_MINT_URL_BYTES_MAX) {
    return false
  }
  try {
    return canonicalizeMintIdentityUrl(value) === value
  } catch {
    return false
  }
}

function sameEntry(left: RecoveryIndexEntry, right: RecoveryIndexEntry): boolean {
  switch (left.kind) {
    case 'regular':
      return right.kind === 'regular'
    case 'conditional':
      return (
        right.kind === 'conditional' &&
        left.conditionId === right.conditionId &&
        left.outcomeCollectionId === right.outcomeCollectionId
      )
    default:
      return assertNever(left)
  }
}

/** Canonical order: the mint URL bytewise (canonical URLs are ASCII), then the keyset id bytes. */
function sortEntries(entries: RecoveryIndexEntry[]): readonly RecoveryIndexEntry[] {
  return Object.freeze(
    entries.sort((left, right) =>
      left.mintUrl !== right.mintUrl
        ? left.mintUrl < right.mintUrl
          ? -1
          : 1
        : left.keysetId < right.keysetId
          ? -1
          : left.keysetId > right.keysetId
            ? 1
            : 0,
    ),
  )
}

function requireVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('recovery index version is invalid')
  return value
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return left.length - right.length
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && compareBytes(left, right) === 0
}

function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0)
}

function content(): RecoveryIndexFormatError {
  return new RecoveryIndexFormatError('content')
}

function assertNever(value: never): never {
  throw new Error(`unhandled recovery index entry: ${JSON.stringify(value)}`)
}
