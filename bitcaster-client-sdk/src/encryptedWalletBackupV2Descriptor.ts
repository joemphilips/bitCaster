import { sha256 } from '@noble/hashes/sha2.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  equalBytes,
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX = 15 as const
export const ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX = 18_446_744_073_709_551_615n

export interface EncryptedWalletBackupV2ObjectReference {
  readonly objectId: string
  readonly digest: string
}

export interface EncryptedWalletBackupV2BundleDescriptor {
  readonly formatVersion: 2
  readonly realm: string
  readonly vaultId: string
  readonly bundleId: string
  readonly assetLocator: string
  readonly declaredAmount: bigint
  readonly custodyRevision: bigint
  readonly payloadCommitment: string
  readonly objects: readonly EncryptedWalletBackupV2ObjectReference[]
}

const DESCRIPTOR_DIGEST_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-descriptor/v1\0'
const DESCRIPTOR_MAX_BYTES = 65_536
const DESCRIPTOR_PREFLIGHT = {
  maximumBytes: DESCRIPTOR_MAX_BYTES,
  maximumDepth: 3,
  maximumTokens: 128,
  maximumArrayLength: 15,
  maximumItemLength: DESCRIPTOR_MAX_BYTES,
  fields: [
    { major: 0, exact: 2 },
    { major: 3, minimum: 1, maximum: 64 },
    { major: 2, minimum: 32, maximum: 32 },
    { major: 2, minimum: 16, maximum: 16 },
    { major: 2, minimum: 32, maximum: 32 },
    { major: 0 },
    { major: 0 },
    { major: 2, minimum: 32, maximum: 32 },
    { major: 4, minimum: 1, maximum: ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX },
  ],
} as const

export function decodeEncryptedWalletBackupV2BundleDescriptor(
  value: unknown,
  expected?: { readonly realm: string; readonly vaultId: string },
): EncryptedWalletBackupV2BundleDescriptor {
  const record = exactRecord(value, [
    'formatVersion',
    'realm',
    'vaultId',
    'bundleId',
    'assetLocator',
    'declaredAmount',
    'custodyRevision',
    'payloadCommitment',
    'objects',
  ])
  if (record.formatVersion !== 2) throw new Error('encrypted backup v2 descriptor is invalid')
  const realm = requireRealm(record.realm)
  const vaultId = requireLowerHex(record.vaultId, 32, 'vault id')
  if (expected !== undefined && (realm !== expected.realm || vaultId !== expected.vaultId))
    throw new Error('encrypted backup v2 descriptor is foreign')
  const objectValues = record.objects
  if (
    !Array.isArray(objectValues) ||
    objectValues.length < 1 ||
    objectValues.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX
  )
    throw new Error('encrypted backup v2 descriptor objects are invalid')
  const objects = objectValues.map((item) => {
    const object = exactRecord(item, ['objectId', 'digest'])
    return Object.freeze({
      objectId: requireLowerHex(object.objectId, 16, 'object id'),
      digest: requireLowerHex(object.digest, 32, 'object digest'),
    })
  })
  if (new Set(objects.map((object) => object.objectId)).size !== objects.length)
    throw new Error('encrypted backup v2 descriptor objects are duplicated')
  return Object.freeze({
    formatVersion: 2,
    realm,
    vaultId,
    bundleId: requireLowerHex(record.bundleId, 16, 'bundle id'),
    assetLocator: requireLowerHex(record.assetLocator, 32, 'asset locator'),
    declaredAmount: requireUint64(record.declaredAmount, 'declared amount'),
    custodyRevision: requireUint64(record.custodyRevision, 'custody revision'),
    payloadCommitment: requireLowerHex(record.payloadCommitment, 32, 'payload commitment'),
    objects: Object.freeze(objects),
  })
}

export function encodeEncryptedWalletBackupV2BundleDescriptor(value: unknown): Uint8Array {
  const descriptor = decodeEncryptedWalletBackupV2BundleDescriptor(value)
  return encodeCanonicalBackupCbor([
    descriptor.formatVersion,
    descriptor.realm,
    hexToBytesStrict(descriptor.vaultId, 32, 'vault id'),
    hexToBytesStrict(descriptor.bundleId, 16, 'bundle id'),
    hexToBytesStrict(descriptor.assetLocator, 32, 'asset locator'),
    descriptor.declaredAmount,
    descriptor.custodyRevision,
    hexToBytesStrict(descriptor.payloadCommitment, 32, 'payload commitment'),
    descriptor.objects.map((item) => [
      hexToBytesStrict(item.objectId, 16, 'object id'),
      hexToBytesStrict(item.digest, 32, 'object digest'),
    ]),
  ])
}

/** Decodes the exact canonical descriptor wire stored by a backup service. */
export function decodeEncryptedWalletBackupV2BundleDescriptorWire(
  bytes: Uint8Array,
  expected?: { readonly realm: string; readonly vaultId: string },
): EncryptedWalletBackupV2BundleDescriptor {
  preflightDescriptorWire(bytes)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  }
  if (!equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) || !Array.isArray(decoded))
    throw new Error('encrypted backup v2 descriptor wire is noncanonical')
  return decodeEncryptedWalletBackupV2BundleDescriptor(
    {
      formatVersion: decoded[0],
      realm: decoded[1],
      vaultId: toHex(requireBytes(decoded[2], 32, 32, 'vault id')),
      bundleId: toHex(requireBytes(decoded[3], 16, 16, 'bundle id')),
      assetLocator: toHex(requireBytes(decoded[4], 32, 32, 'asset locator')),
      declaredAmount: requireUint64(decoded[5], 'declared amount'),
      custodyRevision: requireUint64(decoded[6], 'custody revision'),
      payloadCommitment: toHex(requireBytes(decoded[7], 32, 32, 'payload commitment')),
      objects: decodeObjectReferences(decoded[8]),
    },
    expected,
  )
}

export function digestEncryptedWalletBackupV2BundleDescriptor(value: unknown): string {
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode(DESCRIPTOR_DIGEST_DOMAIN))
      .update(encodeEncryptedWalletBackupV2BundleDescriptor(value))
      .digest(),
  )
}

export function cloneEncryptedWalletBackupV2BundleDescriptor(
  value: unknown,
): EncryptedWalletBackupV2BundleDescriptor {
  return decodeEncryptedWalletBackupV2BundleDescriptor(value)
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup v2 descriptor is invalid')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup v2 descriptor is invalid')
  return record
}

function decodeObjectReferences(value: unknown): readonly EncryptedWalletBackupV2ObjectReference[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 descriptor objects are invalid')
  return value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2)
      throw new Error('encrypted backup v2 descriptor object is invalid')
    return {
      objectId: toHex(requireBytes(item[0], 16, 16, 'object id')),
      digest: toHex(requireBytes(item[1], 32, 32, 'object digest')),
    }
  })
}

function requireUint64(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX)
      throw new Error(`encrypted backup v2 ${name} is invalid`)
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Error(`encrypted backup v2 ${name} is invalid`)
}

function preflightDescriptorWire(bytes: Uint8Array): void {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > DESCRIPTOR_MAX_BYTES
  )
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  const state = { offset: 0, tokens: 0 }
  const root = readDescriptorItem(bytes, state, 0)
  if (
    root.major !== 4 ||
    root.value !== BigInt(DESCRIPTOR_PREFLIGHT.fields.length) ||
    state.offset !== bytes.byteLength
  )
    throw new Error('encrypted backup v2 descriptor wire is invalid')
}

function readDescriptorItem(
  bytes: Uint8Array,
  state: { offset: number; tokens: number },
  depth: number,
): { readonly major: number; readonly value: bigint } {
  if (
    depth > DESCRIPTOR_PREFLIGHT.maximumDepth ||
    state.offset >= bytes.byteLength ||
    ++state.tokens > DESCRIPTOR_PREFLIGHT.maximumTokens
  )
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  const first = bytes[state.offset++]!
  const major = first >>> 5
  const additional = first & 31
  if (major === 1 || major === 5 || major === 6 || major === 7 || additional === 31)
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  const value = readDescriptorArgument(bytes, state, additional)
  if (major === 4) {
    if (value > BigInt(DESCRIPTOR_PREFLIGHT.maximumArrayLength))
      throw new Error('encrypted backup v2 descriptor wire is invalid')
    for (let index = 0n; index < value; index += 1n) readDescriptorItem(bytes, state, depth + 1)
  } else if (major === 2 || major === 3) {
    if (
      value > BigInt(DESCRIPTOR_PREFLIGHT.maximumItemLength) ||
      value > BigInt(bytes.byteLength - state.offset)
    )
      throw new Error('encrypted backup v2 descriptor wire is invalid')
    state.offset += Number(value)
  } else if (major !== 0) {
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  }
  return { major, value }
}

function readDescriptorArgument(
  bytes: Uint8Array,
  state: { offset: number },
  additional: number,
): bigint {
  if (additional < 24) return BigInt(additional)
  const width = ({ 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>)[additional]
  if (width === undefined || state.offset + width > bytes.byteLength)
    throw new Error('encrypted backup v2 descriptor wire is invalid')
  let value = 0n
  for (let index = 0; index < width; index += 1)
    value = (value << 8n) | BigInt(bytes[state.offset++]!)
  const minimum = ({ 1: 24n, 2: 256n, 4: 65_536n, 8: 4_294_967_296n } as Record<number, bigint>)[
    width
  ]!
  if (value < minimum) throw new Error('encrypted backup v2 descriptor wire is noncanonical')
  return value
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
