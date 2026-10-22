import { decodeEncryptedWalletBackupAuthorizationHeader } from './encryptedWalletBackupDelegatedServerCodec.ts'
import {
  verifyEncryptedWalletBackupOwnerRequest,
  type VerifiedEncryptedWalletBackupOwnerRequest,
  type EncryptedWalletBackupOwnerOperation,
  type EncryptedWalletBackupOwnerRouteContext,
} from './encryptedWalletBackupOwnerRequestProof.ts'
import {
  decodeEncryptedWalletBackupOwnerUploadGroup,
  type DecodedEncryptedWalletBackupOwnerUploadGroup,
} from './encryptedWalletBackupOwnerUpload.ts'
import { deriveEncryptedWalletBackupOwnerScope } from './encryptedWalletBackupOwnerScope.ts'
import {
  requireLowerHex,
  requireRealm,
  requireBytes,
  requireValidXOnlyPublicKey,
  hexToBytesStrict,
} from './encryptedWalletBackupServerValidation.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupV2Limits.ts'
export type EncryptedWalletBackupOwnerServerRoute =
  | {
      readonly operation: 'owner-discovery'
      readonly realm: string
      readonly walletId: string
      readonly requestedCursor: string | null
    }
  | {
      readonly operation: 'enrollment-epoch' | 'current-inventory' | 'bundle-supersession'
      readonly realm: string
      readonly walletId: string
      readonly ownerScopeId: string
    }
  | {
      readonly operation: 'descriptor-page'
      readonly realm: string
      readonly walletId: string
      readonly ownerScopeId: string
      readonly afterBundleId: string | null
    }
  | {
      readonly operation: 'object-get'
      readonly realm: string
      readonly walletId: string
      readonly ownerScopeId: string
      readonly objectId: string
    }
export interface EncryptedWalletBackupOwnerServerEnrollment {
  readonly ownerScopeId: string
  readonly authorizationScheme: string
  readonly ownerSubject: string
  readonly realm: string
  readonly walletId: string
  readonly requestAuthPublicKey: string
  readonly enrollmentEpoch: number
  readonly status: 'active' | 'revoked' | 'deleted'
  readonly accountStatus: 'active' | 'disabled'
}
export interface EncryptedWalletBackupOwnerVerifiedDelegatedServerRequest {
  readonly state: 'verified'
  readonly operation: EncryptedWalletBackupOwnerOperation
}
export interface EncryptedWalletBackupOwnerAuthorizedDelegatedServerRequest {
  readonly state: 'enrollment-authorized'
  readonly operation: EncryptedWalletBackupOwnerOperation
  readonly requestDigest: string
  readonly requestEvidence: VerifiedEncryptedWalletBackupOwnerRequest
  readonly decodedUploadGroup: DecodedEncryptedWalletBackupOwnerUploadGroup | undefined
  readonly discovery:
    | { readonly status: 'active'; readonly enrollmentEpoch: number }
    | { readonly status: 'not-enrolled' }
    | undefined
}
const VERIFIED = new WeakMap<
  object,
  {
    readonly request: VerifiedEncryptedWalletBackupOwnerRequest
    readonly group: DecodedEncryptedWalletBackupOwnerUploadGroup | undefined
  }
>()
/** The route is supplied by the trusted router, never reconstructed from proof claims. */
export function encryptedWalletBackupOwnerServerRoute(
  input: EncryptedWalletBackupOwnerServerRoute,
): {
  readonly method: 'GET' | 'POST'
  readonly rawTarget: string
  readonly context: EncryptedWalletBackupOwnerRouteContext
} {
  const realm = requireRealm(input.realm),
    walletId = requireLowerHex(input.walletId, 32, 'route wallet'),
    base = `/v1/encrypted-wallet-backup/realms/${realm}/wallets/${walletId}/owners`
  if (input.operation === 'owner-discovery') {
    const requestedCursor =
      input.requestedCursor === null
        ? null
        : requireLowerHex(input.requestedCursor, 32, 'owner cursor')
    return Object.freeze({
      method: 'GET',
      rawTarget: base + (requestedCursor === null ? '' : '?after=' + requestedCursor),
      context: Object.freeze({
        operation: input.operation,
        realm,
        walletId,
        ownerScopeId: null,
        requestedCursor,
      }),
    })
  }
  const ownerScopeId = requireLowerHex(input.ownerScopeId, 32, 'route owner')
  let suffix: string
  switch (input.operation) {
    case 'enrollment-epoch':
      suffix = '/enrollment-epoch'
      break
    case 'current-inventory':
      suffix = '/current-inventory'
      break
    case 'bundle-supersession':
      suffix = '/head:compare-and-swap'
      break
    case 'descriptor-page':
      suffix =
        input.afterBundleId === null
          ? '/head'
          : '/head/after/' + requireLowerHex(input.afterBundleId, 16, 'bundle cursor')
      break
    case 'object-get':
      suffix = '/objects/' + requireLowerHex(input.objectId, 16, 'object id')
      break
    default:
      throw new Error('backup owner route operation')
  }
  return Object.freeze({
    method: input.operation === 'bundle-supersession' ? 'POST' : 'GET',
    rawTarget: base + '/' + ownerScopeId + suffix,
    context: Object.freeze({
      operation: input.operation,
      realm,
      walletId,
      ownerScopeId,
      requestedCursor: null,
    }),
  })
}
export function verifyAndDecodeEncryptedWalletBackupOwnerDelegatedServerRequest(input: {
  readonly rawAuthorizationHeaderValues: readonly string[]
  readonly configuredOrigin: string
  readonly rawTarget: string
  readonly method: 'GET' | 'POST'
  readonly route: EncryptedWalletBackupOwnerServerRoute
  readonly payload: Uint8Array
  readonly serverNowUnixSeconds: number
}): EncryptedWalletBackupOwnerVerifiedDelegatedServerRequest {
  const route = encryptedWalletBackupOwnerServerRoute(input.route),
    origin = new URL(input.configuredOrigin)
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== input.configuredOrigin ||
    route.method !== input.method ||
    route.rawTarget !== input.rawTarget
  )
    throw new Error('backup owner route target')
  const limit =
    route.context.operation === 'bundle-supersession'
      ? ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES
      : 0
  const payload = requireBytes(input.payload, limit === 0 ? 0 : 1, limit, 'payload').slice()
  const request = verifyEncryptedWalletBackupOwnerRequest({
    canonicalProof: decodeEncryptedWalletBackupAuthorizationHeader(
      input.rawAuthorizationHeaderValues,
    ),
    route: route.context,
    expectedMethod: route.method,
    expectedUrl: origin.origin + route.rawTarget,
    payload,
    serverNowUnixSeconds: input.serverNowUnixSeconds,
  })
  const claims = request.claims
  const group =
    route.context.operation === 'bundle-supersession'
      ? decodeEncryptedWalletBackupOwnerUploadGroup({
          bytes: payload,
          expectedRequestAuthPublicKey: claims.requestAuthPublicKey,
          expectedContext: {
            ownerScopeId: route.context.ownerScopeId!,
            realm: claims.realm,
            walletId: claims.walletId,
            enrollmentEpoch: claims.enrollmentEpoch,
          },
        })
      : undefined
  const result = Object.freeze({ state: 'verified' as const, operation: route.context.operation })
  VERIFIED.set(result, { request, group })
  return result
}
/** Does no replay I/O. The service owns the stable B2 discovery claim before response. */
export function authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest(input: {
  readonly verifiedRequest: EncryptedWalletBackupOwnerVerifiedDelegatedServerRequest
  readonly enrollment: EncryptedWalletBackupOwnerServerEnrollment | null
}): EncryptedWalletBackupOwnerAuthorizedDelegatedServerRequest {
  const verifiedRequest = input.verifiedRequest
  const authority = VERIFIED.get(verifiedRequest)
  if (authority === undefined) throw new Error('backup owner verified request')
  VERIFIED.delete(verifiedRequest)
  try {
    const { request, group } = authority,
      { claims, route } = request
    let discovery: EncryptedWalletBackupOwnerAuthorizedDelegatedServerRequest['discovery']
    if (route.operation === 'owner-discovery') {
      if (input.enrollment !== null)
        throw new Error('backup owner listing cannot select enrollment')
    } else {
      const row = input.enrollment
      let active = false
      if (row !== null) {
        const derived = deriveEncryptedWalletBackupOwnerScope(row)
        const owner = requireLowerHex(row.ownerScopeId, 32, 'enrollment owner'),
          realm = requireRealm(row.realm),
          wallet = requireLowerHex(row.walletId, 32, 'enrollment wallet'),
          key = requireLowerHex(row.requestAuthPublicKey, 32, 'enrollment key'),
          epoch = row.enrollmentEpoch
        requireValidXOnlyPublicKey(hexToBytesStrict(key, 32, 'enrollment key'), 'enrollment key')
        if (
          derived.ownerScopeId !== owner ||
          owner !== route.ownerScopeId ||
          realm !== route.realm ||
          wallet !== route.walletId ||
          !Number.isSafeInteger(epoch) ||
          epoch < 1 ||
          !['active', 'revoked', 'deleted'].includes(row.status) ||
          !['active', 'disabled'].includes(row.accountStatus)
        )
          throw new Error('backup owner enrollment binding')
        active =
          row.status === 'active' &&
          row.accountStatus === 'active' &&
          key === claims.requestAuthPublicKey
        if (route.operation !== 'enrollment-epoch' && epoch !== claims.enrollmentEpoch)
          throw new Error('backup owner enrollment epoch')
        discovery = active
          ? Object.freeze({ status: 'active', enrollmentEpoch: epoch })
          : Object.freeze({ status: 'not-enrolled' })
      } else discovery = Object.freeze({ status: 'not-enrolled' })
      if (route.operation !== 'enrollment-epoch' && !active)
        throw new Error('backup owner enrollment unauthorized')
    }
    return Object.freeze({
      state: 'enrollment-authorized',
      operation: route.operation,
      requestDigest: request.requestDigest,
      requestEvidence: request,
      decodedUploadGroup: group,
      discovery: route.operation === 'enrollment-epoch' ? discovery : undefined,
    })
  } catch {
    throw new EncryptedWalletBackupOwnerDelegatedServerRejection(authority.request)
  }
}

/** Verified context for a redacted refusal, never content or enrollment authority. */
export class EncryptedWalletBackupOwnerDelegatedServerRejection extends Error {
  readonly requestEvidence: VerifiedEncryptedWalletBackupOwnerRequest
  constructor(request: VerifiedEncryptedWalletBackupOwnerRequest) {
    super('backup owner enrollment unauthorized')
    this.name = 'EncryptedWalletBackupOwnerDelegatedServerRejection'
    this.requestEvidence = request
  }
}
