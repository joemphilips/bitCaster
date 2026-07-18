import type { EncryptedWalletBackupRecordKindCode } from "./encryptedWalletBackupRecord.ts";

export interface ValidatedPreparedEncryptedWalletBackupRecord {
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
}

interface PreparedRecordValidator {
  validate(input: {
    readonly seed: Uint8Array;
    readonly canonicalRecord: Uint8Array;
    readonly canonicalManifestEntry: Uint8Array;
  }): ValidatedPreparedEncryptedWalletBackupRecord;
}

let validator: PreparedRecordValidator | null = null;

/** Internal registration seam; deliberately absent from package exports. */
export function registerEncryptedWalletBackupPreparedRecordValidator(
  value: PreparedRecordValidator,
): void {
  if (validator !== null || typeof value?.validate !== "function")
    throw new Error("prepared backup record validator registration is invalid");
  validator = value;
}

export function validatePreparedEncryptedWalletBackupRecord(input: {
  readonly seed: Uint8Array;
  readonly canonicalRecord: Uint8Array;
  readonly canonicalManifestEntry: Uint8Array;
}): ValidatedPreparedEncryptedWalletBackupRecord {
  if (validator === null)
    throw new Error("prepared backup record validator is unavailable");
  return validator.validate(input);
}
