import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  encryptedWalletBackupRequestDigest,
  type EncryptedWalletBackupRequestMethod,
  type EncryptedWalletBackupRequestProof,
  verifyEncryptedWalletBackupRequestProofEvidence,
} from './encryptedWalletBackup.ts'
import {
  deriveEncryptedWalletBackupV2RequestAuthScalar,
  requireEncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupV2Limits.ts'

declare const V2_REQUEST_PROOF: unique symbol

/** A V2 caller capability over the stable request-proof wire. */
export type EncryptedWalletBackupV2RequestProof = EncryptedWalletBackupRequestProof & {
  readonly [V2_REQUEST_PROOF]: true
}

const ISSUED = new WeakSet<object>()

export interface EncryptedWalletBackupV2RequestProofRuntime {
  getRandomValues(target: Uint8Array): Uint8Array
}

export async function prepareEncryptedWalletBackupV2RequestProof(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly enrollmentEpoch: number
  readonly method: EncryptedWalletBackupRequestMethod
  readonly url: string
  readonly issuedAtUnixSeconds: number
  readonly expiresAtUnixSeconds: number
  readonly payload: Uint8Array
  readonly signal: AbortSignal
  readonly runtime?: EncryptedWalletBackupV2RequestProofRuntime
}): Promise<EncryptedWalletBackupV2RequestProof> {
  return prepareProof(input, 1)
}

export async function prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly url: string
  readonly issuedAtUnixSeconds: number
  readonly expiresAtUnixSeconds: number
  readonly signal: AbortSignal
  readonly runtime?: EncryptedWalletBackupV2RequestProofRuntime
}): Promise<EncryptedWalletBackupV2RequestProof> {
  return prepareProof({ ...input, enrollmentEpoch: 0, method: 'GET', payload: new Uint8Array() }, 0)
}

export function requireEncryptedWalletBackupV2RequestProof(
  value: unknown,
): EncryptedWalletBackupV2RequestProof {
  if (typeof value !== 'object' || value === null || !ISSUED.has(value))
    throw new Error('encrypted backup v2 request proof is invalid')
  return value as EncryptedWalletBackupV2RequestProof
}

async function prepareProof(
  input: {
    readonly keyHandle: EncryptedWalletBackupV2KeyHandle
    readonly enrollmentEpoch: number
    readonly method: EncryptedWalletBackupRequestMethod
    readonly url: string
    readonly issuedAtUnixSeconds: number
    readonly expiresAtUnixSeconds: number
    readonly payload: Uint8Array
    readonly signal: AbortSignal
    readonly runtime?: EncryptedWalletBackupV2RequestProofRuntime
  },
  minimumEpoch: 0 | 1,
): Promise<EncryptedWalletBackupV2RequestProof> {
  requireActiveSignal(input.signal)
  const epoch = requireEpoch(input.enrollmentEpoch, minimumEpoch)
  const payload = requirePayload(input.payload)
  const runtime = requireRuntime(input.runtime)
  const replayNonce = randomBytes(runtime, 16)
  const auxiliaryRandomness = randomBytes(runtime, 32)
  const unsigned = createUnsignedProof(input, epoch, payload, replayNonce)
  const digest = encryptedWalletBackupRequestDigest(
    unsigned,
    ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  )
  const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
  const scalar = await deriveEncryptedWalletBackupV2RequestAuthScalar(
    authority,
    input.keyHandle.realm,
  )
  requireActiveSignal(input.signal)
  const proof = Object.freeze({
    ...unsigned,
    signature: bytesToHex(schnorr.sign(hexToBytes(digest), scalar, auxiliaryRandomness)),
  }) as EncryptedWalletBackupV2RequestProof
  verifyEncryptedWalletBackupRequestProofEvidence({
    proof,
    expectedMethod: proof.method,
    expectedUrl: proof.url,
    payload,
    serverNowUnixSeconds: proof.issuedAtUnixSeconds,
    maximumPayloadBytes: ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  })
  ISSUED.add(proof)
  return proof
}

function createUnsignedProof(
  input: {
    readonly keyHandle: EncryptedWalletBackupV2KeyHandle
    readonly method: EncryptedWalletBackupRequestMethod
    readonly url: string
    readonly issuedAtUnixSeconds: number
    readonly expiresAtUnixSeconds: number
  },
  enrollmentEpoch: number,
  payload: Uint8Array,
  replayNonce: Uint8Array,
): EncryptedWalletBackupRequestProof {
  requireFreshness(input.issuedAtUnixSeconds, input.expiresAtUnixSeconds)
  return Object.freeze({
    formatVersion: 1,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    enrollmentEpoch,
    method: input.method,
    url: input.url,
    issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    expiresAtUnixSeconds: input.expiresAtUnixSeconds,
    replayNonce: bytesToHex(replayNonce),
    payloadLength: payload.byteLength,
    payloadDigest: bytesToHex(sha256(payload)),
    signature: '00'.repeat(64),
  })
}

function requireEpoch(value: unknown, minimum: 0 | 1): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum)
    throw new Error('encrypted backup v2 enrollment epoch is invalid')
  if (minimum === 0 && value !== 0)
    throw new Error('encrypted backup v2 discovery epoch is invalid')
  return value
}

function requireFreshness(issuedAt: number, expiresAt: number): void {
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 60
  )
    throw new Error('encrypted backup v2 request freshness is invalid')
}

function requirePayload(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength > ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES
  )
    throw new Error('encrypted backup v2 request payload is invalid')
  return value.slice()
}

function requireRuntime(
  value: EncryptedWalletBackupV2RequestProofRuntime | undefined,
): EncryptedWalletBackupV2RequestProofRuntime {
  const runtime = value ?? globalThis.crypto
  if (runtime === undefined || typeof runtime.getRandomValues !== 'function')
    throw new Error('encrypted backup v2 random runtime is unavailable')
  return { getRandomValues: (target) => runtime.getRandomValues(target) }
}

function randomBytes(
  runtime: EncryptedWalletBackupV2RequestProofRuntime,
  length: number,
): Uint8Array {
  const target = new Uint8Array(length)
  const returned = runtime.getRandomValues(target)
  if (!(returned instanceof Uint8Array) || returned !== target)
    throw new Error('encrypted backup v2 random runtime is invalid')
  return target
}

function requireActiveSignal(value: unknown): asserts value is AbortSignal {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as AbortSignal).aborted !== 'boolean'
  )
    throw new Error('encrypted backup v2 request signal is invalid')
  if ((value as AbortSignal).aborted) throw new Error('encrypted backup v2 request aborted')
}
