export interface EncryptedWalletBackupV2CborField {
  readonly major: 0 | 2 | 3 | 4 | 7
  readonly minimum?: number
  readonly maximum?: number
  readonly exact?: number | string
  readonly alternatives?: readonly EncryptedWalletBackupV2CborField[]
}

export interface EncryptedWalletBackupV2CborTuplePreflight {
  readonly maximumBytes: number
  readonly maximumDepth: number
  readonly maximumTokens: number
  readonly maximumArrayLength: number
  readonly maximumItemLength: number
  readonly fields: readonly EncryptedWalletBackupV2CborField[]
}

/** Iteratively validates a canonical definite CBOR tuple before materialization. */
export function preflightEncryptedWalletBackupV2CborTuple(
  bytes: Uint8Array,
  specification: EncryptedWalletBackupV2CborTuplePreflight,
): void {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > specification.maximumBytes
  ) {
    throw new Error('encrypted backup v2 CBOR input is invalid')
  }
  const state = { offset: 0, tokens: 0 }
  const root = readItem(bytes, state, specification)
  if (
    root.major !== 4 ||
    typeof root.value !== 'number' ||
    root.value !== specification.fields.length
  )
    throw new Error('encrypted backup v2 CBOR tuple is invalid')
  const stack = [root.value]
  let depth = 1
  let rootIndex = 0
  while (stack.length > 0) {
    const remaining = stack[stack.length - 1]
    if (remaining === undefined) throw new Error('encrypted backup v2 CBOR stack is invalid')
    if (remaining === 0) {
      stack.pop()
      depth -= 1
      continue
    }
    stack[stack.length - 1] = remaining - 1
    const item = readItem(bytes, state, specification)
    if (depth === 1) assertField(item, specification.fields[rootIndex++])
    if (item.major === 4) {
      depth += 1
      if (depth > specification.maximumDepth)
        throw new Error('encrypted backup v2 CBOR depth is invalid')
      if (typeof item.value !== 'number')
        throw new Error('encrypted backup v2 CBOR array is invalid')
      stack.push(item.value)
    }
  }
  if (state.offset !== bytes.byteLength || rootIndex !== specification.fields.length)
    throw new Error('encrypted backup v2 CBOR trailing data is invalid')
}

function readItem(
  bytes: Uint8Array,
  state: { offset: number; tokens: number },
  specification: EncryptedWalletBackupV2CborTuplePreflight,
): CborItem {
  if (state.offset >= bytes.byteLength || ++state.tokens > specification.maximumTokens)
    throw new Error('encrypted backup v2 CBOR token limit is invalid')
  const first = bytes[state.offset++]!
  const major = first >>> 5
  const additional = first & 31
  if (major === 1 || major === 5 || major === 6 || additional === 31)
    throw new Error('encrypted backup v2 CBOR type is invalid')
  if (major === 7) {
    if (additional !== 22) throw new Error('encrypted backup v2 CBOR simple value is invalid')
    return { major: 7, value: 22, text: undefined }
  }
  if (major !== 0 && major !== 2 && major !== 3 && major !== 4)
    throw new Error('encrypted backup v2 CBOR type is invalid')
  const value = readArgument(bytes, state, additional)
  if (major === 0) return { major, value, text: undefined }
  if (major === 4) {
    if (typeof value !== 'number') throw new Error('encrypted backup v2 CBOR array is invalid')
    if (value > specification.maximumArrayLength)
      throw new Error('encrypted backup v2 CBOR array limit is invalid')
    return { major, value, text: undefined }
  }
  if (typeof value !== 'number') throw new Error('encrypted backup v2 CBOR item is invalid')
  if (value > specification.maximumItemLength || state.offset + value > bytes.byteLength)
    throw new Error('encrypted backup v2 CBOR item limit is invalid')
  const content = bytes.subarray(state.offset, state.offset + value)
  state.offset += value
  if (major === 2) return { major, value, text: undefined }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error('encrypted backup v2 CBOR text is invalid')
  }
  return { major, value, text }
}

function readArgument(
  bytes: Uint8Array,
  state: { offset: number },
  additional: number,
): number | bigint {
  if (additional < 24) return additional
  const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 }
  const width = widths[additional]
  if (width === undefined || state.offset + width > bytes.byteLength)
    throw new Error('encrypted backup v2 CBOR argument is invalid')
  let value = 0n
  for (let index = 0; index < width; index += 1)
    value = (value << 8n) | BigInt(bytes[state.offset++]!)
  if (
    (width === 1 && value < 24n) ||
    (width === 2 && value <= 0xffn) ||
    (width === 4 && value <= 0xffffn) ||
    (width === 8 && value <= 0xffff_ffffn)
  ) {
    throw new Error('encrypted backup v2 CBOR noncanonical integer is invalid')
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
}

function assertField(item: CborItem, field: EncryptedWalletBackupV2CborField | undefined): void {
  if (field === undefined) throw new Error('encrypted backup v2 CBOR tuple field is invalid')
  if (field.alternatives !== undefined) {
    if (!field.alternatives.some((alternative) => matchesField(item, alternative)))
      throw new Error('encrypted backup v2 CBOR tuple field is invalid')
    return
  }
  if (!matchesField(item, field)) throw new Error('encrypted backup v2 CBOR tuple field is invalid')
}

function matchesField(item: CborItem, field: EncryptedWalletBackupV2CborField): boolean {
  if (item.major !== field.major) return false
  if (typeof field.exact === 'string') {
    return item.text === field.exact
  }
  if (typeof field.exact === 'number') return item.value === field.exact
  return !(
    (field.minimum !== undefined && item.value < BigInt(field.minimum)) ||
    (field.maximum !== undefined && item.value > BigInt(field.maximum))
  )
}

interface CborItem {
  readonly major: 0 | 2 | 3 | 4 | 7
  readonly value: number | bigint
  readonly text: string | undefined
}
