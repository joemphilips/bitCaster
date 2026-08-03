import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'

export const ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST = bytesToHex(
  sha256(encodeCanonical([1, 'reference-set', [], []])),
)

export interface EncryptedWalletBackupFrozenSnapshotControl {
  readonly [encryptedWalletBackupFrozenSnapshotControlBrand]: true
}

export interface EncryptedWalletBackupFrozenSnapshotControlAuthority {
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly parentGeneration: number | null
  readonly parentManifestDigest: string | null
  readonly parentReferenceSetDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly snapshotId: string
  readonly snapshotRevision: number
}

declare const encryptedWalletBackupFrozenSnapshotControlBrand: unique symbol

const AUTHORITIES = new WeakMap<object, EncryptedWalletBackupFrozenSnapshotControlAuthority>()

export function issueEncryptedWalletBackupFrozenSnapshotControl<T extends object>(
  handle: T,
  authority: EncryptedWalletBackupFrozenSnapshotControlAuthority,
): T & EncryptedWalletBackupFrozenSnapshotControl {
  AUTHORITIES.set(handle, Object.freeze({ ...authority }))
  return handle as T & EncryptedWalletBackupFrozenSnapshotControl
}

export function requireEncryptedWalletBackupFrozenSnapshotControl(
  value: unknown,
): EncryptedWalletBackupFrozenSnapshotControlAuthority {
  const authority = typeof value === 'object' && value !== null ? AUTHORITIES.get(value) : undefined
  if (authority === undefined) throw new Error('backup frozen snapshot control is invalid')
  return authority
}
