import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor as cbor,
  preflightEncryptedBackupOwnerAccountRequestCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  decodeEncryptedWalletBackupAccountIntent,
  decodeEncryptedWalletBackupAccountRequest,
  type DecodedEncryptedWalletBackupAccountRequest,
} from './encryptedWalletBackupServerCodec.ts'
import {
  equalBytes,
  requireBytes,
  requireLowerHex,
  requireExactHttpsUrl,
  requireRealm,
  requireInteger,
} from './encryptedWalletBackupServerValidation.ts'
import {
  deriveEncryptedWalletBackupOwnerScope,
  type EncryptedWalletBackupOwnerScope,
} from './encryptedWalletBackupOwnerScope.ts'
import {
  deriveEncryptedWalletBackupV2RequestAuthScalar,
  requireEncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import type { EncryptedWalletBackupAccountAuthorizationPort } from './encryptedWalletBackupEnrollment.ts'
import {
  awaitEncryptedWalletBackupCycle,
  requireEncryptedWalletBackupCycleSignal,
  throwIfEncryptedWalletBackupCycleAborted,
} from './encryptedWalletBackupDeadline.ts'

export interface EncryptedWalletBackupOwnerAccountAuthorizationPort {
  authorizeBackupAccountOperation(
    input: Parameters<
      EncryptedWalletBackupAccountAuthorizationPort['authorizeBackupAccountOperation']
    >[0],
  ): Promise<
    Readonly<{
      scheme: string
      authorization: Uint8Array
      ownerSubject: string
    }>
  >
}

type PublicTarget = Pick<
  EncryptedWalletBackupV2KeyHandle,
  'realm' | 'walletId' | 'requestAuthPublicKey'
>
export type EncryptedWalletBackupOwnerAccountInput = {
  url: string
  operationId: string
  expectedEnrollmentEpoch: number
  authorizationPort: EncryptedWalletBackupOwnerAccountAuthorizationPort
  signal: AbortSignal
  runtime?: { getRandomValues(target: Uint8Array): Uint8Array }
} & (
  | { action: 'enroll'; keyHandle: EncryptedWalletBackupV2KeyHandle }
  | { action: 'revoke' | 'delete'; target: PublicTarget }
)

export interface PreparedEncryptedWalletBackupOwnerAccountOperation extends EncryptedWalletBackupOwnerScope {
  readonly formatVersion: 2
  readonly canonicalRequest: Uint8Array
  readonly intentDigest: string
}
const PREPARED = new WeakMap<object, { bytes: Uint8Array; signal: AbortSignal }>()

export interface DecodedEncryptedWalletBackupOwnerAccountRequest {
  readonly formatVersion: 2
  readonly authorizedRequestBytes: Uint8Array
  readonly accountRequest: DecodedEncryptedWalletBackupAccountRequest
  readonly possession: Uint8Array | null
}

function possessionDigest(authorized: Uint8Array): Uint8Array {
  return sha256(cbor([1, 'backup-account-request-possession', authorized]))
}

/** Structural decoding does not authenticate an account or grant server authority. */
export function decodeEncryptedWalletBackupOwnerAccountRequest(
  bytes: Uint8Array,
): DecodedEncryptedWalletBackupOwnerAccountRequest {
  preflightEncryptedBackupOwnerAccountRequestCbor(bytes)
  const tuple = decode(bytes)
  if (
    !equalBytes(bytes, cbor(tuple)) ||
    !Array.isArray(tuple) ||
    tuple.length !== 4 ||
    tuple[0] !== 2 ||
    tuple[1] !== 'backup-account-request'
  )
    throw new Error('backup owner account request is invalid')
  const authorizedRequestBytes = requireBytes(
    tuple[2],
    1,
    20480,
    'authorized account request',
  ).slice()
  const accountRequest = decodeEncryptedWalletBackupAccountRequest(authorizedRequestBytes)
  const possession =
    accountRequest.intent.action === 'enroll'
      ? requireBytes(tuple[3], 64, 64, 'account possession').slice()
      : null
  if (accountRequest.intent.action !== 'enroll' && tuple[3] !== null)
    throw new Error('backup owner account possession is invalid')
  return Object.freeze({ formatVersion: 2, authorizedRequestBytes, accountRequest, possession })
}

/** Use only after the account credential is independently verified. */
export function verifyEncryptedWalletBackupOwnerAccountPossession(
  request: DecodedEncryptedWalletBackupOwnerAccountRequest,
): void {
  if (
    request.accountRequest.intent.action === 'enroll' &&
    (request.possession === null ||
      !schnorr.verify(
        request.possession,
        possessionDigest(request.authorizedRequestBytes),
        hexToBytes(request.accountRequest.intent.requestAuthPublicKey),
      ))
  )
    throw new Error('backup owner account possession failed')
}

export async function prepareEncryptedWalletBackupOwnerAccountOperation(
  input: EncryptedWalletBackupOwnerAccountInput,
): Promise<PreparedEncryptedWalletBackupOwnerAccountOperation> {
  const signal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const authority =
    input.action === 'enroll' ? requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle) : null
  const target = input.action === 'enroll' ? input.keyHandle : input.target
  const method = input.action === 'delete' ? 'DELETE' : 'POST'
  const operationId = requireLowerHex(input.operationId, 16, 'account operation id')
  const intentBytes = cbor([
    1,
    'backup-account-operation',
    input.action,
    method,
    requireExactHttpsUrl(input.url),
    requireRealm(target.realm),
    hexToBytes(requireLowerHex(target.walletId, 32, 'wallet id')),
    hexToBytes(requireLowerHex(target.requestAuthPublicKey, 32, 'request key')),
    requireInteger(
      input.expectedEnrollmentEpoch,
      input.action === 'enroll' ? 0 : 1,
      'account epoch',
    ),
    hexToBytes(operationId),
  ])
  const intent = decodeEncryptedWalletBackupAccountIntent(intentBytes)
  const intentDigest = bytesToHex(sha256(intentBytes))
  const result = await awaitEncryptedWalletBackupCycle(
    input.authorizationPort.authorizeBackupAccountOperation({
      action: intent.action,
      method: intent.method,
      url: intent.url,
      operationId,
      intentDigest,
      canonicalIntent: intentBytes.slice(),
      signal,
    }),
    signal,
  )
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const owner = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: result.scheme,
    ownerSubject: result.ownerSubject,
  })
  const authorized = cbor([
    1,
    'backup-account-request',
    intentBytes,
    hexToBytes(intentDigest),
    owner.authorizationScheme,
    requireBytes(result.authorization, 1, 16384, 'account authorization').slice(),
  ])
  decodeEncryptedWalletBackupAccountRequest(authorized)
  let possession: Uint8Array | null = null
  if (authority !== null) {
    const scalar = await deriveEncryptedWalletBackupV2RequestAuthScalar(authority, intent.realm)
    try {
      throwIfEncryptedWalletBackupCycleAborted(signal)
      const randomness = new Uint8Array(32)
      const runtime = input.runtime ?? globalThis.crypto
      runtime.getRandomValues(randomness)
      possession = schnorr.sign(possessionDigest(authorized), scalar, randomness)
    } finally {
      scalar.fill(0)
    }
  }
  const bytes = cbor([2, 'backup-account-request', authorized, possession])
  const decoded = decodeEncryptedWalletBackupOwnerAccountRequest(bytes)
  verifyEncryptedWalletBackupOwnerAccountPossession(decoded)
  throwIfEncryptedWalletBackupCycleAborted(signal)
  const prepared = Object.freeze({
    formatVersion: 2 as const,
    ...owner,
    canonicalRequest: bytes.slice(),
    intentDigest,
  })
  PREPARED.set(prepared, { bytes, signal })
  return prepared
}

export function readPreparedEncryptedWalletBackupOwnerAccountOperation(
  value: PreparedEncryptedWalletBackupOwnerAccountOperation,
): Uint8Array {
  const authority = PREPARED.get(value)
  if (authority === undefined) throw new Error('backup owner operation is not prepared')
  throwIfEncryptedWalletBackupCycleAborted(authority.signal)
  return authority.bytes.slice()
}
