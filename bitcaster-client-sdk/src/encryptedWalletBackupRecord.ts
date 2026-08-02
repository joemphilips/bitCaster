export const ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD = 0 as const

export type EncryptedWalletBackupRecordKindCode =
  typeof ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD

declare const preparedEncryptedWalletBackupRecordBrand: unique symbol

/** Opaque SDK authority for one exact prepared backup record. */
export interface PreparedEncryptedWalletBackupRecord {
  readonly [preparedEncryptedWalletBackupRecordBrand]: true
}

export interface PreparedEncryptedWalletBackupRecordAuthority {
  readonly recordId: string
  readonly commitment: string
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode
  readonly keyHandle: object
  readonly canonicalRecord: Uint8Array
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly canonicalManifestEntry: Uint8Array
}

const PREPARED_RECORD_AUTHORITIES = new WeakMap<
  object,
  PreparedEncryptedWalletBackupRecordAuthority
>()

export function issuePreparedEncryptedWalletBackupRecord<T extends object>(
  handle: T,
  authority: PreparedEncryptedWalletBackupRecordAuthority,
): T & PreparedEncryptedWalletBackupRecord {
  PREPARED_RECORD_AUTHORITIES.set(
    handle,
    Object.freeze({
      ...authority,
      canonicalRecord: authority.canonicalRecord.slice(),
      canonicalManifestEntry: authority.canonicalManifestEntry.slice(),
    }),
  )
  return handle as T & PreparedEncryptedWalletBackupRecord
}

export function requirePreparedEncryptedWalletBackupRecord(
  value: unknown,
): PreparedEncryptedWalletBackupRecordAuthority {
  const authority =
    typeof value === 'object' && value !== null ? PREPARED_RECORD_AUTHORITIES.get(value) : undefined
  if (authority === undefined) {
    throw new Error('prepared encrypted wallet backup record is invalid')
  }
  return {
    ...authority,
    canonicalRecord: authority.canonicalRecord.slice(),
    canonicalManifestEntry: authority.canonicalManifestEntry.slice(),
  }
}
