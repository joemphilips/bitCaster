import { secp256k1 } from '@noble/curves/secp256k1.js'
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
  readonly assetLocatorRoot: Uint8Array
  readonly operationLocatorRoot: Uint8Array
  readonly runtime: EncryptedWalletBackupV2Runtime
}

const KEY_AUTHORITIES = new WeakMap<object, EncryptedWalletBackupV2KeyAuthority>()
const SCALAR_ATTEMPTS = 256
const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER

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

export async function deriveEncryptedWalletBackupV2RequestAuthScalar(
  authority: EncryptedWalletBackupV2KeyAuthority,
  realm: string,
): Promise<Uint8Array> {
  return deriveEncryptedWalletBackupV2Scalar(
    authority,
    authority.requestAuthRoot,
    realm,
    'request-auth-scalar',
  )
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

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  return result
}

async function deriveEncryptedWalletBackupV2Scalar(
  authority: EncryptedWalletBackupV2KeyAuthority,
  root: Uint8Array,
  realm: string,
  domain: 'request-auth-scalar',
): Promise<Uint8Array> {
  for (let counter = 0; counter < SCALAR_ATTEMPTS; counter += 1) {
    const candidate = await deriveEncryptedWalletBackupV2Hkdf(
      authority.runtime,
      root,
      encodeCanonicalBackupCbor([2, domain, realm, counter]),
    )
    const scalar = bytesToBigInt(candidate)
    if (scalar > 0n && scalar < SECP256K1_ORDER) return candidate
  }
  throw new Error('encrypted backup scalar derivation exhausted')
}
