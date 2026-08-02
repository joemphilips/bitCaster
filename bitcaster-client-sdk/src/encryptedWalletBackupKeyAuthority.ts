import type { EncryptedWalletBackupKeyHandle } from './encryptedWalletBackup.ts'

interface EncryptedWalletBackupKeyBinding {
  readonly walletId: string
  readonly preparationPersistenceKey: Uint8Array
  readonly subtle: SubtleCrypto
}

const ISSUED_BACKUP_KEY_HANDLES = new WeakMap<object, EncryptedWalletBackupKeyBinding>()
const IMPORTED_PREPARATION_KEYS = new WeakMap<object, Promise<CryptoKey>>()

/** Internal capability registry; deliberately absent from package exports. */
export function registerEncryptedWalletBackupKeyHandle(
  handle: EncryptedWalletBackupKeyHandle,
  binding: EncryptedWalletBackupKeyBinding,
): void {
  ISSUED_BACKUP_KEY_HANDLES.set(
    handle,
    Object.freeze({
      ...binding,
      preparationPersistenceKey: binding.preparationPersistenceKey.slice(),
    }),
  )
  IMPORTED_PREPARATION_KEYS.delete(handle)
}

export function requireEncryptedWalletBackupKeyWalletId(
  handle: EncryptedWalletBackupKeyHandle,
): string {
  return requireKeyBinding(handle).walletId
}

export async function signEncryptedWalletBackupPreparationCapability(
  handle: EncryptedWalletBackupKeyHandle,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const binding = requireKeyBinding(handle)
  const key = await importHmacKey(handle, binding)
  return new Uint8Array(await binding.subtle.sign('HMAC', key, asArrayBuffer(payload)))
}

export async function verifyEncryptedWalletBackupPreparationCapability(
  handle: EncryptedWalletBackupKeyHandle,
  payload: Uint8Array,
  authenticationTag: Uint8Array,
): Promise<void> {
  const binding = requireKeyBinding(handle)
  if (authenticationTag.byteLength !== 32) {
    throw new Error('backup preparation capability authentication failed')
  }
  const key = await importHmacKey(handle, binding)
  if (
    !(await binding.subtle.verify(
      'HMAC',
      key,
      asArrayBuffer(authenticationTag),
      asArrayBuffer(payload),
    ))
  ) {
    throw new Error('backup preparation capability authentication failed')
  }
}

export function requireIssuedEncryptedWalletBackupKeyHandle(
  value: unknown,
): EncryptedWalletBackupKeyHandle {
  if (typeof value !== 'object' || value === null || !ISSUED_BACKUP_KEY_HANDLES.has(value)) {
    throw new Error('backup key handle is invalid')
  }
  return value as EncryptedWalletBackupKeyHandle
}

function requireKeyBinding(value: unknown): EncryptedWalletBackupKeyBinding {
  const handle = requireIssuedEncryptedWalletBackupKeyHandle(value)
  return ISSUED_BACKUP_KEY_HANDLES.get(handle)!
}

async function importHmacKey(
  handle: EncryptedWalletBackupKeyHandle,
  binding: EncryptedWalletBackupKeyBinding,
): Promise<CryptoKey> {
  const cached = IMPORTED_PREPARATION_KEYS.get(handle)
  if (cached !== undefined) return cached
  const imported = binding.subtle.importKey(
    'raw',
    asArrayBuffer(binding.preparationPersistenceKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  IMPORTED_PREPARATION_KEYS.set(handle, imported)
  return imported
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
