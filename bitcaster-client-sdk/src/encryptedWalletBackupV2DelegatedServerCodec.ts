import { bytesToHex } from '@noble/hashes/utils.js'
import {
  consumeEncryptedWalletBackupVerifiedRequestReplay,
  encryptedWalletBackupRequestDigest,
  EncryptedWalletBackupReplayRejectedError,
  type EncryptedWalletBackupReplayStore,
  type EncryptedWalletBackupRequestMethod,
  type EncryptedWalletBackupRequestProof,
  type VerifiedEncryptedWalletBackupRequestProofEvidence,
  verifyEncryptedWalletBackupRequestProofEvidence,
} from './encryptedWalletBackup.ts'
import {
  decodeEncryptedWalletBackupAuthorizationHeader,
  decodeEncryptedWalletBackupRequestProofClaims,
} from './encryptedWalletBackupDelegatedServerCodec.ts'
import {
  decodeEncryptedWalletBackupV2UploadGroup,
  type DecodedEncryptedWalletBackupV2UploadGroup,
} from './encryptedWalletBackupV2ServiceCodec.ts'
import {
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
  requireRealm,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupV2Limits.ts'

export type EncryptedWalletBackupV2ServerRoute =
  | Readonly<{ operation: 'enrollment-epoch'; routeRealm: string; routeWalletId: string }>
  | Readonly<{
      operation: 'descriptor-page'
      routeRealm: string
      routeWalletId: string
      routeAfterBundleId: string | null
    }>
  | Readonly<{ operation: 'bundle-supersession'; routeRealm: string; routeWalletId: string }>
  | Readonly<{
      operation: 'object-get'
      routeRealm: string
      routeWalletId: string
      routeObjectId: string
    }>

export interface EncryptedWalletBackupV2DelegatedServerRequestInput {
  readonly rawAuthorizationHeaderValues: readonly string[]
  readonly configuredOrigin: string
  readonly rawTarget: string
  readonly method: EncryptedWalletBackupRequestMethod
  readonly route: EncryptedWalletBackupV2ServerRoute
  readonly payload: Uint8Array
  readonly serverNowUnixSeconds: number
}

export interface EncryptedWalletBackupV2VerifiedDelegatedServerRequest {
  readonly state: 'verified'
  readonly operation: EncryptedWalletBackupV2ServerRoute['operation']
}

export interface EncryptedWalletBackupV2EnrollmentAuthorizedDelegatedServerRequest {
  readonly state: 'enrollment-authorized'
  readonly operation: EncryptedWalletBackupV2ServerRoute['operation']
  readonly requestDigest: string
  readonly claims: EncryptedWalletBackupRequestProof
  readonly decodedUploadGroup: DecodedEncryptedWalletBackupV2UploadGroup | undefined
  readonly discovery:
    | Readonly<{ status: 'active'; enrollmentEpoch: number }>
    | Readonly<{ status: 'not-enrolled' }>
    | undefined
}

/** A verified rejection that retains the exact response binding. */
export class EncryptedWalletBackupV2DelegatedServerRejection extends Error {
  readonly code: 'unauthorized' | 'replay-rejected'
  readonly operation: EncryptedWalletBackupV2ServerRoute['operation']
  readonly requestDigest: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number

  constructor(input: {
    readonly code: 'unauthorized' | 'replay-rejected'
    readonly authority: VerifiedAuthority
  }) {
    super(`encrypted backup v2 request rejected: ${input.code}`)
    this.name = 'EncryptedWalletBackupV2DelegatedServerRejection'
    this.code = input.code
    this.operation = input.authority.operation
    this.requestDigest = encryptedWalletBackupRequestDigest(
      input.authority.claims,
      ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
    )
    this.realm = input.authority.claims.realm
    this.walletId = input.authority.claims.walletId
    this.enrollmentEpoch = input.authority.claims.enrollmentEpoch
  }
}

interface VerifiedAuthority {
  readonly claims: EncryptedWalletBackupRequestProof
  readonly evidence: VerifiedEncryptedWalletBackupRequestProofEvidence
  readonly operation: EncryptedWalletBackupV2ServerRoute['operation']
  readonly route: ValidatedRoute
  readonly uploadGroup: DecodedEncryptedWalletBackupV2UploadGroup | undefined
}

interface ValidatedRoute {
  readonly operation: EncryptedWalletBackupV2ServerRoute['operation']
  readonly realm: string
  readonly walletId: string
  readonly method: EncryptedWalletBackupRequestMethod
  readonly rawTarget: string
}

const VERIFIED_REQUESTS = new WeakMap<
  EncryptedWalletBackupV2VerifiedDelegatedServerRequest,
  VerifiedAuthority
>()

/** Verifies request binding and V2 payload semantics without durable replay consumption. */
export function verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest(
  input: EncryptedWalletBackupV2DelegatedServerRequestInput,
): EncryptedWalletBackupV2VerifiedDelegatedServerRequest {
  const route = validateRoute(input.route)
  const payload = requirePayload(input.payload, route.operation)
  if (input.method !== route.method || input.rawTarget !== route.rawTarget)
    throw new Error('encrypted backup v2 request is invalid')
  const claims = decodeEncryptedWalletBackupRequestProofClaims(
    decodeEncryptedWalletBackupAuthorizationHeader(input.rawAuthorizationHeaderValues),
    ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  )
  const evidence = verifyEncryptedWalletBackupRequestProofEvidence({
    proof: claims,
    expectedMethod: route.method,
    expectedUrl: `${requireOrigin(input.configuredOrigin)}${route.rawTarget}`,
    payload,
    serverNowUnixSeconds: input.serverNowUnixSeconds,
    maximumPayloadBytes: ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  })
  requireClaimsForRoute(evidence.claims, route)
  const uploadGroup = decodeUploadGroup(route.operation, payload, evidence.claims)
  const verified = Object.freeze({ state: 'verified' as const, operation: route.operation })
  VERIFIED_REQUESTS.set(
    verified,
    Object.freeze({
      claims: evidence.claims,
      evidence,
      operation: route.operation,
      route,
      uploadGroup,
    }),
  )
  return verified
}

/** Authorizes a verified V2 request against the current enrollment without replay I/O. */
export function authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest(input: {
  readonly verifiedRequest: EncryptedWalletBackupV2VerifiedDelegatedServerRequest
  readonly enrollment: EncryptedWalletBackupV2ServerEnrollment
}): EncryptedWalletBackupV2EnrollmentAuthorizedDelegatedServerRequest {
  const authority = VERIFIED_REQUESTS.get(input.verifiedRequest)
  if (authority === undefined) throw new Error('encrypted backup v2 verified request is invalid')
  VERIFIED_REQUESTS.delete(input.verifiedRequest)
  const discovery = enrollmentDiscovery(input.enrollment, authority.claims, authority.operation)
  if (authority.operation !== 'enrollment-epoch' && discovery.status !== 'active')
    throw new EncryptedWalletBackupV2DelegatedServerRejection({
      code: 'unauthorized',
      authority,
    })
  return Object.freeze({
    state: 'enrollment-authorized',
    operation: authority.operation,
    requestDigest: encryptedWalletBackupRequestDigest(
      authority.claims,
      ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
    ),
    claims: Object.freeze({ ...authority.claims }),
    decodedUploadGroup: authority.uploadGroup,
    discovery: authority.operation === 'enrollment-epoch' ? discovery : undefined,
  })
}

/** Discovery retains legacy durable replay protection. Content operations do not use this function. */
export async function consumeEncryptedWalletBackupV2EnrollmentDiscoveryReplay(input: {
  readonly verifiedRequest: EncryptedWalletBackupV2VerifiedDelegatedServerRequest
  readonly enrollment: EncryptedWalletBackupV2ServerEnrollment
  readonly replayStore: EncryptedWalletBackupReplayStore
}): Promise<EncryptedWalletBackupV2EnrollmentAuthorizedDelegatedServerRequest> {
  const authority = VERIFIED_REQUESTS.get(input.verifiedRequest)
  if (authority === undefined || authority.operation !== 'enrollment-epoch')
    throw new Error('encrypted backup v2 enrollment discovery request is invalid')
  const authorized = authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest(input)
  try {
    await consumeEncryptedWalletBackupVerifiedRequestReplay({
      verifiedProof: authority.evidence,
      replayStore: input.replayStore,
    })
  } catch (error) {
    if (error instanceof EncryptedWalletBackupReplayRejectedError)
      throw new EncryptedWalletBackupV2DelegatedServerRejection({
        code: 'replay-rejected',
        authority,
      })
    throw error
  }
  return authorized
}

function validateRoute(value: EncryptedWalletBackupV2ServerRoute): ValidatedRoute {
  if (typeof value !== 'object' || value === null)
    throw new Error('encrypted backup v2 route is invalid')
  const realm = requireRealm(value.routeRealm)
  const walletId = requireLowerHex(value.routeWalletId, 32, 'route wallet id')
  const base = `/v1/encrypted-wallet-backup/realms/${realm}/wallets/${walletId}`
  switch (value.operation) {
    case 'enrollment-epoch':
      return route(value.operation, realm, walletId, 'GET', `${base}/enrollment-epoch`)
    case 'descriptor-page': {
      const after = value.routeAfterBundleId
      if (after !== null && after !== undefined) {
        return route(
          value.operation,
          realm,
          walletId,
          'GET',
          `${base}/head/after/${requireLowerHex(after, 16, 'bundle cursor')}`,
        )
      }
      return route(value.operation, realm, walletId, 'GET', `${base}/head`)
    }
    case 'bundle-supersession':
      return route(value.operation, realm, walletId, 'POST', `${base}/head:compare-and-swap`)
    case 'object-get':
      return route(
        value.operation,
        realm,
        walletId,
        'GET',
        `${base}/objects/${requireLowerHex(value.routeObjectId, 16, 'route object id')}`,
      )
    default:
      return assertNever(value)
  }
}

function requirePayload(
  value: Uint8Array,
  operation: EncryptedWalletBackupV2ServerRoute['operation'],
): Uint8Array {
  const maximum =
    operation === 'bundle-supersession' ? ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES : 0
  return requireBytes(value, maximum === 0 ? 0 : 1, maximum, 'request payload').slice()
}

function requireClaimsForRoute(
  claims: EncryptedWalletBackupRequestProof,
  route: ValidatedRoute,
): void {
  if (claims.realm !== route.realm || claims.walletId !== route.walletId)
    throw new Error('encrypted backup v2 request scope is invalid')
  if (route.operation === 'enrollment-epoch') {
    if (claims.enrollmentEpoch !== 0)
      throw new Error('encrypted backup v2 discovery epoch is invalid')
  } else if (claims.enrollmentEpoch < 1) {
    throw new Error('encrypted backup v2 content epoch is invalid')
  }
}

function decodeUploadGroup(
  operation: EncryptedWalletBackupV2ServerRoute['operation'],
  payload: Uint8Array,
  claims: EncryptedWalletBackupRequestProof,
): DecodedEncryptedWalletBackupV2UploadGroup | undefined {
  if (operation !== 'bundle-supersession') return undefined
  return decodeEncryptedWalletBackupV2UploadGroup({
    bytes: payload,
    expectedRequestAuthPublicKey: claims.requestAuthPublicKey,
    expectedContext: {
      realm: claims.realm,
      walletId: claims.walletId,
      enrollmentEpoch: claims.enrollmentEpoch,
    },
  })
}

function enrollmentDiscovery(
  enrollment: EncryptedWalletBackupV2ServerEnrollment,
  claims: EncryptedWalletBackupRequestProof,
  operation: EncryptedWalletBackupV2ServerRoute['operation'],
): Readonly<{ status: 'active'; enrollmentEpoch: number }> | Readonly<{ status: 'not-enrolled' }> {
  try {
    if (enrollment.protocolVersion !== 2) return Object.freeze({ status: 'not-enrolled' })
    const matches =
      enrollment.status === 'active' &&
      requireRealm(enrollment.realm) === claims.realm &&
      requireLowerHex(enrollment.walletId, 32, 'enrolled wallet id') === claims.walletId &&
      bytesToHex(
        requireValidXOnlyPublicKey(
          hexToBytesStrict(enrollment.requestAuthPublicKey, 32, 'request public key'),
          'request public key',
        ),
      ) === claims.requestAuthPublicKey &&
      (operation === 'enrollment-epoch' || enrollment.enrollmentEpoch === claims.enrollmentEpoch)
    return matches && enrollment.status === 'active'
      ? Object.freeze({ status: 'active', enrollmentEpoch: enrollment.enrollmentEpoch })
      : Object.freeze({ status: 'not-enrolled' })
  } catch {
    return Object.freeze({ status: 'not-enrolled' })
  }
}

function route(
  operation: EncryptedWalletBackupV2ServerRoute['operation'],
  realm: string,
  walletId: string,
  method: EncryptedWalletBackupRequestMethod,
  rawTarget: string,
): ValidatedRoute {
  return { operation, realm, walletId, method, rawTarget }
}

function requireOrigin(value: string): string {
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('encrypted backup v2 origin is invalid')
  return parsed.origin
}

function assertNever(value: never): never {
  throw new Error(`unsupported encrypted backup v2 route: ${String(value)}`)
}
export type EncryptedWalletBackupV2ServerEnrollment =
  | Readonly<{ status: 'not-enrolled'; protocolVersion: 2 }>
  | Readonly<{
      status: 'active'
      protocolVersion: 2
      realm: string
      walletId: string
      requestAuthPublicKey: string
      enrollmentEpoch: number
    }>
