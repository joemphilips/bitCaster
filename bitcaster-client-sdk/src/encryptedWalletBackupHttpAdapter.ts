import {
  decodeEncryptedWalletBackupHttpResponse,
  encryptedWalletBackupHttpResponseMaximumBytes,
} from './encryptedWalletBackupHttpCodec.ts'
import {
  readPreparedEncryptedWalletBackupAccountOperation,
  type EncryptedWalletBackupAccountOperationRemotePort,
  type PreparedEncryptedWalletBackupAccountOperation,
} from './encryptedWalletBackupEnrollment.ts'

const MEDIA_TYPE = 'application/cbor'
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000
const MAX_IN_FLIGHT = 4
const MAX_RESPONSE_CHUNKS = 4_096
type FetchPort = (input: string, init: RequestInit) => Promise<Response>

export type EncryptedWalletBackupHttpTransportErrorCode =
  | 'concurrency-exhausted'
  | 'deadline-exceeded'
  | 'invalid-request'
  | 'invalid-response'
  | 'remote-rejected'
  | 'transport-failure'
export type EncryptedWalletBackupHttpDispatchState = 'not-dispatched' | 'dispatched' | 'uncertain'

/** A redacted shared transport error. It never retains a URL, body, or cause. */
export class EncryptedWalletBackupHttpTransportError extends Error {
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

/** Bounded shared account-lifecycle transport used by the V2 adapter. */
export class EncryptedWalletBackupHttpAdapter implements EncryptedWalletBackupAccountOperationRemotePort {
  readonly #origin: string
  readonly #fetch: FetchPort
  readonly #timeoutMilliseconds: number
  #inFlight = 0

  constructor(input: {
    readonly origin: string
    readonly fetch?: FetchPort
    readonly fallbackTimeoutMilliseconds?: number
  }) {
    this.#origin = requireOrigin(input.origin)
    const fetch = input.fetch ?? globalThis.fetch
    if (typeof fetch !== 'function') throw error('invalid-request', 'not-dispatched')
    this.#fetch = fetch.bind(globalThis) as FetchPort
    this.#timeoutMilliseconds = requireTimeout(
      input.fallbackTimeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    )
  }

  async executeAccountOperation(input: {
    readonly operation: PreparedEncryptedWalletBackupAccountOperation
    readonly canonicalRequest: Uint8Array
    readonly signal: AbortSignal
  }): ReturnType<EncryptedWalletBackupAccountOperationRemotePort['executeAccountOperation']> {
    if (this.#inFlight >= MAX_IN_FLIGHT) throw error('concurrency-exhausted', 'not-dispatched')
    const operation = requireOperation(input.operation, this.#origin)
    const body = requireExactBody(
      input.canonicalRequest,
      readPreparedEncryptedWalletBackupAccountOperation(operation),
    )
    if (!(input.signal instanceof AbortSignal) || input.signal.aborted)
      throw error('deadline-exceeded', 'not-dispatched')
    this.#inFlight += 1
    try {
      const response = await this.#fetchWithDeadline(operation, body, input.signal)
      const decoded = decodeEncryptedWalletBackupHttpResponse({
        operation: actionName(operation.action),
        expectedOperationId: operation.operationId,
        expectedIntentDigest: operation.intentDigest,
        httpStatus: response.status,
        body: await readBody(
          response,
          encryptedWalletBackupHttpResponseMaximumBytes(
            actionName(operation.action),
            response.status,
          ),
        ),
      })
      if (decoded.result === 'error') return mapError(decoded.code, decoded.retryAfterSeconds)
      return {
        status: decoded.result,
        operationId: decoded.operationId,
        intentDigest: decoded.intentDigest,
        enrollmentEpoch: decoded.enrollmentEpoch,
        lifecycle: decoded.lifecycle,
      }
    } catch (cause) {
      if (cause instanceof EncryptedWalletBackupHttpTransportError) throw cause
      throw error('invalid-response', 'uncertain')
    } finally {
      this.#inFlight -= 1
    }
  }

  async #fetchWithDeadline(
    operation: PreparedEncryptedWalletBackupAccountOperation,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    signal.addEventListener('abort', relay, { once: true })
    const timer = setTimeout(() => controller.abort(), this.#timeoutMilliseconds)
    try {
      const response = await this.#fetch(operation.url, {
        method: operation.method,
        headers: new Headers({
          accept: MEDIA_TYPE,
          'content-type': MEDIA_TYPE,
          'cache-control': 'no-store',
        }),
        body: body as unknown as BodyInit,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw error('deadline-exceeded', 'uncertain')
      if (
        response.redirected ||
        response.url !== operation.url ||
        response.headers.get('content-type') !== MEDIA_TYPE ||
        response.headers.has('content-encoding') ||
        !response.headers
          .get('cache-control')
          ?.split(',')
          .map((value) => value.trim().toLowerCase())
          .includes('no-store') ||
        response.body === null
      )
        throw error('invalid-response', 'dispatched')
      return response
    } catch (cause) {
      if (cause instanceof EncryptedWalletBackupHttpTransportError) throw cause
      throw error(
        controller.signal.aborted ? 'deadline-exceeded' : 'transport-failure',
        'uncertain',
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', relay)
    }
  }
}

async function readBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum))
    throw error('invalid-response', 'dispatched')
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (let count = 0; ; count += 1) {
    if (count > MAX_RESPONSE_CHUNKS) throw error('invalid-response', 'dispatched')
    const next = await reader.read()
    if (next.done) break
    if (!(next.value instanceof Uint8Array) || (total += next.value.byteLength) > maximum)
      throw error('invalid-response', 'dispatched')
    chunks.push(next.value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function requireOperation(
  value: PreparedEncryptedWalletBackupAccountOperation,
  origin: string,
): PreparedEncryptedWalletBackupAccountOperation {
  const url = new URL(value.url)
  const base = `/v1/encrypted-wallet-backup/realms/${value.realm}`
  const expected =
    value.action === 'enroll'
      ? `${base}/wallets:enroll`
      : value.action === 'revoke'
        ? `${base}/wallets/${value.walletId}:revoke`
        : `${base}/wallets/${value.walletId}`
  if (
    url.origin !== origin ||
    url.pathname !== expected ||
    url.search !== '' ||
    value.method !== (value.action === 'delete' ? 'DELETE' : 'POST')
  )
    throw error('invalid-request', 'not-dispatched')
  return value
}
function requireExactBody(value: unknown, expected: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== expected.byteLength ||
    value.some((byte, index) => byte !== expected[index])
  )
    throw error('invalid-request', 'not-dispatched')
  return value
}
function actionName(
  action: PreparedEncryptedWalletBackupAccountOperation['action'],
): 'account-enroll' | 'account-revoke' | 'account-delete' {
  return action === 'enroll'
    ? 'account-enroll'
    : action === 'revoke'
      ? 'account-revoke'
      : 'account-delete'
}
function mapError(
  code: string,
  retryAfterSeconds: number | null,
): ReturnType<
  EncryptedWalletBackupAccountOperationRemotePort['executeAccountOperation']
> extends Promise<infer Value>
  ? Value
  : never {
  if (
    code === 'quota-exceeded' ||
    code === 'unauthorized' ||
    code === 'rate-limited' ||
    code === 'overloaded' ||
    code === 'unavailable'
  )
    return { status: code, ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }) } as never
  throw error('remote-rejected', 'dispatched')
}
function requireOrigin(value: unknown): string {
  const url = new URL(String(value))
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw error('invalid-request', 'not-dispatched')
  return url.origin
}
function requireTimeout(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > DEFAULT_TIMEOUT_MILLISECONDS
  )
    throw error('invalid-request', 'not-dispatched')
  return value as number
}
function error(
  code: EncryptedWalletBackupHttpTransportErrorCode,
  dispatchState: EncryptedWalletBackupHttpDispatchState,
): EncryptedWalletBackupHttpTransportError {
  return new EncryptedWalletBackupHttpTransportError(code, dispatchState)
}
