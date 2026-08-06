import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  equalBytes,
  requireBytes,
  requireLowerHex,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_HTTP_ERROR_RESPONSE_MAX_BYTES = 128
export const ENCRYPTED_WALLET_BACKUP_HTTP_ACCOUNT_RESPONSE_MAX_BYTES = 256
export type EncryptedWalletBackupHttpOperation =
  | 'account-enroll'
  | 'account-revoke'
  | 'account-delete'
export type EncryptedWalletBackupHttpErrorCode =
  | 'invalid-request'
  | 'unauthorized'
  | 'conflict'
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'
export type EncryptedWalletBackupHttpResponseContext = Readonly<{
  operation: EncryptedWalletBackupHttpOperation
  expectedOperationId: string
  expectedIntentDigest: string
}>
export type EncryptedWalletBackupHttpResponseValue =
  | Readonly<{
      kind: 'account-result'
      operationId: string
      intentDigest: string
      result: 'committed' | 'conflict'
      enrollmentEpoch: number
      lifecycle: 'active' | 'revoked' | 'deleted'
    }>
  | Readonly<{
      kind: 'error'
      code: EncryptedWalletBackupHttpErrorCode
      retryAfterSeconds: number | null
    }>
export type DecodedEncryptedWalletBackupHttpResponse =
  | Readonly<{
      operation: EncryptedWalletBackupHttpOperation
      result: 'committed' | 'conflict'
      operationId: string
      intentDigest: string
      enrollmentEpoch: number
      lifecycle: 'active' | 'revoked' | 'deleted'
    }>
  | Readonly<{
      operation: EncryptedWalletBackupHttpOperation
      result: 'error'
      code: EncryptedWalletBackupHttpErrorCode
      retryAfterSeconds: number | null
    }>

export function encodeEncryptedWalletBackupHttpResponse(
  value: EncryptedWalletBackupHttpResponseValue,
): Uint8Array {
  if (value.kind === 'account-result')
    return encodeCanonicalBackupCbor([
      1,
      'account-result',
      hexToBytes(requireLowerHex(value.operationId, 16, 'account operation id')),
      hexToBytes(requireLowerHex(value.intentDigest, 32, 'account intent digest')),
      requireResult(value.result),
      requireEpoch(value.enrollmentEpoch),
      requireLifecycle(value.lifecycle),
    ])
  return encodeCanonicalBackupCbor([
    1,
    'error',
    requireCode(value.code),
    requireRetryAfter(value.retryAfterSeconds, value.code),
  ])
}

export function decodeEncryptedWalletBackupHttpResponse(
  input: EncryptedWalletBackupHttpResponseContext &
    Readonly<{ httpStatus: number; body: Uint8Array }>,
): DecodedEncryptedWalletBackupHttpResponse {
  const maximum = encryptedWalletBackupHttpResponseMaximumBytes(input.operation, input.httpStatus)
  if (
    !(input.body instanceof Uint8Array) ||
    input.body.byteLength < 1 ||
    input.body.byteLength > maximum
  )
    throw new Error('encrypted backup HTTP response is invalid')
  const decoded = decode(input.body)
  if (
    !equalBytes(input.body, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded[0] !== 1 ||
    typeof decoded[1] !== 'string'
  )
    throw new Error('encrypted backup HTTP response is invalid')
  if (input.httpStatus !== 200) return decodeError(input.operation, input.httpStatus, decoded)
  if (decoded.length !== 7 || decoded[1] !== 'account-result')
    throw new Error('encrypted backup HTTP response is invalid')
  const operationId = bytesToHex(requireBytes(decoded[2], 16, 16, 'account operation id'))
  const intentDigest = bytesToHex(requireBytes(decoded[3], 32, 32, 'account intent digest'))
  if (
    operationId !== requireLowerHex(input.expectedOperationId, 16, 'expected operation id') ||
    intentDigest !== requireLowerHex(input.expectedIntentDigest, 32, 'expected intent digest')
  )
    throw new Error('account response does not match request')
  const result = requireResult(decoded[4])
  const lifecycle = requireLifecycle(decoded[6])
  if (result === 'committed' && lifecycle !== committedLifecycle(input.operation))
    throw new Error('account lifecycle does not match operation')
  return Object.freeze({
    operation: input.operation,
    result,
    operationId,
    intentDigest,
    enrollmentEpoch: requireEpoch(decoded[5]),
    lifecycle,
  })
}

export function encryptedWalletBackupHttpResponseMaximumBytes(
  operation: EncryptedWalletBackupHttpOperation,
  status: number,
): number {
  requireOperation(operation)
  if (status === 200) return ENCRYPTED_WALLET_BACKUP_HTTP_ACCOUNT_RESPONSE_MAX_BYTES
  if ([400, 401, 409, 429, 503].includes(status))
    return ENCRYPTED_WALLET_BACKUP_HTTP_ERROR_RESPONSE_MAX_BYTES
  throw new Error('encrypted backup HTTP response status is unsupported')
}

function decodeError(
  operation: EncryptedWalletBackupHttpOperation,
  status: number,
  tuple: unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  if (tuple.length !== 4 || tuple[1] !== 'error')
    throw new Error('encrypted backup HTTP error is invalid')
  const code = requireCode(tuple[2])
  if (!allowedError(status, code))
    throw new Error('encrypted backup HTTP response status/code pair is invalid')
  return Object.freeze({
    operation,
    result: 'error' as const,
    code,
    retryAfterSeconds: requireRetryAfter(tuple[3], code),
  })
}

function allowedError(status: number, code: EncryptedWalletBackupHttpErrorCode): boolean {
  switch (status) {
    case 400:
      return code === 'invalid-request'
    case 401:
      return code === 'unauthorized'
    case 409:
      return code === 'conflict'
    case 429:
      return code === 'quota-exceeded' || code === 'rate-limited'
    case 503:
      return code === 'overloaded' || code === 'unavailable'
    default:
      return false
  }
}
function requireOperation(value: unknown): EncryptedWalletBackupHttpOperation {
  if (value !== 'account-enroll' && value !== 'account-revoke' && value !== 'account-delete')
    throw new Error('account operation is invalid')
  return value
}
function requireResult(value: unknown): 'committed' | 'conflict' {
  if (value !== 'committed' && value !== 'conflict') throw new Error('account result is invalid')
  return value
}
function requireLifecycle(value: unknown): 'active' | 'revoked' | 'deleted' {
  if (value !== 'active' && value !== 'revoked' && value !== 'deleted')
    throw new Error('account lifecycle is invalid')
  return value
}
function requireEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('enrollment epoch is invalid')
  return value as number
}
function requireCode(value: unknown): EncryptedWalletBackupHttpErrorCode {
  if (
    value !== 'invalid-request' &&
    value !== 'unauthorized' &&
    value !== 'conflict' &&
    value !== 'quota-exceeded' &&
    value !== 'rate-limited' &&
    value !== 'overloaded' &&
    value !== 'unavailable'
  )
    throw new Error('encrypted backup error code is invalid')
  return value
}
function requireRetryAfter(
  value: unknown,
  code: EncryptedWalletBackupHttpErrorCode,
): number | null {
  if (value === null) {
    if (code === 'rate-limited' || code === 'overloaded' || code === 'unavailable')
      throw new Error('retry-after is required')
    return null
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 3_600 ||
    code === 'quota-exceeded'
  )
    throw new Error('retry-after is invalid')
  return value as number
}
function committedLifecycle(
  operation: EncryptedWalletBackupHttpOperation,
): 'active' | 'revoked' | 'deleted' {
  return operation === 'account-enroll'
    ? 'active'
    : operation === 'account-revoke'
      ? 'revoked'
      : 'deleted'
}
