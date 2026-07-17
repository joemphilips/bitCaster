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
): DecodedEncryptedWalletBackupRequestProofClaims {
  try {
    return decodeRequestProofClaimsUnchecked(canonicalProof)
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
  const context = requireSelfAuthenticatedProof(input, requireDelegatedRequestContext(input))
  const decodedPayload = requireDecodedOperationPayload(context)
  const discovery = context.route.operation === 'enrollment-epoch'
  requireEnrollmentBeforeReplay(input.enrollment, context.claims, discovery)
  const evidence = await authenticateDelegatedProof(input, context)
  const authentication = Object.freeze({
    kind: 'authenticated',
    operation: context.route.operation,
    claims: context.claims,
    requestDigest: evidence.requestDigest,
    replayNonce: evidence.replayNonce,
    discovery: discovery ? discoverEnrollment(input.enrollment, context.claims) : undefined,
  })
  return Object.freeze({ authentication, decodedPayload })
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
      4 * 1_024 * 1_024,
      'request payload length',
    ),
    payloadDigest: bytesToHex(requireBytes(decoded[12], 32, 32, 'request payload digest')),
    signature: bytesToHex(requireBytes(decoded[13], 64, 64, 'request signature')),
  })
}

function requireDelegatedRequestContext(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestInput>,
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
    requireReplayStore(input.replayStore)
    requireInteger(input.serverNowUnixSeconds, 0, 'server time')
    return { proofBytes, route, method, expectedUrl, payload }
  } catch {
    throw delegatedRequestError('invalid-request')
  }
}

function requireSelfAuthenticatedProof(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestInput>,
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

function requireEnrollmentBeforeReplay(
  enrollment: EncryptedWalletBackupServerEnrollment,
  claims: DecodedEncryptedWalletBackupRequestProofClaims,
  discovery: boolean,
): void {
  if (discovery) {
    if (claims.enrollmentEpoch !== 0) {
      throw delegatedRequestError('unauthorized')
    }
    return
  }
  if (!enrollmentMatches(enrollment, claims)) {
    throw delegatedRequestError('unauthorized')
  }
}

async function authenticateDelegatedProof(
  input: Readonly<EncryptedWalletBackupDelegatedServerRequestInput>,
  context: VerifiedDelegatedRequestContext,
): Promise<Awaited<ReturnType<typeof consumeEncryptedWalletBackupVerifiedRequestReplay>>> {
  try {
    return await consumeEncryptedWalletBackupVerifiedRequestReplay({
      verifiedProof: context.verifiedProof,
      replayStore: input.replayStore,
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
