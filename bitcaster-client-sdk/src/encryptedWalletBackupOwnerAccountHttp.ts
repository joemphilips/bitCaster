import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  decodeOwnerHttpTuple,
  ownerHttpUint as uint,
  ownerHttpBytes as bytes,
  ownerHttpText as text,
  ownerHttpTextLength as textLength,
  ownerHttpNullable as nullable,
} from './encryptedWalletBackupOwnerHttpTuple.ts'
import {
  encodeEncryptedWalletBackupHttpResponse,
  requireEncryptedWalletBackupAccountResultLifecycle,
  type EncryptedWalletBackupHttpErrorCode,
} from './encryptedWalletBackupHttpCodec.ts'
import {
  readPreparedEncryptedWalletBackupOwnerAccountOperation,
  decodeEncryptedWalletBackupOwnerAccountRequest,
  type PreparedEncryptedWalletBackupOwnerAccountOperation,
} from './encryptedWalletBackupOwnerAccount.ts'
import {
  hexToBytesStrict,
  requireBytes,
  requireRealm,
  requireLowerHex,
} from './encryptedWalletBackupServerValidation.ts'
interface AccountContext {
  readonly action: 'enroll' | 'revoke' | 'delete'
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly operationId: string
  readonly intentDigest: string
}
export type EncryptedWalletBackupOwnerAccountResponse =
  | (AccountContext & {
      readonly kind: 'account-result'
      readonly result: 'committed' | 'conflict'
      readonly enrollmentEpoch: number
      readonly lifecycle: 'active' | 'revoked' | 'deleted'
    })
  | (AccountContext & {
      readonly kind: 'account-error'
      readonly code: EncryptedWalletBackupHttpErrorCode
      readonly retryAfterSeconds: number | null
    })
  | {
      readonly kind: 'error'
      readonly code: EncryptedWalletBackupHttpErrorCode
      readonly retryAfterSeconds: number | null
    }
function context(value: AccountContext): AccountContext {
  if (!['enroll', 'revoke', 'delete'].includes(value.action))
    throw new Error('backup owner account action')
  return Object.freeze({
    action: value.action,
    ownerScopeId: requireLowerHex(value.ownerScopeId, 32, 'owner scope id'),
    realm: requireRealm(value.realm),
    walletId: requireLowerHex(value.walletId, 32, 'wallet id'),
    operationId: requireLowerHex(value.operationId, 16, 'operation id'),
    intentDigest: requireLowerHex(value.intentDigest, 32, 'intent digest'),
  })
}
/** Encoding validates shared legacy result/error scalars but never grants legacy authority. */
export function encodeEncryptedWalletBackupOwnerAccountHttpResponse(
  value: EncryptedWalletBackupOwnerAccountResponse,
): Uint8Array {
  let tuple: unknown[]
  if (value.kind === 'error') {
    encodeEncryptedWalletBackupHttpResponse(value)
    tuple = [3, 'error', value.code, value.retryAfterSeconds]
  } else {
    const c = context(value),
      prefix = [
        3,
        value.kind,
        c.action,
        hexToBytesStrict(c.ownerScopeId, 32, 'owner'),
        c.realm,
        hexToBytesStrict(c.walletId, 32, 'wallet'),
        hexToBytesStrict(c.operationId, 16, 'operation'),
        hexToBytesStrict(c.intentDigest, 32, 'intent'),
      ]
    if (value.kind === 'account-result') {
      encodeEncryptedWalletBackupHttpResponse({
        kind: 'account-result',
        operationId: c.operationId,
        intentDigest: c.intentDigest,
        result: value.result,
        enrollmentEpoch: value.enrollmentEpoch,
        lifecycle: value.lifecycle,
      })
      tuple = [...prefix, value.result, value.enrollmentEpoch, value.lifecycle]
    } else if (value.kind === 'account-error') {
      encodeEncryptedWalletBackupHttpResponse({
        kind: 'error',
        code: value.code,
        retryAfterSeconds: value.retryAfterSeconds,
      })
      tuple = [...prefix, value.code, value.retryAfterSeconds]
    } else throw new Error('backup owner account response kind')
  }
  const output = encodeCanonicalBackupCbor(tuple)
  if (output.length > (value.kind === 'error' ? 128 : 256))
    throw new Error('backup owner account response size')
  return output
}
/** A generic refusal is returned as an error only; it has no lifecycle authority. */
export function consumeEncryptedWalletBackupOwnerAccountHttpResponse(input: {
  readonly prepared: PreparedEncryptedWalletBackupOwnerAccountOperation
  readonly httpStatus: number
  readonly bytes: Uint8Array
}): EncryptedWalletBackupOwnerAccountResponse {
  const prepared = input.prepared
  const request = decodeEncryptedWalletBackupOwnerAccountRequest(
      readPreparedEncryptedWalletBackupOwnerAccountOperation(prepared),
    ),
    intent = request.accountRequest.intent
  const expected = context({
    action: intent.action,
    ownerScopeId: prepared.ownerScopeId,
    realm: intent.realm,
    walletId: intent.walletId,
    operationId: intent.operationId,
    intentDigest: request.accountRequest.intentDigest,
  })
  let result: EncryptedWalletBackupOwnerAccountResponse
  if (input.bytes[0] === 0x84) {
    const r = decodeOwnerHttpTuple(input.bytes, 128, [
      uint(3),
      text('error'),
      textLength(64),
      nullable(uint()),
    ])
    result = {
      kind: 'error',
      code: r[2] as EncryptedWalletBackupHttpErrorCode,
      retryAfterSeconds: r[3] as number | null,
    }
  } else {
    const success = input.bytes[0] === 0x8b
    const fields = [
      uint(3),
      text(success ? 'account-result' : 'account-error'),
      textLength(6),
      bytes(32),
      textLength(64),
      bytes(32),
      bytes(16),
      bytes(32),
      textLength(64),
      success ? uint() : nullable(uint()),
      ...(success ? [textLength(7)] : []),
    ]
    const r = decodeOwnerHttpTuple(input.bytes, 256, fields),
      hex = (v: unknown, n: number) => bytesToHex(requireBytes(v, n, n, 'identifier'))
    const c = context({
      action: r[2] as AccountContext['action'],
      ownerScopeId: hex(r[3], 32),
      realm: requireRealm(r[4]),
      walletId: hex(r[5], 32),
      operationId: hex(r[6], 16),
      intentDigest: hex(r[7], 32),
    })
    if (
      Object.keys(expected).some(
        (key) => c[key as keyof AccountContext] !== expected[key as keyof AccountContext],
      )
    )
      throw new Error('backup owner account response binding')
    result = success
      ? {
          kind: 'account-result',
          ...c,
          result: r[8] as 'committed' | 'conflict',
          enrollmentEpoch: r[9] as number,
          lifecycle: r[10] as 'active' | 'revoked' | 'deleted',
        }
      : {
          kind: 'account-error',
          ...c,
          code: r[8] as EncryptedWalletBackupHttpErrorCode,
          retryAfterSeconds: r[9] as number | null,
        }
  }
  encodeEncryptedWalletBackupOwnerAccountHttpResponse(result)
  if (result.kind === 'account-result')
    requireEncryptedWalletBackupAccountResultLifecycle(
      `account-${expected.action}`,
      result.result,
      result.lifecycle,
    )
  if (
    result.kind === 'account-result'
      ? input.httpStatus !== 200
      : !Number.isInteger(input.httpStatus) || input.httpStatus < 400 || input.httpStatus > 599
  )
    throw new Error('backup owner account HTTP status')
  return Object.freeze(result)
}
