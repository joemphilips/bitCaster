export const ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD = 0 as const;
export const ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD =
  1 as const;
export const ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD =
  2 as const;

export type EncryptedWalletBackupRecordKindCode =
  | typeof ENCRYPTED_WALLET_BACKUP_DETERMINISTIC_PROOF_RECORD
  | typeof ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD
  | typeof ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD;

/**
 * Opaque authority accepted by the generic chunk packer. Variant-specific
 * handles keep their existing public shape; possession of similarly shaped
 * data never grants preparation authority.
 */
declare const preparedEncryptedWalletBackupRecordBrand: unique symbol;

export interface PreparedEncryptedWalletBackupRecord {
  readonly [preparedEncryptedWalletBackupRecordBrand]: true;
}

export interface PreparedEncryptedWalletBackupRecordAuthority {
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
  readonly keyHandle: object;
  readonly canonicalRecord: Uint8Array;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly manifestEntry: readonly unknown[];
}

const preparedRecordAuthorities = new WeakMap<
  object,
  PreparedEncryptedWalletBackupRecordAuthority
>();

export function issuePreparedEncryptedWalletBackupRecord<T extends object>(
  handle: T,
  authority: PreparedEncryptedWalletBackupRecordAuthority,
): T & PreparedEncryptedWalletBackupRecord {
  preparedRecordAuthorities.set(handle, {
    ...authority,
    canonicalRecord: authority.canonicalRecord.slice(),
    manifestEntry: Object.freeze([...authority.manifestEntry]),
  });
  return handle as T & PreparedEncryptedWalletBackupRecord;
}

export function requirePreparedEncryptedWalletBackupRecord(
  value: unknown,
): PreparedEncryptedWalletBackupRecordAuthority {
  const handle = value as object;
  const authority =
    typeof value === "object" && value !== null
      ? preparedRecordAuthorities.get(handle)
      : undefined;
  if (authority === undefined) {
    throw new Error("prepared encrypted wallet backup record is invalid");
  }
  return {
    ...authority,
    canonicalRecord: authority.canonicalRecord.slice(),
  };
}
