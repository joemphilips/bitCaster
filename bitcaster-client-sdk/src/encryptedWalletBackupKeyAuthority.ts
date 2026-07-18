import type { EncryptedWalletBackupKeyHandle } from './encryptedWalletBackup.ts'

interface EncryptedWalletBackupKeyBinding {
  readonly walletId: string
}

const ISSUED_BACKUP_KEY_HANDLES = new WeakMap<
  object,
  EncryptedWalletBackupKeyBinding
>()

/** Internal capability registry; deliberately absent from package exports. */
export function registerEncryptedWalletBackupKeyHandle(
  handle: EncryptedWalletBackupKeyHandle,
  binding: EncryptedWalletBackupKeyBinding,
): void {
  ISSUED_BACKUP_KEY_HANDLES.set(handle, Object.freeze({ ...binding }))
}

export function requireIssuedEncryptedWalletBackupKeyHandle(
  value: unknown,
): EncryptedWalletBackupKeyHandle {
  if (
    typeof value !== 'object' ||
    value === null ||
    !ISSUED_BACKUP_KEY_HANDLES.has(value)
  ) {
    throw new Error('backup key handle is invalid')
  }
  return value as EncryptedWalletBackupKeyHandle
}

export function requireEncryptedWalletBackupKeyWalletId(
  value: unknown,
): string {
  const handle = requireIssuedEncryptedWalletBackupKeyHandle(value)
  return ISSUED_BACKUP_KEY_HANDLES.get(handle)!.walletId
}
