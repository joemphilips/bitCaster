import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupHttpResponseCbor,
  preflightEncryptedBackupObjectAadCbor,
} from './encryptedWalletBackupCbor.ts'
import { validateEncryptedWalletBackupManifestHeadUnit } from './encryptedWalletBackupManifestHead.ts'

export const ENCRYPTED_WALLET_BACKUP_HTTP_ERROR_RESPONSE_MAX_BYTES = 128
export const ENCRYPTED_WALLET_BACKUP_HTTP_ACCOUNT_RESPONSE_MAX_BYTES = 256
export const ENCRYPTED_WALLET_BACKUP_HTTP_EPOCH_RESPONSE_MAX_BYTES = 128
export const ENCRYPTED_WALLET_BACKUP_HTTP_HEAD_RESPONSE_MAX_BYTES = 132_096
export const ENCRYPTED_WALLET_BACKUP_HTTP_OBJECT_RESPONSE_MAX_BYTES = 266_272
export const ENCRYPTED_WALLET_BACKUP_HTTP_MUTATION_RESPONSE_MAX_BYTES = 128

export type EncryptedWalletBackupHttpOperation =
  | 'account-enroll'
  | 'account-revoke'
  | 'account-delete'
  | 'enrollment-epoch'
  | 'head-get'
  | 'object-get'
  | 'object-put'
  | 'object-delete'
  | 'upload-attempt-abort'
  | 'head-cas'

export type EncryptedWalletBackupHttpErrorCode =
  | 'invalid-request'
  | 'unauthorized'
  | 'not-found'
  | 'conflict'
  | 'replay-rejected'
  | 'quota-exceeded'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'

type AccountResponseContext<O extends 'account-enroll' | 'account-revoke' | 'account-delete'> =
  Readonly<{
    operation: O
    expectedOperationId: string
    expectedIntentDigest: string
  }>

type RequestResponseContext<
  O extends
    | 'enrollment-epoch'
    | 'object-put'
    | 'object-delete'
    | 'upload-attempt-abort'
    | 'head-cas',
> = Readonly<{
  operation: O
  expectedRequestDigest: string
}>

export type EncryptedWalletBackupHttpResponseContext =
  | AccountResponseContext<'account-enroll'>
  | AccountResponseContext<'account-revoke'>
  | AccountResponseContext<'account-delete'>
  | RequestResponseContext<'enrollment-epoch'>
  | RequestResponseContext<'object-put'>
  | RequestResponseContext<'object-delete'>
  | RequestResponseContext<'upload-attempt-abort'>
  | RequestResponseContext<'head-cas'>
  | Readonly<{
      operation: 'head-get'
      expectedRequestDigest: string
      expectedEnrollmentEpoch: number
      expectedRealm: string
      expectedVaultId: string
      expectedBackupPublicKey: string
    }>
  | Readonly<{
      operation: 'object-get'
      expectedRequestDigest: string
      expectedKindCode: 1 | 2
      expectedRealm: string
      expectedVaultId: string
      expectedObjectId: string
      expectedObjectDigest: string
      currentHeadGeneration: number
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
      kind: 'enrollment-epoch-result'
      requestDigest: string
      result: 'active'
      enrollmentEpoch: number
    }>
  | Readonly<{
      kind: 'enrollment-epoch-result'
      requestDigest: string
      result: 'not-enrolled'
    }>
  | Readonly<{
      kind: 'head-result'
      requestDigest: string
      result: 'found'
      enrollmentEpoch: number
      canonicalHead: Uint8Array
      canonicalReferenceSet: Uint8Array
    }>
  | Readonly<{
      kind: 'head-result'
      requestDigest: string
      result: 'not-found'
      enrollmentEpoch: number
    }>
  | Readonly<{
      kind: 'object-result'
      requestDigest: string
      result: 'found'
      kindCode: 1 | 2
      realm: string
      vaultId: string
      objectId: string
      generation: number
      paddedLength: 65_536 | 262_144
      objectDigest: string
      aad: Uint8Array
      encryptedBody: Uint8Array
    }>
  | Readonly<{
      kind: 'object-result'
      requestDigest: string
      result: 'not-found'
    }>
  | Readonly<{
      kind: 'object-put-result'
      requestDigest: string
      result: 'stored' | 'already-stored'
    }>
  | Readonly<{
      kind: 'object-delete-result'
      requestDigest: string
      result: 'deleted' | 'already-deleted'
    }>
  | Readonly<{
      kind: 'upload-attempt-abort-result'
      requestDigest: string
      result: 'abandoned' | 'already-abandoned' | 'already-finalized'
    }>
  | Readonly<{
      kind: 'head-cas-result'
      requestDigest: string
      result: 'committed' | 'conflict'
    }>
  | Readonly<{
      kind: 'error'
      code: EncryptedWalletBackupHttpErrorCode
      retryAfterSeconds: number | null
    }>

export type DecodedEncryptedWalletBackupHttpResponse =
  | Readonly<{
      operation: 'account-enroll' | 'account-revoke' | 'account-delete'
      result: 'committed' | 'conflict'
      operationId: string
      intentDigest: string
      enrollmentEpoch: number
      lifecycle: 'active' | 'revoked' | 'deleted'
    }>
  | Readonly<{
      operation: 'enrollment-epoch'
      result: 'active'
      enrollmentEpoch: number
    }>
  | Readonly<{
      operation: 'enrollment-epoch'
      result: 'not-enrolled'
    }>
  | Readonly<{
      operation: 'head-get'
      result: 'found'
      enrollmentEpoch: number
      canonicalHead: Uint8Array
      canonicalReferenceSet: Uint8Array
    }>
  | Readonly<{
      operation: 'head-get'
      result: 'not-found'
      enrollmentEpoch: number
    }>
  | Readonly<{
      operation: 'object-get'
      result: 'found'
      kindCode: 1 | 2
      realm: string
      vaultId: string
      objectId: string
      generation: number
      paddedLength: 65_536 | 262_144
      objectDigest: string
      aad: Uint8Array
      encryptedBody: Uint8Array
    }>
  | Readonly<{
      operation: 'object-get'
      result: 'not-found'
    }>
  | Readonly<{
      operation: 'object-put'
      result: 'stored' | 'already-stored'
    }>
  | Readonly<{
      operation: 'object-delete'
      effectClass: 'remote-garbage-maintenance-only'
      result: 'deleted' | 'already-deleted'
    }>
  | Readonly<{
      operation: 'upload-attempt-abort'
      effectClass: 'remote-attempt-cleanup-only'
      result: 'abandoned' | 'already-abandoned' | 'already-finalized'
    }>
  | Readonly<{
      operation: 'head-cas'
      result: 'committed' | 'conflict'
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
  const raw = requireRecord(value, 'HTTP response')
  switch (raw.kind) {
    case 'account-result': {
      requireKnownFields(raw, [
        'kind',
        'operationId',
        'intentDigest',
        'result',
        'enrollmentEpoch',
        'lifecycle',
      ])
      return encodeCanonicalBackupCbor([
        1,
        'account-result',
        hexToBytes(requireLowerHex(raw.operationId, 16, 'account operation id')),
        hexToBytes(requireLowerHex(raw.intentDigest, 32, 'account intent digest')),
        requireAccountResult(raw.result),
        requirePositiveInteger(raw.enrollmentEpoch, 'enrollment epoch'),
        requireLifecycle(raw.lifecycle),
      ])
    }
    case 'enrollment-epoch-result': {
      const result = requireEpochResult(raw.result)
      requireKnownFields(
        raw,
        result === 'active'
          ? ['kind', 'requestDigest', 'result', 'enrollmentEpoch']
          : ['kind', 'requestDigest', 'result'],
      )
      return encodeCanonicalBackupCbor(
        result === 'active'
          ? [
              1,
              'enrollment-epoch-result',
              hexToBytes(requireLowerHex(raw.requestDigest, 32, 'request digest')),
              result,
              requirePositiveInteger(raw.enrollmentEpoch, 'enrollment epoch'),
            ]
          : [
              1,
              'enrollment-epoch-result',
              hexToBytes(requireLowerHex(raw.requestDigest, 32, 'request digest')),
              result,
            ],
      )
    }
    case 'head-result': {
      const result = requireFoundResult(raw.result)
      requireKnownFields(
        raw,
        result === 'found'
          ? [
              'kind',
              'requestDigest',
              'result',
              'enrollmentEpoch',
              'canonicalHead',
              'canonicalReferenceSet',
            ]
          : ['kind', 'requestDigest', 'result', 'enrollmentEpoch'],
      )
      const prefix = [
        1,
        'head-result',
        hexToBytes(requireLowerHex(raw.requestDigest, 32, 'request digest')),
        result,
        requirePositiveInteger(raw.enrollmentEpoch, 'enrollment epoch'),
      ]
      if (result === 'not-found') return encodeCanonicalBackupCbor(prefix)
      const head = requireBytes(raw.canonicalHead, 1, 65_536, 'canonical head')
      const references = requireBytes(
        raw.canonicalReferenceSet,
        1,
        65_536,
        'canonical reference set',
      )
      requireConsistentManifestHeadUnit({
        canonicalHead: head,
        canonicalReferenceSet: references,
      })
      return encodeCanonicalBackupCbor([...prefix, head, references])
    }
    case 'object-result': {
      const result = requireFoundResult(raw.result)
      if (result === 'not-found') {
        requireKnownFields(raw, ['kind', 'requestDigest', 'result'])
        return encodeCanonicalBackupCbor([
          1,
          'object-result',
          hexToBytes(requireLowerHex(raw.requestDigest, 32, 'request digest')),
          result,
        ])
      }
      requireKnownFields(raw, [
        'kind',
        'requestDigest',
        'result',
        'kindCode',
        'realm',
        'vaultId',
        'objectId',
        'generation',
        'paddedLength',
        'objectDigest',
        'aad',
        'encryptedBody',
      ])
      const kindCode = requireKindCode(raw.kindCode)
      const realm = requireRealm(raw.realm)
      const vaultId = requireLowerHex(raw.vaultId, 32, 'vault id')
      const objectId = requireLowerHex(raw.objectId, 16, 'object id')
      const generation = requirePositiveInteger(raw.generation, 'object generation')
      const paddedLength = requirePaddedLength(raw.paddedLength)
      const objectDigest = requireLowerHex(raw.objectDigest, 32, 'object digest')
      const aad = requireBytes(raw.aad, 1, 256, 'object AAD')
      const encryptedBody = requireBytes(
        raw.encryptedBody,
        65_564,
        262_172,
        'encrypted object body',
      )
      if (
        paddedLength !== (kindCode === 1 ? 262_144 : 65_536) ||
        encryptedBody.byteLength !== paddedLength + 28
      ) {
        throw new Error('encrypted backup object response body length is invalid')
      }
      requireObjectAad({
        aad,
        kindCode,
        realm,
        vaultId,
        objectId,
        generation,
        paddedLength,
      })
      const recomputedDigest = framedObjectDigest(aad, encryptedBody)
      if (recomputedDigest !== objectDigest) {
        throw new Error('encrypted backup object response framed digest is invalid')
      }
      return encodeCanonicalBackupCbor([
        1,
        'object-result',
        hexToBytes(requireLowerHex(raw.requestDigest, 32, 'request digest')),
        result,
        kindCode,
        realm,
        hexToBytes(vaultId),
        hexToBytes(objectId),
        generation,
        paddedLength,
        hexToBytes(objectDigest),
        aad,
        encryptedBody,
      ])
    }
    case 'object-put-result': {
      requireKnownFields(raw, ['kind', 'requestDigest', 'result'])
      return encodeRequestBoundResult(
        'object-put-result',
        raw.requestDigest,
        requirePutResult(raw.result),
      )
    }
    case 'object-delete-result': {
      requireKnownFields(raw, ['kind', 'requestDigest', 'result'])
      return encodeRequestBoundResult(
        'object-delete-result',
        raw.requestDigest,
        requireDeleteResult(raw.result),
      )
    }
    case 'upload-attempt-abort-result': {
      requireKnownFields(raw, ['kind', 'requestDigest', 'result'])
      return encodeRequestBoundResult(
        'upload-attempt-abort-result',
        raw.requestDigest,
        requireAbortResult(raw.result),
      )
    }
    case 'head-cas-result': {
      requireKnownFields(raw, ['kind', 'requestDigest', 'result'])
      return encodeRequestBoundResult(
        'head-cas-result',
        raw.requestDigest,
        requireAccountResult(raw.result),
      )
    }
    case 'error': {
      requireKnownFields(raw, ['kind', 'code', 'retryAfterSeconds'])
      const code = requireErrorCode(raw.code)
      const retryAfter = requireRetryAfter(raw.retryAfterSeconds, code)
      return encodeCanonicalBackupCbor([1, 'error', code, retryAfter])
    }
    default:
      throw new Error('encrypted backup HTTP response kind is invalid')
  }
}

export function decodeEncryptedWalletBackupHttpResponse(
  input: EncryptedWalletBackupHttpResponseContext &
    Readonly<{
      httpStatus: number
      body: Uint8Array
    }>,
): DecodedEncryptedWalletBackupHttpResponse {
  const operation = requireOperation(input.operation)
  const status = requireHttpStatus(input.httpStatus)
  const maximumBytes = encryptedWalletBackupHttpResponseMaximumBytes(operation, status)
  preflightEncryptedBackupHttpResponseCbor(input.body, maximumBytes)
  const decoded = decode(input.body) as unknown
  if (!equalBytes(input.body, encodeCanonicalBackupCbor(decoded))) {
    throw new Error('encrypted backup HTTP response is not canonical CBOR')
  }
  const tuple = requireTuple(decoded)
  if (status !== 200) return decodeError(operation, status, tuple)
  switch (input.operation) {
    case 'account-enroll':
    case 'account-revoke':
    case 'account-delete':
      return decodeAccountResult(input, tuple)
    case 'enrollment-epoch':
      return decodeEpochResult(input, tuple)
    case 'head-get':
      return decodeHeadResult(input, tuple)
    case 'object-get':
      return decodeObjectResult(input, tuple)
    case 'object-put':
      return decodeSimpleRequestResult(input, tuple, 'object-put-result', requirePutResult)
    case 'object-delete':
      return decodeSimpleRequestResult(input, tuple, 'object-delete-result', requireDeleteResult, {
        effectClass: 'remote-garbage-maintenance-only' as const,
      })
    case 'upload-attempt-abort':
      return decodeSimpleRequestResult(
        input,
        tuple,
        'upload-attempt-abort-result',
        requireAbortResult,
        { effectClass: 'remote-attempt-cleanup-only' as const },
      )
    case 'head-cas':
      return decodeSimpleRequestResult(input, tuple, 'head-cas-result', requireAccountResult)
    default:
      return assertNever(input)
  }
}

function decodeAccountResult(
  context: AccountResponseContext<'account-enroll' | 'account-revoke' | 'account-delete'>,
  tuple: readonly unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  requireTupleHeader(tuple, 7, 'account-result')
  const operationId = bytesToHex(requireExactBytes(tuple[2], 16, 'account operation id'))
  const intentDigest = bytesToHex(requireExactBytes(tuple[3], 32, 'account intent digest'))
  if (operationId !== requireLowerHex(context.expectedOperationId, 16, 'expected operation id')) {
    throw new Error('account response operation id does not match request')
  }
  if (
    intentDigest !== requireLowerHex(context.expectedIntentDigest, 32, 'expected intent digest')
  ) {
    throw new Error('account response intent digest does not match request')
  }
  const result = requireAccountResult(tuple[4])
  const enrollmentEpoch = requirePositiveInteger(tuple[5], 'enrollment epoch')
  const lifecycle = requireLifecycle(tuple[6])
  if (result === 'committed') {
    const expectedLifecycle = committedLifecycle(context.operation)
    if (lifecycle !== expectedLifecycle) {
      throw new Error('account committed lifecycle does not match operation')
    }
  }
  return Object.freeze({
    operation: context.operation,
    result,
    operationId,
    intentDigest,
    enrollmentEpoch,
    lifecycle,
  })
}

function decodeEpochResult(
  context: Extract<EncryptedWalletBackupHttpResponseContext, { operation: 'enrollment-epoch' }>,
  tuple: readonly unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  requireTupleHeader(tuple, tuple.length, 'enrollment-epoch-result')
  requireRequestDigest(tuple[2], context.expectedRequestDigest)
  const result = requireEpochResult(tuple[3])
  if (result === 'not-enrolled') {
    if (tuple.length !== 4) throw new Error('enrollment epoch absence tuple arity is invalid')
    return Object.freeze({
      operation: context.operation,
      result,
    })
  }
  if (tuple.length !== 5) throw new Error('enrollment epoch tuple arity is invalid')
  return Object.freeze({
    operation: context.operation,
    result,
    enrollmentEpoch: requirePositiveInteger(tuple[4], 'enrollment epoch'),
  })
}

function decodeHeadResult(
  context: Extract<EncryptedWalletBackupHttpResponseContext, { operation: 'head-get' }>,
  tuple: readonly unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  requireTupleHeader(tuple, tuple.length, 'head-result')
  requireRequestDigest(tuple[2], context.expectedRequestDigest)
  const result = requireFoundResult(tuple[3])
  const enrollmentEpoch = requirePositiveInteger(tuple[4], 'enrollment epoch')
  if (
    enrollmentEpoch !==
    requirePositiveInteger(context.expectedEnrollmentEpoch, 'expected enrollment epoch')
  ) {
    throw new Error('head response enrollment epoch does not match request')
  }
  if (result === 'not-found') {
    if (tuple.length !== 5) throw new Error('head absence tuple arity is invalid')
    return Object.freeze({
      operation: context.operation,
      result,
      enrollmentEpoch,
    })
  }
  if (tuple.length !== 7) throw new Error('head result tuple arity is invalid')
  const canonicalHead = requireBytes(tuple[5], 1, 65_536, 'canonical head')
  const canonicalReferenceSet = requireBytes(tuple[6], 1, 65_536, 'canonical reference set')
  requireConsistentManifestHeadUnit({
    canonicalHead,
    canonicalReferenceSet,
    expectedRealm: context.expectedRealm,
    expectedVaultId: context.expectedVaultId,
    expectedBackupPublicKey: context.expectedBackupPublicKey,
  })
  return Object.freeze({
    operation: context.operation,
    result,
    enrollmentEpoch,
    canonicalHead,
    canonicalReferenceSet,
  })
}

function decodeObjectResult(
  context: Extract<EncryptedWalletBackupHttpResponseContext, { operation: 'object-get' }>,
  tuple: readonly unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  requireTupleHeader(tuple, tuple.length, 'object-result')
  requireRequestDigest(tuple[2], context.expectedRequestDigest)
  const result = requireFoundResult(tuple[3])
  if (result === 'not-found') {
    if (tuple.length !== 4) throw new Error('object absence tuple arity is invalid')
    return Object.freeze({
      operation: context.operation,
      result,
    })
  }
  if (tuple.length !== 13) throw new Error('object result tuple arity is invalid')
  const kindCode = requireKindCode(tuple[4])
  const realm = requireRealm(tuple[5])
  const vaultId = bytesToHex(requireExactBytes(tuple[6], 32, 'vault id'))
  const objectId = bytesToHex(requireExactBytes(tuple[7], 16, 'object id'))
  const generation = requirePositiveInteger(tuple[8], 'object generation')
  const paddedLength = requirePaddedLength(tuple[9])
  const objectDigest = bytesToHex(requireExactBytes(tuple[10], 32, 'object digest'))
  const aad = requireBytes(tuple[11], 1, 256, 'object AAD')
  const encryptedBody = requireBytes(tuple[12], 65_564, 262_172, 'encrypted object body')
  const expectedKind = requireKindCode(context.expectedKindCode)
  const expectedRealm = requireRealm(context.expectedRealm)
  const expectedVault = requireLowerHex(context.expectedVaultId, 32, 'expected vault id')
  const expectedObject = requireLowerHex(context.expectedObjectId, 16, 'expected object id')
  const expectedDigest = requireLowerHex(context.expectedObjectDigest, 32, 'expected object digest')
  const currentGeneration = requirePositiveInteger(
    context.currentHeadGeneration,
    'current head generation',
  )
  if (
    kindCode !== expectedKind ||
    realm !== expectedRealm ||
    vaultId !== expectedVault ||
    objectId !== expectedObject ||
    objectDigest !== expectedDigest
  ) {
    throw new Error('object response identity does not match request')
  }
  if (
    (kindCode === 1 && generation > currentGeneration) ||
    (kindCode === 2 && generation !== currentGeneration)
  ) {
    throw new Error('object response generation does not match current head')
  }
  const expectedPaddedLength = kindCode === 1 ? 262_144 : 65_536
  if (paddedLength !== expectedPaddedLength || encryptedBody.byteLength !== paddedLength + 28) {
    throw new Error('object response body length is invalid')
  }
  requireObjectAad({
    aad,
    kindCode,
    realm,
    vaultId,
    objectId,
    generation,
    paddedLength,
  })
  const recomputedDigest = framedObjectDigest(aad, encryptedBody)
  if (recomputedDigest !== objectDigest) {
    throw new Error('object response framed digest is invalid')
  }
  return Object.freeze({
    operation: context.operation,
    result,
    kindCode,
    realm,
    vaultId,
    objectId,
    generation,
    paddedLength,
    objectDigest,
    aad,
    encryptedBody,
  })
}

function decodeSimpleRequestResult<
  O extends 'object-put' | 'object-delete' | 'upload-attempt-abort' | 'head-cas',
  R extends string,
  E extends Readonly<Record<string, string>> = Readonly<Record<never, never>>,
>(
  context: Readonly<{ operation: O; expectedRequestDigest: string }>,
  tuple: readonly unknown[],
  discriminator: string,
  requireResult: (value: unknown) => R,
  effect?: E,
): Readonly<{ operation: O; result: R }> & E {
  requireTupleHeader(tuple, 4, discriminator)
  requireRequestDigest(tuple[2], context.expectedRequestDigest)
  return Object.freeze({
    operation: context.operation,
    result: requireResult(tuple[3]),
    ...(effect ?? ({} as E)),
  })
}

function decodeError(
  operation: EncryptedWalletBackupHttpOperation,
  status: number,
  tuple: readonly unknown[],
): DecodedEncryptedWalletBackupHttpResponse {
  requireTupleHeader(tuple, 4, 'error')
  const code = requireErrorCode(tuple[2])
  const retryAfterSeconds = requireRetryAfter(tuple[3], code)
  if (!isAllowedError(operation, status, code)) {
    throw new Error('encrypted backup HTTP response status/code pair is invalid')
  }
  return Object.freeze({
    operation,
    result: 'error' as const,
    code,
    retryAfterSeconds,
  })
}

export function encryptedWalletBackupHttpResponseMaximumBytes(
  operationValue: EncryptedWalletBackupHttpOperation,
  statusValue: number,
): number {
  const operation = requireOperation(operationValue)
  const status = requireHttpStatus(statusValue)
  if (status === 200) return successResponseMaximum(operation)
  switch (status) {
    case 400:
    case 401:
    case 404:
    case 409:
    case 429:
    case 503:
      return ENCRYPTED_WALLET_BACKUP_HTTP_ERROR_RESPONSE_MAX_BYTES
    default:
      throw new Error('encrypted backup HTTP response status is unsupported')
  }
}

function isAllowedError(
  operation: EncryptedWalletBackupHttpOperation,
  status: number,
  code: EncryptedWalletBackupHttpErrorCode,
): boolean {
  switch (status) {
    case 400:
      return code === 'invalid-request'
    case 401:
      return code === 'unauthorized'
    case 404:
      return code === 'not-found'
    case 409:
      return code === 'conflict' || code === 'replay-rejected'
    case 429:
      if (code === 'rate-limited') return true
      if (code !== 'quota-exceeded') return false
      switch (operation) {
        case 'account-enroll':
        case 'object-put':
        case 'head-cas':
          return true
        case 'account-revoke':
        case 'account-delete':
        case 'enrollment-epoch':
        case 'head-get':
        case 'object-get':
        case 'object-delete':
        case 'upload-attempt-abort':
          return false
        default:
          return assertNever(operation)
      }
    case 503:
      return code === 'overloaded' || code === 'unavailable'
    default:
      return false
  }
}

function successResponseMaximum(operation: EncryptedWalletBackupHttpOperation): number {
  switch (operation) {
    case 'account-enroll':
    case 'account-revoke':
    case 'account-delete':
      return ENCRYPTED_WALLET_BACKUP_HTTP_ACCOUNT_RESPONSE_MAX_BYTES
    case 'enrollment-epoch':
      return ENCRYPTED_WALLET_BACKUP_HTTP_EPOCH_RESPONSE_MAX_BYTES
    case 'head-get':
      return ENCRYPTED_WALLET_BACKUP_HTTP_HEAD_RESPONSE_MAX_BYTES
    case 'object-get':
      return ENCRYPTED_WALLET_BACKUP_HTTP_OBJECT_RESPONSE_MAX_BYTES
    case 'object-put':
    case 'object-delete':
    case 'upload-attempt-abort':
    case 'head-cas':
      return ENCRYPTED_WALLET_BACKUP_HTTP_MUTATION_RESPONSE_MAX_BYTES
    default:
      return assertNever(operation)
  }
}

function committedLifecycle(
  operation: 'account-enroll' | 'account-revoke' | 'account-delete',
): 'active' | 'revoked' | 'deleted' {
  switch (operation) {
    case 'account-enroll':
      return 'active'
    case 'account-revoke':
      return 'revoked'
    case 'account-delete':
      return 'deleted'
    default:
      return assertNever(operation)
  }
}

function requireConsistentManifestHeadUnit(
  input: Readonly<{
    canonicalHead: Uint8Array
    canonicalReferenceSet: Uint8Array
    expectedRealm?: string
    expectedVaultId?: string
    expectedBackupPublicKey?: string
  }>,
): void {
  const validated = validateEncryptedWalletBackupManifestHeadUnit(input)
  if (input.expectedRealm !== undefined && validated.realm !== requireRealm(input.expectedRealm)) {
    throw new Error('manifest head realm does not match request')
  }
  if (
    input.expectedVaultId !== undefined &&
    validated.vaultId !== requireLowerHex(input.expectedVaultId, 32, 'expected vault id')
  ) {
    throw new Error('manifest head vault does not match request')
  }
  if (
    input.expectedBackupPublicKey !== undefined &&
    validated.backupPublicKey !==
      requireLowerHex(input.expectedBackupPublicKey, 32, 'expected backup public key')
  ) {
    throw new Error('manifest head public key does not match request')
  }
}

function requireObjectAad(input: {
  aad: Uint8Array
  kindCode: 1 | 2
  realm: string
  vaultId: string
  objectId: string
  generation: number
  paddedLength: 65_536 | 262_144
}): void {
  preflightEncryptedBackupObjectAadCbor(input.aad)
  const decoded = decode(input.aad) as unknown
  if (
    !equalBytes(input.aad, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 7 ||
    decoded[0] !== 1 ||
    decoded[1] !== input.kindCode ||
    decoded[2] !== input.realm ||
    bytesToHex(requireExactBytes(decoded[3], 32, 'AAD vault id')) !== input.vaultId ||
    bytesToHex(requireExactBytes(decoded[4], 16, 'AAD object id')) !== input.objectId ||
    decoded[5] !== input.generation ||
    decoded[6] !== input.paddedLength
  ) {
    throw new Error('object response AAD does not match metadata')
  }
}

function encodeRequestBoundResult(
  discriminator: string,
  requestDigest: unknown,
  result: string,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    discriminator,
    hexToBytes(requireLowerHex(requestDigest, 32, 'request digest')),
    result,
  ])
}

function requireTuple(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup HTTP response must be a tuple')
  return value
}

function requireTupleHeader(
  tuple: readonly unknown[],
  length: number,
  discriminator: string,
): void {
  if (tuple.length !== length || tuple[0] !== 1 || tuple[1] !== discriminator) {
    throw new Error('encrypted backup HTTP response tuple is invalid for operation')
  }
}

function requireRequestDigest(value: unknown, expected: unknown): string {
  const actual = bytesToHex(requireExactBytes(value, 32, 'request digest'))
  if (actual !== requireLowerHex(expected, 32, 'expected request digest')) {
    throw new Error('response request digest does not match request')
  }
  return actual
}

function requireHttpStatus(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    throw new Error('encrypted backup HTTP status is invalid')
  }
  return value as number
}

function requireOperation(value: unknown): EncryptedWalletBackupHttpOperation {
  switch (value) {
    case 'account-enroll':
    case 'account-revoke':
    case 'account-delete':
    case 'enrollment-epoch':
    case 'head-get':
    case 'object-get':
    case 'object-put':
    case 'object-delete':
    case 'upload-attempt-abort':
    case 'head-cas':
      return value
    default:
      throw new Error('encrypted backup HTTP operation is invalid')
  }
}

function requireErrorCode(value: unknown): EncryptedWalletBackupHttpErrorCode {
  switch (value) {
    case 'invalid-request':
    case 'unauthorized':
    case 'not-found':
    case 'conflict':
    case 'replay-rejected':
    case 'quota-exceeded':
    case 'rate-limited':
    case 'overloaded':
    case 'unavailable':
      return value
    default:
      throw new Error('encrypted backup HTTP error code is invalid')
  }
}

function requireRetryAfter(
  value: unknown,
  code: EncryptedWalletBackupHttpErrorCode,
): number | null {
  const retryable = code === 'rate-limited' || code === 'overloaded' || code === 'unavailable'
  if (!retryable) {
    if (value !== null) throw new Error('encrypted backup retry-after is invalid')
    return null
  }
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 3_600) {
    throw new Error('encrypted backup retry-after is invalid')
  }
  return value as number
}

function requireAccountResult(value: unknown): 'committed' | 'conflict' {
  if (value !== 'committed' && value !== 'conflict') {
    throw new Error('encrypted backup account/CAS result is invalid')
  }
  return value
}

function requireEpochResult(value: unknown): 'active' | 'not-enrolled' {
  if (value !== 'active' && value !== 'not-enrolled') {
    throw new Error('encrypted backup enrollment epoch result is invalid')
  }
  return value
}

function requireFoundResult(value: unknown): 'found' | 'not-found' {
  if (value !== 'found' && value !== 'not-found') {
    throw new Error('encrypted backup lookup result is invalid')
  }
  return value
}

function requirePutResult(value: unknown): 'stored' | 'already-stored' {
  if (value !== 'stored' && value !== 'already-stored') {
    throw new Error('encrypted backup PUT result is invalid')
  }
  return value
}

function requireDeleteResult(value: unknown): 'deleted' | 'already-deleted' {
  if (value !== 'deleted' && value !== 'already-deleted') {
    throw new Error('encrypted backup DELETE result is invalid')
  }
  return value
}

function requireAbortResult(
  value: unknown,
): 'abandoned' | 'already-abandoned' | 'already-finalized' {
  if (value !== 'abandoned' && value !== 'already-abandoned' && value !== 'already-finalized') {
    throw new Error('encrypted backup abort result is invalid')
  }
  return value
}

function requireLifecycle(value: unknown): 'active' | 'revoked' | 'deleted' {
  if (value !== 'active' && value !== 'revoked' && value !== 'deleted') {
    throw new Error('encrypted backup lifecycle is invalid')
  }
  return value
}

function requireKindCode(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) throw new Error('encrypted backup object kind is invalid')
  return value
}

function requirePaddedLength(value: unknown): 65_536 | 262_144 {
  if (value !== 65_536 && value !== 262_144) {
    throw new Error('encrypted backup object padded length is invalid')
  }
  return value
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} is invalid`)
  return value as number
}

function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error('encrypted backup realm is invalid')
  }
  return value
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireExactBytes(value: unknown, length: number, name: string): Uint8Array {
  return requireBytes(value, length, length, name)
}

function requireBytes(value: unknown, minimum: number, maximum: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireKnownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (
    Object.keys(value).some((field) => !fields.includes(field)) ||
    fields.some((field) => !(field in value))
  ) {
    throw new Error('encrypted backup HTTP response fields are invalid')
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function framedObjectDigest(aad: Uint8Array, body: Uint8Array): string {
  return bytesToHex(
    sha256.create().update(uint32be(aad.byteLength)).update(aad).update(body).digest(),
  )
}

function uint32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)
}

function assertNever(value: never): never {
  throw new Error(`unhandled encrypted backup HTTP value: ${String(value)}`)
}
