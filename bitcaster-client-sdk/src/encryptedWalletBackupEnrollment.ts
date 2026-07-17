import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  EncryptedWalletBackupRemoteBackoffError,
  type EncryptedWalletBackupKeyHandle,
} from './encryptedWalletBackup.ts'
import { requireIssuedEncryptedWalletBackupKeyHandle } from './encryptedWalletBackupKeyAuthority.ts'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  structurallyPreflightEncryptedBackupAccountRequestCbor,
} from './encryptedWalletBackupCbor.ts'
import { requireEncryptedWalletBackupAuthorizationScheme } from './encryptedWalletBackupServerCodec.ts'
import {
  awaitEncryptedWalletBackupCycle,
  requireEncryptedWalletBackupCycleSignal,
  throwIfEncryptedWalletBackupCycleAborted,
} from './encryptedWalletBackupDeadline.ts'

export const ENCRYPTED_WALLET_BACKUP_ACCOUNT_AUTHORIZATION_MAX_BYTES = 16 * 1_024

/** Terminal, redacted refusal for a new lifetime-distinct vault identity. */
export class EncryptedWalletBackupAccountQuotaExceededError extends Error {
  readonly status = 'quota-exceeded' as const
  readonly retryable = false as const

  constructor() {
    super('encrypted backup account quota exceeded')
    this.name = 'EncryptedWalletBackupAccountQuotaExceededError'
  }
}

export type EncryptedWalletBackupAccountOperationAction = 'enroll' | 'revoke' | 'delete'

export interface EncryptedWalletBackupAccountAuthorizationPort {
  authorizeBackupAccountOperation(input: {
    action: EncryptedWalletBackupAccountOperationAction
    method: 'POST' | 'DELETE'
    url: string
    operationId: string
    intentDigest: string
    canonicalIntent: Uint8Array
    signal: AbortSignal
  }): Promise<Readonly<{
    scheme: string
    authorization: Uint8Array
  }>>
}

export interface PreparedEncryptedWalletBackupAccountOperation {
  readonly formatVersion: 1
  readonly action: EncryptedWalletBackupAccountOperationAction
  readonly method: 'POST' | 'DELETE'
  readonly url: string
  readonly operationId: string
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
  readonly expectedEnrollmentEpoch: number
  readonly intentDigest: string
  readonly authorizationScheme: string
  readonly canonicalRequest: Uint8Array
}

interface AccountOperationAuthority {
  readonly canonicalRequest: Uint8Array
  readonly action: EncryptedWalletBackupAccountOperationAction
  readonly operationId: string
  readonly intentDigest: string
  readonly expectedEnrollmentEpoch: number
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
  readonly cycleSignal: AbortSignal
}

const ACCOUNT_OPERATION_AUTHORITIES = new WeakMap<object, AccountOperationAuthority>()

/**
 * Creates a scheme-neutral owner-authorized lifecycle request. The adapter's
 * credential is opaque and bounded; Nostr is not part of the SDK domain type.
 * An expected epoch of zero means "create if absent". Reopening an active vault
 * uses delegated epoch discovery and does not mutate the enrollment.
 */
export async function prepareEncryptedWalletBackupAccountOperation(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  action: EncryptedWalletBackupAccountOperationAction
  url: string
  operationId: string
  expectedEnrollmentEpoch: number
  authorizationPort: EncryptedWalletBackupAccountAuthorizationPort
  signal: AbortSignal
}): Promise<PreparedEncryptedWalletBackupAccountOperation> {
  const cycleSignal = requireEncryptedWalletBackupCycleSignal(input.signal)
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  const keyHandle = requireKeyHandle(input.keyHandle)
  const action = requireAction(input.action)
  const method = action === 'delete' ? 'DELETE' as const : 'POST' as const
  const url = requireExactHttpsUrl(input.url)
  const operationId = requireLowerHex(input.operationId, 16, 'backup account operation id')
  const expectedEnrollmentEpoch = requireInteger(
    input.expectedEnrollmentEpoch,
    action === 'enroll' ? 0 : 1,
    Number.MAX_SAFE_INTEGER,
    'expected enrollment epoch',
  )
  if (typeof input.authorizationPort !== 'object' || input.authorizationPort === null
    || typeof input.authorizationPort.authorizeBackupAccountOperation !== 'function') {
    throw new Error('backup account authorization port is invalid')
  }
  const canonicalIntent = encodeCanonical([
    1,
    'backup-account-operation',
    action,
    method,
    url,
    keyHandle.realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(keyHandle.requestAuthPublicKey),
    expectedEnrollmentEpoch,
    hexToBytes(operationId),
  ])
  const intentDigest = bytesToHex(sha256(canonicalIntent))
  const authorized = await awaitEncryptedWalletBackupCycle(
    input.authorizationPort.authorizeBackupAccountOperation({
      action,
      method,
      url,
      operationId,
      intentDigest,
      canonicalIntent: canonicalIntent.slice(),
      signal: cycleSignal,
    }),
    cycleSignal,
  )
  if (typeof authorized !== 'object' || authorized === null) {
    throw new Error('backup account authorization is invalid')
  }
  const authorizationScheme = requireEncryptedWalletBackupAuthorizationScheme(
    authorized.scheme,
  )
  const authorization = requireBytesRange(
    authorized.authorization,
    1,
    ENCRYPTED_WALLET_BACKUP_ACCOUNT_AUTHORIZATION_MAX_BYTES,
    'backup account authorization',
  ).slice()
  const canonicalRequest = encodeCanonical([
    1,
    'backup-account-request',
    canonicalIntent,
    hexToBytes(intentDigest),
    authorizationScheme,
    authorization,
  ])
  structurallyPreflightEncryptedBackupAccountRequestCbor(canonicalRequest)
  const prepared = Object.freeze({
    formatVersion: 1 as const,
    action,
    method,
    url,
    operationId,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedEnrollmentEpoch,
    intentDigest,
    authorizationScheme,
    canonicalRequest: canonicalRequest.slice(),
  })
  ACCOUNT_OPERATION_AUTHORITIES.set(prepared, {
    canonicalRequest,
    action,
    operationId,
    intentDigest,
    expectedEnrollmentEpoch,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    cycleSignal,
  })
  return prepared
}

export function readPreparedEncryptedWalletBackupAccountOperation(
  value: PreparedEncryptedWalletBackupAccountOperation,
): Uint8Array {
  const authority = typeof value === 'object' && value !== null
    ? ACCOUNT_OPERATION_AUTHORITIES.get(value)
    : undefined
  if (authority === undefined) throw new Error('backup account operation is not prepared')
  return authority.canonicalRequest.slice()
}

export type EncryptedWalletBackupEnrollmentLifecycle = 'active' | 'revoked' | 'deleted'

export interface EncryptedWalletBackupAccountOperationResultRecord {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly intentDigest: string
  readonly action: EncryptedWalletBackupAccountOperationAction
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
  readonly expectedEnrollmentEpoch: number
  readonly observedEnrollmentEpoch: number
  readonly lifecycle: EncryptedWalletBackupEnrollmentLifecycle
  readonly result: 'committed' | 'conflict'
}

export interface EncryptedWalletBackupAccountOperationResultStore {
  commitAccountOperationResult<T>(
    result: EncryptedWalletBackupAccountOperationResultRecord,
    commit: (stored: EncryptedWalletBackupAccountOperationResultRecord) => T,
  ): Promise<T>
}

export interface EncryptedWalletBackupAccountOperationRemotePort {
  executeAccountOperation(input: {
    operation: PreparedEncryptedWalletBackupAccountOperation
    canonicalRequest: Uint8Array
    signal: AbortSignal
  }): Promise<
    | Readonly<{
        status: 'committed' | 'conflict'
        operationId: string
        intentDigest: string
        enrollmentEpoch: number
        lifecycle: EncryptedWalletBackupEnrollmentLifecycle
      }>
    | Readonly<{
        status:
          | 'quota-exceeded'
          | 'unauthorized'
          | 'rate-limited'
          | 'overloaded'
          | 'unavailable'
        retryAfterSeconds?: number | null
      }>
  >
}

export interface AuthenticatedEncryptedWalletBackupAccountOperationResult {
  readonly state: 'authenticated'
  readonly record: EncryptedWalletBackupAccountOperationResultRecord
}

const ACCOUNT_OPERATION_RESULTS = new WeakMap<object, EncryptedWalletBackupAccountOperationResultRecord>()

/** Executes and durably records the TLS-authenticated lifecycle result before returning authority. */
export async function executeEncryptedWalletBackupAccountOperation(input: {
  operation: PreparedEncryptedWalletBackupAccountOperation
  remote: EncryptedWalletBackupAccountOperationRemotePort
  store: EncryptedWalletBackupAccountOperationResultStore
}): Promise<AuthenticatedEncryptedWalletBackupAccountOperationResult> {
  const authority = typeof input.operation === 'object' && input.operation !== null
    ? ACCOUNT_OPERATION_AUTHORITIES.get(input.operation)
    : undefined
  if (authority === undefined) throw new Error('backup account operation is not prepared')
  const cycleSignal = authority.cycleSignal
  throwIfEncryptedWalletBackupCycleAborted(cycleSignal)
  if (typeof input.remote !== 'object' || input.remote === null
    || typeof input.remote.executeAccountOperation !== 'function') {
    throw new Error('backup account operation remote port is invalid')
  }
  if (typeof input.store !== 'object' || input.store === null
    || typeof input.store.commitAccountOperationResult !== 'function') {
    throw new Error('backup account operation result store is invalid')
  }
  const response = await awaitEncryptedWalletBackupCycle(
    input.remote.executeAccountOperation({
      operation: input.operation,
      canonicalRequest: authority.canonicalRequest.slice(),
      signal: cycleSignal,
    }),
    cycleSignal,
  )
  if (typeof response !== 'object' || response === null || typeof response.status !== 'string') {
    throw new Error('backup account operation response is invalid')
  }
  if (response.status === 'rate-limited'
    || response.status === 'overloaded' || response.status === 'unavailable') {
    throw new EncryptedWalletBackupRemoteBackoffError(
      response.status,
      response.retryAfterSeconds,
    )
  }
  if (response.status === 'quota-exceeded') {
    if (authority.action !== 'enroll' || response.retryAfterSeconds != null) {
      throw new Error('backup account operation response is invalid')
    }
    throw new EncryptedWalletBackupAccountQuotaExceededError()
  }
  if (response.status === 'unauthorized') {
    throw new Error(`backup account operation failed: ${response.status}`)
  }
  if (response.status !== 'committed' && response.status !== 'conflict') {
    throw new Error('backup account operation response is invalid')
  }
  const responseOperationId = requireLowerHex(response.operationId, 16, 'backup account response operation id')
  if (responseOperationId !== authority.operationId) {
    throw new Error('backup account response operation id is invalid')
  }
  const responseIntentDigest = requireLowerHex(response.intentDigest, 32, 'backup account response intent digest')
  if (responseIntentDigest !== authority.intentDigest) {
    throw new Error('backup account response intent digest is invalid')
  }
  const observedEnrollmentEpoch = requireInteger(
    response.enrollmentEpoch, 1, Number.MAX_SAFE_INTEGER, 'observed enrollment epoch',
  )
  const lifecycle = requireLifecycle(response.lifecycle)
  if (response.status === 'committed') {
    const expectedCommittedEpoch = authority.expectedEnrollmentEpoch + 1
    const expectedLifecycle = authority.action === 'enroll' ? 'active'
      : authority.action === 'revoke' ? 'revoked' : 'deleted'
    if (observedEnrollmentEpoch !== expectedCommittedEpoch || lifecycle !== expectedLifecycle) {
      throw new Error('backup account operation committed result is inconsistent')
    }
  } else if (observedEnrollmentEpoch < Math.max(1, authority.expectedEnrollmentEpoch)) {
    throw new Error('backup account operation conflict epoch is invalid')
  }
  const record = Object.freeze({
    schemaVersion: 1 as const,
    operationId: authority.operationId,
    intentDigest: responseIntentDigest,
    action: authority.action,
    realm: authority.realm,
    vaultId: authority.vaultId,
    requestAuthPublicKey: authority.requestAuthPublicKey,
    expectedEnrollmentEpoch: authority.expectedEnrollmentEpoch,
    observedEnrollmentEpoch,
    lifecycle,
    result: response.status,
  })
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await input.store.commitAccountOperationResult(record, (raw) => {
      if (!callbackOpen || callbackCalls++ !== 0) throw new Error('account result callback is invalid')
      const stored = decodeAccountOperationResult(raw)
      if (JSON.stringify(stored) !== JSON.stringify(record)) {
        throw new Error('stored backup account operation result changed')
      }
      const evidence = Object.freeze({ state: 'authenticated' as const, record: stored })
      ACCOUNT_OPERATION_RESULTS.set(evidence, stored)
      issued = evidence
      return evidence
    })
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('backup account operation result commit must be synchronous and exact')
  }
  return issued as AuthenticatedEncryptedWalletBackupAccountOperationResult
}

function decodeAccountOperationResult(value: unknown): EncryptedWalletBackupAccountOperationResultRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('backup account operation result is invalid')
  }
  const raw = value as Record<string, unknown>
  const fields = [
    'schemaVersion', 'operationId', 'intentDigest', 'action', 'realm', 'vaultId', 'requestAuthPublicKey',
    'expectedEnrollmentEpoch', 'observedEnrollmentEpoch', 'lifecycle', 'result',
  ]
  if (Object.keys(raw).some((field) => !fields.includes(field)) || raw.schemaVersion !== 1) {
    throw new Error('backup account operation result is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId: requireLowerHex(raw.operationId, 16, 'backup account operation id'),
    intentDigest: requireLowerHex(raw.intentDigest, 32, 'backup account intent digest'),
    action: requireAction(raw.action),
    realm: requireRealm(raw.realm),
    vaultId: requireLowerHex(raw.vaultId, 32, 'backup vault id'),
    requestAuthPublicKey: requireLowerHex(raw.requestAuthPublicKey, 32, 'backup public key'),
    expectedEnrollmentEpoch: requireInteger(
      raw.expectedEnrollmentEpoch, 0, Number.MAX_SAFE_INTEGER, 'expected enrollment epoch',
    ),
    observedEnrollmentEpoch: requireInteger(
      raw.observedEnrollmentEpoch, 1, Number.MAX_SAFE_INTEGER, 'observed enrollment epoch',
    ),
    lifecycle: requireLifecycle(raw.lifecycle),
    result: raw.result === 'committed' || raw.result === 'conflict'
      ? raw.result : (() => { throw new Error('backup account result kind is invalid') })(),
  })
}

function requireKeyHandle(value: unknown): EncryptedWalletBackupKeyHandle {
  return requireIssuedEncryptedWalletBackupKeyHandle(value)
}

function requireAction(value: unknown): EncryptedWalletBackupAccountOperationAction {
  if (value !== 'enroll' && value !== 'revoke' && value !== 'delete') {
    throw new Error('backup account operation action is invalid')
  }
  return value
}

function requireLifecycle(value: unknown): EncryptedWalletBackupEnrollmentLifecycle {
  if (value !== 'active' && value !== 'revoked' && value !== 'deleted') {
    throw new Error('backup enrollment lifecycle is invalid')
  }
  return value
}

function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error('backup realm is invalid')
  }
  return value
}

function requireExactHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048
    || /[^\x21-\x7e]/.test(value)) throw new Error('backup account URL is invalid')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('backup account URL is invalid') }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.href !== value) throw new Error('backup account URL is invalid')
  return value
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}

function requireBytesRange(value: unknown, minimum: number, maximum: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof (value as PromiseLike<unknown>).then === 'function'
    : false
}
