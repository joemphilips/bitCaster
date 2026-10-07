import type {
  BitcasterEngineClient,
  EngineAuthorizationRequest,
  EngineFetch,
} from './engineClient.ts'
import {
  parseMarketBaseAsset,
  parseMarketDivisibility,
  type MarketBaseAsset,
  type MarketDivisibility,
} from './marketUnits.ts'
import {
  MAX_MARKET_CREATION_REQUEST_BYTES,
  prepareMarketCreationRequest,
  type PreparedMarketCreationRequest,
} from './marketCreationRequest.ts'

export interface CreateMarketOutcome {
  name: string
  color?: string
}

export type MarketOutcomeDetails = CreateMarketOutcome

export interface CreateMarketRequest {
  title: string
  description: string
  outcomes: CreateMarketOutcome[]
  /**
   * Use `yesno` or `categorical`. The `numeric` wire value is retained for
   * compatibility, but numeric market creation and trading are unavailable.
   */
  outcomeType?: 'yesno' | 'categorical' | 'numeric'
  baseAsset: MarketBaseAsset
  categoryTags?: string[]
  oracleAnnouncementHex?: string | null
}

export interface CreateMarketResponse {
  conditionId: string
  marketsCreated: string[]
  baseAsset: MarketBaseAsset
  thumbnailUrl?: string | null
  divisibility: MarketDivisibility
  outcomeDetails?: MarketOutcomeDetails[]
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

/** A create request failed after dispatch or returned an unsuccessful HTTP status. */
export class CreateMarketError extends Error {
  readonly status: number | null
  readonly mayHaveCommitted: boolean

  constructor(message: string, status: number | null, mayHaveCommitted: boolean) {
    super(message)
    this.name = 'CreateMarketError'
    this.status = status
    this.mayHaveCommitted = mayHaveCommitted
  }
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
  return createPreparedMarketViaEngine(
    client,
    conditionId,
    await prepareMarketCreationRequest(metadata, thumbnailBytes),
  )
}

export async function createPreparedMarketViaEngine(
  client: BitcasterEngineClient,
  conditionId: string,
  prepared: PreparedMarketCreationRequest,
): Promise<CreateMarketResponse> {
  const { baseUrl, fetchImpl, authorization } = getEngineClientInternals(client)
  const url = `${baseUrl}/api/v1/markets/${encodeURIComponent(conditionId)}`
  if (prepared.bodyBytes.byteLength > MAX_MARKET_CREATION_REQUEST_BYTES)
    throw new Error('Market creation exceeds the 6 MiB request limit.')
  // Freeze the exact authorized delivery across an asynchronous signer call.
  const bodyBytes = prepared.bodyBytes.slice(0)
  const { contentType } = prepared
  const payloadHash = await sha256Hex(bodyBytes)
  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (authorization) {
    headers.Authorization = await authorization({
      url,
      method: 'POST',
      payloadHash,
    })
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: bodyBytes,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'request failed'
    throw new CreateMarketError(`[Matching Engine] Failed to create market: ${detail}`, null, true)
  }
  if (!response.ok) {
    let detail: string
    try {
      detail = await readErrorDetail(response)
    } catch {
      detail = response.statusText || `HTTP ${response.status}`
    }
    const mayHaveCommitted = response.status === 409 || response.status >= 500
    throw new CreateMarketError(
      `[Matching Engine] Failed to create market: ${detail}`,
      response.status,
      mayHaveCommitted,
    )
  }
  try {
    return parseCreateMarketResponse(await response.json())
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'response could not be read'
    throw new CreateMarketError(
      `[Matching Engine] Failed to read create-market response: ${detail}`,
      response.status,
      true,
    )
  }
}

export function parseCreateMarketResponse(value: unknown): CreateMarketResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('create-market response had an invalid shape')
  }
  const response = value as Record<string, unknown>
  const conditionId =
    typeof response.conditionId === 'string' && response.conditionId.length > 0
      ? response.conditionId
      : null
  const rawMarketsCreated = response.marketsCreated
  const rawMarketCount = Array.isArray(rawMarketsCreated) ? rawMarketsCreated.length : null
  const marketsCreated = Array.isArray(rawMarketsCreated)
    ? rawMarketsCreated.filter(
        (marketId): marketId is string => typeof marketId === 'string' && marketId.length > 0,
      )
    : null
  const baseAsset = parseMarketBaseAsset(response.baseAsset)
  const divisibility = parseMarketDivisibility(response.divisibility)
  if (
    !conditionId ||
    !marketsCreated ||
    marketsCreated.length !== rawMarketCount ||
    !baseAsset ||
    !divisibility
  ) {
    throw new Error('create-market response omitted canonical product metadata')
  }
  const thumbnailUrl =
    response.thumbnailUrl === null || typeof response.thumbnailUrl === 'string'
      ? response.thumbnailUrl
      : undefined
  if (response.thumbnailUrl !== undefined && thumbnailUrl === undefined) {
    throw new Error('create-market response had an invalid thumbnail URL')
  }
  const outcomeDetails = parseMarketOutcomeDetails(
    response.outcomeDetails,
    conditionId,
    marketsCreated,
  )
  return {
    conditionId,
    marketsCreated,
    baseAsset,
    divisibility,
    ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
    ...(outcomeDetails !== undefined ? { outcomeDetails } : {}),
  }
}

function parseMarketOutcomeDetails(
  value: unknown,
  conditionId: string,
  marketsCreated: string[],
): MarketOutcomeDetails[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length !== marketsCreated.length) {
    throw new Error('create-market response had invalid outcome details')
  }

  const expectedNames = new Set<string>()
  const marketPrefix = `${conditionId}-`
  for (const marketId of marketsCreated) {
    if (!marketId.startsWith(marketPrefix) || marketId.length === marketPrefix.length) {
      throw new Error('create-market response had invalid outcome details')
    }
    expectedNames.add(marketId.slice(marketPrefix.length))
  }
  if (expectedNames.size !== marketsCreated.length) {
    throw new Error('create-market response had invalid outcome details')
  }

  const names = new Set<string>()
  return value.map((item): MarketOutcomeDetails => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('create-market response had invalid outcome details')
    }
    const detail = item as Record<string, unknown>
    if (
      typeof detail.name !== 'string' ||
      detail.name.length === 0 ||
      names.has(detail.name) ||
      !expectedNames.has(detail.name)
    ) {
      throw new Error('create-market response had invalid outcome details')
    }
    names.add(detail.name)

    const color = detail.color
    if (
      color !== undefined &&
      color !== null &&
      (typeof color !== 'string' || !/^#[0-9A-F]{6}$/.test(color))
    ) {
      throw new Error('create-market response had invalid outcome details')
    }
    return { name: detail.name, ...(typeof color === 'string' ? { color } : {}) }
  })
}

export function recoverCreatedMarketResponse(
  value: unknown,
  expected: {
    conditionId: string
    creatorPubkey: string
    outcomes: readonly string[]
    baseAsset: MarketBaseAsset
    divisibility: number
  },
): CreateMarketResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (
    entry.conditionId !== expected.conditionId ||
    entry.creatorPubkey !== expected.creatorPubkey ||
    entry.baseAsset !== expected.baseAsset ||
    entry.divisibility !== expected.divisibility ||
    !Array.isArray(entry.outcomes) ||
    expected.outcomes.length < 2
  )
    return null
  const actual = new Set(entry.outcomes)
  const required = new Set(expected.outcomes)
  if (
    actual.size !== entry.outcomes.length ||
    required.size !== expected.outcomes.length ||
    actual.size !== required.size ||
    !expected.outcomes.every((outcome) => actual.has(outcome))
  )
    return null
  return parseCreateMarketResponse({
    conditionId: entry.conditionId,
    marketsCreated: entry.outcomes.map((outcome) => `${entry.conditionId}-${outcome}`),
    baseAsset: entry.baseAsset,
    divisibility: entry.divisibility,
    thumbnailUrl: entry.thumbnailUrl ?? null,
    ...(entry.outcomeDetails === undefined ? {} : { outcomeDetails: entry.outcomeDetails }),
  })
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
