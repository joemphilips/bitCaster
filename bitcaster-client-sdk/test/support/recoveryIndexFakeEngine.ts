import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/**
 * An in-memory stand-in for the engine recovery index routes (ADR-034
 * recovery index amendment). It checks the request signature with its own
 * digest code and applies the compare-and-swap, exact-retry, and tombstone
 * rules. Unit tests use it in place of the network.
 */

const PATH = '/api/v1/recovery-index'
const TAG = 'bitcaster/recovery-index/request/v1'

export interface FakeEngineRow {
  version: number
  document: Uint8Array | null
}

export interface FakeEngineRequest {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export class RecoveryIndexFakeEngine {
  readonly rows = new Map<string, FakeEngineRow>()
  readonly requests: FakeEngineRequest[] = []
  /** Responses that replace the next requests, in order, before the routes run. */
  readonly interruptions: Array<() => Response | Promise<Response>> = []
  /** Runs before each request reaches the routes, for example a write of another client. */
  onRequest: ((request: FakeEngineRequest) => void) | null = null
  nowSeconds = 1_800_000_000

  readonly realm: string
  readonly baseUrl: string

  constructor(realm: string, baseUrl = 'https://engine.example.com') {
    this.realm = realm
    this.baseUrl = baseUrl
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    if (url.origin !== new URL(this.baseUrl).origin || url.pathname !== PATH || url.search !== '') {
      return new Response(null, { status: 404 })
    }
    if (init.redirect !== 'error') throw new Error('recovery index requests must refuse redirects')
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body =
      init.body === undefined || init.body === null
        ? new Uint8Array()
        : new Uint8Array(init.body as Uint8Array)
    const method = init.method ?? 'GET'
    this.requests.push({ method, headers, body })
    this.onRequest?.({ method, headers, body })
    const interruption = this.interruptions.shift()
    if (interruption !== undefined) return interruption()
    return this.route(method, headers, body)
  }

  /** Requests of one method, for assertions. */
  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length
  }

  private route(method: string, headers: Record<string, string>, body: Uint8Array): Response {
    const key = headers['x-recovery-index-key']
    const issuedAt = headers['x-recovery-index-issued-at']
    const signature = headers['x-recovery-index-signature']
    const expectedText = headers['x-recovery-index-expected-version']
    if (
      key === undefined ||
      !/^[0-9a-f]{64}$/.test(key) ||
      issuedAt === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(issuedAt) ||
      signature === undefined ||
      !/^[0-9a-f]{128}$/.test(signature) ||
      (method === 'GET') !== (expectedText === undefined)
    ) {
      return problem(400, 'recovery-index-invalid-request')
    }
    if (method === 'GET' && body.length > 0) return problem(400, 'recovery-index-invalid-request')
    const expected = expectedText === undefined ? 0 : Number(expectedText)
    if (Math.abs(this.nowSeconds - Number(issuedAt)) > 60) {
      return problem(401, 'recovery-index-stale-request', { serverTime: this.nowSeconds })
    }
    const digest = this.digest(method, key, body, expected, Number(issuedAt))
    if (!schnorr.verify(hexToBytes(signature), digest, hexToBytes(key))) {
      return problem(401, 'recovery-index-unauthenticated')
    }
    const row = this.rows.get(key)
    switch (method) {
      case 'GET':
        return this.read(row, headers['if-none-match'])
      case 'PUT':
        return this.write(key, row, body, expected)
      case 'DELETE':
        return this.remove(row, expected)
      default:
        return new Response(null, { status: 405 })
    }
  }

  private read(row: FakeEngineRow | undefined, ifNoneMatch: string | undefined): Response {
    if (row?.document == null) {
      return problem(404, 'recovery-index-not-found', { currentVersion: row?.version ?? 0 })
    }
    const headers = {
      'X-Recovery-Index-Version': String(row.version),
      ETag: `"${row.version}"`,
      'Cache-Control': 'no-store',
    }
    if (ifNoneMatch === `"${row.version}"`) return new Response(null, { status: 304, headers })
    return new Response(row.document.slice(), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    })
  }

  private write(
    key: string,
    row: FakeEngineRow | undefined,
    body: Uint8Array,
    expected: number,
  ): Response {
    if (!isDocumentSize(body.length)) return problem(400, 'recovery-index-invalid-request')
    const current = row?.version ?? 0
    if (current === expected) {
      this.rows.set(key, { version: current + 1, document: body.slice() })
      return accepted(current + 1)
    }
    if (current === expected + 1 && row?.document != null && equal(row.document, body)) {
      return accepted(current)
    }
    return problem(409, 'recovery-index-version-conflict', { currentVersion: current })
  }

  private remove(row: FakeEngineRow | undefined, expected: number): Response {
    if (row?.document == null) {
      return problem(404, 'recovery-index-not-found', { currentVersion: row?.version ?? 0 })
    }
    if (row.version !== expected) {
      return problem(409, 'recovery-index-version-conflict', { currentVersion: row.version })
    }
    row.version += 1
    row.document = null
    return accepted(row.version)
  }

  private digest(
    method: string,
    key: string,
    body: Uint8Array,
    expected: number,
    issuedAt: number,
  ): Uint8Array {
    const prefixed = (text: string) => {
      const bytes = utf8ToBytes(text)
      return concatBytes(Uint8Array.of(bytes.length), bytes)
    }
    const u64 = (value: number) => {
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
      return bytes
    }
    const tag = sha256(utf8ToBytes(TAG))
    return sha256(
      concatBytes(
        tag,
        tag,
        prefixed(this.realm),
        prefixed(method),
        prefixed(PATH),
        hexToBytes(key),
        sha256(body),
        u64(expected),
        u64(issuedAt),
      ),
    )
  }
}

export function problem(
  status: number,
  code: string,
  extensions: Record<string, number | string> = {},
  headers: Record<string, string> = {},
): Response {
  const version = extensions.currentVersion
  return new Response(JSON.stringify({ status, code, ...extensions }), {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      ...(version === undefined ? {} : { 'X-Recovery-Index-Version': String(version) }),
      ...headers,
    },
  })
}

function accepted(version: number): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Recovery-Index-Version': String(version) },
  })
}

function isDocumentSize(length: number): boolean {
  for (let k = 12; k <= 16; k += 1) if (length === 2 ** k + 37) return true
  return false
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && bytesToHex(left) === bytesToHex(right)
}
