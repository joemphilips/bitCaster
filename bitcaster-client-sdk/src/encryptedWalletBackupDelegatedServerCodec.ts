import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  consumeEncryptedWalletBackupVerifiedRequestReplay,
  EncryptedWalletBackupReplayRejectedError,
  EncryptedWalletBackupReplayStoreUnavailableError,
  verifyEncryptedWalletBackupRequestProofEvidence,
  type EncryptedWalletBackupReplayStore,
  type EncryptedWalletBackupRequestMethod,
  type EncryptedWalletBackupRequestProof,
  type VerifiedEncryptedWalletBackupRequestProofEvidence,
} from './encryptedWalletBackup.ts'
export {
  EncryptedWalletBackupReplayRejectedError,
  EncryptedWalletBackupReplayStoreUnavailableError,
} from './encryptedWalletBackup.ts'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupRequestProofCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  assertNever,
  decodeCanonicalBase64Url,
  equalBytes,
  hexToBytesStrict,
  requireBoundedInteger,
  requireBytes,
  requireDelegatedMethod,
  requireExactHttpsOrigin,
  requireExactHttpsUrl,
  requireInteger,
  requireLowerHex,
  requireRealm,
  requireReplayStore,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'
import {
  decodeEncryptedWalletBackupDelegatedOperationPayload,
  encryptedWalletBackupDelegatedPayloadMaximumBytes,
  type DecodedEncryptedWalletBackupDelegatedOperationPayload,
} from './encryptedWalletBackupDelegatedServerPayloadCodec.ts'
import { ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupLimits.ts'

export * from './encryptedWalletBackupDelegatedServerPayloadCodec.ts'

const AUTHORIZATION_PREFIX = 'BackupV1 '

export const ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES = 4_096 as const
export const ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS = 5_471 as const

export type EncryptedWalletBackupServerRoute =
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

export type EncryptedWalletBackupServerEnrollment =
  | Readonly<{ status: 'not-enrolled' }>
  | Readonly<{
      status: 'active'
      realm: string
      vaultId: string
      requestAuthPublicKey: string
      enrollmentEpoch: number
    }>

export interface DecodedEncryptedWalletBackupRequestProofClaims extends EncryptedWalletBackupRequestProof {}

export interface AuthenticatedEncryptedWalletBackupDelegatedServerRequest {
  readonly kind: 'authenticated'
  readonly operation: EncryptedWalletBackupServerRoute['operation']
  readonly claims: DecodedEncryptedWalletBackupRequestProofClaims
  readonly requestDigest: string
  readonly replayNonce: string
  readonly discovery:
    | Readonly<{ status: 'active'; enrollmentEpoch: number }>
    | Readonly<{ status: 'not-enrolled' }>
    | undefined
}

export interface AuthenticatedAndDecodedEncryptedWalletBackupDelegatedServerRequest {
  readonly authentication: AuthenticatedEncryptedWalletBackupDelegatedServerRequest
  readonly decodedPayload: DecodedEncryptedWalletBackupDelegatedOperationPayload
}

export interface EncryptedWalletBackupDelegatedServerRequestInput {
  readonly rawAuthorizationHeaderValues: readonly string[]
  readonly configuredOrigin: string
  readonly rawTarget: string
  readonly method: EncryptedWalletBackupRequestMethod
  readonly route: EncryptedWalletBackupServerRoute
  readonly payload: Uint8Array
  readonly serverNowUnixSeconds: number
  readonly enrollment: EncryptedWalletBackupServerEnrollment
  readonly replayStore: EncryptedWalletBackupReplayStore
}

export type EncryptedWalletBackupDelegatedServerRequestVerificationInput = Omit<
  EncryptedWalletBackupDelegatedServerRequestInput,
  'enrollment' | 'replayStore'
>

export interface VerifiedEncryptedWalletBackupDelegatedServerRequest {
  readonly state: 'verified'
  readonly operation: EncryptedWalletBackupServerRoute['operation']
}

export interface EncryptedWalletBackupVerifiedDelegatedServerRequestInput {
  readonly verifiedRequest: VerifiedEncryptedWalletBackupDelegatedServerRequest
  readonly enrollment: EncryptedWalletBackupServerEnrollment
}

export interface EnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest {
  readonly state: 'enrollment-authorized'
  readonly operation: EncryptedWalletBackupServerRoute['operation']
  readonly accountAdmission: 'enrolled-account' | 'not-applicable'
}

export interface EncryptedWalletBackupEnrollmentAuthorizedDelegatedServerRequestInput {
  readonly authorizedRequest: EnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest
  readonly replayStore: EncryptedWalletBackupReplayStore
}

export type EncryptedWalletBackupDelegatedRequestErrorCode =
  | 'invalid-request'
  | 'unauthorized'
  | 'replay-rejected'

export class EncryptedWalletBackupDelegatedRequestError extends Error {
  readonly code: EncryptedWalletBackupDelegatedRequestErrorCode

  constructor(code: EncryptedWalletBackupDelegatedRequestErrorCode) {
    super(`delegated request rejected: ${code}`)
    this.name = 'EncryptedWalletBackupDelegatedRequestError'
    this.code = code
  }
}

interface ValidatedDelegatedRequestContext {
  readonly proofBytes: Uint8Array
  readonly route: ValidatedServerRoute
  readonly method: EncryptedWalletBackupRequestMethod
  readonly expectedUrl: string
  readonly payload: Uint8Array
}

interface VerifiedDelegatedRequestContext extends ValidatedDelegatedRequestContext {
  readonly verifiedProof: VerifiedEncryptedWalletBackupRequestProofEvidence
  readonly claims: DecodedEncryptedWalletBackupRequestProofClaims
}

interface VerifiedAndDecodedDelegatedRequestAuthority {
  readonly context: VerifiedDelegatedRequestContext
  readonly decodedPayload: DecodedEncryptedWalletBackupDelegatedOperationPayload
}

interface EnrollmentAuthorizedDelegatedRequestAuthority extends VerifiedAndDecodedDelegatedRequestAuthority {
  readonly discovery:
    | Readonly<{ status: 'active'; enrollmentEpoch: number }>
    | Readonly<{ status: 'not-enrolled' }>
    | undefined
}

const VERIFIED_DELEGATED_REQUESTS = new WeakMap<
  VerifiedEncryptedWalletBackupDelegatedServerRequest,
  VerifiedAndDecodedDelegatedRequestAuthority
>()

const ENROLLMENT_AUTHORIZED_DELEGATED_REQUESTS = new WeakMap<
  EnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest,
  EnrollmentAuthorizedDelegatedRequestAuthority
>()

interface ValidatedServerRoute {
  readonly source: EncryptedWalletBackupServerRoute
  readonly operation: EncryptedWalletBackupServerRoute['operation']
  readonly realm: string
  readonly vaultId: string
  readonly method: EncryptedWalletBackupRequestMethod
  readonly rawTarget: string
}

/** Decodes one raw, uncombined, canonical `Authorization: BackupV1` value. */
export function decodeEncryptedWalletBackupAuthorizationHeader(
  rawHeaderValues: readonly string[],
): Uint8Array {
  try {
    return decodeAuthorizationHeaderUnchecked(rawHeaderValues)
  } catch {
    throw new Error('encrypted backup authorization header is invalid; request proof is invalid')
  }
}

/** Strict public decoder for canonical delegated request-proof claims. */
export function decodeEncryptedWalletBackupRequestProofClaims(
  canonicalProof: Uint8Array,
  maximumPayloadBytes: number = ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES,
): DecodedEncryptedWalletBackupRequestProofClaims {
  try {
    return decodeRequestProofClaimsUnchecked(
      canonicalProof,
      requireRequestProofPayloadMaximum(maximumPayloadBytes),
    )
  } catch {
    throw new Error('encrypted backup request proof is invalid')
  }
}

/**
 * Compatibility authentication API; semantic operation decoding is mandatory.
 */
export async function authenticateEncryptedWalletBackupDelegatedServerRequest(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestInput>,
): Promise<AuthenticatedEncryptedWalletBackupDelegatedServerRequest> {
  return (await authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest(input))
    .authentication
}

/**
 * Verifies the self-signed request, semantically decodes its operation, checks
 * enrollment binding, and only then consumes the replay nonce.
 */
export async function authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestInput>,
): Promise<AuthenticatedAndDecodedEncryptedWalletBackupDelegatedServerRequest> {
  const verifiedRequest = verifyAndDecodeEncryptedWalletBackupDelegatedServerRequest(input)
  const authorizedRequest = authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest({
    verifiedRequest,
    enrollment: input.enrollment,
  })
  return authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest({
    authorizedRequest,
    replayStore: input.replayStore,
  })
}

/**
 * Verifies the request signature, exact route and body binding, and semantic
 * payload entirely in memory. The returned value is an SDK-issued capability;
 * copying its visible fields does not grant continuation authority.
 */
export function verifyAndDecodeEncryptedWalletBackupDelegatedServerRequest(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestVerificationInput>,
): VerifiedEncryptedWalletBackupDelegatedServerRequest {
  const context = requireSelfAuthenticatedProof(input, requireDelegatedRequestContext(input))
  const decodedPayload = requireDecodedOperationPayload(context)
  const verifiedRequest = Object.freeze({
    state: 'verified' as const,
    operation: context.route.operation,
  })
  VERIFIED_DELEGATED_REQUESTS.set(verifiedRequest, Object.freeze({ context, decodedPayload }))
  return verifiedRequest
}

/** Checks current enrollment without consuming replay or other durable state. */
export function authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest(
  input: Readonly<EncryptedWalletBackupVerifiedDelegatedServerRequestInput>,
): EnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest {
  const authority = VERIFIED_DELEGATED_REQUESTS.get(input.verifiedRequest)
  if (authority === undefined) {
    throw new Error('encrypted backup verified delegated request is invalid')
  }
  VERIFIED_DELEGATED_REQUESTS.delete(input.verifiedRequest)
  const discovery = authorizeEnrollment(input.enrollment, authority.context)
  const authorizedRequest = Object.freeze({
    state: 'enrollment-authorized' as const,
    operation: authority.context.route.operation,
    accountAdmission: accountAdmissionForDiscovery(discovery),
  })
  ENROLLMENT_AUTHORIZED_DELEGATED_REQUESTS.set(
    authorizedRequest,
    Object.freeze({ ...authority, discovery }),
  )
  return authorizedRequest
}

/** Consumes replay only after the host has acquired required admission. */
export async function authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest(
  input: Readonly<EncryptedWalletBackupEnrollmentAuthorizedDelegatedServerRequestInput>,
): Promise<AuthenticatedAndDecodedEncryptedWalletBackupDelegatedServerRequest> {
  const authority = ENROLLMENT_AUTHORIZED_DELEGATED_REQUESTS.get(input.authorizedRequest)
  if (authority === undefined) {
    throw new Error('encrypted backup enrollment-authorized delegated request is invalid')
  }
  ENROLLMENT_AUTHORIZED_DELEGATED_REQUESTS.delete(input.authorizedRequest)
  const { context, decodedPayload, discovery } = authority
  const evidence = await authenticateDelegatedProof(input.replayStore, context)
  const authentication = Object.freeze({
    kind: 'authenticated',
    operation: context.route.operation,
    claims: context.claims,
    requestDigest: evidence.requestDigest,
    replayNonce: evidence.replayNonce,
    discovery,
  })
  return Object.freeze({ authentication, decodedPayload })
}

function accountAdmissionForDiscovery(
  discovery: EnrollmentAuthorizedDelegatedRequestAuthority['discovery'],
): EnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest['accountAdmission'] {
  const status = discovery?.status
  switch (status) {
    case undefined:
    case 'active':
      return 'enrolled-account'
    case 'not-enrolled':
      return 'not-applicable'
    default:
      return assertNever(status)
  }
}

function decodeAuthorizationHeaderUnchecked(rawHeaderValues: readonly string[]): Uint8Array {
  if (
    !Array.isArray(rawHeaderValues) ||
    rawHeaderValues.length !== 1 ||
    typeof rawHeaderValues[0] !== 'string'
  ) {
    throw new Error()
  }
  const value = rawHeaderValues[0]
  if (
    value.length > ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS ||
    !/^BackupV1 [A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error()
  }
  const decoded = decodeCanonicalBase64Url(value.slice(AUTHORIZATION_PREFIX.length))
  return requireBytes(decoded, 1, ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES, 'request proof')
}

function decodeRequestProofClaimsUnchecked(
  canonicalProof: Uint8Array,
  maximumPayloadBytes: number,
): DecodedEncryptedWalletBackupRequestProofClaims {
  const proofBytes = requireBytes(
    canonicalProof,
    1,
    ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
    'request proof',
  )
  preflightEncryptedBackupRequestProofCbor(proofBytes)
  const decoded = decode(proofBytes)
  if (
    !equalBytes(proofBytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 14 ||
    decoded[0] !== 1 ||
    decoded[1] !== 'backup-request-proof'
  ) {
    throw new Error()
  }
  return Object.freeze({
    formatVersion: 1,
    realm: requireRealm(decoded[2]),
    vaultId: bytesToHex(requireBytes(decoded[3], 32, 32, 'request vault id')),
    requestAuthPublicKey: bytesToHex(requireValidXOnlyPublicKey(decoded[4], 'request public key')),
    enrollmentEpoch: requireInteger(decoded[5], 0, 'request epoch'),
    method: requireDelegatedMethod(decoded[6]),
    url: requireExactHttpsUrl(decoded[7]),
    issuedAtUnixSeconds: requireInteger(decoded[8], 0, 'request issue time'),
    expiresAtUnixSeconds: requireInteger(decoded[9], 0, 'request expiry time'),
    replayNonce: bytesToHex(requireBytes(decoded[10], 16, 16, 'request replay nonce')),
    payloadLength: requireBoundedInteger(
      decoded[11],
      0,
      maximumPayloadBytes,
      'request payload length',
    ),
    payloadDigest: bytesToHex(requireBytes(decoded[12], 32, 32, 'request payload digest')),
    signature: bytesToHex(requireBytes(decoded[13], 64, 64, 'request signature')),
  })
}

function requireRequestProofPayloadMaximum(value: unknown): number {
  return requireBoundedInteger(value, 0, 4 * 1_024 * 1_024, 'request payload maximum')
}

function requireDelegatedRequestContext(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestVerificationInput>,
): ValidatedDelegatedRequestContext {
  try {
    const proofBytes = decodeEncryptedWalletBackupAuthorizationHeader(
      input.rawAuthorizationHeaderValues,
    )
    const route = validateServerRoute(input.route)
    const method = requireDelegatedMethod(input.method)
    if (method !== route.method || input.rawTarget !== route.rawTarget) {
      throw new Error()
    }
    const expectedUrl = `${requireExactHttpsOrigin(input.configuredOrigin)}${route.rawTarget}`
    const maximumPayloadBytes = encryptedWalletBackupDelegatedPayloadMaximumBytes(route.operation)
    const payload = requireBytes(
      input.payload,
      maximumPayloadBytes === 0 ? 0 : 1,
      maximumPayloadBytes,
      'request payload',
    ).slice()
    requireInteger(input.serverNowUnixSeconds, 0, 'server time')
    return { proofBytes, route, method, expectedUrl, payload }
  } catch {
    throw delegatedRequestError('invalid-request')
  }
}

function requireSelfAuthenticatedProof(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestVerificationInput>,
  context: ValidatedDelegatedRequestContext,
): VerifiedDelegatedRequestContext {
  let verifiedProof: VerifiedEncryptedWalletBackupRequestProofEvidence
  try {
    verifiedProof = verifyEncryptedWalletBackupRequestProofEvidence({
      proof: context.proofBytes,
      expectedMethod: context.method,
      expectedUrl: context.expectedUrl,
      payload: context.payload,
      serverNowUnixSeconds: input.serverNowUnixSeconds,
    })
  } catch {
    throw delegatedRequestError('unauthorized')
  }
  const claims = verifiedProof.claims
  if (
    claims.realm !== context.route.realm ||
    claims.vaultId !== context.route.vaultId ||
    claims.method !== context.method ||
    claims.url !== context.expectedUrl
  ) {
    throw delegatedRequestError('invalid-request')
  }
  return { ...context, verifiedProof, claims }
}

function requireDecodedOperationPayload(
  context: VerifiedDelegatedRequestContext,
): DecodedEncryptedWalletBackupDelegatedOperationPayload {
  try {
    return decodeEncryptedWalletBackupDelegatedOperationPayload({
      canonicalPayload: context.payload,
      route: context.route.source,
      requestAuthPublicKey: context.claims.requestAuthPublicKey,
    })
  } catch {
    throw delegatedRequestError('invalid-request')
  }
}

function authorizeEnrollment(
  enrollment: EncryptedWalletBackupServerEnrollment,
  context: VerifiedDelegatedRequestContext,
): EnrollmentAuthorizedDelegatedRequestAuthority['discovery'] {
  if (context.route.operation === 'enrollment-epoch') {
    if (context.claims.enrollmentEpoch !== 0) {
      throw delegatedRequestError('unauthorized')
    }
    return discoverEnrollment(enrollment, context.claims)
  }
  if (!enrollmentMatches(enrollment, context.claims)) {
    throw delegatedRequestError('unauthorized')
  }
  return undefined
}

async function authenticateDelegatedProof(
  replayStore: EncryptedWalletBackupReplayStore,
  context: VerifiedDelegatedRequestContext,
): Promise<Awaited<ReturnType<typeof consumeEncryptedWalletBackupVerifiedRequestReplay>>> {
  try {
    requireReplayStore(replayStore)
    return await consumeEncryptedWalletBackupVerifiedRequestReplay({
      verifiedProof: context.verifiedProof,
      replayStore,
    })
  } catch (error) {
    if (error instanceof EncryptedWalletBackupReplayRejectedError) {
      throw delegatedRequestError('replay-rejected')
    }
    if (error instanceof EncryptedWalletBackupReplayStoreUnavailableError) {
      throw error
    }
    throw delegatedRequestError('unauthorized')
  }
}

function validateServerRoute(value: EncryptedWalletBackupServerRoute): ValidatedServerRoute {
  if (typeof value !== 'object' || value === null) throw new Error()
  const realm = requireRealm(value.routeRealm)
  const vaultId = requireLowerHex(value.routeVaultId, 32, 'route vault id')
  const base = `/v1/encrypted-wallet-backup/realms/${realm}/vaults/${vaultId}`
  switch (value.operation) {
    case 'enrollment-epoch':
      return route(value, value.operation, realm, vaultId, 'GET', `${base}/enrollment-epoch`)
    case 'head-get':
      return route(value, value.operation, realm, vaultId, 'GET', `${base}/head`)
    case 'head-cas':
      return route(value, value.operation, realm, vaultId, 'POST', `${base}/head:compare-and-swap`)
    case 'object-get':
    case 'object-put':
    case 'object-delete': {
      const objectId = requireLowerHex(value.routeObjectId, 16, 'route object id')
      return route(
        value,
        value.operation,
        realm,
        vaultId,
        objectRouteMethod(value.operation),
        `${base}/objects/${objectId}`,
      )
    }
    case 'upload-attempt-abort': {
      const attemptId = requireLowerHex(value.routeAttemptId, 16, 'route attempt id')
      return route(
        value,
        value.operation,
        realm,
        vaultId,
        'DELETE',
        `${base}/upload-attempts/${attemptId}`,
      )
    }
    default:
      return assertNever(value)
  }
}

function route(
  source: EncryptedWalletBackupServerRoute,
  operation: EncryptedWalletBackupServerRoute['operation'],
  realm: string,
  vaultId: string,
  method: EncryptedWalletBackupRequestMethod,
  rawTarget: string,
): ValidatedServerRoute {
  return { source, operation, realm, vaultId, method, rawTarget }
}

function objectRouteMethod(
  operation: 'object-get' | 'object-put' | 'object-delete',
): 'GET' | 'PUT' | 'DELETE' {
  switch (operation) {
    case 'object-get':
      return 'GET'
    case 'object-put':
      return 'PUT'
    case 'object-delete':
      return 'DELETE'
    default:
      return assertNever(operation)
  }
}

function enrollmentMatches(
  enrollment: EncryptedWalletBackupServerEnrollment,
  claims: DecodedEncryptedWalletBackupRequestProofClaims,
): boolean {
  try {
    if (enrollment.status !== 'active') return false
    return (
      requireRealm(enrollment.realm) === claims.realm &&
      requireLowerHex(enrollment.vaultId, 32, 'enrolled vault id') === claims.vaultId &&
      bytesToHex(
        requireValidXOnlyPublicKey(
          hexToBytesStrict(enrollment.requestAuthPublicKey, 32, 'enrolled request public key'),
          'enrolled request public key',
        ),
      ) === claims.requestAuthPublicKey &&
      requireInteger(enrollment.enrollmentEpoch, 1, 'enrolled epoch') === claims.enrollmentEpoch
    )
  } catch {
    return false
  }
}

function discoverEnrollment(
  enrollment: EncryptedWalletBackupServerEnrollment,
  claims: DecodedEncryptedWalletBackupRequestProofClaims,
): Readonly<{ status: 'active'; enrollmentEpoch: number }> | Readonly<{ status: 'not-enrolled' }> {
  if (
    enrollment.status === 'active' &&
    enrollmentMatches(enrollment, {
      ...claims,
      enrollmentEpoch: enrollment.enrollmentEpoch,
    })
  ) {
    return Object.freeze({
      status: 'active',
      enrollmentEpoch: enrollment.enrollmentEpoch,
    })
  }
  return Object.freeze({ status: 'not-enrolled' })
}

function delegatedRequestError(
  code: EncryptedWalletBackupDelegatedRequestErrorCode,
): EncryptedWalletBackupDelegatedRequestError {
  return new EncryptedWalletBackupDelegatedRequestError(code)
}
