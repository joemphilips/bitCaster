import type { Market, FilterState } from '@/types/market'
import type {
  MarketDetail,
  OrderBook,
  Order,
} from '@/types/market-detail'
import { getNdk } from '@/lib/nostr'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { bytesToHex } from 'nostr-tools/utils'

// CDK mint response types

export interface PartitionInfoEntry {
  partition: string[]
  collateral: string
  parent_collection_id: string
  keysets: Record<string, string>
}

export interface AttestationState {
  status: 'pending' | 'attested' | 'expired' | 'violation'
  winning_outcome: string | null
  attested_at: number | null
}

export interface ConditionInfo {
  condition_id: string
  tags?: string[][]              // NIP-88 tag array (new spec)
  description?: string           // Legacy field (pre-tags CDK)
  threshold: number
  announcements: string[]
  partitions: PartitionInfoEntry[]
  attestation: AttestationState
  condition_type?: string // "enum" (default, omitted) or "numeric"
}

export function getTagValue(tags: string[][], key: string): string | undefined {
  const tag = tags.find((t) => t.length >= 2 && t[0] === key)
  return tag?.[1]
}

export function getTagValues(tags: string[][], key: string): string[] {
  const tag = tags.find((t) => t.length >= 2 && t[0] === key)
  return tag ? tag.slice(1) : []
}

const KNOWN_TAG_KEYS = new Set(['description', 'n'])

export function extractCategoryTagIds(tags: string[][]): string[] {
  return tags
    .filter((t) => t.length >= 2 && !KNOWN_TAG_KEYS.has(t[0]))
    .map((t) => t[1])
}

interface ConditionsResponse {
  conditions: ConditionInfo[]
}

export async function fetchConditions(): Promise<ConditionInfo[]> {
  const response = await fetch('/v1/conditions')
  if (!response.ok) {
    throw new Error(`Failed to fetch conditions: ${response.status}`)
  }
  const data: ConditionsResponse = await response.json()
  return data.conditions
}

export function mapConditionToMarket(c: ConditionInfo): Market {
  // Determine market type from partition structure
  const firstPartition = c.partitions[0]
  const outcomes = firstPartition?.partition ?? []

  const isYesNo =
    outcomes.length === 2 &&
    outcomes[0].toLowerCase() === 'yes' &&
    outcomes[1].toLowerCase() === 'no'

  const now = new Date().toISOString()
  const tags = c.tags ?? []
  const title = getTagValue(tags, 'description') ?? c.description ?? 'Untitled Market'
  const categoryTags = extractCategoryTagIds(tags)
  const metaTags = getTagValues(tags, 'n')

  if (isYesNo) {
    return {
      id: c.condition_id,
      title,
      type: 'yesno',
      imageUrl: '',
      categoryTags,
      metaTags,
      currentOdds: { yes: 50, no: 50 },
      volume: 0,
      liquidity: 0,
      traderCount: 0,
      closingDate: now,
      createdDate: now,
      activeSince: now,
      creatorFeePercent: 0,
      baseMarket: 'sats',
    }
  }

  return {
    id: c.condition_id,
    title,
    type: 'categorical',
    imageUrl: '',
    categoryTags,
    metaTags,
    outcomes: outcomes.map((label, i) => ({
      id: `outcome-${i}`,
      label,
      odds: 100 / outcomes.length,
    })),
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    creatorFeePercent: 0,
    baseMarket: 'sats',
  }
}

export async function fetchMarketMetadata(marketId: string): Promise<MarketMetadataSnapshot | null> {
  try {
    const response = await fetch(`/api/v1/${marketId}/metadata`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function applyMetadata<T extends { volume: number; liquidity: number; traderCount: number }>(
  base: T,
  meta: MarketMetadataSnapshot,
): T {
  return {
    ...base,
    volume: meta.totalVolumeSats,
    liquidity: meta.totalLiquiditySats,
    traderCount: meta.uniqueTraderCount,
  }
}

export async function fetchMarkets(): Promise<Market[]> {
  const conditions = await fetchConditions()
  const markets = conditions
    .filter((c) => c.attestation.status === 'pending')
    .map(mapConditionToMarket)

  const enriched = await Promise.all(
    markets.map(async (m) => {
      const [meta, thumbnailUrl] = await Promise.all([
        fetchMarketMetadata(m.id),
        fetchThumbnailUrl(m.id),
      ])
      let result = meta ? applyMetadata(m, meta) : m
      if (thumbnailUrl) result = { ...result, imageUrl: thumbnailUrl }
      return result
    })
  )
  return enriched
}

export function filterMarkets(markets: Market[], filter: FilterState): Market[] {
  let result = markets

  if (filter.searchQuery) {
    const query = filter.searchQuery.toLowerCase()
    result = result.filter((m) => m.title.toLowerCase().includes(query))
  }

  if (filter.selectedTag) {
    const tagId = filter.selectedTag
    result = result.filter(
      (m) => m.metaTags.includes(tagId) || m.categoryTags.includes(tagId)
    )
  }

  if (filter.marketTypes.length > 0) {
    result = result.filter((m) => filter.marketTypes.includes(m.type))
  }

  if (filter.volumeRange.min !== undefined) {
    const min = filter.volumeRange.min
    result = result.filter((m) => m.volume >= min)
  }

  if (filter.volumeRange.max !== undefined) {
    const max = filter.volumeRange.max
    result = result.filter((m) => m.volume <= max)
  }

  if (filter.closingInDays !== undefined) {
    const days = filter.closingInDays
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + days)
    result = result.filter((m) => new Date(m.closingDate) <= cutoff)
  }

  return result
}

// Types from generated OpenAPI spec

import type { components } from '@/generated/api'

export type SubmitOrderRequest = components['schemas']['SubmitOrderRequest']
export type SubmitOrderResponse = components['schemas']['SubmitOrderResponse']
export type OrderBookSnapshot = components['schemas']['OrderBookSnapshot']
export type LevelDto = components['schemas']['LevelDto']
export type Fill = components['schemas']['Fill']
export type MarketMetadataSnapshot = components['schemas']['MarketMetadataSnapshot']
export type CreateMarketRequest = components['schemas']['CreateMarketRequest']
export type CreateMarketResponse = components['schemas']['CreateMarketResponse']
export type CreatorMarketEntry = components['schemas']['CreatorMarketEntry']
export type CreatorMarketsResponse = components['schemas']['CreatorMarketsResponse']

// =============================================================================
// Market Detail Data Fetching
// =============================================================================

function mapConditionToMarketDetail(c: ConditionInfo): MarketDetail {
  const firstPartition = c.partitions[0]
  const outcomes = firstPartition?.partition ?? []
  const now = new Date().toISOString()

  const isYesNo =
    outcomes.length === 2 &&
    outcomes[0].toLowerCase() === 'yes' &&
    outcomes[1].toLowerCase() === 'no'

  const isResolved = c.attestation.status === 'attested'
  const tags = c.tags ?? []
  const title = getTagValue(tags, 'description') ?? c.description ?? 'Untitled Market'

  const base = {
    id: c.condition_id,
    title,
    imageUrl: undefined,
    categoryTags: extractCategoryTagIds(tags).map((id) => ({
      id,
      label: id,
      marketCount: 0,
    })),
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    baseUnit: 'sats',
    creator: {
      id: 'unknown',
      name: 'Unknown',
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: title,
      source: 'oracle' as const,
      resolutionDate: now,
      status: isResolved ? 'resolved' as const : 'open' as const,
      finalOutcome: c.attestation.winning_outcome ?? undefined,
    },
    priceHistory: { data: [], timeframe: '7d' as const },
    orderBook: { bids: [], asks: [], spread: 0 },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
  }

  if (isYesNo) {
    return {
      ...base,
      type: 'yesno',
      currentOdds: { yes: 50, no: 50 },
    }
  }

  return {
    ...base,
    type: 'categorical',
    outcomes: outcomes.map((label, i) => ({
      id: `outcome-${i}`,
      label,
      odds: 100 / outcomes.length,
    })),
    outcomePriceHistories: {},
    outcomeOrderBooks: {},
  }
}

export async function fetchMarketDetail(conditionId: string): Promise<MarketDetail> {
  const conditions = await fetchConditions()
  const condition = conditions.find((c) => c.condition_id === conditionId)
  if (!condition) {
    throw new Error(`Condition not found: ${conditionId}`)
  }
  const detail = mapConditionToMarketDetail(condition)
  const meta = await fetchMarketMetadata(conditionId)
  return meta ? applyMetadata(detail, meta) : detail
}

export function mapSnapshotToOrderBook(snapshot: OrderBookSnapshot): OrderBook {
  let cumulativeBid = 0
  const bids: Order[] = snapshot.bids.map((level) => {
    cumulativeBid += level.amount
    return { price: level.price, amount: level.amount, total: cumulativeBid }
  })

  let cumulativeAsk = 0
  const asks: Order[] = snapshot.asks.map((level) => {
    cumulativeAsk += level.amount
    return { price: level.price, amount: level.amount, total: cumulativeAsk }
  })

  return {
    bids,
    asks,
    spread: snapshot.spread ?? 0,
  }
}

export async function fetchOrderBook(marketId: string): Promise<OrderBook> {
  const response = await fetch(`/api/v1/${marketId}/orderbook`)
  if (!response.ok) {
    throw new Error(`Failed to fetch order book: ${response.status}`)
  }
  const snapshot: OrderBookSnapshot = await response.json()
  return mapSnapshotToOrderBook(snapshot)
}

export async function submitOrder(marketId: string, params: SubmitOrderRequest): Promise<SubmitOrderResponse> {
  const url = `${window.location.origin}/api/v1/${marketId}/orders`
  // Bind the NIP-98 token to the exact body bytes the server will hash.
  const bodyText = JSON.stringify(params)
  const bodyBytes = new TextEncoder().encode(bodyText)
  const payloadHash = await sha256Hex(bodyBytes)
  const authHeader = await generateNip98Header(url, 'POST', payloadHash)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: bodyText,
  })
  if (!response.ok) {
    throw new Error(`Failed to submit order: ${response.status}`)
  }
  return response.json()
}

// =============================================================================
// Market Creation API
// =============================================================================

export class MintError extends Error {
  constructor(public readonly code: number, public readonly detail: string) {
    super(`[Mint] ${detail}`)
    this.name = 'MintError'
  }
}

/** Parse a non-OK mint response into a MintError with the CDK error code. */
async function parseMintError(response: Response, fallbackPrefix: string): Promise<MintError> {
  let code = 0
  let detail = `${fallbackPrefix}: ${response.status}`
  try {
    const text = await response.text()
    try {
      const body = JSON.parse(text)
      code = typeof body.code === 'number' ? body.code : 0
      detail = body.detail ?? body.message ?? text
    } catch {
      detail = text
    }
  } catch { /* empty */ }
  return new MintError(code, detail)
}

export async function registerCondition(params: {
  tags: string[][]
  announcementHex: string
}): Promise<{ condition_id: string }> {
  const response = await fetch('/v1/conditions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tags: params.tags,
      announcements: [params.announcementHex],
    }),
  })
  if (!response.ok) {
    throw await parseMintError(response, 'Failed to register condition')
  }
  return response.json()
}

export async function registerPartition(
  conditionId: string,
  partition: string[],
): Promise<{ keysets: Record<string, string> }> {
  const response = await fetch(`/v1/conditions/${conditionId}/partitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collateral: 'sat',
      partition,
      parent_collection_id: '0000000000000000000000000000000000000000000000000000000000000000',
    }),
  })
  if (!response.ok) {
    throw await parseMintError(response, 'Failed to register partition')
  }
  return response.json()
}

/**
 * Lowercase-hex SHA-256 of a byte buffer. Used to bind NIP-98 tokens to
 * the request body (`payload` tag); the matching engine rejects body-bearing
 * REST verbs whose token's `payload` does not match the digest of the bytes
 * the server actually receives.
 */
async function sha256Hex(data: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(hash))
}

/**
 * Generate a NIP-98 Authorization header using NDK's active signer.
 * Works with both NIP-07 (browser extension) and nsec (private key) signers.
 *
 * When `payloadHash` is supplied (lowercase-hex SHA-256 of the request body),
 * a `payload` tag is added per NIP-98. The matching engine REQUIRES this for
 * `POST`/`PUT`/`PATCH` — without it, the request is rejected as a replay
 * candidate. GET / DELETE / SignalR-negotiate calls omit the parameter.
 *
 * Exported so other modules (portfolio store, MarketHub helper, etc.) can
 * reuse a single implementation instead of each growing its own NDK wiring.
 */
export async function generateNip98Header(
  url: string,
  method: string,
  payloadHash?: string,
): Promise<string> {
  const ndk = getNdk()
  if (!ndk.signer) throw new Error('No Nostr signer configured — connect in Settings first')
  const event = new NDKEvent(ndk)
  event.kind = 27235
  event.created_at = Math.floor(Date.now() / 1000)
  event.content = ''
  event.tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ]
  if (payloadHash) {
    event.tags.push(['payload', payloadHash])
  }
  await event.sign()
  const token = btoa(JSON.stringify(event.rawEvent()))
  return `Nostr ${token}`
}

export async function createMarket(
  conditionId: string,
  params: CreateMarketRequest,
  thumbnailFile?: File | null,
): Promise<CreateMarketResponse> {
  const formData = new FormData()
  formData.append('metadata', JSON.stringify(params))
  if (thumbnailFile) {
    formData.append('thumbnail', thumbnailFile)
  }
  const url = `${window.location.origin}/api/v1/markets/${conditionId}`
  // Multipart bodies need pre-serialization so the NIP-98 `payload` tag binds
  // to the exact bytes (including the random multipart boundary) that fetch
  // will ship. Construct a transient Request to serialize, hash, then send
  // the same bytes with the same Content-Type so server-side SHA-256 matches.
  const serialized = new Request(url, { method: 'POST', body: formData })
  const bodyBytes = await serialized.arrayBuffer()
  const contentType = serialized.headers.get('Content-Type') ?? 'multipart/form-data'
  const payloadHash = await sha256Hex(bodyBytes)
  const authHeader = await generateNip98Header(url, 'POST', payloadHash)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Authorization: authHeader },
    body: bodyBytes,
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      const raw = body.detail ?? body.title ?? body.message ?? JSON.stringify(body)
      detail = typeof raw === 'string' ? raw.slice(0, 500) : String(raw).slice(0, 500)
    } catch {
      detail = response.statusText || detail
    }
    throw new Error(`[Matching Engine] Failed to create market: ${detail}`)
  }
  return response.json()
}

export async function fetchThumbnailUrl(conditionId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/${conditionId}/thumbnail`, { method: 'HEAD' })
    if (response.ok) return `/api/v1/${conditionId}/thumbnail`
    return null
  } catch {
    return null
  }
}

/**
 * Fetch the list of markets the matching engine has indexed under a given
 * creator pubkey. The engine returns volume/created-at for markets it knows
 * about; the client is responsible for merging this with its own store so
 * markets the backend hasn't indexed still show up as `0` volume.
 */
export async function fetchCreatorMarkets(
  pubkey: string,
): Promise<CreatorMarketsResponse> {
  const response = await fetch(`/api/v1/creators/${pubkey}/markets`)
  if (!response.ok) {
    throw new Error(`Failed to fetch creator markets: ${response.status}`)
  }
  return response.json()
}
