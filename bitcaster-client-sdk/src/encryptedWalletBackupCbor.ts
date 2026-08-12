import { decode, encode, rfc8949EncodeOptions } from 'cborg'

export const ENCRYPTED_WALLET_BACKUP_ACCOUNT_REQUEST_MAX_BYTES = 20 * 1_024

export function encodeCanonicalBackupCbor(value: unknown): Uint8Array {
  return encode(value, rfc8949EncodeOptions)
}

export function measureCanonicalBackupCbor(value: unknown): number {
  if (value === null) return 1
  if (typeof value === 'number') return headerLength(requireUnsigned(value))
  if (typeof value === 'string') {
    const length = new TextEncoder().encode(value).byteLength
    return headerLength(length) + length
  }
  if (value instanceof Uint8Array) return headerLength(value.byteLength) + value.byteLength
  if (Array.isArray(value)) {
    return value.reduce(
      (size, item) => size + measureCanonicalBackupCbor(item),
      headerLength(value.length),
    )
  }
  throw new Error('canonical CBOR value is invalid')
}

export function measureCanonicalBackupCborArrayHeader(itemCount: number): number {
  return headerLength(requireUnsigned(itemCount))
}

export function measureCanonicalBackupCborByteString(byteLength: number): number {
  const length = requireUnsigned(byteLength)
  return headerLength(length) + length
}

export function preflightEncryptedBackupRequestProofCbor(bytes: Uint8Array): void {
  const tuple = scanTuple(bytes, 4_096, 2, 32, 14)
  requireUnsignedField(tuple, 0, 1, 'request proof version')
  requireTextField(tuple, 1, 20, 20, 'request proof discriminator')
  requireTextField(tuple, 2, 1, 64, 'request realm')
  requireBytesField(tuple, 3, 32, 32, 'request wallet id')
  requireBytesField(tuple, 4, 32, 32, 'request public key')
  requireUnsignedField(tuple, 5, undefined, 'request epoch')
  requireTextField(tuple, 6, 3, 6, 'request method')
  requireTextField(tuple, 7, 1, 2_048, 'request URL')
  requireUnsignedField(tuple, 8, undefined, 'request issue time')
  requireUnsignedField(tuple, 9, undefined, 'request expiry time')
  requireBytesField(tuple, 10, 16, 16, 'request nonce')
  requireUnsignedField(tuple, 11, undefined, 'request payload length')
  requireBytesField(tuple, 12, 32, 32, 'request payload digest')
  requireBytesField(tuple, 13, 64, 64, 'request signature')
}

/** Allocation-bounded structural scan. Account decoders own semantic validation. */
export function structurallyPreflightEncryptedBackupAccountRequestCbor(bytes: Uint8Array): void {
  const tuple = scanTuple(bytes, ENCRYPTED_WALLET_BACKUP_ACCOUNT_REQUEST_MAX_BYTES, 2, 16, 6)
  requireUnsignedField(tuple, 0, 1, 'account request version')
  requireTextField(tuple, 1, 22, 22, 'account request discriminator')
  requireBytesField(tuple, 2, 1, 4_096, 'account canonical intent')
  requireBytesField(tuple, 3, 32, 32, 'account intent digest')
  requireTextField(tuple, 4, 1, 64, 'account authorization scheme')
  requireBytesField(tuple, 5, 1, 16 * 1_024, 'account authorization')
  const decoded = decode(bytes)
  if (!Array.isArray(decoded) || decoded[1] !== 'backup-account-request')
    throw new Error('account request shape')
}

export function preflightEncryptedBackupAccountIntentCbor(bytes: Uint8Array): void {
  const tuple = scanTuple(bytes, 4_096, 1, 16, 10)
  requireUnsignedField(tuple, 0, 1, 'account intent version')
  requireTextField(tuple, 1, 24, 24, 'account intent discriminator')
  requireTextField(tuple, 2, 6, 6, 'account action')
  requireTextField(tuple, 3, 4, 6, 'account method')
  requireTextField(tuple, 4, 1, 2_048, 'account URL')
  requireTextField(tuple, 5, 1, 64, 'account realm')
  requireBytesField(tuple, 6, 32, 32, 'account wallet id')
  requireBytesField(tuple, 7, 32, 32, 'account public key')
  requireUnsignedField(tuple, 8, undefined, 'account epoch')
  requireBytesField(tuple, 9, 16, 16, 'account operation id')
}

interface CborShape {
  readonly major: number
  readonly value: number | null
  readonly children: readonly CborShape[]
}

function scanTuple(
  bytes: Uint8Array,
  maximumBytes: number,
  depth: number,
  tokens: number,
  arity: number,
): CborShape {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximumBytes)
    throw new Error('CBOR envelope size')
  const state = { offset: 0, tokens: 0 }
  const root = scan(bytes, state, 0, { depth, tokens, maximumBytes })
  if (state.offset !== bytes.byteLength || root.major !== 4 || root.value !== arity)
    throw new Error('CBOR tuple shape')
  return root
}

function scan(
  bytes: Uint8Array,
  state: { offset: number; tokens: number },
  depth: number,
  limits: { depth: number; tokens: number; maximumBytes: number },
): CborShape {
  if (depth > limits.depth || ++state.tokens > limits.tokens || state.offset >= bytes.length)
    throw new Error('CBOR bounds')
  const first = bytes[state.offset++]!
  const major = first >>> 5
  const additional = first & 31
  if (major === 1 || major === 5 || major === 6 || additional === 31) throw new Error('CBOR type')
  if (major === 7) {
    if (additional !== 22) throw new Error('CBOR simple')
    return { major, value: additional, children: [] }
  }
  if (major !== 0 && major !== 2 && major !== 3 && major !== 4) throw new Error('CBOR major')
  const value = readArgument(bytes, state, additional)
  if (major === 0) return { major, value, children: [] }
  if (value > limits.maximumBytes) throw new Error('CBOR item length')
  if (major === 2 || major === 3) {
    if (state.offset + value > bytes.length) throw new Error('CBOR truncation')
    if (major === 3)
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(state.offset, state.offset + value),
      )
    state.offset += value
    return { major, value, children: [] }
  }
  const children: CborShape[] = []
  for (let index = 0; index < value; index += 1)
    children.push(scan(bytes, state, depth + 1, limits))
  return { major, value, children }
}

function readArgument(bytes: Uint8Array, state: { offset: number }, additional: number): number {
  if (additional < 24) return additional
  const width = ({ 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>)[additional]
  if (width === undefined || state.offset + width > bytes.length) throw new Error('CBOR argument')
  let value = 0n
  for (let index = 0; index < width; index += 1)
    value = (value << 8n) | BigInt(bytes[state.offset++]!)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer')
  const numeric = Number(value)
  if (
    (width === 1 && numeric < 24) ||
    (width === 2 && numeric <= 0xff) ||
    (width === 4 && numeric <= 0xffff) ||
    (width === 8 && numeric <= 0xffff_ffff)
  )
    throw new Error('noncanonical CBOR integer')
  return numeric
}

function requireUnsignedField(
  tuple: CborShape,
  index: number,
  exact: number | undefined,
  name: string,
): void {
  const field = tuple.children[index]
  if (field?.major !== 0 || field.value === null || (exact !== undefined && field.value !== exact))
    throw new Error(`${name} shape`)
}

function requireTextField(
  tuple: CborShape,
  index: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  const field = tuple.children[index]
  if (field?.major !== 3 || field.value === null || field.value < minimum || field.value > maximum)
    throw new Error(`${name} shape`)
}

function requireBytesField(
  tuple: CborShape,
  index: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  const field = tuple.children[index]
  if (field?.major !== 2 || field.value === null || field.value < minimum || field.value > maximum)
    throw new Error(`${name} shape`)
}

function requireUnsigned(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('canonical CBOR integer is invalid')
  return value
}

function headerLength(value: number): number {
  if (value < 24) return 1
  if (value <= 0xff) return 2
  if (value <= 0xffff) return 3
  if (value <= 0xffff_ffff) return 5
  return 9
}
