import type { EncryptedWalletBackupKeyHandle } from './encryptedWalletBackup.ts'

const ISSUED_BACKUP_KEY_HANDLES = new WeakSet<object>()

/** Internal capability registry; deliberately absent from package exports. */
export function registerEncryptedWalletBackupKeyHandle(
  handle: EncryptedWalletBackupKeyHandle,
): void {
  ISSUED_BACKUP_KEY_HANDLES.add(handle)
}

export function requireIssuedEncryptedWalletBackupKeyHandle(
  value: unknown,
): EncryptedWalletBackupKeyHandle {
  if (typeof value !== 'object' || value === null || !ISSUED_BACKUP_KEY_HANDLES.has(value)) {
    throw new Error('backup key handle is invalid')
  }
  return value as EncryptedWalletBackupKeyHandle
}
