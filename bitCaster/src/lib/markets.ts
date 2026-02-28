import type { Market, FilterState } from '@/types/market'

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

export async function fetchMarkets(): Promise<Market[]> {
  const conditions = await fetchConditions()
  return conditions
    .filter((c) => c.attestation.status === 'pending')
    .map(mapConditionToMarket)
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

// Order submission — types from generated OpenAPI spec

import type { components } from '@/generated/api'

export type SubmitOrderRequest = components['schemas']['SubmitOrderRequest']
export type SubmitOrderResponse = components['schemas']['SubmitOrderResponse']
export type OrderBookSnapshot = components['schemas']['OrderBookSnapshot']
export type LevelDto = components['schemas']['LevelDto']
export type Fill = components['schemas']['Fill']

export async function submitOrder(params: SubmitOrderRequest): Promise<SubmitOrderResponse> {
  const response = await fetch('/api/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    throw new Error(`Failed to submit order: ${response.status}`)
  }
  return response.json()
}
