import { decode, encode, rfc8949EncodeOptions } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
} from './encryptedWalletBackupCasState.ts'

const PROOF_CBOR_MAX_BYTES = 245_760
const PROOF_COUNT_MAX = 512
const TOKEN_LIMIT = 16_384
const DEPTH_LIMIT = 6
const MANIFEST_CBOR_MAX_BYTES = 65_532
const PUBLIC_METADATA_MAX_BYTES = 65_536
const REQUEST_PROOF_MAX_BYTES = 4_096
const PUT_PAYLOAD_MAX_BYTES = 4 * 1_024 * 1_024
const ACCOUNT_REQUEST_MAX_BYTES = 20 * 1_024
const ATTEMPT_ABORT_MAX_BYTES = 128

export function encodeCanonicalBackupCbor(value: unknown): Uint8Array {
  return encode(value, rfc8949EncodeOptions)
}

export function measureCanonicalBackupCbor(value: unknown): number {
  if (value === null) return 1
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('canonical CBOR integer is invalid')
    return headerLength(value)
  }
  if (typeof value === 'string') {
    const length = new TextEncoder().encode(value).byteLength
    return headerLength(length) + length
  }
  if (value instanceof Uint8Array) return headerLength(value.byteLength) + value.byteLength
  if (Array.isArray(value)) {
    let length = headerLength(value.length)
    for (const item of value) length += measureCanonicalBackupCbor(item)
    return length
  }
  throw new Error('canonical CBOR value is invalid')
}

export function preflightEncryptedProofChunkCbor(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > PROOF_CBOR_MAX_BYTES) throw new Error('cbor input')
  const state = { offset: 0, tokens: 0 }
  const root = scanCbor(bytes, state, 0, {
    depth: DEPTH_LIMIT,
    tokens: TOKEN_LIMIT,
    itemLength: PROOF_CBOR_MAX_BYTES,
    arrayLength: PROOF_COUNT_MAX,
  })
  if (state.offset !== bytes.byteLength) throw new Error('trailing cbor')
  if (root.major !== 4 || root.value !== 3
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1
    || root.children[1]?.major !== 0 || root.children[1]?.value !== 1) throw new Error('root shape')
  const records = root.children[2]
  if (records?.major !== 4 || records.value === null || records.value < 1
    || records.value > PROOF_COUNT_MAX) throw new Error('record count')
  for (const record of records.children) {
    if (record.major !== 4 || record.value !== 14) throw new Error('record shape')
    requireBytes(record.children[0], 32, 32, 'proof id')
    requireBytes(record.children[1], 32, 32, 'commitment')
    requireText(record.children[2], 1, 2_048, 'mint')
    requireText(record.children[3], 1, 64, 'unit')
    const keyset = record.children[4]
    const dleq = record.children[8]
    const ctf = record.children[11]
    if (keyset?.major !== 4 || keyset.value !== 2) throw new Error('keyset shape')
    const keysetKind = keyset.children[0]
    if (keysetKind?.major !== 0 || keysetKind.value === null
      || keysetKind.value < 0 || keysetKind.value > 2) throw new Error('keyset kind')
    requireText(keyset.children[1], 1, 128, 'keyset text')
    requireText(record.children[5], 1, 20, 'amount')
    requireBytes(record.children[6], 64, 64, 'secret')
    requireBytes(record.children[7], keysetKind.value === 2 ? 33 : 33,
      keysetKind.value === 2 ? 48 : 33, 'signature')
    if (dleq === undefined || !((dleq.major === 7 && dleq.value === 22)
      || (dleq.major === 4 && dleq.value === 3))) throw new Error('dleq shape')
    if (dleq.major === 4) for (const item of dleq.children) requireBytes(item, 32, 32, 'dleq value')
    requireUnsigned(record.children[9], 'counter')
    const proofKind = record.children[10]
    if (proofKind?.major !== 0 || (proofKind.value !== 0 && proofKind.value !== 1)) {
      throw new Error('proof kind')
    }
    if (ctf === undefined || !((ctf.major === 7 && ctf.value === 22)
      || (ctf.major === 4 && ctf.value === 5))) throw new Error('ctf shape')
    if (ctf.major === 4) {
      requireBytes(ctf.children[0], 32, 32, 'condition id')
      requireText(ctf.children[1], 1, 256, 'outcome label')
      requireBytes(ctf.children[2], 32, 32, 'outcome collection id')
      requireUnsigned(ctf.children[3], 'registration')
      requireUnsigned(ctf.children[4], 'expiry')
    }
    requireUnsigned(record.children[12], 'created')
    requireUnsigned(record.children[13], 'updated')
  }
}

export function preflightEncryptedManifestPageCbor(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MANIFEST_CBOR_MAX_BYTES) throw new Error('cbor input')
  const state = { offset: 0, tokens: 0 }
  const root = scanCbor(bytes, state, 0, {
    depth: 6,
    tokens: TOKEN_LIMIT,
    itemLength: MANIFEST_CBOR_MAX_BYTES,
    arrayLength: PROOF_COUNT_MAX,
  })
  if (state.offset !== bytes.byteLength) throw new Error('trailing cbor')
  if (root.major !== 4 || root.value !== 7
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1
    || root.children[1]?.major !== 0 || root.children[1]?.value !== 2) throw new Error('root shape')
  requireUnsigned(root.children[2], 'generation')
  requireBytes(root.children[3], 16, 16, 'snapshot nonce')
  requireUnsigned(root.children[4], 'page index')
  requireUnsigned(root.children[5], 'page count')
  const entries = root.children[6]
  if (entries?.major !== 4 || entries.value === null || entries.value < 1
    || entries.value > PROOF_COUNT_MAX) {
    throw new Error('manifest entry count')
  }
  for (const entry of entries.children) {
    if (entry.major !== 4 || entry.value !== 11) throw new Error('manifest entry shape')
    requireBytes(entry.children[0], 32, 32, 'proof id')
    requireBytes(entry.children[1], 32, 32, 'commitment')
    requireBytes(entry.children[2], 16, 16, 'chunk object id')
    requireBytes(entry.children[3], 32, 32, 'chunk digest')
    requireText(entry.children[4], 1, 2_048, 'mint')
    requireText(entry.children[5], 1, 64, 'unit')
    requireText(entry.children[6], 1, 20, 'amount')
    const proofKind = entry.children[7]
    if (proofKind?.major !== 0 || (proofKind.value !== 0 && proofKind.value !== 1)) {
      throw new Error('proof kind')
    }
    const ctf = entry.children[8]
    if (ctf === undefined || !((ctf.major === 7 && ctf.value === 22)
      || (ctf.major === 4 && ctf.value === 5))) throw new Error('ctf shape')
    if (ctf.major === 4) {
      requireBytes(ctf.children[0], 32, 32, 'condition id')
      requireText(ctf.children[1], 1, 256, 'outcome label')
      requireBytes(ctf.children[2], 32, 32, 'outcome collection id')
      requireUnsigned(ctf.children[3], 'registration')
      requireUnsigned(ctf.children[4], 'expiry')
    }
    requireUnsigned(entry.children[9], 'created')
    requireUnsigned(entry.children[10], 'updated')
  }
}

export function preflightEncryptedBackupRequestProofCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, REQUEST_PROOF_MAX_BYTES, 2, 32, 14)
  if (root.major !== 4 || root.value !== 14
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('request proof shape')
  }
  requireText(root.children[1], 20, 20, 'request proof discriminator')
  requireText(root.children[2], 1, 64, 'request realm')
  requireBytes(root.children[3], 32, 32, 'request vault id')
  requireBytes(root.children[4], 32, 32, 'request public key')
  requireUnsigned(root.children[5], 'request epoch')
  requireText(root.children[6], 3, 6, 'request method')
  requireText(root.children[7], 1, 2_048, 'request URL')
  requireUnsigned(root.children[8], 'request issue time')
  requireUnsigned(root.children[9], 'request expiry time')
  requireBytes(root.children[10], 16, 16, 'request nonce')
  requireUnsigned(root.children[11], 'request payload length')
  requireBytes(root.children[12], 32, 32, 'request payload digest')
  requireBytes(root.children[13], 64, 64, 'request signature')
}

export function preflightEncryptedBackupHeadCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, PUBLIC_METADATA_MAX_BYTES, 5, 8_192, 1_024)
  if (root.major !== 4 || root.value !== 13
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('head shape')
  }
  requireText(root.children[1], 13, 13, 'head discriminator')
  requireText(root.children[2], 1, 64, 'head realm')
  requireBytes(root.children[3], 32, 32, 'head vault id')
  requireBytes(root.children[4], 32, 32, 'head public key')
  requireUnsigned(root.children[5], 'head generation')
  const parent = root.children[6]
  if (parent === undefined || !((parent.major === 7 && parent.value === 22)
    || (parent.major === 4 && parent.value === 2))) throw new Error('head parent shape')
  requireBytes(root.children[7], 16, 16, 'head snapshot nonce')
  requireObjectReferenceArray(root.children[8], 'head page references')
  requireObjectReferenceArray(root.children[9], 'head chunk references')
  requireUnsigned(root.children[10], 'head proof count')
  requireUnsigned(root.children[11], 'head stored bytes')
  requireBytes(root.children[12], 32, 32, 'head reference digest')
}

export function preflightEncryptedBackupReferenceSetCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, PUBLIC_METADATA_MAX_BYTES, 4, 8_192, 1_024)
  if (root.major !== 4 || root.value !== 4
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('reference set shape')
  }
  requireText(root.children[1], 13, 13, 'reference set discriminator')
  requireObjectReferenceArray(root.children[2], 'page references')
  requireObjectReferenceArray(root.children[3], 'chunk references')
}

export function preflightEncryptedBackupCasCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(
    bytes,
    ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES,
    3,
    32,
    6,
  )
  if (root.major !== 4 || root.value !== 6
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('CAS shape')
  }
  requireText(root.children[1], 8, 8, 'CAS discriminator')
  requireBytes(root.children[2], 16, 16, 'CAS upload attempt id')
  const expected = root.children[3]
  if (expected === undefined || !((expected.major === 7 && expected.value === 22)
    || (expected.major === 2 && expected.value === 32))) throw new Error('CAS parent shape')
  requireBytes(root.children[4], 1, PUBLIC_METADATA_MAX_BYTES, 'CAS head')
  requireBytes(root.children[5], 1, PUBLIC_METADATA_MAX_BYTES, 'CAS reference set')
}
export function preflightEncryptedBackupPutCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, PUT_PAYLOAD_MAX_BYTES, 2, 32, 12)
  if (root.major !== 4 || root.value !== 12
    || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('PUT shape')
  }
  requireText(root.children[1], 10, 10, 'PUT discriminator')
  requireBytes(root.children[2], 16, 16, 'PUT attempt id')
  requireUnsigned(root.children[3], 'PUT kind')
  requireText(root.children[4], 1, 64, 'PUT realm')
  requireBytes(root.children[5], 32, 32, 'PUT vault id')
  requireBytes(root.children[6], 16, 16, 'PUT object id')
  requireUnsigned(root.children[7], 'PUT generation')
  requireUnsigned(root.children[8], 'PUT padded length')
  requireBytes(root.children[9], 32, 32, 'PUT digest')
  requireBytes(root.children[10], 1, 4_096, 'PUT AAD')
  requireBytes(root.children[11], 65_564, 262_172, 'PUT body')
}

/** Allocation-bounded structural scan; the account builder owns semantic validation. */
export function structurallyPreflightEncryptedBackupAccountRequestCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, ACCOUNT_REQUEST_MAX_BYTES, 2, 16, 6)
  if (root.major !== 4 || root.value !== 6 || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('account request shape')
  }
  requireText(root.children[1], 22, 22, 'account request discriminator')
  requireBytes(root.children[2], 1, 4_096, 'account canonical intent')
  requireBytes(root.children[3], 32, 32, 'account intent digest')
  requireText(root.children[4], 1, 64, 'account authorization scheme')
  requireBytes(root.children[5], 1, 16 * 1_024, 'account authorization')
  const tuple = decode(bytes)
  if (!Array.isArray(tuple) || tuple[1] !== 'backup-account-request') {
    throw new Error('account request discriminator')
  }
}

/** Allocation-bounded structural scan; the abort builder owns semantic validation. */
export function structurallyPreflightEncryptedBackupAttemptAbortCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, ATTEMPT_ABORT_MAX_BYTES, 1, 8, 4)
  if (root.major !== 4 || root.value !== 4 || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('attempt abort shape')
  }
  requireText(root.children[1], 20, 20, 'attempt abort discriminator')
  requireBytes(root.children[2], 16, 16, 'attempt abort id')
  requireBytes(root.children[3], 32, 32, 'attempt abort target digest')
  const tuple = decode(bytes)
  if (!Array.isArray(tuple) || tuple[1] !== 'upload-attempt-abort') {
    throw new Error('attempt abort discriminator')
  }
}

export function preflightEncryptedBackupObjectAadCbor(bytes: Uint8Array): void {
  const root = scanBoundedEnvelope(bytes, 256, 1, 12, 7)
  if (root.major !== 4 || root.value !== 7 || root.children[0]?.major !== 0 || root.children[0]?.value !== 1) {
    throw new Error('object AAD shape')
  }
  requireUnsigned(root.children[1], 'object AAD kind')
  requireText(root.children[2], 1, 64, 'object AAD realm')
  requireBytes(root.children[3], 32, 32, 'object AAD vault id')
  requireBytes(root.children[4], 16, 16, 'object AAD object id')
  requireUnsigned(root.children[5], 'object AAD generation')
  requireUnsigned(root.children[6], 'object AAD padded length')
}

/**
 * Performs allocation-bounded structural scanning before a response is
 * materialized. All v1 response tuples are flat definite arrays.
 */
export function preflightEncryptedBackupHttpResponseCbor(bytes: Uint8Array, maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('response CBOR limit')
  }
  const root = scanBoundedEnvelope(bytes, maximumBytes, 1, 16, 13)
  if (root.major !== 4 || root.value === null || root.value < 4 || root.value > 13) {
    throw new Error('response tuple shape')
  }
  if (root.children.some((child) => child.major === 4)) {
    throw new Error('response tuple must be flat')
  }
}

function scanBoundedEnvelope(
  bytes: Uint8Array,
  maximumBytes: number,
  depth: number,
  tokens: number,
  arrayLength: number,
): CborShape {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error('CBOR envelope size')
  }
  const state = { offset: 0, tokens: 0 }
  const root = scanCbor(bytes, state, 0, {
    depth, tokens, itemLength: maximumBytes, arrayLength,
  })
  if (state.offset !== bytes.byteLength) throw new Error('trailing CBOR envelope')
  return root
}

function requireObjectReferenceArray(shape: CborShape | undefined, name: string): void {
  if (shape?.major !== 4 || shape.value === null || shape.value > 1_024) {
    throw new Error(`${name} shape`)
  }
  for (const reference of shape.children) {
    if (reference.major !== 4 || reference.value !== 2) throw new Error(`${name} shape`)
    requireBytes(reference.children[0], 16, 16, 'referenced object id')
    requireBytes(reference.children[1], 32, 32, 'referenced object digest')
  }
}

function requireBytes(shape: CborShape | undefined, min: number, max: number, name: string): void {
  if (shape?.major !== 2 || shape.value === null || shape.value < min || shape.value > max) {
    throw new Error(`${name} shape`)
  }
}

function requireText(shape: CborShape | undefined, min: number, max: number, name: string): void {
  if (shape?.major !== 3 || shape.value === null || shape.value < min || shape.value > max) {
    throw new Error(`${name} shape`)
  }
}

function requireUnsigned(shape: CborShape | undefined, name: string): void {
  if (shape?.major !== 0 || shape.value === null) throw new Error(`${name} shape`)
}

function headerLength(value: number): number {
  if (value < 24) return 1
  if (value <= 0xff) return 2
  if (value <= 0xffff) return 3
  if (value <= 0xffff_ffff) return 5
  return 9
}

interface CborShape {
  major: number
  value: number | null
  children: CborShape[]
}

function scanCbor(
  bytes: Uint8Array,
  state: { offset: number; tokens: number },
  depth: number,
  limits: { depth: number; tokens: number; itemLength: number; arrayLength: number },
): CborShape {
  if (depth > limits.depth || ++state.tokens > limits.tokens || state.offset >= bytes.length) {
    throw new Error('cbor bounds')
  }
  const first = bytes[state.offset++]!
  const major = first >>> 5
  const additional = first & 31
  if (major === 1 || major === 5 || major === 6 || additional === 31) throw new Error('cbor type')
  if (major === 7) {
    if (additional !== 22) throw new Error('cbor simple')
    return { major, value: additional, children: [] }
  }
  if (major !== 0 && major !== 2 && major !== 3 && major !== 4) throw new Error('cbor major')
  const value = readCborArgument(bytes, state, additional)
  if (major === 0) return { major, value, children: [] }
  if (value > limits.itemLength) throw new Error('cbor item length')
  if (major === 2 || major === 3) {
    if (state.offset + value > bytes.length) throw new Error('cbor truncation')
    if (major === 3) {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(state.offset, state.offset + value))
    }
    state.offset += value
    return { major, value, children: [] }
  }
  if (value > limits.arrayLength && depth > 1) throw new Error('cbor array length')
  const children: CborShape[] = []
  for (let index = 0; index < value; index += 1) {
    children.push(scanCbor(bytes, state, depth + 1, limits))
  }
  return { major, value, children }
}

function readCborArgument(
  bytes: Uint8Array,
  state: { offset: number },
  additional: number,
): number {
  if (additional < 24) return additional
  const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 }
  const width = widths[additional]
  if (width === undefined || state.offset + width > bytes.length) throw new Error('cbor argument')
  let value = 0n
  for (let index = 0; index < width; index += 1) value = (value << 8n) | BigInt(bytes[state.offset++]!)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor integer')
  const numeric = Number(value)
  if ((width === 1 && numeric < 24) || (width === 2 && numeric <= 0xff)
    || (width === 4 && numeric <= 0xffff) || (width === 8 && numeric <= 0xffff_ffff)) {
    throw new Error('noncanonical cbor integer')
  }
  return numeric
}
