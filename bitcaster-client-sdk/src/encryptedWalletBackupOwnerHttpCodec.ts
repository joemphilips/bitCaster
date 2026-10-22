import {
  requireIssuedEncryptedWalletBackupOwnerRequest,
  encryptedWalletBackupOwnerRequestDigest,
  type EncryptedWalletBackupOwnerRequestProof,
} from './encryptedWalletBackupOwnerRequestProof.ts'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  equalBytes,
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'
import {
  preflightEncryptedWalletBackupV2CborTuple,
  type EncryptedWalletBackupV2CborTuplePreflight,
} from './encryptedWalletBackupV2Cbor.ts'

export const ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES = 300_256 as const
export const ENCRYPTED_WALLET_BACKUP_OWNER_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES =
  65_536 as const

export type EncryptedWalletBackupOwnerHttpResponseKind =
  | 'enrollment-epoch'
  | 'current-inventory'
  | 'descriptor-page'
  | 'bundle-supersession-receipt'
  | 'object'
  | 'error'

export type EncryptedWalletBackupOwnerHttpErrorCode =
  | 'unauthorized'
  | 'replay-rejected'
  | 'conflict'
  | 'not-found'
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'

export interface EncryptedWalletBackupOwnerHttpResponseEnvelope {
  readonly kind: EncryptedWalletBackupOwnerHttpResponseKind
  readonly requestDigest: string
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly body: Uint8Array
}

const RESPONSE_PREFLIGHT: EncryptedWalletBackupV2CborTuplePreflight = {
  maximumBytes: ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES,
  maximumDepth: 2,
  maximumTokens: 32,
  maximumArrayLength: 9,
  maximumItemLength: ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES,
  fields: [
    { major: 0, exact: 3 },
    { major: 3, exact: 'encrypted-wallet-backup-v2-http-response' },
    { major: 3, alternatives: responseKinds() },
    { major: 2, exact: 32 },
    { major: 2, exact: 32 },
    { major: 3, minimum: 1, maximum: 64 },
    { major: 2, exact: 32 },
    { major: 0, minimum: 0 },
    { major: 2, minimum: 0, maximum: ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES },
  ],
}

const EPOCH_RESULT_PREFLIGHT: EncryptedWalletBackupV2CborTuplePreflight = {
  maximumBytes: 64,
  maximumDepth: 1,
  maximumTokens: 5,
  maximumArrayLength: 4,
  maximumItemLength: 64,
  fields: [
    { major: 0, exact: 3 },
    { major: 3, exact: 'enrollment-epoch-result' },
    {
      major: 3,
      alternatives: [
        { major: 3, exact: 'active' },
        { major: 3, exact: 'not-enrolled' },
      ],
    },
    { major: 0, minimum: 0 },
  ],
}

const ERROR_PREFLIGHT: EncryptedWalletBackupV2CborTuplePreflight = {
  maximumBytes: 128,
  maximumDepth: 1,
  maximumTokens: 6,
  maximumArrayLength: 5,
  maximumItemLength: 64,
  fields: [
    { major: 0, exact: 3 },
    { major: 3, exact: 'encrypted-wallet-backup-v2-error' },
    { major: 3, minimum: 1, maximum: 64 },
    { major: 3, minimum: 1, maximum: 64 },
    {
      major: 7,
      alternatives: [
        { major: 7, exact: 22 },
        { major: 0, minimum: 0 },
      ],
    },
  ],
}

/** Encodes a response that is bound to one owner request and its exact owner scope. */
export function encodeEncryptedWalletBackupOwnerHttpResponse(
  value: EncryptedWalletBackupOwnerHttpResponseEnvelope,
): Uint8Array {
  const response = decodeEnvelopeRecord(value)
  const bytes = encodeCanonicalBackupCbor([
    3,
    'encrypted-wallet-backup-v2-http-response',
    response.kind,
    hexToBytesStrict(response.requestDigest, 32, 'request digest'),
    hexToBytesStrict(response.ownerScopeId, 32, 'owner scope id'),
    response.realm,
    hexToBytesStrict(response.walletId, 32, 'wallet id'),
    response.enrollmentEpoch,
    response.body,
  ])
  if (bytes.byteLength > responseMaximumBytes(response.kind))
    throw new Error('encrypted backup owner HTTP response is too large')
  return bytes
}

/** Decodes one bounded canonical owner response envelope before service I/O consumers use it. */
export function decodeEncryptedWalletBackupOwnerHttpResponse(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerHttpResponseEnvelope {
  preflightEncryptedWalletBackupV2CborTuple(bytes, RESPONSE_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup owner HTTP response is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 9
  )
    throw new Error('encrypted backup owner HTTP response is invalid')
  if (decoded[0] !== 3 || decoded[1] !== 'encrypted-wallet-backup-v2-http-response')
    throw new Error('encrypted backup owner HTTP response is invalid')
  const kind = requireResponseKind(decoded[2])
  const enrollmentEpoch = requireEpoch(decoded[7])
  const response = Object.freeze({
    kind,
    requestDigest: bytesToHex(requireBytes(decoded[3], 32, 32, 'request digest')),
    ownerScopeId: bytesToHex(requireBytes(decoded[4], 32, 32, 'owner scope id')),
    realm: requireRealm(decoded[5]),
    walletId: bytesToHex(requireBytes(decoded[6], 32, 32, 'wallet id')),
    enrollmentEpoch,
    body: requireBytes(decoded[8], 0, responseBodyMaximumBytes(kind), 'response body').slice(),
  })
  if (bytes.byteLength > responseMaximumBytes(response.kind))
    throw new Error('encrypted backup owner HTTP response is invalid')
  return response
}

/** Decodes one response for an expected operation with its operation-specific byte bound. */
export function decodeEncryptedWalletBackupOwnerHttpResponseForKind(
  bytes: Uint8Array,
  expectedKind: Exclude<EncryptedWalletBackupOwnerHttpResponseKind, 'error'>,
): EncryptedWalletBackupOwnerHttpResponseEnvelope {
  if (bytes.byteLength > responseMaximumBytes(expectedKind))
    throw new Error('encrypted backup owner HTTP response is invalid')
  const response = decodeEncryptedWalletBackupOwnerHttpResponse(bytes)
  if (response.kind !== expectedKind && response.kind !== 'error')
    throw new Error('encrypted backup owner HTTP response kind is invalid')
  return response
}

/** Fails closed when an envelope is not for the exact V2 request and scope. */
export function requireEncryptedWalletBackupOwnerHttpResponseBinding(input: {
  readonly response: EncryptedWalletBackupOwnerHttpResponseEnvelope
  readonly kind: EncryptedWalletBackupOwnerHttpResponseKind
  readonly requestDigest: string
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
}): Uint8Array {
  const response = requireEncryptedWalletBackupOwnerHttpResponseScope(input)
  if (response.kind !== input.kind || response.kind === 'error') {
    throw new Error('encrypted backup owner HTTP response binding is invalid')
  }
  return response.body.slice()
}

export function requireEncryptedWalletBackupOwnerHttpResponseScope(input: {
  readonly response: EncryptedWalletBackupOwnerHttpResponseEnvelope
  readonly requestDigest: string
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
}): EncryptedWalletBackupOwnerHttpResponseEnvelope {
  const response = decodeEnvelopeRecord(input.response)
  if (
    response.requestDigest !== requireLowerHex(input.requestDigest, 32, 'request digest') ||
    response.ownerScopeId !== requireLowerHex(input.ownerScopeId, 32, 'owner scope id') ||
    response.realm !== requireRealm(input.realm) ||
    response.walletId !== requireLowerHex(input.walletId, 32, 'wallet id') ||
    response.enrollmentEpoch !== requireEpoch(input.enrollmentEpoch)
  )
    throw new Error('encrypted backup owner HTTP response binding is invalid')
  return response
}

export function encodeEncryptedWalletBackupOwnerHttpError(input: {
  readonly operation:
    | 'owner-discovery'
    | 'enrollment-epoch'
    | 'current-inventory'
    | 'descriptor-page'
    | 'bundle-supersession'
    | 'object-get'
  readonly code: EncryptedWalletBackupOwnerHttpErrorCode
  readonly retryAfterSeconds: number | null
}): Uint8Array {
  const code = requireErrorCode(input.code)
  const retryAfterSeconds = requireRetryAfter(input.retryAfterSeconds, code)
  return encodeCanonicalBackupCbor([
    3,
    'encrypted-wallet-backup-v2-error',
    requireErrorOperation(input.operation),
    code,
    retryAfterSeconds,
  ])
}

export function decodeEncryptedWalletBackupOwnerHttpError(bytes: Uint8Array): {
  readonly operation:
    | 'owner-discovery'
    | 'enrollment-epoch'
    | 'current-inventory'
    | 'descriptor-page'
    | 'bundle-supersession'
    | 'object-get'
  readonly code: EncryptedWalletBackupOwnerHttpErrorCode
  readonly retryAfterSeconds: number | null
} {
  preflightEncryptedWalletBackupV2CborTuple(bytes, ERROR_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup owner HTTP error is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 5
  )
    throw new Error('encrypted backup owner HTTP error is invalid')
  const code = requireErrorCode(decoded[3])
  return Object.freeze({
    operation: requireErrorOperation(decoded[2]),
    code,
    retryAfterSeconds: requireRetryAfter(decoded[4], code),
  })
}

export function encodeEncryptedWalletBackupOwnerEnrollmentEpochResult(input: {
  readonly result: 'active' | 'not-enrolled'
  readonly enrollmentEpoch: number
}): Uint8Array {
  const epoch = requireEpoch(input.enrollmentEpoch)
  if (input.result !== 'active' && input.result !== 'not-enrolled')
    throw new Error('encrypted backup owner enrollment result is invalid')
  if (input.result === 'active' && epoch < 1)
    throw new Error('encrypted backup owner enrollment epoch is invalid')
  if (input.result === 'not-enrolled' && epoch !== 0)
    throw new Error('encrypted backup owner enrollment epoch is invalid')
  return encodeCanonicalBackupCbor([3, 'enrollment-epoch-result', input.result, epoch])
}

export function decodeEncryptedWalletBackupOwnerEnrollmentEpochResult(bytes: Uint8Array): {
  readonly result: 'active' | 'not-enrolled'
  readonly enrollmentEpoch: number
} {
  preflightEncryptedWalletBackupV2CborTuple(bytes, EPOCH_RESULT_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup owner enrollment epoch result is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 4
  )
    throw new Error('encrypted backup owner enrollment epoch result is invalid')
  const result = decoded[2]
  const enrollmentEpoch = requireEpoch(decoded[3])
  if (result === 'active' && enrollmentEpoch >= 1) return Object.freeze({ result, enrollmentEpoch })
  if (result === 'not-enrolled' && enrollmentEpoch === 0)
    return Object.freeze({ result, enrollmentEpoch })
  throw new Error('encrypted backup owner enrollment epoch result is invalid')
}

function decodeEnvelopeRecord(value: unknown): EncryptedWalletBackupOwnerHttpResponseEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup owner HTTP response is invalid')
  const record = value as Record<string, unknown>
  const fields = [
    'kind',
    'requestDigest',
    'ownerScopeId',
    'realm',
    'walletId',
    'enrollmentEpoch',
    'body',
  ]
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup owner HTTP response is invalid')
  return Object.freeze({
    kind: requireResponseKind(record.kind),
    requestDigest: requireLowerHex(record.requestDigest, 32, 'request digest'),
    ownerScopeId: requireLowerHex(record.ownerScopeId, 32, 'owner scope id'),
    realm: requireRealm(record.realm),
    walletId: requireLowerHex(record.walletId, 32, 'wallet id'),
    enrollmentEpoch: requireEpoch(record.enrollmentEpoch),
    body: requireBytes(
      record.body,
      0,
      responseBodyMaximumBytes(requireResponseKind(record.kind)),
      'response body',
    ).slice(),
  })
}

function requireResponseKind(value: unknown): EncryptedWalletBackupOwnerHttpResponseKind {
  switch (value) {
    case 'enrollment-epoch':
    case 'current-inventory':
    case 'descriptor-page':
    case 'bundle-supersession-receipt':
    case 'object':
    case 'error':
      return value
    default:
      throw new Error('encrypted backup owner HTTP response kind is invalid')
  }
}

function requireEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0)
    throw new Error('encrypted backup owner enrollment epoch is invalid')
  return value
}

function responseKinds() {
  return [
    { major: 3 as const, exact: 'enrollment-epoch' },
    { major: 3 as const, exact: 'current-inventory' },
    { major: 3 as const, exact: 'descriptor-page' },
    { major: 3 as const, exact: 'bundle-supersession-receipt' },
    { major: 3 as const, exact: 'object' },
    { major: 3 as const, exact: 'error' },
  ] as const
}

function requireErrorOperation(
  value: unknown,
):
  | 'owner-discovery'
  | 'enrollment-epoch'
  | 'current-inventory'
  | 'descriptor-page'
  | 'bundle-supersession'
  | 'object-get' {
  switch (value) {
    case 'owner-discovery':
    case 'enrollment-epoch':
    case 'current-inventory':
    case 'descriptor-page':
    case 'bundle-supersession':
    case 'object-get':
      return value
    default:
      throw new Error('encrypted backup owner error operation is invalid')
  }
}

export function encryptedWalletBackupOwnerHttpResponseMaximumBytes(
  kind: EncryptedWalletBackupOwnerHttpResponseKind,
): number {
  return responseMaximumBytes(kind)
}

function responseMaximumBytes(kind: EncryptedWalletBackupOwnerHttpResponseKind): number {
  return kind === 'current-inventory'
    ? ENCRYPTED_WALLET_BACKUP_OWNER_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES
    : ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES
}

function requireErrorCode(value: unknown): EncryptedWalletBackupOwnerHttpErrorCode {
  switch (value) {
    case 'unauthorized':
    case 'replay-rejected':
    case 'conflict':
    case 'not-found':
    case 'quota-exceeded':
    case 'rate-limited':
    case 'overloaded':
    case 'unavailable':
      return value
    default:
      throw new Error('encrypted backup owner error code is invalid')
  }
}

function requireRetryAfter(
  value: unknown,
  code: EncryptedWalletBackupOwnerHttpErrorCode,
): number | null {
  if (value === null) return null
  if (
    (code !== 'rate-limited' && code !== 'overloaded' && code !== 'unavailable') ||
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3_600
  )
    throw new Error('encrypted backup owner retry value is invalid')
  return value
}

/** Requires a genuine live request; a caller-supplied DTO cannot select response authority. */
export function consumeEncryptedWalletBackupOwnerHttpResponse(input: {
  readonly request: EncryptedWalletBackupOwnerRequestProof
  readonly bytes: Uint8Array
}): EncryptedWalletBackupOwnerHttpResponseEnvelope {
  const request = input.request
  const route = requireIssuedEncryptedWalletBackupOwnerRequest(request)
  if (route.ownerScopeId === null || route.operation === 'owner-discovery')
    throw new Error('encrypted backup scoped response purpose is invalid')
  const kind =
    route.operation === 'object-get'
      ? 'object'
      : route.operation === 'bundle-supersession'
        ? 'bundle-supersession-receipt'
        : route.operation
  const response = decodeEncryptedWalletBackupOwnerHttpResponseForKind(input.bytes, kind)
  requireEncryptedWalletBackupOwnerHttpResponseScope({
    response,
    ownerScopeId: route.ownerScopeId,
    realm: route.realm,
    walletId: route.walletId,
    enrollmentEpoch: request.enrollmentEpoch,
    requestDigest: encryptedWalletBackupOwnerRequestDigest(request),
  })
  if (
    response.kind === 'error' &&
    decodeEncryptedWalletBackupOwnerHttpError(response.body).operation !== route.operation
  )
    throw new Error('encrypted backup error operation is invalid')
  return response
}

function responseBodyMaximumBytes(kind: EncryptedWalletBackupOwnerHttpResponseKind): number {
  switch (kind) {
    case 'object':
      return 300000
    case 'current-inventory':
      return 60000
    case 'descriptor-page':
    case 'bundle-supersession-receipt':
      return 65536
    case 'error':
      return 128
    case 'enrollment-epoch':
      return 64
  }
}
