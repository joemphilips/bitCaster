import { schnorr } from '@noble/curves/secp256k1.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  deriveEncryptedWalletBackupV2Hkdf,
  deriveEncryptedWalletBackupV2RequestAuthScalar,
  registerEncryptedWalletBackupV2KeyHandle,
  requireEncryptedWalletBackupV2KeyAuthority,
  type EncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'
import { canonicalizeMintIdentityUrl } from './tokenImportValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION = 2 as const

const MINT_URL_MAX_BYTES = 2_048
const UNIT_MAX_BYTES = 64
const ASSET_ID_MAX_BYTES = 256

export interface EncryptedWalletBackupV2Runtime {
  readonly subtle: Pick<SubtleCrypto, 'deriveBits' | 'importKey'>
}

export interface EncryptedWalletBackupV2KeyHandle {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
}

export async function createEncryptedWalletBackupV2KeyHandle(input: {
  seed: Uint8Array
  realm: string
  runtime?: EncryptedWalletBackupV2Runtime
}): Promise<EncryptedWalletBackupV2KeyHandle> {
  const seed = requireSeed(input.seed)
  const realm = requireRealm(input.realm)
  const runtime = requireRuntime(input.runtime)
  const authority = await deriveKeyAuthority(seed, realm, runtime)
  const vaultId = toLowerHex(await deriveVaultId(authority, realm))
  const requestAuthPublicKey = toLowerHex(
    schnorr.getPublicKey(await deriveEncryptedWalletBackupV2RequestAuthScalar(authority, realm)),
  )
  const handle = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    realm,
    vaultId,
    requestAuthPublicKey,
  })
  registerEncryptedWalletBackupV2KeyHandle(handle, authority)
  return handle
}

export async function deriveEncryptedWalletBackupV2AssetLocator(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  mintUrl: string
  unit: string
  assetIdentity: string
}): Promise<string> {
  const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
  const mintUrl = canonicalizeMintIdentity(input.mintUrl)
  const unit = requireUtf8Text(input.unit, UNIT_MAX_BYTES, 'encrypted backup unit')
  const assetIdentity = requireUtf8Text(
    input.assetIdentity,
    ASSET_ID_MAX_BYTES,
    'encrypted backup asset identity',
  )
  return toLowerHex(
    await deriveEncryptedWalletBackupV2Hkdf(
      authority.runtime,
      authority.assetLocatorRoot,
      locatorInfo('asset-locator', input.keyHandle.realm, mintUrl, unit, assetIdentity),
    ),
  )
}

async function deriveKeyAuthority(
  seed: Uint8Array,
  realm: string,
  runtime: EncryptedWalletBackupV2Runtime,
): Promise<EncryptedWalletBackupV2KeyAuthority> {
  const [encryptionRoot, vaultIdRoot, requestAuthRoot, assetLocatorRoot] = await Promise.all([
    deriveRoot(seed, realm, 'encryption-root', runtime),
    deriveRoot(seed, realm, 'vault-id-root', runtime),
    deriveRoot(seed, realm, 'request-auth-root', runtime),
    deriveRoot(seed, realm, 'asset-locator-root', runtime),
  ])
  return Object.freeze({
    encryptionRoot,
    vaultIdRoot,
    requestAuthRoot,
    assetLocatorRoot,
    runtime,
  })
}

function deriveRoot(
  seed: Uint8Array,
  realm: string,
  domain: string,
  runtime: EncryptedWalletBackupV2Runtime,
): Promise<Uint8Array> {
  return deriveEncryptedWalletBackupV2Hkdf(runtime, seed, rootInfo(domain, realm))
}

function deriveVaultId(
  authority: EncryptedWalletBackupV2KeyAuthority,
  realm: string,
): Promise<Uint8Array> {
  return deriveEncryptedWalletBackupV2Hkdf(
    authority.runtime,
    authority.vaultIdRoot,
    rootInfo('vault-id', realm),
  )
}

function rootInfo(domain: string, realm: string): Uint8Array {
  return encodeCanonicalBackupCbor([ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION, domain, realm])
}

function locatorInfo(domain: string, realm: string, ...identity: string[]): Uint8Array {
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    domain,
    realm,
    ...identity,
  ])
}

function requireSeed(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 64) {
    throw new Error('encrypted backup seed is invalid')
  }
  return value.slice()
}

function requireRuntime(
  value: EncryptedWalletBackupV2Runtime | undefined,
): EncryptedWalletBackupV2Runtime {
  const runtime = value ?? globalThis.crypto
  if (
    runtime === undefined ||
    runtime.subtle === undefined ||
    typeof runtime.subtle.importKey !== 'function' ||
    typeof runtime.subtle.deriveBits !== 'function'
  ) {
    throw new Error('encrypted backup crypto runtime is unavailable')
  }
  return { subtle: runtime.subtle }
}

function canonicalizeMintIdentity(value: unknown): string {
  const raw = requireUtf8Text(value, MINT_URL_MAX_BYTES, 'encrypted backup mint URL')
  try {
    return canonicalizeMintIdentityUrl(raw)
  } catch {
    throw new Error('encrypted backup mint URL is invalid')
  }
}

function toLowerHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
