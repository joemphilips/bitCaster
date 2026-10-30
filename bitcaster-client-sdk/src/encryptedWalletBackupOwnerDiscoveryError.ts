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
  requireVerifiedEncryptedWalletBackupOwnerRequest,
  requireIssuedEncryptedWalletBackupOwnerRequest,
  encryptedWalletBackupOwnerRequestDigest,
  type VerifiedEncryptedWalletBackupOwnerRequest,
  type EncryptedWalletBackupOwnerRequestProof,
} from './encryptedWalletBackupOwnerRequestProof.ts'
import {
  encodeEncryptedWalletBackupOwnerHttpError,
  decodeEncryptedWalletBackupOwnerHttpError,
  type EncryptedWalletBackupOwnerHttpErrorCode,
} from './encryptedWalletBackupOwnerHttpCodec.ts'
import {
  hexToBytesStrict,
  requireBytes,
  requireRealm,
  requireLowerHex,
} from './encryptedWalletBackupServerValidation.ts'
export function encodeEncryptedWalletBackupOwnerDiscoveryError(input: {
  readonly request: VerifiedEncryptedWalletBackupOwnerRequest
  readonly code: EncryptedWalletBackupOwnerHttpErrorCode
  readonly retryAfterSeconds: number | null
}): Uint8Array {
  const request = requireVerifiedEncryptedWalletBackupOwnerRequest(input.request)
  if (request.route.operation !== 'owner-discovery')
    throw new Error('backup owner discovery error purpose')
  const proof = request.claims
  const result = encodeCanonicalBackupCbor([
    1,
    'backup-owner-discovery-error',
    hexToBytesStrict(request.requestDigest, 32, 'request digest'),
    proof.realm,
    hexToBytesStrict(proof.walletId, 32, 'wallet id'),
    hexToBytesStrict(proof.requestAuthPublicKey, 32, 'request key'),
    request.route.requestedCursor,
    encodeEncryptedWalletBackupOwnerHttpError({
      operation: 'owner-discovery',
      code: input.code,
      retryAfterSeconds: input.retryAfterSeconds,
    }),
  ])
  if (result.length > 512) throw new Error('backup owner discovery error size')
  return result
}
export function consumeEncryptedWalletBackupOwnerDiscoveryError(input: {
  readonly request: EncryptedWalletBackupOwnerRequestProof
  readonly bytes: Uint8Array
}): ReturnType<typeof decodeEncryptedWalletBackupOwnerHttpError> {
  const request = input.request
  const route = requireIssuedEncryptedWalletBackupOwnerRequest(request)
  if (route.operation !== 'owner-discovery') throw new Error('backup owner discovery error purpose')
  const record = decodeOwnerHttpTuple(input.bytes, 512, [
    uint(1),
    text('backup-owner-discovery-error'),
    bytes(32),
    textLength(64),
    bytes(32),
    bytes(32),
    nullable(textLength(64)),
    bytes(1, 128),
  ])
  const hex = (value: unknown) => bytesToHex(requireBytes(value, 32, 32, 'identifier'))
  const cursor = record[6] === null ? null : requireLowerHex(record[6], 32, 'owner cursor')
  if (
    hex(record[2]) !== encryptedWalletBackupOwnerRequestDigest(request) ||
    requireRealm(record[3]) !== route.realm ||
    hex(record[4]) !== route.walletId ||
    hex(record[5]) !== request.requestAuthPublicKey ||
    cursor !== route.requestedCursor
  )
    throw new Error('backup owner discovery error binding')
  const error = decodeEncryptedWalletBackupOwnerHttpError(requireBytes(record[7], 1, 128, 'error'))
  if (error.operation !== 'owner-discovery')
    throw new Error('backup owner discovery error operation')
  return error
}
