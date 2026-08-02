import type {
  EncryptedWalletBackupKeyHandle,
  PreparedEncryptedWalletBackupProof,
} from './encryptedWalletBackup.ts'
import type { EncryptedWalletBackupRecordKindCode } from './encryptedWalletBackupRecord.ts'

export interface ValidatedPreparedEncryptedWalletBackupRecord {
  readonly recordId: string
  readonly commitment: string
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode
}

interface PreparedRecordValidator {
  validate(input: {
    readonly keyHandle: EncryptedWalletBackupKeyHandle
    readonly seed: Uint8Array
    readonly canonicalRecord: Uint8Array
    readonly canonicalManifestEntry: Uint8Array
  }): ValidatedPreparedEncryptedWalletBackupRecord
  rehydrate(input: {
    readonly keyHandle: EncryptedWalletBackupKeyHandle
    readonly seed: Uint8Array
    readonly canonicalRecord: Uint8Array
    readonly canonicalManifestEntry: Uint8Array
    readonly snapshotId: string
    readonly snapshotRevision: number
  }): PreparedEncryptedWalletBackupProof
}

let validator: PreparedRecordValidator | null = null

/** Internal registration seam. This function is not a package export. */
export function registerEncryptedWalletBackupPreparedRecordValidator(
  value: PreparedRecordValidator,
): void {
  if (
    validator !== null ||
    typeof value?.validate !== 'function' ||
    typeof value.rehydrate !== 'function'
  ) {
    throw new Error('prepared backup record validator registration is invalid')
  }
  validator = value
}

export function validatePreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
}): ValidatedPreparedEncryptedWalletBackupRecord {
  if (validator === null) {
    throw new Error('prepared backup record validator is unavailable')
  }
  return validator.validate(input)
}

export function rehydrateValidatedPreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly canonicalRecord: Uint8Array
  readonly canonicalManifestEntry: Uint8Array
  readonly snapshotId: string
  readonly snapshotRevision: number
}): PreparedEncryptedWalletBackupProof {
  if (validator === null) {
    throw new Error('prepared backup record validator is unavailable')
  }
  return validator.rehydrate(input)
}
