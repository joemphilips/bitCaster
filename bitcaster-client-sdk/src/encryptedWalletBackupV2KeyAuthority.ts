import { exactEncryptedWalletBackupArrayBuffer } from './encryptedWalletBackupBytes.ts'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { equalBytes } from './encryptedWalletBackupServerValidation.ts'
import type {
  EncryptedWalletBackupV2KeyHandle,
  EncryptedWalletBackupV2Runtime,
} from './encryptedWalletBackupV2Keys.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_ROOT_SALT = new TextEncoder().encode(
  'bitcaster/encrypted-wallet-backup/hkdf-salt/v2',
)

export interface EncryptedWalletBackupV2KeyAuthority {
  readonly encryptionRoot: Uint8Array
  readonly vaultIdRoot: Uint8Array
  readonly requestAuthRoot: Uint8Array
  readonly portfolioReportingRoot: Uint8Array
  readonly assetLocatorRoot: Uint8Array
  readonly operationLocatorRoot: Uint8Array
  readonly runtime: EncryptedWalletBackupV2Runtime
}

const KEY_AUTHORITIES = new WeakMap<object, EncryptedWalletBackupV2KeyAuthority>()

export function registerEncryptedWalletBackupV2KeyHandle(
  handle: EncryptedWalletBackupV2KeyHandle,
  authority: EncryptedWalletBackupV2KeyAuthority,
): void {
  KEY_AUTHORITIES.set(handle, authority)
}

export function requireEncryptedWalletBackupV2KeyAuthority(
  value: unknown,
): EncryptedWalletBackupV2KeyAuthority {
  if (typeof value !== 'object' || value === null) {
    throw new Error('encrypted backup v2 key handle is invalid')
  }
  const authority = KEY_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('encrypted backup v2 key handle is invalid')
  return authority
}

export async function deriveEncryptedWalletBackupV2Hkdf(
  runtime: EncryptedWalletBackupV2Runtime,
  ikm: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const key = await runtime.subtle.importKey(
    'raw',
    exactEncryptedWalletBackupArrayBuffer(ikm),
    'HKDF',
    false,
    ['deriveBits'],
  )
  const output = await runtime.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: exactEncryptedWalletBackupArrayBuffer(ENCRYPTED_WALLET_BACKUP_V2_ROOT_SALT),
      info: exactEncryptedWalletBackupArrayBuffer(info),
    },
    key,
    256,
  )
  if (!(output instanceof ArrayBuffer) || output.byteLength !== 32) {
    throw new Error('encrypted backup runtime returned invalid HKDF output')
  }
  return new Uint8Array(output)
}

/** Confirms private seed authority without exposing the seed or a seed digest. */
export async function requireEncryptedWalletBackupV2SeedHandleMatch(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
}): Promise<Uint8Array> {
  if (!(input.seed instanceof Uint8Array) || input.seed.byteLength !== 64) {
    throw new Error('encrypted backup seed is invalid')
  }
  const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
  const expected = await deriveEncryptedWalletBackupV2Hkdf(
    authority.runtime,
    input.seed,
    encodeCanonicalBackupCbor([2, 'encryption-root', input.keyHandle.realm]),
  )
  if (!equalBytes(expected, authority.encryptionRoot)) {
    throw new Error('encrypted backup seed does not match the key handle')
  }
  return new Uint8Array(input.seed)
}
