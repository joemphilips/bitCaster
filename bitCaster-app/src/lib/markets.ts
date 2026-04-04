import type { Market, FilterState } from '@/types/market'
import type {
  MarketDetail,
  OrderBook,
  Order,
} from '@/types/market-detail'

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
  description: string
  threshold: number
  announcements: string[]
  partitions: PartitionInfoEntry[]
  attestation: AttestationState
  condition_type?: string // "enum" (default, omitted) or "numeric"
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

  if (isYesNo) {
    return {
      id: c.condition_id,
      title: c.description,
      type: 'yesno',
      imageUrl: '',
      categoryTags: [],
      metaTags: [],
      currentOdds: { yes: 50, no: 50 },
      volume: 0,
      liquidity: 0,
      traderCount: 0,
      closingDate: now,
      createdDate: now,
      activeSince: now,
      creatorFeePercent: 0,
      likeCount: 0,
      isLiked: false,
      baseMarket: 'sats',
    }
  }

  return {
    id: c.condition_id,
    title: c.description,
    type: 'categorical',
    imageUrl: '',
    categoryTags: [],
    metaTags: [],
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
    likeCount: 0,
    isLiked: false,
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

function applyMetadata<T extends { volume: number; liquidity: number; traderCount: number; likeCount: number; isLiked: boolean }>(
  base: T,
  meta: MarketMetadataSnapshot,
): T {
  return {
    ...base,
    volume: meta.totalVolumeSats,
    liquidity: meta.totalLiquiditySats,
    traderCount: meta.uniqueTraderCount,
    likeCount: meta.likeCount,
    isLiked: meta.isLiked,
  }
}

export async function fetchMarkets(): Promise<Market[]> {
  const conditions = await fetchConditions()
  const markets = conditions
    .filter((c) => c.attestation.status === 'pending')
    .map(mapConditionToMarket)

  const enriched = await Promise.all(
    markets.map(async (m) => {
      const meta = await fetchMarketMetadata(m.id)
      return meta ? applyMetadata(m, meta) : m
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
export type ToggleLikeResponse = components['schemas']['ToggleLikeResponse']

export async function toggleMarketLike(marketId: string, userId: string): Promise<ToggleLikeResponse> {
  const response = await fetch(`/api/v1/${marketId}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
  if (!response.ok) {
    throw new Error(`Failed to toggle like: ${response.status}`)
  }
  return response.json()
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

  const isResolved = c.attestation.status === 'attested'

  const base = {
    id: c.condition_id,
    title: c.description,
    imageUrl: undefined,
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    traderCount: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    likeCount: 0,
    isLiked: false,
    baseUnit: 'sats',
    creator: {
      id: 'unknown',
      name: 'Unknown',
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: c.description,
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

function mapSnapshotToOrderBook(snapshot: OrderBookSnapshot): OrderBook {
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
  const response = await fetch(`/api/v1/${marketId}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    throw new Error(`Failed to submit order: ${response.status}`)
  }
  return response.json()
}
