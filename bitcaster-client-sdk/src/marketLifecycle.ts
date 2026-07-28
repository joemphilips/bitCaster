import type {
  BitcasterEngineClient,
  EngineAuthorizationRequest,
  EngineFetch,
} from './engineClient.ts'
import type { MarketBaseAsset } from './marketUnits.ts'

export interface CreateMarketOutcome {
  name: string
  probability: number
}

export interface CreateMarketRequest {
  title: string
  description: string
  outcomes: CreateMarketOutcome[]
  outcomeType?: 'yesno' | 'categorical' | 'numeric'
  liquiditySats?: number
  baseAsset: MarketBaseAsset
  categoryTags?: string[]
  oracleAnnouncementHex?: string | null
}

export interface CreateMarketResponse {
  conditionId: string
  marketsCreated: string[]
  thumbnailUrl?: string | null
  divisibility: number
}

export interface OracleNostrEvent {
  id: string
  pubkey: string
  createdAt: number
  kind: 89
  tags: string[][]
  content: string
  sig: string
}

export function isKind89NostrEvent(value: unknown): value is OracleNostrEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.sig === 'string' &&
    event.kind === 89 &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'),
    ) &&
    typeof event.content === 'string' &&
    typeof event.createdAt === 'number'
  )
}

export type OracleAttestationResult =
  | 'Closed'
  | 'AlreadyClosed'
  | 'DuplicateReplay'
  | 'WrongKind'
  | 'InvalidSignature'
  | 'InvalidPayload'
  | 'NoMatchingMarket'

export interface OracleAttestationResponse {
  result: OracleAttestationResult
}

export interface MarketThumbnailBytes {
  data: ArrayBuffer | ArrayBufferView
  filename: string
  contentType?: string
}

interface EngineClientInternals {
  baseUrl: string
  fetchImpl: EngineFetch
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>
}

export async function createMarketViaEngine(
  client: BitcasterEngineClient,
  conditionId: string,
  metadata: CreateMarketRequest,
  thumbnailBytes?: MarketThumbnailBytes,
): Promise<CreateMarketResponse> {
  const { baseUrl, fetchImpl, authorization } = getEngineClientInternals(client)
  const url = `${baseUrl}/api/v1/markets/${encodeURIComponent(conditionId)}`
  const formData = new FormData()
  formData.append('metadata', JSON.stringify(metadata))
  if (thumbnailBytes) {
    formData.append(
      'thumbnail',
      new Blob([toArrayBuffer(thumbnailBytes.data)], {
        type: thumbnailBytes.contentType,
      }),
      thumbnailBytes.filename,
    )
  }

  // Multipart bodies need pre-serialization so the NIP-98 `payload` tag binds
  // to the exact bytes (including the random multipart boundary) that fetch
  // will ship. Construct a transient Request to serialize, hash, then send the
  // same bytes with the same Content-Type so server-side SHA-256 matches.
  const serialized = new Request(url, { method: 'POST', body: formData })
  const bodyBytes = await serialized.arrayBuffer()
  const contentType = serialized.headers.get('Content-Type') ?? 'multipart/form-data'
  const payloadHash = await sha256Hex(bodyBytes)
  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (authorization) {
    headers.Authorization = await authorization({
      url,
      method: 'POST',
      payloadHash,
    })
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: bodyBytes,
  })
  if (!response.ok) {
    throw new Error(`[Matching Engine] Failed to create market: ${await readErrorDetail(response)}`)
  }
  return (await response.json()) as CreateMarketResponse
}

export async function submitOracleAttestationViaEngine(
  client: BitcasterEngineClient,
  conditionId: string,
  event: OracleNostrEvent,
): Promise<OracleAttestationResponse> {
  const { baseUrl, fetchImpl } = getEngineClientInternals(client)
  const url = `${baseUrl}/api/v1/markets/${encodeURIComponent(conditionId)}/oracle-attestation`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  const body = (await response.json().catch(() => null)) as OracleAttestationResponse | null
  if (!response.ok) {
    throw new Error(
      body?.result
        ? `Oracle attestation rejected: ${body.result}`
        : `Oracle attestation rejected: HTTP ${response.status}`,
    )
  }
  if (!body) throw new Error('Oracle attestation response was empty')
  return body
}

function getEngineClientInternals(client: BitcasterEngineClient): EngineClientInternals {
  return client as unknown as EngineClientInternals
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readErrorDetail(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`
  try {
    const body = await response.json()
    const candidate = readProblemDetail(body)
    detail =
      typeof candidate === 'string' ? candidate.slice(0, 500) : String(candidate).slice(0, 500)
  } catch {
    detail = response.statusText || detail
  }
  return detail
}

function readProblemDetail(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body
  const problem = body as {
    detail?: unknown
    title?: unknown
    message?: unknown
  }
  return problem.detail ?? problem.title ?? problem.message ?? JSON.stringify(body)
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  const copy = new Uint8Array(data.byteLength)
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return copy.buffer
}
