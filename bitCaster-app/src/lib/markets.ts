import type { Market, FilterState } from '@/types/market'
import type {
  MarketDetail,
  OrderBook,
  Order,
} from '@/types/market-detail'
import type { MarketSort } from '@/hooks/useMarketSort'
import type { components } from '@/generated/api'
import { getNdk } from '@/lib/nostr'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { bytesToHex } from 'nostr-tools/utils'
import { isAttestationResolved, normalizeMintdStatus } from './mintdIngress'

// Types from generated OpenAPI spec

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

/**
 * Fetch the full mintd condition catalogue. Per ADR-009 only the
 * market-detail page (`/markets/{conditionId}`) consumes this directly —
 * it MUST reach mintd to verify a market exists before the user can place
 * deposits or orders. The markets-list page goes through the engine's
 * `/api/v1/markets/query` proxy (`getMarkets()` below).
 */
export async function fetchConditions(): Promise<ConditionInfo[]> {
  const response = await fetch('/v1/conditions')
  if (!response.ok) {
    throw new Error(`Failed to fetch conditions: ${response.status}`)
  }
  const data: ConditionsResponse = await response.json()
  return data.conditions
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

// =============================================================================
// Engine markets-query proxy (ADR-009)
// =============================================================================

const SORT_TO_QUERY: Record<MarketSort, 'Trending' | 'Popular' | 'New'> = {
  trending: 'Trending',
  popular: 'Popular',
  new: 'New',
}

export interface GetMarketsParams {
  /** Sort dimension. Defaults to engine default (`Trending`) when omitted. */
  sort?: MarketSort
  /** Repeatable category-tag filter. OR semantics across the supplied tags. */
  tags?: string[]
  /** Bulk-fetch by conditionId (cap 100). Pagination still applies. */
  ids?: string[]
  /** State filter — defaults to `Open`. */
  state?: 'Open' | 'Closed' | 'All'
  /** Opaque HMAC-signed cursor returned in the previous response. */
  cursor?: string
  /** Page size (default 20, max 50). */
  pageSize?: number
}

export interface GetMarketsResult {
  /** Page of markets ordered by the active sort dimension. */
  markets: Market[]
  /** Cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null
  /** Mintd-mirror staleness timestamp (ISO-8601). */
  lastSuccessfulRefreshAt: string
}

export type MarketCatalogueEntry = components['schemas']['MarketCatalogueEntry']
export type MarketCatalogueResponse = components['schemas']['MarketCatalogueResponse']

function buildMarketsQueryString(params: GetMarketsParams): string {
  const search = new URLSearchParams()
  if (params.sort) search.set('sort', SORT_TO_QUERY[params.sort])
  if (params.state) search.set('state', params.state)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.pageSize) search.set('page_size', String(params.pageSize))
  for (const t of params.tags ?? []) search.append('tag', t)
  // ?ids= is comma-separated per the OpenAPI spec, not repeated.
  if (params.ids && params.ids.length > 0) search.set('ids', params.ids.join(','))
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Convert one engine catalogue entry into the frontend `Market` shape used
 * by the markets-list view. The engine projection already carries the merged
 * mintd snapshot (outcomes, deadline) plus engine-derived fields (volume,
 * createdAt, last-traded price, state); the mapper just shapes them into the
 * existing `Market` union without re-fetching mintd.
 */
export function mapCatalogueEntryToMarket(entry: MarketCatalogueEntry): Market {
  const outcomes = entry.outcomes ?? []
  const isYesNo =
    outcomes.length === 2 &&
    outcomes[0]?.toLowerCase() === 'yes' &&
    outcomes[1]?.toLowerCase() === 'no'

  const closingDate = entry.deadline ?? entry.createdAt
  const title = entry.title ?? 'Untitled Market'
  const imageUrl = entry.thumbnailUrl ?? ''

  const base = {
    id: entry.conditionId,
    title,
    imageUrl,
    categoryTags: entry.categoryTags ?? [],
    metaTags: [],
    // 24h drives the Trending sort; the wire format also exposes 30d but the
    // existing `Market` shape only carries one rolling-volume number. The
    // sort dimension itself is hoisted up to the engine, so all three
    // ordering dimensions are correct — `Market.volume` is now a UI display
    // hint, not a tie-breaker.
    volume: entry.volume24hSats ?? 0,
    liquidity: 0,
    traderCount: 0,
    closingDate,
    createdDate: entry.createdAt,
    activeSince: entry.createdAt,
    creatorFeePercent: 0,
    baseMarket: 'sats',
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
      odds: 100 / Math.max(outcomes.length, 1),
    })),
  }
}

/**
 * Fetch a page of markets from the engine's catalogue proxy
 * (`GET /api/v1/markets/query`). Mintd remains authoritative for outcomes /
 * deadline / creator pubkey; the engine layers its own projections on top
 * (state, volume, lastTradedPrice, createdAt). The frontend trust contract
 * (ADR-009) is: the markets-list page may rely on this response, but the
 * market-detail page MUST verify market existence directly against mintd.
 */
export async function getMarkets(params: GetMarketsParams = {}): Promise<GetMarketsResult> {
  const url = `/api/v1/markets/query${buildMarketsQueryString(params)}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Failed to query markets: ${response.status}`)
  }
  const body: MarketCatalogueResponse = await response.json()
  const markets = (body.markets ?? []).map(mapCatalogueEntryToMarket)
  return {
    markets,
    nextCursor: body.nextCursor ?? null,
    lastSuccessfulRefreshAt: body.lastSuccessfulRefreshAt,
  }
}

export function filterMarkets(markets: Market[], filter: FilterState): Market[] {
  let result = markets

  if (filter.searchQuery) {
    const query = filter.searchQuery.toLowerCase()
    result = result.filter((m) => m.title.toLowerCase().includes(query))
  }

  // Multi-tag OR semantics: a market matches if ANY of its meta/category
  // tags is in the selected set. Empty set means "no tag filter".
  if (filter.selectedTags.length > 0) {
    const wanted = new Set(filter.selectedTags)
    result = result.filter(
      (m) =>
        m.metaTags.some((id) => wanted.has(id)) ||
        m.categoryTags.some((id) => wanted.has(id)),
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

  // Mintd attestation is reduced to outcome metadata per ADR-009 Amendment
  // 2026-05-04. Lifecycle (Open / Closed) reads engine `state` and is merged
  // in by `fetchMarketDetail` after this mapper runs. Normalise the raw
  // mintd value once at the ingress boundary per `bitcaster-coding-guideline`
  // Rule 2; the resolution-info panel consumes the canonical union below.
  const attestationStatus = normalizeMintdStatus(c.attestation.status)
  const isResolved = isAttestationResolved(attestationStatus)
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

/**
 * Resolve the engine catalogue entry for a single `conditionId`. Used by the
 * detail page to read engine-authoritative fields (`state`, `thumbnailUrl`,
 * `volume24hSats`) that mintd does not carry. ADR-009 Amendment 2026-05-04
 * splits the trust contract: mintd is the existence + outcome-metadata
 * authority; the engine is the lifecycle + analytics + thumbnail authority.
 * Returns `null` when the engine has no record of the market or the request
 * fails — the detail page falls back to mintd-only data and renders the
 * safer "Open" pre-fetch view.
 */
async function fetchEngineCatalogueEntry(
  conditionId: string,
): Promise<MarketCatalogueEntry | null> {
  try {
    const url = `/api/v1/markets/query?ids=${encodeURIComponent(conditionId)}&state=All`
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const body: MarketCatalogueResponse = await response.json()
    return body.markets.find((m) => m.conditionId === conditionId) ?? null
  } catch {
    return null
  }
}

/**
 * Merge engine catalogue fields into a mintd-derived `MarketDetail`. Engine
 * is authoritative for lifecycle (`state`), analytics (volume), and thumbnail.
 * Mintd-derived fields (title, outcomes, resolution metadata) survive
 * untouched. Idempotent; safe to call when the engine entry is `null`
 * (returns the detail unchanged so the caller need not branch).
 */
function mergeEngineCatalogueEntry(
  detail: MarketDetail,
  engineEntry: MarketCatalogueEntry | null,
): MarketDetail {
  if (!engineEntry) return detail
  return {
    ...detail,
    state: engineEntry.state,
    imageUrl: engineEntry.thumbnailUrl ?? detail.imageUrl,
    volume: engineEntry.volume24hSats ?? detail.volume,
  }
}

export async function fetchMarketDetail(conditionId: string): Promise<MarketDetail> {
  const conditions = await fetchConditions()
  const condition = conditions.find((c) => c.condition_id === conditionId)
  if (!condition) {
    throw new Error(`Condition not found: ${conditionId}`)
  }
  // Run the engine catalogue lookup in parallel with the metadata lookup —
  // the two are independent and both feed the rendered detail.
  const [engineEntry, meta] = await Promise.all([
    fetchEngineCatalogueEntry(conditionId),
    fetchMarketMetadata(conditionId),
  ])
  const detail = mapConditionToMarketDetail(condition)
  const withEngine = mergeEngineCatalogueEntry(detail, engineEntry)
  return meta ? applyMetadata(withEngine, meta) : withEngine
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
 * Resolve a market's thumbnail URL for rendering. Returns the canonical
 * matching-engine thumbnail URL when the engine reports a stored image,
 * the explicit URL the caller has already resolved, or `null` when no
 * thumbnail is available — the caller renders a placeholder asset instead
 * of letting `<div style="background-image: url()">` produce a broken
 * empty-string URL request (the P6 P4.3 regression).
 */
export function getMarketThumbnail(market: { id: string; imageUrl?: string | null }): string | null {
  const explicit = market.imageUrl
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit
  return null
}

// =============================================================================
// CPMM Bot Deposit API (matching engine MarketFunding aggregate)
// =============================================================================

export type RequestLnInvoiceDepositRequest = components['schemas']['RequestLnInvoiceDepositRequest']
export type RequestLnInvoiceDepositResponse = components['schemas']['RequestLnInvoiceDepositResponse']
export type RequestEcashDepositRequest = components['schemas']['RequestEcashDepositRequest']
export type RequestEcashDepositResponse = components['schemas']['RequestEcashDepositResponse']
export type GetDepositResponseDto = components['schemas']['GetDepositResponseDto']
export type DepositState = components['schemas']['DepositState']
export type DepositMethod = components['schemas']['DepositMethod']

/**
 * Request a Lightning invoice for a market's CPMM bot deposit. The returned
 * `bolt11` is bearer material — it appears only in this immediate response,
 * never in the polling endpoint, so capture and display it before navigating
 * away.
 */
export async function requestLnInvoiceDeposit(
  conditionId: string,
  amountSats: number,
): Promise<RequestLnInvoiceDepositResponse> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/ln-invoice`
  const bodyText = JSON.stringify({ amountSats })
  const bodyBytes = new TextEncoder().encode(bodyText)
  const payloadHash = await sha256Hex(bodyBytes)
  const authHeader = await generateNip98Header(url, 'POST', payloadHash)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: bodyText,
  })
  if (!response.ok) {
    throw new Error(`[Matching Engine] Failed to request LN deposit: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

/**
 * Submit ecash proofs as a market's CPMM bot deposit. Phase 1 of the engine
 * records the request and defers proof verification to the wallet-service;
 * the deposit walks `Requested → Paid → Credited` as the wallet-service
 * confirms.
 */
export async function requestEcashDeposit(
  conditionId: string,
  amountSats: number,
  proofsToken: string,
): Promise<RequestEcashDepositResponse> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/ecash`
  const bodyText = JSON.stringify({ amountSats, proofsToken })
  const bodyBytes = new TextEncoder().encode(bodyText)
  const payloadHash = await sha256Hex(bodyBytes)
  const authHeader = await generateNip98Header(url, 'POST', payloadHash)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: bodyText,
  })
  if (!response.ok) {
    throw new Error(`[Matching Engine] Failed to submit ecash deposit: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

/**
 * Polling read of a deposit's current lifecycle state. Public — no auth.
 * Returns `null` when the engine has no record of `depositId` for this
 * `conditionId` (404). Bearer payment instruments (bolt11) and proof
 * material are deliberately excluded from this shape by the engine.
 */
export async function getDepositStatus(
  conditionId: string,
  depositId: string,
): Promise<GetDepositResponseDto | null> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/${depositId}`
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Failed to read deposit status: ${response.status}`)
  }
  return response.json()
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
