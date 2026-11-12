import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  readAllocationBoundedBytesResponse,
  readAllocationBoundedJsonResponse,
} from './boundedJsonResponse.ts'
import type { operations } from './generated/api.ts'
import {
  RECOVERY_INDEX_DOCUMENT_BYTES_MAX,
  isRecoveryIndexDocumentSize,
  requireRecoveryIndexContext,
  type RecoveryIndexKeys,
} from './recoveryIndexDocument.ts'

/**
 * The engine store of the recovery index (ADR-034 recovery index amendment):
 * the realms, the request signature, and the three routes. A refusal of an
 * index request never refuses a trade, so callers never wait for this store
 * before a funded operation.
 */

/** The permanent realms (ADR-034 "Clarifications (2026-11-13)"). Each gives other keys. */
export const RECOVERY_INDEX_REALMS = Object.freeze({
  production: 'bitcaster-production',
  staging: 'bitcaster-staging',
  local: 'bitcaster-local',
} as const)
export type RecoveryIndexRealm = (typeof RECOVERY_INDEX_REALMS)[keyof typeof RECOVERY_INDEX_REALMS]

export const RECOVERY_INDEX_REQUEST_TAG = 'bitcaster/recovery-index/request/v1'
export const RECOVERY_INDEX_PATH = '/api/v1/recovery-index'
export type RecoveryIndexMethod = 'GET' | 'PUT' | 'DELETE'

type ReadHeaders = operations['getRecoveryIndex']['parameters']['header']
type WriteHeaders = operations['putRecoveryIndex']['parameters']['header']
const KEY_HEADER = 'X-Recovery-Index-Key' satisfies keyof ReadHeaders
const ISSUED_AT_HEADER = 'X-Recovery-Index-Issued-At' satisfies keyof ReadHeaders
const SIGNATURE_HEADER = 'X-Recovery-Index-Signature' satisfies keyof ReadHeaders
const EXPECTED_VERSION_HEADER = 'X-Recovery-Index-Expected-Version' satisfies keyof WriteHeaders
const VERSION_HEADER = 'X-Recovery-Index-Version'
const STALE_REQUEST_CODE = 'recovery-index-stale-request'
const PROBLEM_RESPONSE_BYTES_MAX = 16 * 1024
const CANONICAL_VERSION = /^(0|[1-9][0-9]{0,15})$/

export function isRecoveryIndexRealm(value: unknown): value is RecoveryIndexRealm {
  return Object.values(RECOVERY_INDEX_REALMS).some((realm) => realm === value)
}

/**
 * The digest that the request signature signs: the BIP340 tagged hash with
 * tag `bitcaster/recovery-index/request/v1` of `u8 len(realm) || realm ||
 * u8 len(method) || method || u8 len(path) || path || request key (32) ||
 * SHA-256(body) (32) || u64be(expected version) || u64be(issue time)`.
 */
export function recoveryIndexRequestDigest(input: {
  readonly realm: string
  readonly method: RecoveryIndexMethod
  readonly requestPublicKey: string
  readonly body: Uint8Array
  readonly expectedVersion: number
  readonly issuedAt: number
}): Uint8Array {
  let realm: Uint8Array
  try {
    realm = requireRecoveryIndexContext(input.realm)
  } catch {
    throw new Error('recovery index realm is invalid')
  }
  if (input.method !== 'GET' && input.method !== 'PUT' && input.method !== 'DELETE') {
    throw new Error('recovery index method is invalid')
  }
  if (
    typeof input.requestPublicKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.requestPublicKey)
  ) {
    throw new Error('recovery index request key is invalid')
  }
  if (!(input.body instanceof Uint8Array)) throw new Error('recovery index body is invalid')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('recovery index expected version is invalid')
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new Error('recovery index issue time is invalid')
  }
  return schnorr.utils.taggedHash(
    RECOVERY_INDEX_REQUEST_TAG,
    concatBytes(
      prefixed(realm),
      prefixed(utf8ToBytes(input.method)),
      prefixed(utf8ToBytes(RECOVERY_INDEX_PATH)),
      hexToBytes(input.requestPublicKey),
      sha256(input.body),
      u64(input.expectedVersion),
      u64(input.issuedAt),
    ),
  )
}

/** Sign one request with the locator key (BIP340). */
export function signRecoveryIndexRequest(input: {
  readonly locatorSecretKey: Uint8Array
  readonly realm: string
  readonly method: RecoveryIndexMethod
  readonly body: Uint8Array
  readonly expectedVersion: number
  readonly issuedAt: number
  /** BIP340 auxiliary randomness. The default is fresh random bytes. */
  readonly auxRand?: Uint8Array
}): { readonly requestPublicKey: string; readonly signature: string } {
  const requestPublicKey = bytesToHex(schnorr.getPublicKey(input.locatorSecretKey))
  const digest = recoveryIndexRequestDigest({ ...input, requestPublicKey })
  return {
    requestPublicKey,
    signature: bytesToHex(schnorr.sign(digest, input.locatorSecretKey, input.auxRand)),
  }
}

export type RecoveryIndexReadResult =
  | { readonly status: 'found'; readonly version: number; readonly document: Uint8Array }
  | { readonly status: 'not-modified'; readonly version: number }
  /** No document: a tombstone of `version`, or no row with version 0. */
  | { readonly status: 'absent'; readonly version: number }

export type RecoveryIndexWriteResult =
  | { readonly status: 'written'; readonly version: number }
  | { readonly status: 'conflict'; readonly currentVersion: number }

export type RecoveryIndexDeleteResult =
  | { readonly status: 'deleted'; readonly version: number }
  | { readonly status: 'absent'; readonly version: number }
  | { readonly status: 'conflict'; readonly currentVersion: number }

/** One document and its version for one locator key, with compare-and-swap writes (ADR-051). */
export interface RecoveryIndexStore {
  read(options?: { readonly knownVersion?: number }): Promise<RecoveryIndexReadResult>
  write(document: Uint8Array, expectedVersion: number): Promise<RecoveryIndexWriteResult>
  remove(expectedVersion: number): Promise<RecoveryIndexDeleteResult>
}

export type RecoveryIndexEngineErrorKind =
  /** A 429 limit. `retryAfterMs` holds the engine's `Retry-After`. */
  | 'limited'
  /** A 503 or another server failure. */
  | 'unavailable'
  /** The issue time stayed outside the engine window after one clock correction. */
  | 'clock'
  | 'unauthenticated'
  /** A 4xx refusal of the request shape (400, 408, 411, or 413). */
  | 'refused'
  | 'network'
  | 'invalid-response'

/** An engine request failed. The message never holds a key, a signature, or a document. */
export class RecoveryIndexEngineError extends Error {
  readonly kind: RecoveryIndexEngineErrorKind
  readonly retryAfterMs: number | null
  readonly limitCode: string | null

  constructor(
    kind: RecoveryIndexEngineErrorKind,
    options: { readonly retryAfterMs?: number | null; readonly limitCode?: string | null } = {},
  ) {
    super(`recovery index request failed (${kind})`)
    this.name = 'RecoveryIndexEngineError'
    this.kind = kind
    this.retryAfterMs = options.retryAfterMs ?? null
    this.limitCode = options.limitCode ?? null
  }
}

/** The engine routes of one seed and realm, over an injected `fetch`. */
export function createRecoveryIndexEngineStore(options: {
  readonly engineBaseUrl: string
  readonly realm: RecoveryIndexRealm
  readonly keys: RecoveryIndexKeys
  readonly fetchImpl: typeof fetch
  readonly nowMs?: () => number
}): RecoveryIndexStore {
  if (!isRecoveryIndexRealm(options.realm)) throw new Error('recovery index realm is unknown')
  const context: SendContext = {
    url: new URL(RECOVERY_INDEX_PATH, options.engineBaseUrl),
    realm: options.realm,
    keys: options.keys,
    // A call through `options` would bind `this` to it, which a browser `fetch` refuses.
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs ?? Date.now,
    clockOffsetSeconds: 0,
  }
  const send = (
    method: RecoveryIndexMethod,
    body: Uint8Array,
    expectedVersion: number | null,
    extraHeaders: Record<string, string> = {},
  ) => sendSigned(context, method, body, expectedVersion, extraHeaders)

  return {
    async read(readOptions = {}) {
      const known = readOptions.knownVersion
      if (known !== undefined) requireVersion(known, 1)
      const response = await send(
        'GET',
        new Uint8Array(),
        null,
        known === undefined ? {} : { 'If-None-Match': `"${known}"` },
      )
      switch (response.status) {
        case 200: {
          const version = requireResponseVersion(response.headers.get(VERSION_HEADER), 1)
          const document = await readDocument(response)
          return { status: 'found', version, document }
        }
        case 304:
          return {
            status: 'not-modified',
            version: requireResponseVersion(response.headers.get(VERSION_HEADER), 1),
          }
        case 404:
          return { status: 'absent', version: await currentVersion(response) }
        default:
          throw await failure(response)
      }
    },
    async write(document, expectedVersion) {
      if (!(document instanceof Uint8Array) || !isRecoveryIndexDocumentSize(document.length)) {
        throw new Error('recovery index document size is not permitted')
      }
      requireVersion(expectedVersion, 0)
      const response = await send('PUT', document, expectedVersion)
      switch (response.status) {
        case 200:
          return { status: 'written', version: await acceptedVersion(response) }
        case 409:
          return { status: 'conflict', currentVersion: await currentVersion(response) }
        default:
          throw await failure(response)
      }
    },
    async remove(expectedVersion) {
      requireVersion(expectedVersion, 0)
      const response = await send('DELETE', new Uint8Array(), expectedVersion)
      switch (response.status) {
        case 200:
          return { status: 'deleted', version: await acceptedVersion(response) }
        case 404:
          return { status: 'absent', version: await currentVersion(response) }
        case 409:
          return { status: 'conflict', currentVersion: await currentVersion(response) }
        default:
          throw await failure(response)
      }
    },
  }
}

interface SendContext {
  readonly url: URL
  readonly realm: RecoveryIndexRealm
  readonly keys: RecoveryIndexKeys
  readonly fetchImpl: typeof fetch
  readonly nowMs: () => number
  /** The engine time minus the local time, learned from one issue-time refusal. */
  clockOffsetSeconds: number
}

/**
 * Sign and send one request. After an issue-time refusal, correct the clock
 * offset from the engine time and send once more.
 */
async function sendSigned(
  context: SendContext,
  method: RecoveryIndexMethod,
  body: Uint8Array,
  expectedVersion: number | null,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const fetchImpl = context.fetchImpl
  for (let attempt = 0; ; attempt += 1) {
    const issuedAt = Math.floor(context.nowMs() / 1000) + context.clockOffsetSeconds
    const signed = signRecoveryIndexRequest({
      locatorSecretKey: context.keys.locatorSecretKey,
      realm: context.realm,
      method,
      body,
      expectedVersion: expectedVersion ?? 0,
      issuedAt,
    })
    let response: Response
    try {
      response = await fetchImpl(context.url, {
        method,
        redirect: 'error',
        headers: {
          [KEY_HEADER]: signed.requestPublicKey,
          [ISSUED_AT_HEADER]: String(issuedAt),
          [SIGNATURE_HEADER]: signed.signature,
          ...(expectedVersion === null
            ? {}
            : { [EXPECTED_VERSION_HEADER]: String(expectedVersion) }),
          ...(method === 'PUT' ? { 'Content-Type': 'application/octet-stream' } : {}),
          ...extraHeaders,
        },
        // A copy is backed by an ArrayBuffer, which a fetch body requires.
        ...(method === 'PUT' ? { body: new Uint8Array(body) } : {}),
      })
    } catch {
      throw new RecoveryIndexEngineError('network')
    }
    if (response.status !== 401) return response
    const problem = await readProblem(response)
    if (problem.code !== STALE_REQUEST_CODE) throw new RecoveryIndexEngineError('unauthenticated')
    if (attempt > 0 || problem.serverTime === null) throw new RecoveryIndexEngineError('clock')
    context.clockOffsetSeconds = problem.serverTime - Math.floor(context.nowMs() / 1000)
  }
}

async function readDocument(response: Response): Promise<Uint8Array> {
  let document: Uint8Array
  try {
    document = await readAllocationBoundedBytesResponse(response, RECOVERY_INDEX_DOCUMENT_BYTES_MAX)
  } catch {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  if (!isRecoveryIndexDocumentSize(document.length)) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  return document
}

/** The version of a 200 write or delete: the JSON body, which the header repeats. */
async function acceptedVersion(response: Response): Promise<number> {
  const body = await readJson(response)
  const version = body.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  const header = response.headers.get(VERSION_HEADER)
  if (header !== null && requireResponseVersion(header, 1) !== version) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  return version
}

/** The current version of a 404 or a 409: the header, or else `currentVersion` of the body. */
async function currentVersion(response: Response): Promise<number> {
  const header = response.headers.get(VERSION_HEADER)
  const problem = await readProblem(response)
  if (header !== null) return requireResponseVersion(header, 0)
  if (problem.currentVersion === null) throw new RecoveryIndexEngineError('invalid-response')
  return problem.currentVersion
}

async function failure(response: Response): Promise<RecoveryIndexEngineError> {
  const status = response.status
  if (status === 429) {
    const problem = await readProblem(response)
    return new RecoveryIndexEngineError('limited', {
      retryAfterMs: retryAfterMs(response.headers.get('Retry-After')),
      limitCode: problem.limitCode,
    })
  }
  await response.body?.cancel().catch(() => {})
  if (status >= 500) return new RecoveryIndexEngineError('unavailable')
  if (status === 400 || status === 408 || status === 411 || status === 413) {
    return new RecoveryIndexEngineError('refused')
  }
  return new RecoveryIndexEngineError('invalid-response')
}

interface Problem {
  readonly code: string | null
  readonly limitCode: string | null
  readonly currentVersion: number | null
  readonly serverTime: number | null
}

/** Read bounded problem details. A body that is not one gives empty fields. */
async function readProblem(response: Response): Promise<Problem> {
  let body: Record<string, unknown> = {}
  try {
    body = await readJson(response, PROBLEM_RESPONSE_BYTES_MAX)
  } catch {
    // The status and the headers still classify the response.
  }
  const text = (value: unknown) =>
    typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) ? value : null
  const integer = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  return {
    code: text(body.code),
    limitCode: text(body.limitCode),
    currentVersion: integer(body.currentVersion),
    serverTime: integer(body.serverTime),
  }
}

async function readJson(
  response: Response,
  maximumBytes = PROBLEM_RESPONSE_BYTES_MAX,
): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await readAllocationBoundedJsonResponse(response, maximumBytes)
  } catch {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  return body as Record<string, unknown>
}

function requireResponseVersion(value: string | null, minimum: number): number {
  if (value === null || !CANONICAL_VERSION.test(value)) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < minimum) {
    throw new RecoveryIndexEngineError('invalid-response')
  }
  return version
}

function retryAfterMs(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,6}$/.test(value)) return null
  return Number(value) * 1000
}

function requireVersion(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error('recovery index version is invalid')
  }
}

function prefixed(value: Uint8Array): Uint8Array {
  if (value.length > 255) throw new Error('recovery index request field is too long')
  return concatBytes(Uint8Array.of(value.length), value)
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}
