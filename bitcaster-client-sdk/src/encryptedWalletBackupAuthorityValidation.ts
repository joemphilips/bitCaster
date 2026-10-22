import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import { requireLowerHex } from './encryptedWalletBackupServerValidation.ts'

// Structural validators only. These functions do not issue authenticated capabilities.
const ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX = 256
export function decodeBundleSet(
  value: readonly EncryptedWalletBackupV2BundleDescriptor[],
  context: { readonly realm: string; readonly walletId: string },
): readonly EncryptedWalletBackupV2BundleDescriptor[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX)
    throw new Error('encrypted backup v2 active bundles are invalid')
  const bundles = value.map((bundle) =>
    decodeEncryptedWalletBackupV2BundleDescriptor(bundle, context),
  )
  const assets = new Set<string>()
  const objects = new Set<string>()
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index]!
    if (index > 0 && bundle.bundleId <= bundles[index - 1]!.bundleId)
      throw new Error('encrypted backup v2 active bundles are unordered or duplicated')
    if (assets.has(bundle.assetLocator))
      throw new Error('encrypted backup v2 asset locator is duplicated')
    assets.add(bundle.assetLocator)
    for (const object of bundle.objects) {
      if (objects.has(object.objectId))
        throw new Error('encrypted backup v2 object id is duplicated')
      objects.add(object.objectId)
    }
  }
  if (objects.size > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX)
    throw new Error('encrypted backup v2 active object count is invalid')
  return Object.freeze(bundles)
}

export function objectCount(bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]): number {
  return bundles.reduce((count, bundle) => count + bundle.objects.length, 0)
}

export function cursor(value: unknown): string | null {
  return value === null ? null : requireLowerHex(value, 16, 'bundle cursor')
}

export function positive(value: unknown, name: string): number {
  return bounded(value, 1, Number.MAX_SAFE_INTEGER, name)
}

export function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  return value
}

export function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup v2 record is invalid')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup v2 record is invalid')
  return record
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

export function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}

export function requireExactAssetReplacement(
  addedBundle: EncryptedWalletBackupV2BundleDescriptor | null,
  supersededBundleIds: readonly string[],
  currentBundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
): void {
  const superseded = supersededBundleIds
  const currentIds = new Set(currentBundles.map((bundle) => bundle.bundleId))
  if (superseded.some((bundleId) => !currentIds.has(bundleId)))
    throw new Error('encrypted backup mutation predecessor is not current')
  if (addedBundle === null) return
  const matching = currentBundles.filter(
    (bundle) => bundle.assetLocator === addedBundle.assetLocator,
  )
  if (matching.length === 0) {
    if (superseded.length !== 0)
      throw new Error('encrypted backup mutation addition has a predecessor')
    return
  }
  if (matching.length !== 1 || superseded.length !== 1 || superseded[0] !== matching[0]!.bundleId) {
    throw new Error('encrypted backup mutation replacement predecessor is invalid')
  }
}

export function decodeSupersededBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX)
    throw new Error('encrypted backup superseded bundles are invalid')
  const bundleIds = value.map((item) => requireLowerHex(item, 16, 'superseded bundle id'))
  if (bundleIds.some((item, index) => index > 0 && item <= bundleIds[index - 1]!))
    throw new Error('encrypted backup superseded bundles are invalid')
  return Object.freeze(bundleIds)
}

export function requireMutationMode(
  addedBundle: EncryptedWalletBackupV2BundleDescriptor | null,
  supersededBundleIds: readonly string[],
): void {
  if (addedBundle === null && supersededBundleIds.length === 0)
    throw new Error('encrypted backup mutation is a no-op')
  if (addedBundle !== null && supersededBundleIds.includes(addedBundle.bundleId))
    throw new Error('encrypted backup mutation supersedes its added bundle')
}
