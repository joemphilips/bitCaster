import type { components } from './generated/api.ts'
import type { MarketDivisibility } from './marketUnits.ts'

export type ActivityType =
  | 'deposit'
  | 'withdrawal'
  | 'Buy'
  | 'Sell'
  | 'payout_claimed'
  | 'creator_fee_claimed'
export type ActivityStatus = 'pending' | 'completed' | 'Failed'

export interface TradeActivityDetails {
  /** Exact submitted order identity. Absent on legacy records. */
  orderId?: string
  fillId: string
  outcomeId: string
  tokenSide: components['schemas']['TokenSide']
  faceAmountSubunits: number
  divisibility: MarketDivisibility
}

export interface ActivityItem {
  id: string
  /** Missing only on legacy history whose wallet cannot be inferred. */
  walletId?: string
  type: ActivityType
  /** Exact msat value. Legacy wire amounts retain their stored value. */
  amountSubunits: number
  baseAsset: 'sat'
  date: string
  status: ActivityStatus
  txId: string | null
  lightningInvoice: string | null
  failureReason?: string
  marketId?: string
  marketTitle?: string
  positionId?: string
  /** Exact confirmed fill values. Old manually added Buy/Sell rows may omit them. */
  tradeDetails?: TradeActivityDetails
}

const ACTIVITY_TYPES = new Set<ActivityType>([
  'deposit',
  'withdrawal',
  'Buy',
  'Sell',
  'payout_claimed',
  'creator_fee_claimed',
])
const ACTIVITY_STATUSES = new Set<ActivityStatus>(['pending', 'completed', 'Failed'])
const CANONICAL_WALLET_ID = /^[0-9a-f]{64}$/

function decodeTradeDetails(value: unknown): TradeActivityDetails | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const details = value as Record<string, unknown>
  if (
    (Object.hasOwn(details, 'orderId') &&
      (typeof details.orderId !== 'string' ||
        details.orderId.length === 0 ||
        details.orderId.trim() !== details.orderId)) ||
    typeof details.fillId !== 'string' ||
    details.fillId.length === 0 ||
    typeof details.outcomeId !== 'string' ||
    details.outcomeId.length === 0 ||
    (details.tokenSide !== 'Outcome' && details.tokenSide !== 'Complement') ||
    typeof details.faceAmountSubunits !== 'number' ||
    !Number.isSafeInteger(details.faceAmountSubunits) ||
    details.faceAmountSubunits <= 0 ||
    (details.divisibility !== 1_000 && details.divisibility !== 1_000_000)
  ) {
    return null
  }
  return {
    ...(typeof details.orderId === 'string' ? { orderId: details.orderId } : {}),
    fillId: details.fillId,
    outcomeId: details.outcomeId,
    tokenSide: details.tokenSide,
    faceAmountSubunits: details.faceAmountSubunits,
    divisibility: details.divisibility,
  }
}

/** Decode current and legacy persisted items without assigning an unknown wallet. */
export function decodeActivityItem(value: unknown): ActivityItem | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  const amountValue = Object.hasOwn(item, 'amountSubunits') ? item.amountSubunits : item.amountSats
  const hasWalletId = Object.hasOwn(item, 'walletId')
  const hasTradeDetails = Object.hasOwn(item, 'tradeDetails')
  const tradeDetails = hasTradeDetails ? decodeTradeDetails(item.tradeDetails) : undefined
  if (
    typeof item.id !== 'string' ||
    typeof item.type !== 'string' ||
    !ACTIVITY_TYPES.has(item.type as ActivityType) ||
    typeof amountValue !== 'number' ||
    !Number.isSafeInteger(amountValue) ||
    item.baseAsset !== 'sat' ||
    typeof item.date !== 'string' ||
    typeof item.status !== 'string' ||
    !ACTIVITY_STATUSES.has(item.status as ActivityStatus) ||
    (item.txId !== null && typeof item.txId !== 'string') ||
    (item.lightningInvoice !== null && typeof item.lightningInvoice !== 'string') ||
    (item.failureReason !== undefined && typeof item.failureReason !== 'string') ||
    (item.marketId !== undefined && typeof item.marketId !== 'string') ||
    (item.marketTitle !== undefined && typeof item.marketTitle !== 'string') ||
    (item.positionId !== undefined && typeof item.positionId !== 'string') ||
    (hasWalletId &&
      (typeof item.walletId !== 'string' || !CANONICAL_WALLET_ID.test(item.walletId))) ||
    (hasTradeDetails &&
      (tradeDetails === undefined ||
        tradeDetails === null ||
        (item.type !== 'Buy' && item.type !== 'Sell') ||
        item.status !== 'completed' ||
        !hasWalletId ||
        typeof item.walletId !== 'string' ||
        typeof item.marketId !== 'string' ||
        item.id !== `trade:${item.walletId}:${tradeDetails.fillId}`))
  ) {
    return null
  }

  return {
    id: item.id,
    ...(hasWalletId ? { walletId: item.walletId as string } : {}),
    type: item.type as ActivityType,
    amountSubunits: amountValue,
    baseAsset: 'sat',
    date: item.date,
    status: item.status as ActivityStatus,
    txId: item.txId as string | null,
    lightningInvoice: item.lightningInvoice as string | null,
    ...(typeof item.failureReason === 'string' ? { failureReason: item.failureReason } : {}),
    ...(typeof item.marketId === 'string' ? { marketId: item.marketId } : {}),
    ...(typeof item.marketTitle === 'string' ? { marketTitle: item.marketTitle } : {}),
    ...(typeof item.positionId === 'string' ? { positionId: item.positionId } : {}),
    ...(tradeDetails ? { tradeDetails } : {}),
  }
}

export function decodeActivityItems(value: unknown): ActivityItem[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const decoded = decodeActivityItem(item)
        return decoded === null ? [] : [decoded]
      })
    : []
}

export function activityItemIdentityKey(item: ActivityItem): string {
  return JSON.stringify([item.walletId ?? null, item.id])
}

function activityItemEqual(a: ActivityItem, b: ActivityItem): boolean {
  return (
    a.id === b.id &&
    a.walletId === b.walletId &&
    a.type === b.type &&
    a.amountSubunits === b.amountSubunits &&
    a.baseAsset === b.baseAsset &&
    a.date === b.date &&
    a.status === b.status &&
    a.txId === b.txId &&
    a.lightningInvoice === b.lightningInvoice &&
    a.failureReason === b.failureReason &&
    a.marketId === b.marketId &&
    a.marketTitle === b.marketTitle &&
    a.positionId === b.positionId &&
    (a.tradeDetails === undefined
      ? b.tradeDetails === undefined
      : b.tradeDetails !== undefined &&
        a.tradeDetails.orderId === b.tradeDetails.orderId &&
        a.tradeDetails.fillId === b.tradeDetails.fillId &&
        a.tradeDetails.outcomeId === b.tradeDetails.outcomeId &&
        a.tradeDetails.tokenSide === b.tradeDetails.tokenSide &&
        a.tradeDetails.faceAmountSubunits === b.tradeDetails.faceAmountSubunits &&
        a.tradeDetails.divisibility === b.tradeDetails.divisibility)
  )
}

export function activityLogsEqual(a: readonly ActivityItem[], b: readonly ActivityItem[]): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(a.map((item) => [activityItemIdentityKey(item), item] as const))
  for (const item of b) {
    const other = byId.get(activityItemIdentityKey(item))
    if (!other || !activityItemEqual(other, item)) return false
  }
  return true
}

export function activityLogsEqualInOrder(
  a: readonly ActivityItem[],
  b: readonly ActivityItem[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => activityItemEqual(item, b[index]))
}

export const ACTIVITY_LOG_D_TAG = 'bitcaster:activity-log' as const

export function isCanonicalActivityWalletId(value: string): boolean {
  return CANONICAL_WALLET_ID.test(value)
}

/** Local rows replace remote rows only when both exact identities match. */
export function mergeActivityLogs(
  local: readonly ActivityItem[],
  remote: readonly ActivityItem[],
): ActivityItem[] {
  const byId = new Map<string, ActivityItem>()
  for (const item of [...remote, ...local]) {
    byId.set(activityItemIdentityKey(item), item)
  }
  return Array.from(byId.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Preserve the deployed NIP-78 envelope and reject invalid writes. */
export function encodeActivityLogPayload(items: readonly ActivityItem[]): string {
  const decodedItems = decodeActivityItems(items)
  if (decodedItems.length !== items.length) {
    throw new Error('Activity log contains an invalid item.')
  }
  return JSON.stringify({ items: decodedItems })
}

/** Keep unknown-wallet legacy rows without assigning them to a wallet. */
export function decodeActivityLogPayload(content: string): ActivityItem[] | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const items = (parsed as Record<string, unknown>).items
    return Array.isArray(items) ? decodeActivityItems(items) : null
  } catch {
    return null
  }
}

export interface ConfirmedTradeActivityContext {
  walletId: string
  orderId: string
  marketId: string
}

export type ConfirmedTradeActivitySource = Pick<
  components['schemas']['OrderStatusResponse'],
  | 'orderId'
  | 'marketId'
  | 'outcomeId'
  | 'side'
  | 'tokenSide'
  | 'baseAsset'
  | 'divisibility'
  | 'fills'
>

/**
 * Map exact committed fills from an authenticated owner-order response.
 * The caller must prove that this wallet submitted this exact order.
 * Account authentication alone does not establish wallet ownership.
 */
export function mapConfirmedTradeActivities(
  status: ConfirmedTradeActivitySource,
  context: ConfirmedTradeActivityContext,
): ActivityItem[] {
  if (
    !CANONICAL_WALLET_ID.test(context.walletId) ||
    context.orderId.length === 0 ||
    context.orderId.trim() !== context.orderId ||
    status.orderId !== context.orderId ||
    status.marketId !== context.marketId ||
    status.baseAsset !== 'sat' ||
    (status.side !== 'Buy' && status.side !== 'Sell')
  ) {
    return []
  }

  return status.fills.flatMap((fill): ActivityItem[] => {
    if (
      fill.status !== 'Filled' ||
      (fill.takerOrderId !== context.orderId && fill.makerOrderId !== context.orderId) ||
      fill.baseAsset !== status.baseAsset ||
      fill.divisibility !== status.divisibility ||
      (fill.divisibility !== 1_000 && fill.divisibility !== 1_000_000) ||
      fill.tokenSide !== status.tokenSide ||
      !Number.isSafeInteger(fill.quotePaymentSubunits) ||
      fill.quotePaymentSubunits < 0 ||
      !Number.isSafeInteger(fill.outcomeFaceAmountSubunits) ||
      fill.outcomeFaceAmountSubunits <= 0 ||
      !Number.isFinite(Date.parse(fill.filledAt))
    ) {
      return []
    }

    const divisibility = fill.divisibility as MarketDivisibility
    return [
      {
        id: `trade:${context.walletId}:${fill.id}`,
        walletId: context.walletId,
        type: status.side,
        amountSubunits: fill.quotePaymentSubunits,
        baseAsset: 'sat',
        date: fill.filledAt,
        status: 'completed',
        txId: null,
        lightningInvoice: null,
        marketId: status.marketId,
        tradeDetails: {
          orderId: context.orderId,
          fillId: fill.id,
          outcomeId: status.outcomeId,
          tokenSide: fill.tokenSide,
          faceAmountSubunits: fill.outcomeFaceAmountSubunits,
          divisibility,
        },
      },
    ]
  })
}
