import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  encodeEncryptedWalletBackupRequestProof,
  encryptedWalletBackupRequestDigest,
  type EncryptedWalletBackupRequestProof,
} from './encryptedWalletBackup.ts'
import {
  requireEncryptedWalletBackupV2RequestProof,
  type EncryptedWalletBackupV2RequestProof,
} from './encryptedWalletBackupV2RequestProof.ts'
import {
  decodeEncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleObjectWire,
} from './encryptedWalletBackupV2Bundle.ts'
import type { EncryptedWalletBackupV2BundleDescriptor } from './encryptedWalletBackupV2Descriptor.ts'
import {
  decodeEncryptedWalletBackupV2HttpResponse,
  decodeEncryptedWalletBackupV2HttpError,
  decodeEncryptedWalletBackupV2EnrollmentEpochResult,
  ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
  requireEncryptedWalletBackupV2HttpResponseBinding,
  requireEncryptedWalletBackupV2HttpResponseScope,
  type EncryptedWalletBackupV2HttpResponseKind,
} from './encryptedWalletBackupV2HttpCodec.ts'
import {
  decodeEncryptedWalletBackupV2DescriptorPage,
  decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire,
  decodeEncryptedWalletBackupV2UploadGroup,
} from './encryptedWalletBackupV2ServiceCodec.ts'
import type { EncryptedWalletBackupV2DescriptorPage } from './encryptedWalletBackupV2Head.ts'
import type { EncryptedWalletBackupV2BundleSupersessionReceipt } from './encryptedWalletBackupV2Receipt.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupV2Limits.ts'
import {
  requireBytes,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'
import {
  EncryptedWalletBackupHttpAdapter,
  EncryptedWalletBackupHttpTransportError,
  type EncryptedWalletBackupHttpDispatchState,
} from './encryptedWalletBackupHttpAdapter.ts'
import type {
  EncryptedWalletBackupAccountOperationRemotePort,
  PreparedEncryptedWalletBackupAccountOperation,
} from './encryptedWalletBackupEnrollment.ts'

const MEDIA_TYPE = 'application/cbor'
const AUTHORIZATION_PREFIX = 'BackupV1 '
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000
const MAX_IN_FLIGHT = 4
const MAX_RESPONSE_CHUNKS = 4_096

type FetchPort = (input: string, init: RequestInit) => Promise<Response>

export class EncryptedWalletBackupV2HttpTransportError extends Error {
  readonly retryAfterSeconds: number | null
  readonly dispatchState: EncryptedWalletBackupHttpDispatchState | null
  readonly code:
    | 'concurrency-exhausted'
    | 'deadline-exceeded'
    | 'invalid-request'
    | 'invalid-response'
    | 'transport-failure'
    | 'unauthorized'
    | 'replay-rejected'
    | 'conflict'
    | 'not-found'
    | 'quota-exceeded'
    | 'rate-limited'
    | 'overloaded'
    | 'unavailable'

  constructor(
    code:
      | 'concurrency-exhausted'
      | 'deadline-exceeded'
      | 'invalid-request'
      | 'invalid-response'
      | 'transport-failure'
      | 'unauthorized'
      | 'replay-rejected'
      | 'conflict'
      | 'not-found'
      | 'quota-exceeded'
      | 'rate-limited'
      | 'overloaded'
      | 'unavailable',
    retryAfterSeconds: number | null = null,
    dispatchState: EncryptedWalletBackupHttpDispatchState | null = null,
  ) {
    super(`encrypted backup v2 transport failed: ${code}`)
    this.name = 'EncryptedWalletBackupV2HttpTransportError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.dispatchState = dispatchState
  }
}

export interface EncryptedWalletBackupV2RemotePort {
  discoverEnrollmentEpoch(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly signal?: AbortSignal
  }): Promise<
    Readonly<{ status: 'active'; enrollmentEpoch: number }> | Readonly<{ status: 'not-enrolled' }>
  >
  readDescriptorPage(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly afterBundleId: string | null
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2DescriptorPage>
  mutateHeadOnce(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly canonicalUploadGroup: Uint8Array
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2BundleSupersessionReceipt>
  readObject(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly objectId: string
    readonly expectedDescriptor: EncryptedWalletBackupV2BundleDescriptor
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2BundleObjectWire>
}

/** Bounded V2 client port. It performs one request per immutable V2 operation. */
export class EncryptedWalletBackupV2HttpAdapter
  implements EncryptedWalletBackupV2RemotePort, EncryptedWalletBackupAccountOperationRemotePort
{
  readonly #origin: string
  readonly #fetch: FetchPort
  readonly #accountOperations: EncryptedWalletBackupAccountOperationRemotePort
  #inFlight = 0

  constructor(input: { readonly origin: string; readonly fetch?: FetchPort }) {
    this.#origin = requireOrigin(input.origin)
    const fetch = input.fetch ?? globalThis.fetch
    if (typeof fetch !== 'function') throw error('invalid-request')
    this.#fetch = fetch.bind(globalThis) as FetchPort
    this.#accountOperations = new EncryptedWalletBackupHttpAdapter({
      origin: this.#origin,
      fetch: this.#fetch,
    })
  }

  /** Uses only the scheme-neutral account endpoint. It does not enable V1 object or head calls. */
  async executeAccountOperation(input: {
    readonly operation: PreparedEncryptedWalletBackupAccountOperation
    readonly canonicalRequest: Uint8Array
    readonly signal: AbortSignal
  }): ReturnType<EncryptedWalletBackupAccountOperationRemotePort['executeAccountOperation']> {
    try {
      return await this.#accountOperations.executeAccountOperation(input)
    } catch (cause) {
      throw mapAccountOperationTransportError(cause)
    }
  }

  async discoverEnrollmentEpoch(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly signal?: AbortSignal
  }): Promise<
    Readonly<{ status: 'active'; enrollmentEpoch: number }> | Readonly<{ status: 'not-enrolled' }>
  > {
    const body = await this.#call(
      input.requestProof,
      'enrollment-epoch',
      new Uint8Array(),
      input.signal,
    )
    const result = decodeEncryptedWalletBackupV2EnrollmentEpochResult(body)
    if (
      result.enrollmentEpoch !== input.requestProof.enrollmentEpoch &&
      input.requestProof.enrollmentEpoch !== 0
    )
      throw error('invalid-response')
    return result.result === 'active'
      ? { status: 'active', enrollmentEpoch: result.enrollmentEpoch }
      : { status: 'not-enrolled' }
  }

  async readDescriptorPage(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly afterBundleId: string | null
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2DescriptorPage> {
    requireDescriptorCursorRoute(input.requestProof, this.#origin, input.afterBundleId)
    const body = await this.#call(
      input.requestProof,
      'descriptor-page',
      new Uint8Array(),
      input.signal,
    )
    const page = decodeEncryptedWalletBackupV2DescriptorPage(body)
    if (
      page.afterBundleId !== input.afterBundleId ||
      page.head.realm !== input.requestProof.realm ||
      page.head.walletId !== input.requestProof.walletId ||
      page.head.enrollmentEpoch !== input.requestProof.enrollmentEpoch
    )
      throw error('invalid-response')
    return page
  }

  async mutateHeadOnce(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly canonicalUploadGroup: Uint8Array
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2BundleSupersessionReceipt> {
    const group = requireBytes(
      input.canonicalUploadGroup,
      1,
      ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
      'upload group',
    ).slice()
    decodeEncryptedWalletBackupV2UploadGroup({
      bytes: group,
      expectedRequestAuthPublicKey: input.requestProof.requestAuthPublicKey,
      expectedContext: requestScope(input.requestProof),
    })
    const body = await this.#call(
      input.requestProof,
      'bundle-supersession-receipt',
      group,
      input.signal,
    )
    const receipt = decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(body)
    if (
      receipt.realm !== input.requestProof.realm ||
      receipt.walletId !== input.requestProof.walletId ||
      receipt.enrollmentEpoch !== input.requestProof.enrollmentEpoch ||
      receipt.requestAuthPublicKey !== input.requestProof.requestAuthPublicKey
    )
      throw error('invalid-response')
    return receipt
  }

  async readObject(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly objectId: string
    readonly expectedDescriptor: EncryptedWalletBackupV2BundleDescriptor
    readonly signal?: AbortSignal
  }): Promise<EncryptedWalletBackupV2BundleObjectWire> {
    const objectId = requireLowerHex(input.objectId, 16, 'object id')
    requireObjectRoute(input.requestProof, this.#origin, objectId)
    const body = await this.#call(input.requestProof, 'object', new Uint8Array(), input.signal)
    const object = decodeEncryptedWalletBackupV2BundleObjectWire(body, input.expectedDescriptor)
    if (object.objectId !== objectId) throw error('invalid-response')
    return object
  }

  async #call(
    proof: EncryptedWalletBackupRequestProof,
    kind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
    body: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    return this.#withSlot(async (deadline) => {
      try {
        requireEncryptedWalletBackupV2RequestProof(proof)
      } catch {
        throw error('invalid-request')
      }
      const request = requireRequest(proof, this.#origin, kind, body)
      const response = await dispatch(this.#fetch, request, deadline)
      const envelope = decodeEncryptedWalletBackupV2HttpResponse(response.body)
      const scoped = requireEncryptedWalletBackupV2HttpResponseScope({
        response: envelope,
        requestDigest: encryptedWalletBackupRequestDigest(
          proof,
          ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
        ),
        realm: proof.realm,
        walletId: proof.walletId,
        enrollmentEpoch: proof.enrollmentEpoch,
      })
      if (scoped.kind === 'error') {
        const failure = decodeEncryptedWalletBackupV2HttpError(scoped.body)
        if (
          failure.operation !== errorOperation(kind) ||
          response.status !== errorStatus(failure.code)
        )
          throw error('invalid-response')
        throw error(failure.code, failure.retryAfterSeconds)
      }
      if (response.status !== 200) throw error('invalid-response')
      return requireEncryptedWalletBackupV2HttpResponseBinding({
        response: scoped,
        kind,
        requestDigest: encryptedWalletBackupRequestDigest(
          proof,
          ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
        ),
        realm: proof.realm,
        walletId: proof.walletId,
        enrollmentEpoch: proof.enrollmentEpoch,
      })
    }, signal)
  }

  #withSlot<T>(task: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (this.#inFlight >= MAX_IN_FLIGHT) return Promise.reject(error('concurrency-exhausted'))
    if (callerSignal?.aborted) return Promise.reject(error('deadline-exceeded'))
    this.#inFlight += 1
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, DEFAULT_TIMEOUT_MILLISECONDS)
    return task(controller.signal)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) throw error('deadline-exceeded')
        throw reason
      })
      .finally(() => {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', abort)
        this.#inFlight -= 1
      })
  }
}

function requestScope(proof: EncryptedWalletBackupRequestProof): {
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
} {
  return {
    realm: proof.realm,
    walletId: proof.walletId,
    enrollmentEpoch: proof.enrollmentEpoch,
  }
}

function requireRequest(
  proof: EncryptedWalletBackupRequestProof,
  origin: string,
  kind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
  body: Uint8Array,
): {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly body: Uint8Array
  readonly authorization: string
} {
  const method = kind === 'bundle-supersession-receipt' ? 'POST' : 'GET'
  const url = requireEndpoint(proof, origin, kind)
  if (
    proof.method !== method ||
    proof.payloadLength !== body.byteLength ||
    proof.payloadDigest !== bytesToHex(sha256(body))
  )
    throw error('invalid-request')
  return Object.freeze({
    url,
    method,
    body: body.slice(),
    authorization: `${AUTHORIZATION_PREFIX}${base64Url(
      encodeEncryptedWalletBackupRequestProof(
        proof,
        ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
      ),
    )}`,
  })
}

function requireEndpoint(
  proof: EncryptedWalletBackupRequestProof,
  origin: string,
  kind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
): string {
  const url = new URL(proof.url)
  const base = `/v1/encrypted-wallet-backup/realms/${requireRealm(proof.realm)}/wallets/${requireLowerHex(proof.walletId, 32, 'wallet id')}`
  if (
    url.origin !== origin ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw error('invalid-request')
  const expected = endpointPath(base, kind, url.pathname)
  if (url.pathname !== expected) throw error('invalid-request')
  return url.href
}

function requireDescriptorCursorRoute(
  proof: EncryptedWalletBackupRequestProof,
  origin: string,
  afterBundleId: string | null,
): void {
  const url = new URL(proof.url)
  const base = `/v1/encrypted-wallet-backup/realms/${requireRealm(proof.realm)}/wallets/${requireLowerHex(proof.walletId, 32, 'wallet id')}`
  const expected =
    afterBundleId === null
      ? `${base}/head`
      : `${base}/head/after/${requireLowerHex(afterBundleId, 16, 'bundle cursor')}`
  if (url.origin !== origin || url.pathname !== expected || url.search !== '' || url.hash !== '')
    throw error('invalid-request')
}

function requireObjectRoute(
  proof: EncryptedWalletBackupRequestProof,
  origin: string,
  objectId: string,
): void {
  const url = new URL(proof.url)
  const expected = `/v1/encrypted-wallet-backup/realms/${requireRealm(proof.realm)}/wallets/${requireLowerHex(proof.walletId, 32, 'wallet id')}/objects/${objectId}`
  if (url.origin !== origin || url.pathname !== expected || url.search !== '' || url.hash !== '')
    throw error('invalid-request')
}

function endpointPath(
  base: string,
  kind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
  actual: string,
): string {
  switch (kind) {
    case 'enrollment-epoch':
      return `${base}/enrollment-epoch`
    case 'descriptor-page':
      return actual === `${base}/head` ||
        new RegExp(`^${escapeRegExp(base)}/head/after/[0-9a-f]{32}$`).test(actual)
        ? actual
        : `${base}/head`
    case 'bundle-supersession-receipt':
      return `${base}/head:compare-and-swap`
    case 'object':
      return new RegExp(`^${escapeRegExp(base)}/objects/[0-9a-f]{32}$`).test(actual)
        ? actual
        : `${base}/objects/invalid`
    default:
      return assertNever(kind)
  }
}

async function dispatch(
  fetch: FetchPort,
  request: {
    readonly url: string
    readonly method: 'GET' | 'POST'
    readonly body: Uint8Array
    readonly authorization: string
  },
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: Uint8Array }> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: {
        accept: MEDIA_TYPE,
        'cache-control': 'no-store',
        'content-type': MEDIA_TYPE,
        authorization: request.authorization,
      },
      body: request.body.byteLength === 0 ? undefined : (request.body as unknown as BodyInit),
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    })
  } catch {
    throw error('transport-failure')
  }
  if (!isSupportedStatus(response.status) || response.url !== request.url)
    throw error('invalid-response')
  try {
    return { status: response.status, body: await readBounded(response, signal) }
  } catch (cause) {
    if (cause instanceof EncryptedWalletBackupV2HttpTransportError) throw cause
    throw error('invalid-response')
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const stream = response.body
  if (stream === null) throw error('invalid-response')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (let count = 0; count < MAX_RESPONSE_CHUNKS; count += 1) {
      if (signal.aborted) throw error('deadline-exceeded')
      const item = await reader.read()
      if (item.done) {
        const result = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.byteLength
        }
        return result
      }
      const chunk = requireBytes(
        item.value,
        1,
        ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES,
        'response chunk',
      ).slice()
      length += chunk.byteLength
      if (length > ENCRYPTED_WALLET_BACKUP_V2_HTTP_RESPONSE_MAX_BYTES)
        throw error('invalid-response')
      chunks.push(chunk)
    }
    throw error('invalid-response')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function requireOrigin(value: string): string {
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw error('invalid-request')
  return parsed.origin
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function error(
  code: ConstructorParameters<typeof EncryptedWalletBackupV2HttpTransportError>[0],
  retryAfterSeconds: number | null = null,
): EncryptedWalletBackupV2HttpTransportError {
  return new EncryptedWalletBackupV2HttpTransportError(code, retryAfterSeconds)
}

function mapAccountOperationTransportError(
  cause: unknown,
): EncryptedWalletBackupV2HttpTransportError {
  if (!(cause instanceof EncryptedWalletBackupHttpTransportError)) throw cause
  const code = cause.code === 'remote-rejected' ? 'invalid-response' : cause.code
  return new EncryptedWalletBackupV2HttpTransportError(code, null, cause.dispatchState)
}

function errorOperation(
  kind: Exclude<EncryptedWalletBackupV2HttpResponseKind, 'error'>,
): 'enrollment-epoch' | 'descriptor-page' | 'bundle-supersession' | 'object-get' {
  switch (kind) {
    case 'enrollment-epoch':
      return 'enrollment-epoch'
    case 'descriptor-page':
      return 'descriptor-page'
    case 'bundle-supersession-receipt':
      return 'bundle-supersession'
    case 'object':
      return 'object-get'
    default:
      return assertNever(kind)
  }
}

function errorStatus(
  code:
    | 'unauthorized'
    | 'replay-rejected'
    | 'conflict'
    | 'not-found'
    | 'quota-exceeded'
    | 'rate-limited'
    | 'overloaded'
    | 'unavailable',
): number {
  switch (code) {
    case 'unauthorized':
      return 401
    case 'replay-rejected':
    case 'conflict':
      return 409
    case 'not-found':
      return 404
    case 'quota-exceeded':
      return 413
    case 'rate-limited':
      return 429
    case 'overloaded':
    case 'unavailable':
      return 503
    default:
      return assertNever(code)
  }
}

function isSupportedStatus(status: number): boolean {
  return (
    status === 200 ||
    status === 401 ||
    status === 404 ||
    status === 409 ||
    status === 413 ||
    status === 429 ||
    status === 503
  )
}

function assertNever(_value: never): never {
  throw error('invalid-request')
}
