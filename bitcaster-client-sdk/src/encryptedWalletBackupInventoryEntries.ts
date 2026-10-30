import { requireBytes, requireLowerHex } from './encryptedWalletBackupServerValidation.ts'
import { exactRecord, toHex } from './encryptedWalletBackupAuthorityValidation.ts'
import {
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
export interface EncryptedWalletBackupV2CurrentInventoryEntry {
  readonly assetLocator: string
  readonly declaredAmount: bigint
  readonly custodyRevision: bigint
  readonly bundleId: string
  readonly descriptorDigest: string
}
export function decodeCurrentInventoryEntries(
  value: unknown,
): EncryptedWalletBackupV2CurrentInventoryEntry[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX)
    throw new Error('encrypted backup v2 current inventory is invalid')
  const entries = value.map((item) => {
    if (Array.isArray(item)) {
      if (item.length !== 5)
        throw new Error('encrypted backup v2 current inventory entry is invalid')
      return currentInventoryEntry({
        assetLocator: toHex(requireBytes(item[0], 32, 32, 'asset locator')),
        declaredAmount: item[1],
        custodyRevision: item[2],
        bundleId: toHex(requireBytes(item[3], 16, 16, 'bundle id')),
        descriptorDigest: toHex(requireBytes(item[4], 32, 32, 'descriptor digest')),
      })
    }
    return currentInventoryEntry(item)
  })
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (index > 0 && entry.bundleId <= entries[index - 1]!.bundleId)
      throw new Error('encrypted backup v2 current inventory entries are unordered or duplicated')
    if (
      entries.some(
        (other, otherIndex) => otherIndex < index && other.assetLocator === entry.assetLocator,
      )
    )
      throw new Error('encrypted backup v2 current inventory asset locator is duplicated')
  }
  return entries
}

function currentInventoryEntry(value: unknown): EncryptedWalletBackupV2CurrentInventoryEntry {
  const record = exactRecord(value, [
    'assetLocator',
    'declaredAmount',
    'custodyRevision',
    'bundleId',
    'descriptorDigest',
  ])
  return Object.freeze({
    assetLocator: requireLowerHex(record.assetLocator, 32, 'asset locator'),
    declaredAmount: requireUint64(record.declaredAmount, 'declared amount'),
    custodyRevision: requireUint64(record.custodyRevision, 'custody revision'),
    bundleId: requireLowerHex(record.bundleId, 16, 'bundle id'),
    descriptorDigest: requireLowerHex(record.descriptorDigest, 32, 'descriptor digest'),
  })
}

function requireUint64(value: unknown, name: string): bigint {
  if (typeof value === 'bigint' && value >= 0n && value <= ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX)
    return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Error(`encrypted backup v2 ${name} is invalid`)
}
