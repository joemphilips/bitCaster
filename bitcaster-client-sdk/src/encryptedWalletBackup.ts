import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'

export const ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION = 1 as const
const REQUEST_PAYLOAD_MAXIMUM = 4 * 1_024 * 1_024

export type EncryptedWalletBackupRemoteBackoffStatus =
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'

export class EncryptedWalletBackupRemoteFailureError extends Error {}

/** A redacted remote result that is safe for the V2 scheduler to persist. */
export class EncryptedWalletBackupRemoteBackoffError extends EncryptedWalletBackupRemoteFailureError {
  readonly status: EncryptedWalletBackupRemoteBackoffStatus
  readonly retryAfterSeconds: number | null

  constructor(status: EncryptedWalletBackupRemoteBackoffStatus, retryAfterSeconds?: number | null) {
    if (!['quota-exceeded', 'rate-limited', 'overloaded', 'unavailable'].includes(status)) {
      throw new Error('encrypted backup backoff status is invalid')
    }
    if (status === 'quota-exceeded' && retryAfterSeconds != null) {
      throw new Error('encrypted backup quota backoff must not include retry-after')
    }
    if (
      retryAfterSeconds != null &&
      (!Number.isSafeInteger(retryAfterSeconds) ||
        retryAfterSeconds < 1 ||
        retryAfterSeconds > 3_600)
    ) {
      throw new Error('encrypted backup retry-after is invalid')
    }
    super(`encrypted backup remote backoff: ${status}`)
    this.name = 'EncryptedWalletBackupRemoteBackoffError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds ?? null
  }

  delayMilliseconds(defaultMilliseconds = 5_000): number {
    if (
      !Number.isSafeInteger(defaultMilliseconds) ||
      defaultMilliseconds < 1 ||
      defaultMilliseconds > 3_600_000
    ) {
      throw new Error('encrypted backup default backoff is invalid')
    }
    return this.retryAfterSeconds === null ? defaultMilliseconds : this.retryAfterSeconds * 1_000
  }
}

export type EncryptedWalletBackupRequestMethod = 'GET' | 'PUT' | 'POST' | 'DELETE'

/** Stable shared account and V2 delegated-request wire. */
export interface EncryptedWalletBackupRequestProof {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly realm: string
  readonly walletId: string
  readonly requestAuthPublicKey: string
  readonly enrollmentEpoch: number
  readonly method: EncryptedWalletBackupRequestMethod
  readonly url: string
  readonly issuedAtUnixSeconds: number
  readonly expiresAtUnixSeconds: number
  readonly replayNonce: string
  readonly payloadLength: number
  readonly payloadDigest: string
  readonly signature: string
}

export interface EncryptedWalletBackupReplayStore {
  consumeReplayNonce(input: {
    readonly realm: string
    readonly walletId: string
    readonly requestAuthPublicKey: string
    readonly enrollmentEpoch: number
    readonly replayNonce: string
    readonly expiresAtUnixSeconds: number
    readonly requestDigest: string
  }): Promise<'consumed' | 'replayed'>
}

export interface AuthenticatedEncryptedWalletBackupRequestEvidence {
  readonly state: 'authenticated'
  readonly requestDigest: string
  readonly replayNonce: string
}

export interface VerifiedEncryptedWalletBackupRequestProofEvidence {
  readonly state: 'verified'
  readonly claims: EncryptedWalletBackupRequestProof
}

export class EncryptedWalletBackupReplayRejectedError extends Error {
  constructor() {
    super('encrypted backup request replayed')
    this.name = 'EncryptedWalletBackupReplayRejectedError'
  }
}

export class EncryptedWalletBackupReplayStoreUnavailableError extends Error {
  constructor() {
    super('encrypted backup replay store unavailable')
    this.name = 'EncryptedWalletBackupReplayStoreUnavailableError'
  }
}

const VERIFIED_PROOFS = new WeakMap<
  object,
  Readonly<{ proof: EncryptedWalletBackupRequestProof; requestDigest: string }>
>()

/** Verify exact method, target, payload, freshness, and Schnorr signature before replay I/O. */
export function verifyEncryptedWalletBackupRequestProofEvidence(input: {
  readonly proof: unknown
  readonly expectedMethod: EncryptedWalletBackupRequestMethod
  readonly expectedUrl: string
  readonly payload: Uint8Array
  readonly serverNowUnixSeconds: number
  readonly maximumPayloadBytes?: number
}): VerifiedEncryptedWalletBackupRequestProofEvidence {
  const maximumPayloadBytes = requirePayloadMaximum(input.maximumPayloadBytes)
  const proof = decodeProof(input.proof, maximumPayloadBytes)
  const payload = requirePayload(input.payload, maximumPayloadBytes)
  const now = requireInteger(input.serverNowUnixSeconds, 0, 'server time')
  if (
    proof.method !== requireMethod(input.expectedMethod) ||
    proof.url !== requireHttpsUrl(input.expectedUrl) ||
    proof.expiresAtUnixSeconds <= proof.issuedAtUnixSeconds ||
    proof.expiresAtUnixSeconds - proof.issuedAtUnixSeconds > 60 ||
    proof.issuedAtUnixSeconds > now + 30 ||
    now > proof.expiresAtUnixSeconds ||
    proof.payloadLength !== payload.byteLength ||
    proof.payloadDigest !== bytesToHex(sha256(payload)) ||
    !schnorr.verify(
      hexToBytes(proof.signature),
      hexToBytes(encryptedWalletBackupRequestDigest(proof, maximumPayloadBytes)),
      hexToBytes(proof.requestAuthPublicKey),
    )
  ) {
    throw new Error('encrypted backup request authentication failed')
  }
  const evidence = Object.freeze({ state: 'verified' as const, claims: proof })
  VERIFIED_PROOFS.set(
    evidence,
    Object.freeze({
      proof,
      requestDigest: encryptedWalletBackupRequestDigest(proof, maximumPayloadBytes),
    }),
  )
  return evidence
}

export function encodeEncryptedWalletBackupRequestProof(
  value: EncryptedWalletBackupRequestProof,
  maximumPayloadBytes?: number,
): Uint8Array {
  const proof = decodeProof(value, requirePayloadMaximum(maximumPayloadBytes))
  return encodeCanonicalBackupCbor([
    1,
    'backup-request-proof',
    proof.realm,
    hexToBytes(proof.walletId),
    hexToBytes(proof.requestAuthPublicKey),
    proof.enrollmentEpoch,
    proof.method,
    proof.url,
    proof.issuedAtUnixSeconds,
    proof.expiresAtUnixSeconds,
    hexToBytes(proof.replayNonce),
    proof.payloadLength,
    hexToBytes(proof.payloadDigest),
    hexToBytes(proof.signature),
  ])
}

/** Returns the digest of the signed request preimage, not of its envelope. */
export function encryptedWalletBackupRequestDigest(
  value: EncryptedWalletBackupRequestProof,
  maximumPayloadBytes?: number,
): string {
  const proof = decodeProof(value, requirePayloadMaximum(maximumPayloadBytes))
  return bytesToHex(sha256(encodePreimage(proof)))
}

export async function consumeEncryptedWalletBackupVerifiedRequestReplay(input: {
  readonly verifiedProof: VerifiedEncryptedWalletBackupRequestProofEvidence
  readonly replayStore: EncryptedWalletBackupReplayStore
}): Promise<AuthenticatedEncryptedWalletBackupRequestEvidence> {
  if (
    typeof input.replayStore !== 'object' ||
    input.replayStore === null ||
    typeof input.replayStore.consumeReplayNonce !== 'function'
  ) {
    throw new Error('encrypted backup replay store is invalid')
  }
  const authority = VERIFIED_PROOFS.get(input.verifiedProof)
  if (authority === undefined) throw new Error('encrypted backup verified request proof is invalid')
  let result: 'consumed' | 'replayed'
  try {
    result = await input.replayStore.consumeReplayNonce({
      realm: authority.proof.realm,
      walletId: authority.proof.walletId,
      requestAuthPublicKey: authority.proof.requestAuthPublicKey,
      enrollmentEpoch: authority.proof.enrollmentEpoch,
      replayNonce: authority.proof.replayNonce,
      expiresAtUnixSeconds: authority.proof.expiresAtUnixSeconds,
      requestDigest: authority.requestDigest,
    })
  } catch {
    throw new EncryptedWalletBackupReplayStoreUnavailableError()
  }
  if (result === 'replayed') throw new EncryptedWalletBackupReplayRejectedError()
  if (result !== 'consumed') throw new EncryptedWalletBackupReplayStoreUnavailableError()
  return Object.freeze({
    state: 'authenticated' as const,
    requestDigest: authority.requestDigest,
    replayNonce: authority.proof.replayNonce,
  })
}

function decodeProof(
  value: unknown,
  maximumPayloadBytes: number,
): EncryptedWalletBackupRequestProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup request proof is invalid')
  const raw = value as Record<string, unknown>
  const fields = [
    'formatVersion',
    'realm',
    'walletId',
    'requestAuthPublicKey',
    'enrollmentEpoch',
    'method',
    'url',
    'issuedAtUnixSeconds',
    'expiresAtUnixSeconds',
    'replayNonce',
    'payloadLength',
    'payloadDigest',
    'signature',
  ]
  if (
    Object.keys(raw).length !== fields.length ||
    Object.keys(raw).some((field) => !fields.includes(field)) ||
    raw.formatVersion !== 1
  )
    throw new Error('encrypted backup request proof is invalid')
  return Object.freeze({
    formatVersion: 1,
    realm: requireRealm(raw.realm),
    walletId: requireHex(raw.walletId, 32, 'wallet id'),
    requestAuthPublicKey: requireHex(raw.requestAuthPublicKey, 32, 'request public key'),
    enrollmentEpoch: requireInteger(raw.enrollmentEpoch, 0, 'enrollment epoch'),
    method: requireMethod(raw.method),
    url: requireHttpsUrl(raw.url),
    issuedAtUnixSeconds: requireInteger(raw.issuedAtUnixSeconds, 0, 'request issue time'),
    expiresAtUnixSeconds: requireInteger(raw.expiresAtUnixSeconds, 0, 'request expiry time'),
    replayNonce: requireHex(raw.replayNonce, 16, 'request nonce'),
    payloadLength: requireInteger(
      raw.payloadLength,
      0,
      'request payload length',
      maximumPayloadBytes,
    ),
    payloadDigest: requireHex(raw.payloadDigest, 32, 'request payload digest'),
    signature: requireHex(raw.signature, 64, 'request signature'),
  })
}

function encodePreimage(proof: EncryptedWalletBackupRequestProof): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    'backup-request',
    proof.realm,
    hexToBytes(proof.walletId),
    hexToBytes(proof.requestAuthPublicKey),
    proof.enrollmentEpoch,
    proof.method,
    proof.url,
    proof.issuedAtUnixSeconds,
    proof.expiresAtUnixSeconds,
    hexToBytes(proof.replayNonce),
    proof.payloadLength,
    hexToBytes(proof.payloadDigest),
  ])
}

function requirePayloadMaximum(value: unknown): number {
  return value === undefined
    ? REQUEST_PAYLOAD_MAXIMUM
    : requireInteger(value, 0, 'request payload maximum', REQUEST_PAYLOAD_MAXIMUM)
}
function requirePayload(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum)
    throw new Error('request payload is invalid')
  return value
}
function requireMethod(value: unknown): EncryptedWalletBackupRequestMethod {
  if (value !== 'GET' && value !== 'PUT' && value !== 'POST' && value !== 'DELETE')
    throw new Error('request method is invalid')
  return value
}
function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value))
    throw new Error('backup realm is invalid')
  return value
}
function requireHttpsUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[^\x21-\x7e]/u.test(value)
  )
    throw new Error('request URL is invalid')
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.href !== value
  )
    throw new Error('request URL is invalid')
  return value
}
function requireHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u').test(value))
    throw new Error(`${name} is invalid`)
  return value
}
function requireInteger(
  value: unknown,
  minimum: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${name} is invalid`)
  return value as number
}
