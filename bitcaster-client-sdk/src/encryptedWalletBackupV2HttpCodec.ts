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

export const ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES = 300_256 as const
export const ENCRYPTED_WALLET_BACKUP_V2_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES = 65_536 as const

export type EncryptedWalletBackupV2HttpResponseKind =
  | 'enrollment-epoch'
  | 'current-inventory'
  | 'descriptor-page'
  | 'bundle-supersession-receipt'
  | 'object'
  | 'error'

export type EncryptedWalletBackupV2HttpErrorCode =
  | 'unauthorized'
  | 'replay-rejected'
  | 'conflict'
  | 'not-found'
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'

export interface EncryptedWalletBackupV2HttpResponseEnvelope {
  readonly kind: EncryptedWalletBackupV2HttpResponseKind
  readonly requestDigest: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly body: Uint8Array
}

const RESPONSE_PREFLIGHT: EncryptedWalletBackupV2CborTuplePreflight = {
  maximumBytes: ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
  maximumDepth: 2,
  maximumTokens: 32,
  maximumArrayLength: 8,
  maximumItemLength: ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
  fields: [
    { major: 0, exact: 2 },
    { major: 3, exact: 'encrypted-wallet-backup-v2-http-response' },
    { major: 3, alternatives: responseKinds() },
    { major: 2, exact: 32 },
    { major: 3, minimum: 1, maximum: 64 },
    { major: 2, exact: 32 },
    { major: 0, minimum: 0 },
    { major: 2, minimum: 0, maximum: ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES },
  ],
}

const EPOCH_RESULT_PREFLIGHT: EncryptedWalletBackupV2CborTuplePreflight = {
  maximumBytes: 64,
  maximumDepth: 1,
  maximumTokens: 5,
  maximumArrayLength: 4,
  maximumItemLength: 64,
  fields: [
    { major: 0, exact: 2 },
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
    { major: 0, exact: 2 },
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

/** Encodes a response that is bound to one V2 request and one V2 wallet scope. */
export function encodeEncryptedWalletBackupV2HttpResponse(
  value: EncryptedWalletBackupV2HttpResponseEnvelope,
): Uint8Array {
  const response = decodeEnvelopeRecord(value)
  const bytes = encodeCanonicalBackupCbor([
    2,
    'encrypted-wallet-backup-v2-http-response',
    response.kind,
    hexToBytesStrict(response.requestDigest, 32, 'request digest'),
    response.realm,
    hexToBytesStrict(response.walletId, 32, 'wallet id'),
    response.enrollmentEpoch,
    response.body,
  ])
  if (bytes.byteLength > responseMaximumBytes(response.kind))
    throw new Error('encrypted backup v2 HTTP response is too large')
  return bytes
}

/** Decodes one bounded canonical V2 response envelope before service I/O consumers use it. */
export function decodeEncryptedWalletBackupV2HttpResponse(
  bytes: Uint8Array,
): EncryptedWalletBackupV2HttpResponseEnvelope {
  preflightEncryptedWalletBackupV2CborTuple(bytes, RESPONSE_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup v2 HTTP response is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 8
  )
    throw new Error('encrypted backup v2 HTTP response is invalid')
  if (decoded[0] !== 2 || decoded[1] !== 'encrypted-wallet-backup-v2-http-response')
    throw new Error('encrypted backup v2 HTTP response is invalid')
  const kind = requireResponseKind(decoded[2])
  const enrollmentEpoch = requireEpoch(decoded[6])
  const response = Object.freeze({
    kind,
    requestDigest: bytesToHex(requireBytes(decoded[3], 32, 32, 'request digest')),
    realm: requireRealm(decoded[4]),
    walletId: bytesToHex(requireBytes(decoded[5], 32, 32, 'wallet id')),
    enrollmentEpoch,
    body: requireBytes(
      decoded[7],
      0,
      ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
      'response body',
    ).slice(),
  })
  if (bytes.byteLength > responseMaximumBytes(response.kind))
    throw new Error('encrypted backup v2 HTTP response is invalid')
  return response
}

/** Decodes one response for an expected operation with its operation-specific byte bound. */
export function decodeEncryptedWalletBackupV2HttpResponseForKind(
  bytes: Uint8Array,
  expectedKind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
): EncryptedWalletBackupV2HttpResponseEnvelope {
  if (bytes.byteLength > responseMaximumBytes(expectedKind))
    throw new Error('encrypted backup v2 HTTP response is invalid')
  const response = decodeEncryptedWalletBackupV2HttpResponse(bytes)
  if (response.kind !== expectedKind && response.kind !== 'error')
    throw new Error('encrypted backup v2 HTTP response kind is invalid')
  return response
}

/** Fails closed when an envelope is not for the exact V2 request and scope. */
export function requireEncryptedWalletBackupV2HttpResponseBinding(input: {
  readonly response: EncryptedWalletBackupV2HttpResponseEnvelope
  readonly kind: EncryptedWalletBackupV2HttpResponseKind
  readonly requestDigest: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
}): Uint8Array {
  const response = requireEncryptedWalletBackupV2HttpResponseScope(input)
  if (response.kind !== input.kind || response.kind === 'error') {
    throw new Error('encrypted backup v2 HTTP response binding is invalid')
  }
  return response.body.slice()
}

export function requireEncryptedWalletBackupV2HttpResponseScope(input: {
  readonly response: EncryptedWalletBackupV2HttpResponseEnvelope
  readonly requestDigest: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
}): EncryptedWalletBackupV2HttpResponseEnvelope {
  const response = decodeEnvelopeRecord(input.response)
  if (
    response.requestDigest !== requireLowerHex(input.requestDigest, 32, 'request digest') ||
    response.realm !== requireRealm(input.realm) ||
    response.walletId !== requireLowerHex(input.walletId, 32, 'wallet id') ||
    response.enrollmentEpoch !== requireEpoch(input.enrollmentEpoch)
  )
    throw new Error('encrypted backup v2 HTTP response binding is invalid')
  return response
}

export function encodeEncryptedWalletBackupV2HttpError(input: {
  readonly operation:
    | 'enrollment-epoch'
    | 'current-inventory'
    | 'descriptor-page'
    | 'bundle-supersession'
    | 'object-get'
  readonly code: EncryptedWalletBackupV2HttpErrorCode
  readonly retryAfterSeconds: number | null
}): Uint8Array {
  const code = requireErrorCode(input.code)
  const retryAfterSeconds = requireRetryAfter(input.retryAfterSeconds, code)
  return encodeCanonicalBackupCbor([
    2,
    'encrypted-wallet-backup-v2-error',
    requireErrorOperation(input.operation),
    code,
    retryAfterSeconds,
  ])
}

export function decodeEncryptedWalletBackupV2HttpError(bytes: Uint8Array): {
  readonly operation:
    | 'enrollment-epoch'
    | 'current-inventory'
    | 'descriptor-page'
    | 'bundle-supersession'
    | 'object-get'
  readonly code: EncryptedWalletBackupV2HttpErrorCode
  readonly retryAfterSeconds: number | null
} {
  preflightEncryptedWalletBackupV2CborTuple(bytes, ERROR_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup v2 HTTP error is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 5
  )
    throw new Error('encrypted backup v2 HTTP error is invalid')
  const code = requireErrorCode(decoded[3])
  return Object.freeze({
    operation: requireErrorOperation(decoded[2]),
    code,
    retryAfterSeconds: requireRetryAfter(decoded[4], code),
  })
}

export function encodeEncryptedWalletBackupV2EnrollmentEpochResult(input: {
  readonly result: 'active' | 'not-enrolled'
  readonly enrollmentEpoch: number
}): Uint8Array {
  const epoch = requireEpoch(input.enrollmentEpoch)
  if (input.result === 'active' && epoch < 1)
    throw new Error('encrypted backup v2 enrollment epoch is invalid')
  if (input.result === 'not-enrolled' && epoch !== 0)
    throw new Error('encrypted backup v2 enrollment epoch is invalid')
  return encodeCanonicalBackupCbor([2, 'enrollment-epoch-result', input.result, epoch])
}

export function decodeEncryptedWalletBackupV2EnrollmentEpochResult(bytes: Uint8Array): {
  readonly result: 'active' | 'not-enrolled'
  readonly enrollmentEpoch: number
} {
  preflightEncryptedWalletBackupV2CborTuple(bytes, EPOCH_RESULT_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup v2 enrollment epoch result is invalid')
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 4
  )
    throw new Error('encrypted backup v2 enrollment epoch result is invalid')
  const result = decoded[2]
  const enrollmentEpoch = requireEpoch(decoded[3])
  if (result === 'active' && enrollmentEpoch >= 1) return Object.freeze({ result, enrollmentEpoch })
  if (result === 'not-enrolled' && enrollmentEpoch === 0)
    return Object.freeze({ result, enrollmentEpoch })
  throw new Error('encrypted backup v2 enrollment epoch result is invalid')
}

function decodeEnvelopeRecord(value: unknown): EncryptedWalletBackupV2HttpResponseEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup v2 HTTP response is invalid')
  const record = value as Record<string, unknown>
  const fields = ['kind', 'requestDigest', 'realm', 'walletId', 'enrollmentEpoch', 'body']
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup v2 HTTP response is invalid')
  return Object.freeze({
    kind: requireResponseKind(record.kind),
    requestDigest: requireLowerHex(record.requestDigest, 32, 'request digest'),
    realm: requireRealm(record.realm),
    walletId: requireLowerHex(record.walletId, 32, 'wallet id'),
    enrollmentEpoch: requireEpoch(record.enrollmentEpoch),
    body: requireBytes(
      record.body,
      0,
      ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
      'response body',
    ).slice(),
  })
}

function requireResponseKind(value: unknown): EncryptedWalletBackupV2HttpResponseKind {
  switch (value) {
    case 'enrollment-epoch':
    case 'current-inventory':
    case 'descriptor-page':
    case 'bundle-supersession-receipt':
    case 'object':
    case 'error':
      return value
    default:
      throw new Error('encrypted backup v2 HTTP response kind is invalid')
  }
}

function requireEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0)
    throw new Error('encrypted backup v2 enrollment epoch is invalid')
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
  | 'enrollment-epoch'
  | 'current-inventory'
  | 'descriptor-page'
  | 'bundle-supersession'
  | 'object-get' {
  switch (value) {
    case 'enrollment-epoch':
    case 'current-inventory':
    case 'descriptor-page':
    case 'bundle-supersession':
    case 'object-get':
      return value
    default:
      throw new Error('encrypted backup v2 error operation is invalid')
  }
}

export function encryptedWalletBackupV2HttpResponseMaximumBytes(
  kind: EncryptedWalletBackupV2HttpResponseKind,
): number {
  return responseMaximumBytes(kind)
}

function responseMaximumBytes(kind: EncryptedWalletBackupV2HttpResponseKind): number {
  return kind === 'current-inventory'
    ? ENCRYPTED_WALLET_BACKUP_V2_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES
    : ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES
}

function requireErrorCode(value: unknown): EncryptedWalletBackupV2HttpErrorCode {
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
      throw new Error('encrypted backup v2 error code is invalid')
  }
}

function requireRetryAfter(
  value: unknown,
  code: EncryptedWalletBackupV2HttpErrorCode,
): number | null {
  if (value === null) return null
  if (
    (code !== 'rate-limited' && code !== 'overloaded' && code !== 'unavailable') ||
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3_600
  )
    throw new Error('encrypted backup v2 retry value is invalid')
  return value
}
