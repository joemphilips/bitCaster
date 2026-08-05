import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { exactEncryptedWalletBackupArrayBuffer } from './encryptedWalletBackupBytes.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'
import { canonicalizeMintIdentityUrl } from './tokenImportValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION = 2 as const

const ROOT_SALT = new TextEncoder().encode('bitcaster/encrypted-wallet-backup/hkdf-salt/v2')
const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER
const SCALAR_ATTEMPTS = 256
const MINT_URL_MAX_BYTES = 2_048
const UNIT_MAX_BYTES = 64
const ASSET_ID_MAX_BYTES = 256
const OPERATION_ID_MAX_BYTES = 256

export interface EncryptedWalletBackupV2Runtime {
  readonly subtle: Pick<SubtleCrypto, 'deriveBits' | 'importKey'>
}

export interface EncryptedWalletBackupV2KeyHandle {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
  readonly portfolioReportingPublicKey: string
}

interface KeyAuthority {
  readonly vaultIdRoot: Uint8Array
  readonly requestAuthRoot: Uint8Array
  readonly portfolioReportingRoot: Uint8Array
  readonly assetLocatorRoot: Uint8Array
  readonly operationLocatorRoot: Uint8Array
  readonly runtime: EncryptedWalletBackupV2Runtime
}

const KEY_AUTHORITIES = new WeakMap<object, KeyAuthority>()

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
    schnorr.getPublicKey(
      await deriveScalar(authority.requestAuthRoot, realm, 'request-auth-scalar', runtime),
    ),
  )
  const portfolioReportingPublicKey = toLowerHex(
    schnorr.getPublicKey(
      await deriveScalar(
        authority.portfolioReportingRoot,
        realm,
        'portfolio-reporting-scalar',
        runtime,
      ),
    ),
  )
  const handle = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    realm,
    vaultId,
    requestAuthPublicKey,
    portfolioReportingPublicKey,
  })
  KEY_AUTHORITIES.set(handle, authority)
  return handle
}

export async function deriveEncryptedWalletBackupV2AssetLocator(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  mintUrl: string
  unit: string
  assetIdentity: string
}): Promise<string> {
  const authority = requireKeyAuthority(input.keyHandle)
  const mintUrl = canonicalizeMintIdentity(input.mintUrl)
  const unit = requireUtf8Text(input.unit, UNIT_MAX_BYTES, 'encrypted backup unit')
  const assetIdentity = requireUtf8Text(
    input.assetIdentity,
    ASSET_ID_MAX_BYTES,
    'encrypted backup asset identity',
  )
  return toLowerHex(
    await hkdf(
      authority.runtime,
      authority.assetLocatorRoot,
      locatorInfo('asset-locator', input.keyHandle.realm, mintUrl, unit, assetIdentity),
    ),
  )
}

export async function deriveEncryptedWalletBackupV2OperationLocator(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  operationId: string
}): Promise<string> {
  const authority = requireKeyAuthority(input.keyHandle)
  const operationId = requireUtf8Text(
    input.operationId,
    OPERATION_ID_MAX_BYTES,
    'encrypted backup operation id',
  )
  return toLowerHex(
    await hkdf(
      authority.runtime,
      authority.operationLocatorRoot,
      locatorInfo('operation-locator', input.keyHandle.realm, operationId),
    ),
  )
}

async function deriveKeyAuthority(
  seed: Uint8Array,
  realm: string,
  runtime: EncryptedWalletBackupV2Runtime,
): Promise<KeyAuthority> {
  const [
    vaultIdRoot,
    requestAuthRoot,
    portfolioReportingRoot,
    assetLocatorRoot,
    operationLocatorRoot,
  ] = await Promise.all([
    deriveRoot(seed, realm, 'vault-id-root', runtime),
    deriveRoot(seed, realm, 'request-auth-root', runtime),
    deriveRoot(seed, realm, 'portfolio-reporting-root', runtime),
    deriveRoot(seed, realm, 'asset-locator-root', runtime),
    deriveRoot(seed, realm, 'operation-locator-root', runtime),
  ])
  return Object.freeze({
    vaultIdRoot,
    requestAuthRoot,
    portfolioReportingRoot,
    assetLocatorRoot,
    operationLocatorRoot,
    runtime,
  })
}

function deriveRoot(
  seed: Uint8Array,
  realm: string,
  domain: string,
  runtime: EncryptedWalletBackupV2Runtime,
): Promise<Uint8Array> {
  return hkdf(runtime, seed, rootInfo(domain, realm))
}

function deriveVaultId(authority: KeyAuthority, realm: string): Promise<Uint8Array> {
  return hkdf(authority.runtime, authority.vaultIdRoot, rootInfo('vault-id', realm))
}

async function deriveScalar(
  root: Uint8Array,
  realm: string,
  domain: 'portfolio-reporting-scalar' | 'request-auth-scalar',
  runtime: EncryptedWalletBackupV2Runtime,
): Promise<Uint8Array> {
  for (let counter = 0; counter < SCALAR_ATTEMPTS; counter += 1) {
    const candidate = await hkdf(runtime, root, scalarInfo(domain, realm, counter))
    const scalar = bytesToBigInt(candidate)
    if (scalar > 0n && scalar < SECP256K1_ORDER) return candidate
  }
  throw new Error('encrypted backup scalar derivation exhausted')
}

async function hkdf(
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
      salt: exactEncryptedWalletBackupArrayBuffer(ROOT_SALT),
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

function rootInfo(domain: string, realm: string): Uint8Array {
  return encodeCanonicalBackupCbor([ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION, domain, realm])
}

function scalarInfo(domain: string, realm: string, counter: number): Uint8Array {
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    domain,
    realm,
    counter,
  ])
}

function locatorInfo(domain: string, realm: string, ...identity: string[]): Uint8Array {
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    domain,
    realm,
    ...identity,
  ])
}

function requireKeyAuthority(value: unknown): KeyAuthority {
  if (typeof value !== 'object' || value === null)
    throw new Error('encrypted backup key handle is invalid')
  const authority = KEY_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('encrypted backup key handle is invalid')
  return authority
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

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  return result
}

function toLowerHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
