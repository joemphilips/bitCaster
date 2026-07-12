import { encode, rfc8949EncodeOptions } from 'cborg'

const PROOF_CBOR_MAX_BYTES = 245_760
const PROOF_COUNT_MAX = 512
const TOKEN_LIMIT = 16_384
const DEPTH_LIMIT = 6

export function encodeCanonicalBackupCbor(value: unknown): Uint8Array {
  return encode(value, rfc8949EncodeOptions)
}

export function measureCanonicalBackupCbor(value: unknown): number {
  if (value === null) return 1
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('canonical CBOR integer is invalid')
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
  const root = scanCbor(bytes, state, 0)
  if (state.offset !== bytes.byteLength) throw new Error('trailing cbor')
  if (
    root.major !== 4 ||
    root.value !== 3 ||
    root.children[0]?.major !== 0 ||
    root.children[0]?.value !== 1 ||
    root.children[1]?.major !== 0 ||
    root.children[1]?.value !== 1
  )
    throw new Error('root shape')
  const records = root.children[2]
  if (
    records?.major !== 4 ||
    records.value === null ||
    records.value < 1 ||
    records.value > PROOF_COUNT_MAX
  )
    throw new Error('record count')
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
    if (
      keysetKind?.major !== 0 ||
      keysetKind.value === null ||
      keysetKind.value < 0 ||
      keysetKind.value > 2
    )
      throw new Error('keyset kind')
    requireText(keyset.children[1], 1, 128, 'keyset text')
    requireText(record.children[5], 1, 20, 'amount')
    requireBytes(record.children[6], 64, 64, 'secret')
    requireBytes(
      record.children[7],
      keysetKind.value === 2 ? 33 : 33,
      keysetKind.value === 2 ? 48 : 33,
      'signature',
    )
    if (
      dleq === undefined ||
      !((dleq.major === 7 && dleq.value === 22) || (dleq.major === 4 && dleq.value === 3))
    )
      throw new Error('dleq shape')
    if (dleq.major === 4) for (const item of dleq.children) requireBytes(item, 32, 32, 'dleq value')
    requireUnsigned(record.children[9], 'counter')
    const proofKind = record.children[10]
    if (proofKind?.major !== 0 || (proofKind.value !== 0 && proofKind.value !== 1)) {
      throw new Error('proof kind')
    }
    if (
      ctf === undefined ||
      !((ctf.major === 7 && ctf.value === 22) || (ctf.major === 4 && ctf.value === 5))
    )
      throw new Error('ctf shape')
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
): CborShape {
  if (depth > DEPTH_LIMIT || ++state.tokens > TOKEN_LIMIT || state.offset >= bytes.length) {
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
  if (value > PROOF_CBOR_MAX_BYTES) throw new Error('cbor item length')
  if (major === 2 || major === 3) {
    if (state.offset + value > bytes.length) throw new Error('cbor truncation')
    if (major === 3) {
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(state.offset, state.offset + value),
      )
    }
    state.offset += value
    return { major, value, children: [] }
  }
  if (value > PROOF_COUNT_MAX && depth > 1) throw new Error('cbor array length')
  const children: CborShape[] = []
  for (let index = 0; index < value; index += 1) children.push(scanCbor(bytes, state, depth + 1))
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
  for (let index = 0; index < width; index += 1)
    value = (value << 8n) | BigInt(bytes[state.offset++]!)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor integer')
  const numeric = Number(value)
  if (
    (width === 1 && numeric < 24) ||
    (width === 2 && numeric <= 0xff) ||
    (width === 4 && numeric <= 0xffff) ||
    (width === 8 && numeric <= 0xffff_ffff)
  ) {
    throw new Error('noncanonical cbor integer')
  }
  return numeric
}
