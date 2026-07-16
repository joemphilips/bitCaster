import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupCasState.ts'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupCasCbor,
  preflightEncryptedBackupPutCbor,
  structurallyPreflightEncryptedBackupAttemptAbortCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  validateEncryptedWalletBackupManifestHeadUnit,
  type ValidatedEncryptedWalletBackupManifestHeadUnit,
} from './encryptedWalletBackupManifestHead.ts'
import {
  assertNever,
  equalBytes,
  framedEncryptedObjectDigest,
  requireBytes,
  requireInteger,
  requireLowerHex,
  requireObjectAad,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES = 4 * 1_024 * 1_024
export const ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES =
  ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES
export const ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES = 128 as const

export interface DecodedEncryptedWalletBackupObjectPutRequest {
  readonly formatVersion: 1
  readonly uploadAttemptId: string
  readonly kindCode: 1 | 2
  readonly realm: string
  readonly vaultId: string
  readonly objectId: string
  readonly generation: number
  readonly paddedLength: 65_536 | 262_144
  readonly objectDigest: string
  readonly canonicalAad: Uint8Array
  readonly encryptedBody: Uint8Array
}

export interface DecodedEncryptedWalletBackupHeadCasRequest {
  readonly formatVersion: 1
  readonly uploadAttemptId: string
  readonly expectedManifestDigest: string | null
  readonly canonicalHead: Uint8Array
  readonly canonicalReferenceSet: Uint8Array
  readonly target: ValidatedEncryptedWalletBackupManifestHeadUnit
}

export interface DecodedEncryptedWalletBackupUploadAttemptAbortRequest {
  readonly formatVersion: 1
  readonly uploadAttemptId: string
  readonly targetManifestDigest: string
}

export type EncryptedWalletBackupDelegatedNoBodyOperation =
  | 'enrollment-epoch'
  | 'head-get'
  | 'object-get'
  | 'object-delete'

export type DecodedEncryptedWalletBackupDelegatedOperationPayload =
  | Readonly<{
      kind: 'no-body'
      operation: EncryptedWalletBackupDelegatedNoBodyOperation
    }>
  | Readonly<{
      kind: 'object-put'
      value: DecodedEncryptedWalletBackupObjectPutRequest
    }>
  | Readonly<{
      kind: 'head-cas'
      value: DecodedEncryptedWalletBackupHeadCasRequest
    }>
  | Readonly<{
      kind: 'upload-attempt-abort'
      value: DecodedEncryptedWalletBackupUploadAttemptAbortRequest
    }>

export type EncryptedWalletBackupDelegatedPayloadRoute =
  | Readonly<{
      operation: 'enrollment-epoch' | 'head-get' | 'head-cas'
      routeRealm: string
      routeVaultId: string
    }>
  | Readonly<{
      operation: 'object-get' | 'object-put' | 'object-delete'
      routeRealm: string
      routeVaultId: string
      routeObjectId: string
    }>
  | Readonly<{
      operation: 'upload-attempt-abort'
      routeRealm: string
      routeVaultId: string
      routeAttemptId: string
    }>

export function encryptedWalletBackupDelegatedPayloadMaximumBytes(
  operation: EncryptedWalletBackupDelegatedPayloadRoute['operation'],
): number {
  switch (operation) {
    case 'enrollment-epoch':
    case 'head-get':
    case 'object-get':
    case 'object-delete':
      return 0
    case 'object-put':
      return ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES
    case 'head-cas':
      return ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES
    case 'upload-attempt-abort':
      return ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES
    default:
      return assertNever(operation)
  }
}

export function decodeEncryptedWalletBackupDelegatedOperationPayload(
  input: Readonly<{
    canonicalPayload: Uint8Array
    route: EncryptedWalletBackupDelegatedPayloadRoute
    requestAuthPublicKey: string
  }>,
): DecodedEncryptedWalletBackupDelegatedOperationPayload {
  switch (input.route.operation) {
    case 'enrollment-epoch':
    case 'head-get':
    case 'object-get':
    case 'object-delete':
      if (input.canonicalPayload.byteLength !== 0) throw new Error()
      return Object.freeze({
        kind: 'no-body',
        operation: input.route.operation,
      })
    case 'object-put':
      return Object.freeze({
        kind: 'object-put',
        value: decodeEncryptedWalletBackupObjectPutRequest({
          canonicalPayload: input.canonicalPayload,
          routeRealm: input.route.routeRealm,
          routeVaultId: input.route.routeVaultId,
          routeObjectId: input.route.routeObjectId,
        }),
      })
    case 'head-cas':
      return Object.freeze({
        kind: 'head-cas',
        value: decodeEncryptedWalletBackupHeadCasRequest({
          canonicalPayload: input.canonicalPayload,
          routeRealm: input.route.routeRealm,
          routeVaultId: input.route.routeVaultId,
          enrolledRequestAuthPublicKey: input.requestAuthPublicKey,
        }),
      })
    case 'upload-attempt-abort':
      return Object.freeze({
        kind: 'upload-attempt-abort',
        value: decodeEncryptedWalletBackupUploadAttemptAbortRequest({
          canonicalPayload: input.canonicalPayload,
          routeAttemptId: input.route.routeAttemptId,
        }),
      })
    default:
      return assertNever(input.route)
  }
}

/** Strict semantic decoder for the canonical object PUT body. */
export function decodeEncryptedWalletBackupObjectPutRequest(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeRealm: string
    routeVaultId: string
    routeObjectId: string
  }>,
): DecodedEncryptedWalletBackupObjectPutRequest {
  try {
    return decodeObjectPutUnchecked(input)
  } catch {
    throw new Error('encrypted backup object PUT request is invalid')
  }
}

/** Strict semantic decoder for the canonical manifest-head CAS body. */
export function decodeEncryptedWalletBackupHeadCasRequest(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeRealm: string
    routeVaultId: string
    enrolledRequestAuthPublicKey: string
  }>,
): DecodedEncryptedWalletBackupHeadCasRequest {
  try {
    return decodeHeadCasUnchecked(input)
  } catch {
    throw new Error('encrypted backup head CAS request is invalid')
  }
}

/** Strict semantic decoder for the canonical upload-attempt abort body. */
export function decodeEncryptedWalletBackupUploadAttemptAbortRequest(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeAttemptId: string
  }>,
): DecodedEncryptedWalletBackupUploadAttemptAbortRequest {
  try {
    return decodeUploadAttemptAbortUnchecked(input)
  } catch {
    throw new Error('encrypted backup upload-attempt abort request is invalid')
  }
}

function decodeObjectPutUnchecked(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeRealm: string
    routeVaultId: string
    routeObjectId: string
  }>,
): DecodedEncryptedWalletBackupObjectPutRequest {
  const decoded = decodeCanonicalObjectPut(input.canonicalPayload)
  const identity = decodeObjectPutIdentity(decoded)
  const routeRealm = requireRealm(input.routeRealm)
  const routeVaultId = requireLowerHex(input.routeVaultId, 32, 'route vault id')
  const routeObjectId = requireLowerHex(input.routeObjectId, 16, 'route object id')
  const encryptedBody = requireBytes(
    decoded[11],
    identity.paddedLength + 28,
    identity.paddedLength + 28,
    'object PUT encrypted body',
  )
  if (
    identity.realm !== routeRealm ||
    identity.vaultId !== routeVaultId ||
    identity.objectId !== routeObjectId ||
    !equalBytes(
      identity.objectDigestBytes,
      framedEncryptedObjectDigest(identity.canonicalAad, encryptedBody),
    )
  ) {
    throw new Error()
  }
  requireObjectAad({ ...identity, canonicalAad: identity.canonicalAad })
  return Object.freeze({
    formatVersion: 1,
    uploadAttemptId: bytesToHex(requireBytes(decoded[2], 16, 16, 'object PUT attempt id')),
    kindCode: identity.kindCode,
    realm: identity.realm,
    vaultId: identity.vaultId,
    objectId: identity.objectId,
    generation: identity.generation,
    paddedLength: identity.paddedLength,
    objectDigest: bytesToHex(identity.objectDigestBytes),
    canonicalAad: identity.canonicalAad.slice(),
    encryptedBody: encryptedBody.slice(),
  })
}

function decodeCanonicalObjectPut(payloadValue: unknown): readonly unknown[] {
  const payload = requireBytes(
    payloadValue,
    1,
    ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES,
    'object PUT payload',
  )
  preflightEncryptedBackupPutCbor(payload)
  const decoded = decode(payload)
  if (
    !equalBytes(payload, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 12 ||
    decoded[0] !== 1 ||
    decoded[1] !== 'object-put'
  ) {
    throw new Error()
  }
  return decoded
}

function decodeObjectPutIdentity(decoded: readonly unknown[]): {
  readonly kindCode: 1 | 2
  readonly realm: string
  readonly vaultId: string
  readonly objectId: string
  readonly generation: number
  readonly paddedLength: 65_536 | 262_144
  readonly objectDigestBytes: Uint8Array
  readonly canonicalAad: Uint8Array
} {
  const kindCode = requireObjectKindCode(decoded[3])
  return {
    kindCode,
    realm: requireRealm(decoded[4]),
    vaultId: bytesToHex(requireBytes(decoded[5], 32, 32, 'object PUT vault id')),
    objectId: bytesToHex(requireBytes(decoded[6], 16, 16, 'object PUT object id')),
    generation: requireInteger(decoded[7], 1, 'object PUT generation'),
    paddedLength: requireObjectPaddedLength(kindCode, decoded[8]),
    objectDigestBytes: requireBytes(decoded[9], 32, 32, 'object PUT digest'),
    canonicalAad: requireBytes(decoded[10], 1, 4_096, 'object PUT AAD'),
  }
}

function decodeHeadCasUnchecked(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeRealm: string
    routeVaultId: string
    enrolledRequestAuthPublicKey: string
  }>,
): DecodedEncryptedWalletBackupHeadCasRequest {
  const decoded = decodeCanonicalHeadCas(input.canonicalPayload)
  const expectedManifestDigest = decodeExpectedManifestDigest(decoded[3])
  const canonicalHead = requireBytes(decoded[4], 1, 65_536, 'head CAS canonical head')
  const canonicalReferenceSet = requireBytes(decoded[5], 1, 65_536, 'head CAS reference set')
  const target = validateEncryptedWalletBackupManifestHeadUnit({
    canonicalHead,
    canonicalReferenceSet,
  })
  requireHeadCasBinding({ ...input, expectedManifestDigest, target })
  return Object.freeze({
    formatVersion: 1,
    uploadAttemptId: bytesToHex(requireBytes(decoded[2], 16, 16, 'head CAS attempt id')),
    expectedManifestDigest,
    canonicalHead: canonicalHead.slice(),
    canonicalReferenceSet: canonicalReferenceSet.slice(),
    target,
  })
}

function decodeCanonicalHeadCas(payloadValue: unknown): readonly unknown[] {
  const payload = requireBytes(
    payloadValue,
    1,
    ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES,
    'head CAS payload',
  )
  preflightEncryptedBackupCasCbor(payload)
  const decoded = decode(payload)
  if (
    !equalBytes(payload, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 6 ||
    decoded[0] !== 1 ||
    decoded[1] !== 'head-cas'
  ) {
    throw new Error()
  }
  return decoded
}

function requireHeadCasBinding(
  input: Readonly<{
    routeRealm: string
    routeVaultId: string
    enrolledRequestAuthPublicKey: string
    expectedManifestDigest: string | null
    target: ValidatedEncryptedWalletBackupManifestHeadUnit
  }>,
): void {
  if (
    input.target.realm !== requireRealm(input.routeRealm) ||
    input.target.vaultId !== requireLowerHex(input.routeVaultId, 32, 'route vault id') ||
    input.target.backupPublicKey !==
      requireLowerHex(input.enrolledRequestAuthPublicKey, 32, 'enrolled request public key') ||
    (input.target.parent === null
      ? input.target.generation !== 1 || input.expectedManifestDigest !== null
      : input.expectedManifestDigest === null ||
        input.target.parent.manifestDigest !== input.expectedManifestDigest)
  ) {
    throw new Error()
  }
}

function decodeUploadAttemptAbortUnchecked(
  input: Readonly<{
    canonicalPayload: Uint8Array
    routeAttemptId: string
  }>,
): DecodedEncryptedWalletBackupUploadAttemptAbortRequest {
  const payload = requireBytes(
    input.canonicalPayload,
    1,
    ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES,
    'upload-attempt abort payload',
  )
  structurallyPreflightEncryptedBackupAttemptAbortCbor(payload)
  const decoded = decode(payload)
  if (
    !equalBytes(payload, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== 1 ||
    decoded[1] !== 'upload-attempt-abort'
  ) {
    throw new Error()
  }
  const uploadAttemptId = bytesToHex(requireBytes(decoded[2], 16, 16, 'upload-attempt abort id'))
  if (uploadAttemptId !== requireLowerHex(input.routeAttemptId, 16, 'route attempt id')) {
    throw new Error()
  }
  return Object.freeze({
    formatVersion: 1,
    uploadAttemptId,
    targetManifestDigest: bytesToHex(
      requireBytes(decoded[3], 32, 32, 'upload-attempt abort target digest'),
    ),
  })
}

function decodeExpectedManifestDigest(value: unknown): string | null {
  return value === null ? null : bytesToHex(requireBytes(value, 32, 32, 'head CAS expected digest'))
}

function requireObjectKindCode(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) throw new Error()
  return value
}

function requireObjectPaddedLength(kindCode: 1 | 2, value: unknown): 65_536 | 262_144 {
  switch (kindCode) {
    case 1:
      if (value !== 262_144) throw new Error()
      return value
    case 2:
      if (value !== 65_536) throw new Error()
      return value
    default:
      return assertNever(kindCode)
  }
}
