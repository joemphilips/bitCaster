import {
  encodeEncryptedWalletBackupOwnerRequestProof,
  prepareEncryptedWalletBackupOwnerRequestProof,
  type EncryptedWalletBackupOwnerRequestProof,
} from './encryptedWalletBackupOwnerRequestProof.ts'
import {
  consumeEncryptedWalletBackupOwnerHttpResponse,
  decodeEncryptedWalletBackupOwnerHttpError,
  ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_OWNER_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES,
  type EncryptedWalletBackupOwnerHttpResponseEnvelope,
} from './encryptedWalletBackupOwnerHttpCodec.ts'
import {
  encryptedWalletBackupOwnerServerRoute,
  type EncryptedWalletBackupOwnerServerRoute,
} from './encryptedWalletBackupOwnerDelegatedServerCodec.ts'
import {
  verifyEncryptedWalletBackupOwnerDiscoveryPage,
  type EncryptedWalletBackupOwnerDiscoveryPage,
} from './encryptedWalletBackupOwnerDiscovery.ts'
import { requireEncryptedWalletBackupV2KeyAuthority } from './encryptedWalletBackupV2KeyAuthority.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import { requireBytes } from './encryptedWalletBackupServerValidation.ts'
import {
  readPreparedEncryptedWalletBackupOwnerAccountOperation,
  decodeEncryptedWalletBackupOwnerAccountRequest,
  type PreparedEncryptedWalletBackupOwnerAccountOperation,
} from './encryptedWalletBackupOwnerAccount.ts'
import {
  consumeEncryptedWalletBackupOwnerAccountHttpResponse,
  type EncryptedWalletBackupOwnerAccountResponse,
} from './encryptedWalletBackupOwnerAccountHttp.ts'

const AUTHORIZATION_PREFIX = 'BackupV1 '
const MEDIA_TYPE = 'application/cbor'
const MAX_IN_FLIGHT = 4
const MAX_RESPONSE_CHUNKS = 4_096
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000
type FetchPort = (input: string, init: RequestInit) => Promise<Response>

export class EncryptedWalletBackupOwnerHttpTransportError extends Error {
  readonly code: string
  readonly retryAfterSeconds: number | null

  constructor(code: string, retryAfterSeconds: number | null = null) {
    super(`encrypted backup owner request failed: ${code}`)
    this.name = 'EncryptedWalletBackupOwnerHttpTransportError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Bounded request-key transport for owner-scoped backup routes. */
export class EncryptedWalletBackupOwnerHttpAdapter {
  readonly #origin: string
  readonly #keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly #fetch: FetchPort
  readonly #now: () => number
  #inFlight = 0

  constructor(input: {
    readonly origin: string
    readonly keyHandle: EncryptedWalletBackupV2KeyHandle
    readonly fetch?: FetchPort
    readonly nowUnixSeconds?: () => number
  }) {
    const parsed = new URL(input.origin)
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== input.origin ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-request')
    requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
    const fetch = input.fetch ?? globalThis.fetch
    if (typeof fetch !== 'function')
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-request')
    this.#origin = parsed.origin
    this.#keyHandle = input.keyHandle
    this.#fetch = fetch.bind(globalThis) as FetchPort
    this.#now = input.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  async discover(input: {
    readonly requestedCursor: string | null
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerDiscoveryPage> {
    const route: EncryptedWalletBackupOwnerServerRoute = {
      operation: 'owner-discovery',
      realm: this.#keyHandle.realm,
      walletId: this.#keyHandle.walletId,
      requestedCursor: input.requestedCursor,
    }
    const issued = await this.#issue(route, 0, new Uint8Array(), input.signal)
    const response = await this.#call(issued, new Uint8Array(), input.signal, 65_536)
    if (response.status !== 200) throw this.#failure(response.body, 'owner-discovery')
    return verifyEncryptedWalletBackupOwnerDiscoveryPage({
      bytes: response.body,
      request: issued.proof,
    })
  }

  async request(input: {
    readonly route: Exclude<EncryptedWalletBackupOwnerServerRoute, { operation: 'owner-discovery' }>
    readonly enrollmentEpoch: number
    readonly payload: Uint8Array
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerHttpResponseEnvelope> {
    if (
      input.route.realm !== this.#keyHandle.realm ||
      input.route.walletId !== this.#keyHandle.walletId
    )
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-request')
    const body = requireBytes(input.payload, 0, 4 * 1024 * 1024, 'owner payload').slice()
    const issued = await this.#issue(input.route, input.enrollmentEpoch, body, input.signal)
    const maximum =
      input.route.operation === 'current-inventory'
        ? ENCRYPTED_WALLET_BACKUP_OWNER_CURRENT_INVENTORY_HTTP_RESPONSE_MAX_BYTES
        : ENCRYPTED_WALLET_BACKUP_OWNER_HTTP_RESPONSE_MAX_BYTES
    const response = await this.#call(issued, body, input.signal, maximum)
    if (response.status >= 400) throw this.#failure(response.body, input.route.operation)
    if (response.status !== 200)
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
    return consumeEncryptedWalletBackupOwnerHttpResponse({
      request: issued.proof,
      bytes: response.body,
    })
  }

  /** Sends one already account-authorized lifecycle operation through the same bounded transport. */
  async accountOperation(input: {
    readonly operation: PreparedEncryptedWalletBackupOwnerAccountOperation
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerAccountResponse> {
    let body: Uint8Array
    let decoded: ReturnType<typeof decodeEncryptedWalletBackupOwnerAccountRequest>
    try {
      body = readPreparedEncryptedWalletBackupOwnerAccountOperation(input.operation)
      decoded = decodeEncryptedWalletBackupOwnerAccountRequest(body)
      const intent = decoded.accountRequest.intent
      const base = `/v1/encrypted-wallet-backup/realms/${intent.realm}/wallets`
      const expectedPath =
        intent.action === 'enroll'
          ? `${base}:enroll`
          : intent.action === 'revoke'
            ? `${base}/${intent.walletId}:revoke`
            : `${base}/${intent.walletId}`
      const url = new URL(intent.url)
      if (
        url.origin !== this.#origin ||
        url.pathname !== expectedPath ||
        url.search !== '' ||
        url.hash !== '' ||
        url.href !== intent.url ||
        intent.realm !== this.#keyHandle.realm ||
        intent.walletId !== this.#keyHandle.walletId ||
        intent.method !== (intent.action === 'delete' ? 'DELETE' : 'POST')
      )
        throw new Error('invalid owner account request')
    } catch {
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-request')
    }
    const intent = decoded.accountRequest.intent
    const response = await this.#dispatch({
      url: intent.url,
      method: intent.method,
      headers: { accept: MEDIA_TYPE, 'cache-control': 'no-store', 'content-type': MEDIA_TYPE },
      body,
      signal: input.signal,
      maxBytes: 256,
    })
    try {
      return consumeEncryptedWalletBackupOwnerAccountHttpResponse({
        prepared: input.operation,
        httpStatus: response.status,
        bytes: response.body,
      })
    } catch {
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
    }
  }

  #issue(
    routeInput: EncryptedWalletBackupOwnerServerRoute,
    epoch: number,
    payload: Uint8Array,
    signal: AbortSignal,
  ) {
    const route = encryptedWalletBackupOwnerServerRoute(routeInput)
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0)
      throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-request')
    return prepareEncryptedWalletBackupOwnerRequestProof({
      keyHandle: this.#keyHandle,
      route: route.context,
      enrollmentEpoch: epoch,
      method: route.method,
      url: this.#origin + route.rawTarget,
      issuedAtUnixSeconds: now,
      expiresAtUnixSeconds: now + 30,
      payload,
      signal,
    }).then((proof) => ({ proof, url: this.#origin + route.rawTarget, method: route.method }))
  }

  async #call(
    issued: { proof: EncryptedWalletBackupOwnerRequestProof; url: string; method: 'GET' | 'POST' },
    body: Uint8Array,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<{ status: number; body: Uint8Array }> {
    return this.#dispatch({
      url: issued.url,
      method: issued.method,
      headers: {
        accept: MEDIA_TYPE,
        'cache-control': 'no-store',
        'content-type': MEDIA_TYPE,
        authorization:
          AUTHORIZATION_PREFIX +
          base64Url(encodeEncryptedWalletBackupOwnerRequestProof(issued.proof)),
      },
      body: body.byteLength === 0 ? undefined : body,
      signal,
      maxBytes,
    })
  }

  async #dispatch(input: {
    readonly url: string
    readonly method: 'GET' | 'POST' | 'DELETE'
    readonly headers: HeadersInit
    readonly body?: Uint8Array
    readonly signal: AbortSignal
    readonly maxBytes: number
  }): Promise<{ status: number; body: Uint8Array }> {
    if (this.#inFlight >= MAX_IN_FLIGHT)
      throw new EncryptedWalletBackupOwnerHttpTransportError('concurrency-exhausted')
    if (input.signal.aborted)
      throw new EncryptedWalletBackupOwnerHttpTransportError('deadline-exceeded')
    this.#inFlight += 1
    const controller = new AbortController()
    const abort = () => controller.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, DEFAULT_TIMEOUT_MILLISECONDS)
    try {
      const response = await this.#fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body as unknown as BodyInit | undefined,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (controller.signal.aborted || input.signal.aborted)
        throw new EncryptedWalletBackupOwnerHttpTransportError('deadline-exceeded')
      if (response.redirected || response.url !== input.url)
        throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
      if (
        response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== MEDIA_TYPE
      )
        throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
      if (
        response.headers.has('content-encoding') ||
        !response.headers
          .get('cache-control')
          ?.split(',')
          .map((value) => value.trim().toLowerCase())
          .includes('no-store')
      )
        throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
      return {
        status: response.status,
        body: await readBounded(response, controller.signal, input.maxBytes),
      }
    } catch (cause) {
      if (cause instanceof EncryptedWalletBackupOwnerHttpTransportError) throw cause
      if (controller.signal.aborted || input.signal.aborted)
        throw new EncryptedWalletBackupOwnerHttpTransportError('deadline-exceeded')
      throw new EncryptedWalletBackupOwnerHttpTransportError('transport-failure')
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      this.#inFlight -= 1
    }
  }

  #failure(body: Uint8Array, operation: EncryptedWalletBackupOwnerServerRoute['operation']): Error {
    try {
      const failure = decodeEncryptedWalletBackupOwnerHttpError(body)
      if (failure.operation !== operation) throw new Error('operation mismatch')
      return new EncryptedWalletBackupOwnerHttpTransportError(
        failure.code,
        failure.retryAfterSeconds,
      )
    } catch {
      return new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
    }
  }
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
  maximum: number,
): Promise<Uint8Array> {
  if (response.body === null)
    throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (let count = 0; count < MAX_RESPONSE_CHUNKS; count += 1) {
      if (signal.aborted)
        throw new EncryptedWalletBackupOwnerHttpTransportError('deadline-exceeded')
      const next = await reader.read()
      if (signal.aborted)
        throw new EncryptedWalletBackupOwnerHttpTransportError('deadline-exceeded')
      if (next.done) {
        const result = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.byteLength
        }
        return result
      }
      const chunk = requireBytes(next.value, 1, maximum, 'response chunk').slice()
      length += chunk.byteLength
      if (length > maximum)
        throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
      chunks.push(chunk)
    }
    throw new EncryptedWalletBackupOwnerHttpTransportError('invalid-response')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
