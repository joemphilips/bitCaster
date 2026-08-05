import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  hexToBytesStrict,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX = 15 as const
export const ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_ASSET_MAX = 64 as const

export interface EncryptedWalletBackupV2BundleDescriptor {
  readonly formatVersion: 2
  readonly realm: string
  readonly vaultId: string
  readonly bundleId: string
  readonly operationLocator: string
  readonly assetLocators: readonly string[]
  readonly payloadCommitment: string
  readonly objects: readonly Readonly<{ objectId: string; digest: string }>[]
}

const DESCRIPTOR_DIGEST_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-descriptor/v1\0'

export function decodeEncryptedWalletBackupV2BundleDescriptor(
  value: unknown,
  expected?: { readonly realm: string; readonly vaultId: string },
): EncryptedWalletBackupV2BundleDescriptor {
  const record = exactRecord(value, [
    'formatVersion',
    'realm',
    'vaultId',
    'bundleId',
    'operationLocator',
    'assetLocators',
    'payloadCommitment',
    'objects',
  ])
  if (record.formatVersion !== 2) throw new Error('encrypted backup v2 descriptor is invalid')
  const realm = requireRealm(record.realm)
  const vaultId = requireLowerHex(record.vaultId, 32, 'vault id')
  if (expected !== undefined && (realm !== expected.realm || vaultId !== expected.vaultId))
    throw new Error('encrypted backup v2 descriptor is foreign')
  const assetLocatorValues = record.assetLocators
  if (
    !Array.isArray(assetLocatorValues) ||
    assetLocatorValues.length < 1 ||
    assetLocatorValues.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_ASSET_MAX
  )
    throw new Error('encrypted backup v2 descriptor assets are invalid')
  const assetLocators = assetLocatorValues.map((item) => requireLowerHex(item, 32, 'asset locator'))
  if (assetLocators.some((item, index) => index > 0 && item <= assetLocators[index - 1]!))
    throw new Error('encrypted backup v2 descriptor assets are invalid')
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
    operationLocator: requireLowerHex(record.operationLocator, 32, 'operation locator'),
    assetLocators: Object.freeze(assetLocators),
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
    hexToBytesStrict(descriptor.operationLocator, 32, 'operation locator'),
    descriptor.assetLocators.map((item) => hexToBytesStrict(item, 32, 'asset locator')),
    hexToBytesStrict(descriptor.payloadCommitment, 32, 'payload commitment'),
    descriptor.objects.map((item) => [
      hexToBytesStrict(item.objectId, 16, 'object id'),
      hexToBytesStrict(item.digest, 32, 'object digest'),
    ]),
  ])
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

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
