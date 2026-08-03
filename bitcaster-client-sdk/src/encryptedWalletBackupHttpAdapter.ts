import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  encodeEncryptedWalletBackupRequestProof,
  encryptedWalletBackupRequestDigest,
  EncryptedWalletBackupRemoteFailureError,
  type EncryptedWalletBackupCasRemotePort,
  type EncryptedWalletBackupEnrollmentEpochRemotePort,
  type EncryptedWalletBackupHeadRemotePort,
  type EncryptedWalletBackupRequestProof,
} from './encryptedWalletBackup.ts'
import type {
  EncryptedWalletBackupAccountOperationRemotePort,
  PreparedEncryptedWalletBackupAccountOperation,
} from './encryptedWalletBackupEnrollment.ts'
import { readPreparedEncryptedWalletBackupAccountOperation } from './encryptedWalletBackupEnrollment.ts'
import {
  decodeEncryptedWalletBackupHttpResponse,
  encryptedWalletBackupHttpResponseMaximumBytes,
  type DecodedEncryptedWalletBackupHttpResponse,
  type EncryptedWalletBackupHttpOperation,
  type EncryptedWalletBackupHttpResponseContext,
} from './encryptedWalletBackupHttpCodec.ts'
import type {
  EncryptedWalletBackupObjectGetInput,
  EncryptedWalletBackupObjectGetResult,
  EncryptedWalletBackupObjectRemotePort,
  EncryptedWalletBackupRecoveryObjectRemotePort,
  EncryptedWalletBackupUploadAbortRemotePort,
} from './encryptedWalletBackupSync.ts'
import {
  preflightEncryptedBackupCasCbor,
  preflightEncryptedBackupPutCbor,
  structurallyPreflightEncryptedBackupAccountRequestCbor,
  structurallyPreflightEncryptedBackupAttemptAbortCbor,
} from './encryptedWalletBackupCbor.ts'
import { requireEncryptedWalletBackupAbortSignal } from './encryptedWalletBackupDeadline.ts'
import { ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupLimits.ts'

const MEDIA_TYPE = 'application/cbor'
const AUTHORIZATION_PREFIX = 'BackupV1 '
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000
const MAX_TIMEOUT_MILLISECONDS = 15_000
const MAX_IN_FLIGHT = 4
const MAX_RESPONSE_CHUNKS = 4_096

export type EncryptedWalletBackupHttpTransportErrorCode =
  | 'concurrency-exhausted'
  | 'deadline-exceeded'
  | 'invalid-request'
  | 'invalid-response'
  | 'remote-rejected'
  | 'transport-failure'

export type EncryptedWalletBackupHttpDispatchState = 'not-dispatched' | 'dispatched' | 'uncertain'

/** A deliberately redacted transport error. It never retains a cause or URL. */
export class EncryptedWalletBackupHttpTransportError extends EncryptedWalletBackupRemoteFailureError {
  readonly code: EncryptedWalletBackupHttpTransportErrorCode
  readonly dispatchState: EncryptedWalletBackupHttpDispatchState

  constructor(
    code: EncryptedWalletBackupHttpTransportErrorCode,
    dispatchState: EncryptedWalletBackupHttpDispatchState,
  ) {
    super(`encrypted backup transport failed: ${code}`)
    this.name = 'EncryptedWalletBackupHttpTransportError'
    this.code = code
    this.dispatchState = dispatchState
  }
}

/** Injected implementations must honor `init.signal` and settle after abort. */
type FetchPort = (input: string, init: RequestInit) => Promise<Response>

export interface EncryptedWalletBackupHttpCallOptions {
  /** Caller-owned absolute-deadline signal; never retained after the call. */
  readonly signal?: AbortSignal
}

export type EncryptedWalletBackupHttpObjectGetInput = EncryptedWalletBackupObjectGetInput

export interface EncryptedWalletBackupHttpObjectDeleteInput extends EncryptedWalletBackupHttpCallOptions {
  readonly requestProof: EncryptedWalletBackupRequestProof
}

export type EncryptedWalletBackupHttpObjectGetResult = EncryptedWalletBackupObjectGetResult

export type EncryptedWalletBackupHttpObjectDeleteResult =
  | Readonly<{ status: 'deleted' | 'already-deleted' }>
  | Readonly<{
      status: 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
      retryAfterSeconds?: number | null
    }>

export class EncryptedWalletBackupHttpAdapter
  implements
    EncryptedWalletBackupAccountOperationRemotePort,
    EncryptedWalletBackupEnrollmentEpochRemotePort,
    EncryptedWalletBackupHeadRemotePort,
    EncryptedWalletBackupCasRemotePort,
    EncryptedWalletBackupObjectRemotePort,
    EncryptedWalletBackupRecoveryObjectRemotePort,
    EncryptedWalletBackupUploadAbortRemotePort
{
  readonly #origin: string
  readonly #fetch: FetchPort
  readonly #fallbackTimeoutMilliseconds: number
  #inFlight = 0

  constructor(input: { origin: string; fetch?: FetchPort; fallbackTimeoutMilliseconds?: number }) {
    this.#origin = requireOrigin(input.origin)
    const fetchPort = input.fetch ?? globalThis.fetch
    if (typeof fetchPort !== 'function') {
      throw transportError('invalid-request', 'not-dispatched')
    }
    this.#fetch = fetchPort.bind(globalThis) as FetchPort
    this.#fallbackTimeoutMilliseconds = requireTimeout(
      input.fallbackTimeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    )
  }

  executeAccountOperation(input: {
    operation: PreparedEncryptedWalletBackupAccountOperation
    canonicalRequest: Uint8Array
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupAccountOperationRemotePort['executeAccountOperation']> {
    return this.#withSlot(
      true,
      () => input.signal,
      async (context) => {
        const operation = requireAccountOperation(input.operation, this.#origin)
        const body = requireExactPayload(input.canonicalRequest, operation.canonicalRequest)
        const operationName = accountOperationName(operation.action)
        const decoded = await this.#dispatch({
          context,
          operation: operationName,
          url: operation.url,
          method: operation.method,
          body,
          responseContext: {
            operation: operationName,
            expectedOperationId: operation.operationId,
            expectedIntentDigest: operation.intentDigest,
          },
        })
        if (decoded.result === 'error') return mapAccountError(decoded)
        if (
          decoded.operation !== operationName ||
          (decoded.result !== 'committed' && decoded.result !== 'conflict')
        ) {
          throw transportError('invalid-response', 'uncertain')
        }
        return {
          status: decoded.result,
          operationId: decoded.operationId,
          intentDigest: decoded.intentDigest,
          enrollmentEpoch: decoded.enrollmentEpoch,
          lifecycle: decoded.lifecycle,
        }
      },
    )
  }

  discoverEnrollmentEpoch(input: {
    requestProof: EncryptedWalletBackupRequestProof
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupEnrollmentEpochRemotePort['discoverEnrollmentEpoch']> {
    return this.#withSlot(
      false,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'GET',
          endpoint: 'enrollment-epoch',
          payload: EMPTY_BODY,
        })
        const decoded = await this.#dispatchDelegated(context, 'enrollment-epoch', request, {
          operation: 'enrollment-epoch',
          expectedRequestDigest: request.requestDigest,
        })
        if (decoded.result === 'error') return mapEpochError(decoded)
        if (decoded.operation !== 'enrollment-epoch') {
          throw transportError('invalid-response', 'dispatched')
        }
        return decoded.result === 'active'
          ? { status: 'active', enrollmentEpoch: decoded.enrollmentEpoch }
          : { status: 'not-enrolled' }
      },
    )
  }

  readCurrentHead(input: {
    requestProof: EncryptedWalletBackupRequestProof
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupHeadRemotePort['readCurrentHead']> {
    return this.#withSlot(
      false,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'GET',
          endpoint: 'head',
          payload: EMPTY_BODY,
        })
        const decoded = await this.#dispatchDelegated(context, 'head-get', request, {
          operation: 'head-get',
          expectedRequestDigest: request.requestDigest,
          expectedEnrollmentEpoch: request.proof.enrollmentEpoch,
          expectedRealm: request.proof.realm,
          expectedVaultId: request.proof.vaultId,
          expectedBackupPublicKey: request.proof.requestAuthPublicKey,
        })
        if (decoded.result === 'error') return mapReadError(decoded)
        if (decoded.operation !== 'head-get') {
          throw transportError('invalid-response', 'dispatched')
        }
        return decoded.result === 'found'
          ? {
              status: 'found',
              enrollmentEpoch: decoded.enrollmentEpoch,
              head: {
                canonicalHead: decoded.canonicalHead,
                canonicalReferenceSet: decoded.canonicalReferenceSet,
              },
            }
          : { status: 'not-found' }
      },
    )
  }

  putObject(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalPutPayload: Uint8Array
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupObjectRemotePort['putObject']> {
    return this.#withSlot(
      true,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'PUT',
          endpoint: 'object',
          payload: input.canonicalPutPayload,
        })
        const decoded = await this.#dispatchDelegated(context, 'object-put', request, {
          operation: 'object-put',
          expectedRequestDigest: request.requestDigest,
        })
        if (decoded.result === 'error') return mapPutError(decoded)
        if (decoded.operation !== 'object-put') {
          throw transportError('invalid-response', 'uncertain')
        }
        return { status: decoded.result }
      },
    )
  }

  compareAndSwapCurrentHead(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalCasPayload: Uint8Array
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupCasRemotePort['compareAndSwapCurrentHead']> {
    return this.#withSlot(
      true,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'POST',
          endpoint: 'head-cas',
          payload: input.canonicalCasPayload,
        })
        const decoded = await this.#dispatchDelegated(context, 'head-cas', request, {
          operation: 'head-cas',
          expectedRequestDigest: request.requestDigest,
        })
        if (decoded.result === 'error') return mapCasError(decoded)
        if (decoded.operation !== 'head-cas') {
          throw transportError('invalid-response', 'uncertain')
        }
        return { status: decoded.result }
      },
    )
  }

  abortUploadAttempt(input: {
    requestProof: EncryptedWalletBackupRequestProof
    canonicalAbortPayload: Uint8Array
    signal?: AbortSignal
  }): ReturnType<EncryptedWalletBackupUploadAbortRemotePort['abortUploadAttempt']> {
    return this.#withSlot(
      true,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'DELETE',
          endpoint: 'upload-attempt',
          payload: input.canonicalAbortPayload,
        })
        const decoded = await this.#dispatchDelegated(context, 'upload-attempt-abort', request, {
          operation: 'upload-attempt-abort',
          expectedRequestDigest: request.requestDigest,
        })
        if (decoded.result === 'error') return mapReadError(decoded)
        if (decoded.operation !== 'upload-attempt-abort') {
          throw transportError('invalid-response', 'uncertain')
        }
        return { status: decoded.result }
      },
    )
  }

  getObject(
    input: EncryptedWalletBackupHttpObjectGetInput,
  ): Promise<EncryptedWalletBackupHttpObjectGetResult> {
    return this.#withSlot(
      false,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'GET',
          endpoint: 'object',
          payload: EMPTY_BODY,
        })
        const decoded = await this.#dispatchDelegated(context, 'object-get', request, {
          operation: 'object-get',
          expectedRequestDigest: request.requestDigest,
          expectedKindCode: input.expectedKindCode,
          expectedRealm: request.proof.realm,
          expectedVaultId: request.proof.vaultId,
          expectedObjectId: request.objectId!,
          expectedObjectDigest: input.expectedObjectDigest,
          currentHeadGeneration: input.currentHeadGeneration,
        })
        if (decoded.result === 'error') return mapReadError(decoded)
        if (decoded.operation !== 'object-get') {
          throw transportError('invalid-response', 'dispatched')
        }
        return decoded.result === 'not-found'
          ? { status: 'not-found' }
          : {
              status: 'found',
              kindCode: decoded.kindCode,
              realm: decoded.realm,
              vaultId: decoded.vaultId,
              objectId: decoded.objectId,
              generation: decoded.generation,
              paddedLength: decoded.paddedLength,
              objectDigest: decoded.objectDigest,
              aad: decoded.aad,
              encryptedBody: decoded.encryptedBody,
            }
      },
    )
  }

  deleteObject(
    input: EncryptedWalletBackupHttpObjectDeleteInput,
  ): Promise<EncryptedWalletBackupHttpObjectDeleteResult> {
    return this.#withSlot(
      true,
      () => input.signal,
      async (context) => {
        const request = requireDelegatedRequest({
          proof: input.requestProof,
          origin: this.#origin,
          method: 'DELETE',
          endpoint: 'object',
          payload: EMPTY_BODY,
        })
        const decoded = await this.#dispatchDelegated(context, 'object-delete', request, {
          operation: 'object-delete',
          expectedRequestDigest: request.requestDigest,
        })
        if (decoded.result === 'error') return mapReadError(decoded)
        if (decoded.operation !== 'object-delete') {
          throw transportError('invalid-response', 'uncertain')
        }
        return { status: decoded.result }
      },
    )
  }

  async #dispatchDelegated(
    context: CallContext,
    operation: EncryptedWalletBackupHttpOperation,
    request: DelegatedRequest,
    responseContext: EncryptedWalletBackupHttpResponseContext,
  ): Promise<DecodedEncryptedWalletBackupHttpResponse> {
    return this.#dispatch({
      context,
      operation,
      url: request.proof.url,
      method: request.proof.method,
      body: request.body,
      authorization: `${AUTHORIZATION_PREFIX}${base64Url(request.canonicalProof)}`,
      responseContext,
    })
  }

  async #dispatch(input: {
    context: CallContext
    operation: EncryptedWalletBackupHttpOperation
    url: string
    method: 'GET' | 'PUT' | 'POST' | 'DELETE'
    body: Uint8Array
    authorization?: string
    responseContext: EncryptedWalletBackupHttpResponseContext
  }): Promise<DecodedEncryptedWalletBackupHttpResponse> {
    throwIfAborted(input.context.signal, 'not-dispatched')
    const headers = new Headers({
      accept: MEDIA_TYPE,
      'cache-control': 'no-store',
      'content-type': MEDIA_TYPE,
    })
    if (input.authorization !== undefined) {
      headers.set('authorization', input.authorization)
    }
    let response: Response
    input.context.dispatched = true
    let fetchPromise: Promise<Response> | undefined
    try {
      fetchPromise = this.#fetch(input.url, {
        method: input.method,
        headers,
        body: input.body.byteLength === 0 ? undefined : (input.body as unknown as BodyInit),
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: input.context.signal,
      })
      response = await raceAbort(fetchPromise, input.context.signal)
    } catch (error) {
      if (input.context.signal.aborted) {
        if (fetchPromise !== undefined) {
          try {
            const lateResponse = await fetchPromise
            await cancelResponse(lateResponse)
          } catch {
            // A conforming fetch rejects after abort; no response remains.
          }
        }
        throw transportError('deadline-exceeded', mutationDispatchState(input.operation))
      }
      throw transportError('transport-failure', mutationDispatchState(input.operation))
    }
    try {
      requireResponseMetadata(response, input.url)
      const maximumBytes = encryptedWalletBackupHttpResponseMaximumBytes(
        input.operation,
        response.status,
      )
      const body = await readBoundedBody(response, maximumBytes, input.context.signal)
      return decodeEncryptedWalletBackupHttpResponse({
        ...input.responseContext,
        httpStatus: response.status,
        body,
      } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0])
    } catch (error) {
      await cancelResponse(response)
      if (input.context.signal.aborted) {
        throw transportError('deadline-exceeded', mutationDispatchState(input.operation))
      }
      if (
        error instanceof EncryptedWalletBackupHttpTransportError &&
        error.code === 'transport-failure'
      ) {
        throw transportError('transport-failure', mutationDispatchState(input.operation))
      }
      throw transportError('invalid-response', mutationDispatchState(input.operation))
    }
  }

  #withSlot<T>(
    mutation: boolean,
    readCallerSignal: () => AbortSignal | undefined,
    task: (context: CallContext) => Promise<T>,
  ): Promise<T> {
    if (this.#inFlight >= MAX_IN_FLIGHT) {
      return Promise.reject(transportError('concurrency-exhausted', 'not-dispatched'))
    }
    let callerSignal: AbortSignal | undefined
    let disposeCallerSignal: (() => void) | undefined
    try {
      const rawSignal = readCallerSignal()
      if (rawSignal !== undefined) {
        const normalized = requireEncryptedWalletBackupAbortSignal(rawSignal)
        callerSignal = normalized.signal
        disposeCallerSignal = normalized.dispose
      }
    } catch {
      return Promise.reject(transportError('invalid-request', 'not-dispatched'))
    }
    if (callerSignal?.aborted) {
      disposeCallerSignal?.()
      return Promise.reject(transportError('deadline-exceeded', 'not-dispatched'))
    }
    const detachCallerSignal = (): void => {
      disposeCallerSignal?.()
      disposeCallerSignal = undefined
    }
    this.#inFlight += 1
    try {
      return runWithDeadline(
        callerSignal,
        this.#fallbackTimeoutMilliseconds,
        mutation,
        task,
        () => {
          this.#inFlight -= 1
        },
        detachCallerSignal,
      )
    } catch {
      detachCallerSignal()
      this.#inFlight -= 1
      return Promise.reject(transportError('invalid-request', 'not-dispatched'))
    }
  }
}

const EMPTY_BODY = new Uint8Array()

interface CallContext {
  readonly signal: AbortSignal
  dispatched: boolean
}

interface DelegatedRequest {
  readonly proof: EncryptedWalletBackupRequestProof
  readonly body: Uint8Array
  readonly canonicalProof: Uint8Array
  readonly requestDigest: string
  readonly objectId?: string
}

function runWithDeadline<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
  mutation: boolean,
  task: (context: CallContext) => Promise<T>,
  release: () => void,
  detachCallerSignal: () => void,
): Promise<T> {
  const controller = new AbortController()
  const relay = (): void => controller.abort()
  callerSignal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds)
  const context: CallContext = {
    signal: controller.signal,
    dispatched: false,
  }
  let detached = false
  const detachDeadline = (): void => {
    if (detached) return
    detached = true
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', relay)
    detachCallerSignal()
  }
  const execution = Promise.resolve()
    .then(() => task(context))
    .finally(detachDeadline)
  execution.then(release, release)
  return raceVisibleDeadline(execution, controller.signal, context, mutation, detachDeadline)
}

function requireDelegatedRequest(input: {
  proof: EncryptedWalletBackupRequestProof
  origin: string
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  endpoint: 'enrollment-epoch' | 'head' | 'head-cas' | 'object' | 'upload-attempt'
  payload: Uint8Array
}): DelegatedRequest {
  try {
    const canonicalProof = encodeEncryptedWalletBackupRequestProof(input.proof)
    const body = requireBytes(input.payload, 0, ENCRYPTED_WALLET_BACKUP_REQUEST_PAYLOAD_MAX_BYTES)
    if (
      input.proof.method !== input.method ||
      input.proof.payloadLength !== body.byteLength ||
      input.proof.payloadDigest !== bytesToHex(sha256(body))
    ) {
      throw new Error()
    }
    const endpoint = requireDelegatedEndpoint(
      input.proof.url,
      input.origin,
      input.proof.realm,
      input.proof.vaultId,
      input.endpoint,
    )
    switch (input.endpoint) {
      case 'head-cas':
        preflightEncryptedBackupCasCbor(body)
        break
      case 'upload-attempt':
        structurallyPreflightEncryptedBackupAttemptAbortCbor(body)
        break
      case 'object':
        if (input.method === 'PUT') preflightEncryptedBackupPutCbor(body)
        break
      case 'enrollment-epoch':
      case 'head':
        break
    }
    return {
      proof: input.proof,
      body,
      canonicalProof,
      requestDigest: encryptedWalletBackupRequestDigest(input.proof),
      objectId: endpoint.objectId,
    }
  } catch {
    throw transportError('invalid-request', 'not-dispatched')
  }
}

function requireDelegatedEndpoint(
  raw: string,
  origin: string,
  realm: string,
  vaultId: string,
  endpoint: 'enrollment-epoch' | 'head' | 'head-cas' | 'object' | 'upload-attempt',
): { objectId?: string } {
  const url = requireExactUrl(raw, origin)
  const base = `/v1/encrypted-wallet-backup/realms/${realm}/vaults/${vaultId}`
  switch (endpoint) {
    case 'enrollment-epoch':
      if (url.pathname !== `${base}/enrollment-epoch`) throw new Error()
      break
    case 'head':
      if (url.pathname !== `${base}/head`) throw new Error()
      break
    case 'head-cas':
      if (url.pathname !== `${base}/head:compare-and-swap`) throw new Error()
      break
    case 'object': {
      const match = url.pathname.match(new RegExp(`^${escapeRegExp(base)}/objects/([0-9a-f]{32})$`))
      if (match === null) throw new Error()
      return { objectId: match[1] }
    }
    case 'upload-attempt':
      if (!new RegExp(`^${escapeRegExp(base)}/upload-attempts/[0-9a-f]{32}$`).test(url.pathname)) {
        throw new Error()
      }
      break
    default:
      throw new Error()
  }
  return {}
}

function requireAccountOperation(
  operation: PreparedEncryptedWalletBackupAccountOperation,
  origin: string,
): PreparedEncryptedWalletBackupAccountOperation {
  try {
    const issuedRequest = readPreparedEncryptedWalletBackupAccountOperation(operation)
    structurallyPreflightEncryptedBackupAccountRequestCbor(issuedRequest)
    if (!equalBytes(issuedRequest, operation.canonicalRequest)) {
      throw new Error()
    }
    if (
      operation.action !== 'enroll' &&
      operation.action !== 'revoke' &&
      operation.action !== 'delete'
    ) {
      throw new Error()
    }
    const url = requireExactUrl(operation.url, origin)
    const base = `/v1/encrypted-wallet-backup/realms/${operation.realm}`
    const expected =
      operation.action === 'enroll'
        ? `${base}/vaults:enroll`
        : operation.action === 'revoke'
          ? `${base}/vaults/${operation.vaultId}:revoke`
          : `${base}/vaults/${operation.vaultId}`
    if (
      url.pathname !== expected ||
      url.search !== '' ||
      operation.method !== (operation.action === 'delete' ? 'DELETE' : 'POST')
    ) {
      throw new Error()
    }
    return operation
  } catch {
    throw transportError('invalid-request', 'not-dispatched')
  }
}

function requireResponseMetadata(response: Response, expectedUrl: string): void {
  if (
    typeof response !== 'object' ||
    response === null ||
    response.redirected !== false ||
    response.url !== expectedUrl ||
    response.headers.get('content-type') !== MEDIA_TYPE ||
    response.headers.has('content-encoding') ||
    !hasNoStore(response.headers.get('cache-control')) ||
    response.body === null
  ) {
    throw transportError('invalid-response', 'dispatched')
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) {
      throw transportError('invalid-response', 'dispatched')
    }
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      throw transportError('invalid-response', 'dispatched')
    }
  }
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let chunkCount = 0
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) {
        throw transportError('invalid-response', 'dispatched')
      }
      chunkCount += 1
      if (chunkCount > MAX_RESPONSE_CHUNKS) {
        throw transportError('invalid-response', 'dispatched')
      }
      if (next.value.byteLength === 0) continue
      total += next.value.byteLength
      if (total > maximumBytes) {
        throw transportError('invalid-response', 'dispatched')
      }
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (signal.aborted) {
      throw transportError('deadline-exceeded', 'dispatched')
    }
    throw error
  } finally {
    reader.releaseLock()
  }
  if (declared !== null && total !== Number(declared)) {
    throw transportError('invalid-response', 'dispatched')
  }
  if (chunks.length === 1) return chunks[0]!.slice()
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Rejection means cancellation settled; the transport permit may release.
  }
}

function raceVisibleDeadline<T>(
  execution: Promise<T>,
  signal: AbortSignal,
  context: CallContext,
  mutation: boolean,
  detachDeadline: () => void,
): Promise<T> {
  if (signal.aborted) {
    detachDeadline()
    return Promise.reject(
      transportError('deadline-exceeded', visibleDispatchState(context, mutation)),
    )
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      detachDeadline()
      reject(transportError('deadline-exceeded', visibleDispatchState(context, mutation)))
    }
    signal.addEventListener('abort', abort, { once: true })
    execution.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function visibleDispatchState(
  context: CallContext,
  mutation: boolean,
): EncryptedWalletBackupHttpDispatchState {
  if (!context.dispatched) return 'not-dispatched'
  return mutation ? 'uncertain' : 'dispatched'
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(transportError('deadline-exceeded', 'not-dispatched'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(transportError('deadline-exceeded', 'dispatched'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', abort)
        reject(transportError('transport-failure', 'dispatched'))
      },
    )
  })
}

function mapReadError(
  decoded: Extract<DecodedEncryptedWalletBackupHttpResponse, { result: 'error' }>,
): Readonly<{
  status: 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
  retryAfterSeconds: number | null
}> {
  if (
    decoded.code === 'unauthorized' ||
    decoded.code === 'rate-limited' ||
    decoded.code === 'overloaded' ||
    decoded.code === 'unavailable'
  ) {
    return {
      status: decoded.code,
      retryAfterSeconds: decoded.retryAfterSeconds,
    }
  }
  throw transportError('remote-rejected', 'dispatched')
}

function mapEpochError(
  decoded: Extract<DecodedEncryptedWalletBackupHttpResponse, { result: 'error' }>,
): Readonly<{
  status: 'rate-limited' | 'overloaded' | 'unavailable'
  retryAfterSeconds: number | null
}> {
  if (
    decoded.code === 'rate-limited' ||
    decoded.code === 'overloaded' ||
    decoded.code === 'unavailable'
  ) {
    return {
      status: decoded.code,
      retryAfterSeconds: decoded.retryAfterSeconds,
    }
  }
  throw transportError('remote-rejected', 'dispatched')
}

function mapPutError(
  decoded: Extract<DecodedEncryptedWalletBackupHttpResponse, { result: 'error' }>,
): Readonly<{
  status: 'quota-exceeded' | 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
  retryAfterSeconds: number | null
}> {
  if (decoded.code === 'quota-exceeded') {
    return {
      status: decoded.code,
      retryAfterSeconds: decoded.retryAfterSeconds,
    }
  }
  return mapReadError(decoded)
}

function mapCasError(
  decoded: Extract<DecodedEncryptedWalletBackupHttpResponse, { result: 'error' }>,
): Readonly<{
  status: 'quota-exceeded' | 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
  retryAfterSeconds: number | null
}> {
  if (decoded.code === 'quota-exceeded') {
    return {
      status: decoded.code,
      retryAfterSeconds: decoded.retryAfterSeconds,
    }
  }
  return mapReadError(decoded)
}

function mapAccountError(
  decoded: Extract<DecodedEncryptedWalletBackupHttpResponse, { result: 'error' }>,
): Readonly<{
  status: 'quota-exceeded' | 'unauthorized' | 'rate-limited' | 'overloaded' | 'unavailable'
  retryAfterSeconds: number | null
}> {
  if (decoded.code === 'quota-exceeded') {
    return {
      status: decoded.code,
      retryAfterSeconds: decoded.retryAfterSeconds,
    }
  }
  return mapReadError(decoded)
}

function mutationDispatchState(
  operation: EncryptedWalletBackupHttpOperation,
): EncryptedWalletBackupHttpDispatchState {
  switch (operation) {
    case 'enrollment-epoch':
    case 'head-get':
    case 'object-get':
      return 'dispatched'
    case 'account-enroll':
    case 'account-revoke':
    case 'account-delete':
    case 'object-put':
    case 'object-delete':
    case 'upload-attempt-abort':
    case 'head-cas':
      return 'uncertain'
  }
}

function accountOperationName(
  action: PreparedEncryptedWalletBackupAccountOperation['action'],
): 'account-enroll' | 'account-revoke' | 'account-delete' {
  return `account-${action}`
}

function requireOrigin(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw transportError('invalid-request', 'not-dispatched')
  }
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== raw
    ) {
      throw new Error()
    }
    return raw
  } catch {
    throw transportError('invalid-request', 'not-dispatched')
  }
}

function requireExactUrl(raw: unknown, origin: string): URL {
  if (typeof raw !== 'string' || raw.length > 2_048) throw new Error()
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.href !== raw ||
    url.search !== ''
  ) {
    throw new Error()
  }
  return url
}

function requireTimeout(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_TIMEOUT_MILLISECONDS
  ) {
    throw transportError('invalid-request', 'not-dispatched')
  }
  return value as number
}

function requireBytes(value: unknown, minimum: number, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error()
  }
  return value
}

function requireExactPayload(value: unknown, expected: Uint8Array): Uint8Array {
  const actual = requireBytes(value, 1, 4 * 1_024 * 1_024)
  if (!equalBytes(actual, expected)) {
    throw transportError('invalid-request', 'not-dispatched')
  }
  return actual
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function hasNoStore(value: string | null): boolean {
  return (
    value !== null &&
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .includes('no-store')
  )
}

function base64Url(value: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function transportError(
  code: EncryptedWalletBackupHttpTransportErrorCode,
  dispatchState: EncryptedWalletBackupHttpDispatchState,
): EncryptedWalletBackupHttpTransportError {
  return new EncryptedWalletBackupHttpTransportError(code, dispatchState)
}

function throwIfAborted(
  signal: AbortSignal,
  dispatchState: EncryptedWalletBackupHttpDispatchState,
): void {
  if (signal.aborted) {
    throw transportError('deadline-exceeded', dispatchState)
  }
}
