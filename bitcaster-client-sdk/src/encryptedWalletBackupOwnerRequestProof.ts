import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor as cbor,
  preflightEncryptedBackupOwnerProofCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  equalBytes,
  requireBytes,
  requireLowerHex,
  requireRealm,
  requireInteger,
  requireBoundedInteger,
  requireDelegatedMethod,
  requireExactHttpsUrl,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'
import {
  requireEncryptedWalletBackupV2KeyAuthority,
  deriveEncryptedWalletBackupV2RequestAuthScalar,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import type { EncryptedWalletBackupRequestMethod } from './encryptedWalletBackup.ts'
import { isEncryptedWalletBackupRequestFresh } from './encryptedWalletBackup.ts'
import {
  requireEncryptedWalletBackupCycleSignal,
  throwIfEncryptedWalletBackupCycleAborted,
} from './encryptedWalletBackupDeadline.ts'

export type EncryptedWalletBackupOwnerOperation =
  | 'owner-discovery'
  | 'enrollment-epoch'
  | 'current-inventory'
  | 'descriptor-page'
  | 'bundle-supersession'
  | 'object-get'
export interface EncryptedWalletBackupOwnerRequestProof {
  readonly formatVersion: 2
  readonly purpose: 'scoped' | 'owner-discovery'
  readonly ownerScopeId: string | null
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
export type EncryptedWalletBackupOwnerRouteContext = {
  readonly operation: EncryptedWalletBackupOwnerOperation
  readonly realm: string
  readonly walletId: string
  readonly ownerScopeId: string | null
  readonly requestedCursor: string | null
}
export interface VerifiedEncryptedWalletBackupOwnerRequest {
  readonly state: 'verified'
  readonly claims: EncryptedWalletBackupOwnerRequestProof
  readonly requestDigest: string
  readonly route: EncryptedWalletBackupOwnerRouteContext
}
const VERIFIED = new WeakSet<object>()
const ISSUED = new WeakMap<
  object,
  { route: EncryptedWalletBackupOwnerRouteContext; signal: AbortSignal }
>()
const FIELDS = [
  'formatVersion',
  'purpose',
  'ownerScopeId',
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
].sort()
const MAX_PAYLOAD = 4 * 1024 * 1024

function claims(value: unknown): EncryptedWalletBackupOwnerRequestProof {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== FIELDS.join(',')
  )
    throw new Error('backup owner request shape')
  const v = value as EncryptedWalletBackupOwnerRequestProof
  if (v.formatVersion !== 2 || !['scoped', 'owner-discovery'].includes(v.purpose))
    throw new Error('backup owner request version')
  const ownerScopeId =
    v.ownerScopeId === null ? null : requireLowerHex(v.ownerScopeId, 32, 'owner scope')
  if ((v.purpose === 'owner-discovery') !== (ownerScopeId === null))
    throw new Error('backup owner request scope')
  const result = Object.freeze({
    formatVersion: 2 as const,
    purpose: v.purpose,
    ownerScopeId,
    realm: requireRealm(v.realm),
    walletId: requireLowerHex(v.walletId, 32, 'wallet id'),
    requestAuthPublicKey: bytesToHex(
      requireValidXOnlyPublicKey(
        hexToBytes(requireLowerHex(v.requestAuthPublicKey, 32, 'request key')),
        'request key',
      ),
    ),
    enrollmentEpoch: requireInteger(v.enrollmentEpoch, 0, 'epoch'),
    method: requireDelegatedMethod(v.method),
    url: requireExactHttpsUrl(v.url),
    issuedAtUnixSeconds: requireInteger(v.issuedAtUnixSeconds, 0, 'issued'),
    expiresAtUnixSeconds: requireInteger(v.expiresAtUnixSeconds, 0, 'expires'),
    replayNonce: requireLowerHex(v.replayNonce, 16, 'nonce'),
    payloadLength: requireBoundedInteger(v.payloadLength, 0, MAX_PAYLOAD, 'payload length'),
    payloadDigest: requireLowerHex(v.payloadDigest, 32, 'payload digest'),
    signature: requireLowerHex(v.signature, 64, 'signature'),
  })
  if (
    result.purpose === 'owner-discovery' &&
    (result.enrollmentEpoch !== 0 ||
      result.method !== 'GET' ||
      result.payloadLength !== 0 ||
      result.payloadDigest !== bytesToHex(sha256(new Uint8Array())))
  )
    throw new Error('backup owner discovery claims')
  return result
}
function tuple(v: EncryptedWalletBackupOwnerRequestProof, wire: boolean): unknown[] {
  const result: unknown[] = [
    2,
    wire ? 'backup-owner-request-proof' : 'backup-owner-request',
    v.purpose,
    v.ownerScopeId === null ? null : hexToBytes(v.ownerScopeId),
    v.realm,
    hexToBytes(v.walletId),
    hexToBytes(v.requestAuthPublicKey),
    v.enrollmentEpoch,
    v.method,
    v.url,
    v.issuedAtUnixSeconds,
    v.expiresAtUnixSeconds,
    hexToBytes(v.replayNonce),
    v.payloadLength,
    hexToBytes(v.payloadDigest),
  ]
  if (wire) result.push(hexToBytes(v.signature))
  return result
}
export function encryptedWalletBackupOwnerRequestDigest(value: unknown): string {
  return bytesToHex(sha256(cbor(tuple(claims(value), false))))
}
export function encodeEncryptedWalletBackupOwnerRequestProof(value: unknown): Uint8Array {
  const bytes = cbor(tuple(claims(value), true))
  preflightEncryptedBackupOwnerProofCbor(bytes)
  return bytes
}
export function decodeEncryptedWalletBackupOwnerRequestProof(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerRequestProof {
  preflightEncryptedBackupOwnerProofCbor(bytes)
  const t = decode(bytes)
  if (
    !Array.isArray(t) ||
    t.length !== 16 ||
    t[0] !== 2 ||
    t[1] !== 'backup-owner-request-proof' ||
    !equalBytes(bytes, cbor(t))
  )
    throw new Error('backup owner proof encoding')
  const hex = (v: unknown, n: number) => bytesToHex(requireBytes(v, n, n, 'proof bytes'))
  return claims({
    formatVersion: t[0],
    purpose: t[2],
    ownerScopeId: t[3] === null ? null : hex(t[3], 32),
    realm: t[4],
    walletId: hex(t[5], 32),
    requestAuthPublicKey: hex(t[6], 32),
    enrollmentEpoch: t[7],
    method: t[8],
    url: t[9],
    issuedAtUnixSeconds: t[10],
    expiresAtUnixSeconds: t[11],
    replayNonce: hex(t[12], 16),
    payloadLength: t[13],
    payloadDigest: hex(t[14], 32),
    signature: hex(t[15], 64),
  })
}

/** The future trusted router must supply the operation and exact target independently. */
function routeContext(
  input: EncryptedWalletBackupOwnerRouteContext,
  proof: EncryptedWalletBackupOwnerRequestProof,
): EncryptedWalletBackupOwnerRouteContext {
  const allowed: readonly string[] = [
    'owner-discovery',
    'enrollment-epoch',
    'current-inventory',
    'descriptor-page',
    'bundle-supersession',
    'object-get',
  ]
  if (!allowed.includes(input.operation)) throw new Error('backup owner route operation')
  const route = Object.freeze({
    operation: input.operation,
    realm: requireRealm(input.realm),
    walletId: requireLowerHex(input.walletId, 32, 'route wallet'),
    ownerScopeId:
      input.ownerScopeId === null ? null : requireLowerHex(input.ownerScopeId, 32, 'route owner'),
    requestedCursor:
      input.requestedCursor === null
        ? null
        : requireLowerHex(input.requestedCursor, 32, 'owner cursor'),
  })
  const listing = route.operation === 'owner-discovery'
  if (
    route.realm !== proof.realm ||
    route.walletId !== proof.walletId ||
    route.ownerScopeId !== proof.ownerScopeId ||
    listing !== (proof.purpose === 'owner-discovery') ||
    (!listing && route.requestedCursor !== null)
  )
    throw new Error('backup owner route scope')
  const discovery = listing || route.operation === 'enrollment-epoch'
  if ((discovery && proof.enrollmentEpoch !== 0) || (!discovery && proof.enrollmentEpoch < 1))
    throw new Error('backup owner route epoch')
  if (
    proof.method !== (route.operation === 'bundle-supersession' ? 'POST' : 'GET') ||
    (route.operation !== 'bundle-supersession' && proof.payloadLength !== 0)
  )
    throw new Error('backup owner route method or body')
  if (listing) {
    const u = new URL(proof.url)
    if (
      proof.url.includes('#') ||
      (route.requestedCursor === null && proof.url.includes('?')) ||
      u.search !== (route.requestedCursor === null ? '' : '?after=' + route.requestedCursor)
    )
      throw new Error('backup owner cursor target')
  }
  return route
}
export async function prepareEncryptedWalletBackupOwnerRequestProof(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  route: EncryptedWalletBackupOwnerRouteContext
  enrollmentEpoch: number
  method: EncryptedWalletBackupRequestMethod
  url: string
  issuedAtUnixSeconds: number
  expiresAtUnixSeconds: number
  payload: Uint8Array
  signal: AbortSignal
  runtime?: { getRandomValues(target: Uint8Array): Uint8Array }
}): Promise<EncryptedWalletBackupOwnerRequestProof> {
  const signal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
  const payload = requireBytes(input.payload, 0, MAX_PAYLOAD, 'payload').slice()
  const runtime = input.runtime ?? globalThis.crypto
  const random = (n: number) => {
    const b = new Uint8Array(n)
    if (runtime.getRandomValues(b) !== b) throw new Error('backup randomness')
    return b
  }
  const v = claims({
    formatVersion: 2,
    purpose: input.route.operation === 'owner-discovery' ? 'owner-discovery' : 'scoped',
    ownerScopeId: input.route.ownerScopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    enrollmentEpoch: input.enrollmentEpoch,
    method: input.method,
    url: input.url,
    issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    expiresAtUnixSeconds: input.expiresAtUnixSeconds,
    replayNonce: bytesToHex(random(16)),
    payloadLength: payload.length,
    payloadDigest: bytesToHex(sha256(payload)),
    signature: '00'.repeat(64),
  })
  const route = routeContext(input.route, v)
  if (
    !isEncryptedWalletBackupRequestFresh(
      v.issuedAtUnixSeconds,
      v.expiresAtUnixSeconds,
      v.issuedAtUnixSeconds,
    )
  )
    throw new Error('backup owner request time')
  const key = await deriveEncryptedWalletBackupV2RequestAuthScalar(authority, v.realm)
  let signature: string
  try {
    throwIfEncryptedWalletBackupCycleAborted(signal)
    signature = bytesToHex(
      schnorr.sign(hexToBytes(encryptedWalletBackupOwnerRequestDigest(v)), key, random(32)),
    )
  } finally {
    key.fill(0)
  }
  const result = Object.freeze({ ...v, signature })
  encodeEncryptedWalletBackupOwnerRequestProof(result)
  throwIfEncryptedWalletBackupCycleAborted(signal)
  ISSUED.set(result, { route, signal })
  return result
}
export function requireIssuedEncryptedWalletBackupOwnerRequest(
  value: EncryptedWalletBackupOwnerRequestProof,
) {
  const record = ISSUED.get(value)
  if (record === undefined) throw new Error('backup owner request was not issued')
  throwIfEncryptedWalletBackupCycleAborted(record.signal)
  return record.route
}
export function verifyEncryptedWalletBackupOwnerRequest(input: {
  canonicalProof: Uint8Array
  route: EncryptedWalletBackupOwnerRouteContext
  expectedMethod: EncryptedWalletBackupRequestMethod
  expectedUrl: string
  payload: Uint8Array
  serverNowUnixSeconds: number
}): VerifiedEncryptedWalletBackupOwnerRequest {
  const proof = decodeEncryptedWalletBackupOwnerRequestProof(input.canonicalProof),
    route = routeContext(input.route, proof)
  const payload = requireBytes(input.payload, 0, MAX_PAYLOAD, 'payload'),
    now = requireInteger(input.serverNowUnixSeconds, 0, 'server time')
  const requestDigest = encryptedWalletBackupOwnerRequestDigest(proof)
  if (
    proof.method !== requireDelegatedMethod(input.expectedMethod) ||
    proof.url !== requireExactHttpsUrl(input.expectedUrl) ||
    !isEncryptedWalletBackupRequestFresh(
      proof.issuedAtUnixSeconds,
      proof.expiresAtUnixSeconds,
      now,
    ) ||
    proof.payloadLength !== payload.length ||
    proof.payloadDigest !== bytesToHex(sha256(payload)) ||
    !schnorr.verify(
      hexToBytes(proof.signature),
      hexToBytes(requestDigest),
      hexToBytes(proof.requestAuthPublicKey),
    )
  )
    throw new Error('backup owner request authentication failed')
  const evidence = Object.freeze({
    state: 'verified' as const,
    claims: proof,
    requestDigest,
    route,
  })
  VERIFIED.add(evidence)
  return evidence
}
export function requireVerifiedEncryptedWalletBackupOwnerRequest(
  value: VerifiedEncryptedWalletBackupOwnerRequest,
): VerifiedEncryptedWalletBackupOwnerRequest {
  if (!VERIFIED.has(value)) throw new Error('backup owner evidence is invalid')
  return value
}
