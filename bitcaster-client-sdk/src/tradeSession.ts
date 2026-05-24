export const TRADE_MESSAGE_TYPES = {
  adaptorPoint: 'adaptor-point',
  lockedProofsSeller: 'locked-proofs-seller',
  lockedProofsBuyer: 'locked-proofs-buyer',
  settlementComplete: 'settlement-complete',
} as const

export type TradeMessageType =
  (typeof TRADE_MESSAGE_TYPES)[keyof typeof TRADE_MESSAGE_TYPES]

export type SwapCipherMessageType = Exclude<
  TradeMessageType,
  typeof TRADE_MESSAGE_TYPES.settlementComplete
>

export type SwapRole = 'seller' | 'buyer'

export const SETTLEMENT_KINDS = {
  directSwap: 'DirectSwap',
  complementarySplit: 'ComplementarySplit',
} as const

export type SettlementKind =
  (typeof SETTLEMENT_KINDS)[keyof typeof SETTLEMENT_KINDS]

export const MIN_LOCKTIME_DELTA_SECS = 5

const TRADE_MESSAGE_TYPE_VALUES = new Set<string>(
  Object.values(TRADE_MESSAGE_TYPES),
)

const SWAP_CIPHER_MESSAGE_TYPE_VALUES = new Set<string>([
  TRADE_MESSAGE_TYPES.adaptorPoint,
  TRADE_MESSAGE_TYPES.lockedProofsSeller,
  TRADE_MESSAGE_TYPES.lockedProofsBuyer,
])

export function isTradeMessageType(value: string): value is TradeMessageType {
  return TRADE_MESSAGE_TYPE_VALUES.has(value)
}

export function isSwapCipherMessageType(
  value: string,
): value is SwapCipherMessageType {
  return SWAP_CIPHER_MESSAGE_TYPE_VALUES.has(value)
}

export function validateLocktimeOrdering(
  sellerLocktime: number,
  buyerLocktime: number,
  minLocktimeDeltaSecs = MIN_LOCKTIME_DELTA_SECS,
): string | null {
  if (!Number.isFinite(sellerLocktime) || !Number.isFinite(buyerLocktime)) {
    return 'Trade rejected: invalid locktime values from engine.'
  }
  if (sellerLocktime <= buyerLocktime + minLocktimeDeltaSecs) {
    return (
      `Trade rejected: locktime ordering violates protocol invariant ` +
      `(sellerLocktime=${sellerLocktime}, buyerLocktime=${buyerLocktime}). ` +
      `Seller's locktime must exceed buyer's by at least ` +
      `${minLocktimeDeltaSecs}s.`
    )
  }
  return null
}

export interface TradeCreatedProtocolFields {
  sellerLocktime: number
  buyerLocktime: number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
  outcomeFaceAmountSats?: number | null
  quotePaymentSats?: number | null
}

export function validateTradeCreatedProtocol(
  fields: TradeCreatedProtocolFields,
  minLocktimeDeltaSecs = MIN_LOCKTIME_DELTA_SECS,
): string | null {
  const locktimeError = validateLocktimeOrdering(
    fields.sellerLocktime,
    fields.buyerLocktime,
    minLocktimeDeltaSecs,
  )
  if (locktimeError) return locktimeError

  const settlementKind = fields.settlementKind ?? null
  if (settlementKind === null || settlementKind === SETTLEMENT_KINDS.directSwap) {
    return null
  }

  if (settlementKind !== SETTLEMENT_KINDS.complementarySplit) {
    return `Trade rejected: unsupported settlement kind '${settlementKind}'.`
  }

  if (
    !fields.sellerKeepOutcomeSetId?.trim() ||
    !fields.sellerLockOutcomeSetId?.trim()
  ) {
    return 'Trade rejected: complementary split is missing seller outcome-set metadata.'
  }
  if (fields.sellerKeepOutcomeSetId === fields.sellerLockOutcomeSetId) {
    return 'Trade rejected: complementary split keep and lock outcome sets are identical.'
  }
  if (!isPositiveFiniteAmount(fields.outcomeFaceAmountSats)) {
    return 'Trade rejected: complementary split is missing a positive outcome face amount.'
  }
  if (!isPositiveFiniteAmount(fields.quotePaymentSats)) {
    return 'Trade rejected: complementary split is missing a positive quote payment.'
  }
  return null
}

export function parseIsoLocktimeSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

export function decideSwapRole(params: {
  ownEphemeralPubkey: string
  sellerPubkey: string
  buyerPubkey: string
}): SwapRole | null {
  const ownKey = params.ownEphemeralPubkey.toLowerCase()
  if (params.sellerPubkey.toLowerCase() === ownKey) return 'seller'
  if (params.buyerPubkey.toLowerCase() === ownKey) return 'buyer'
  return null
}

export function cacheSwapCipher<T extends {
  adaptorPoint?: string
  lockedProofsSeller?: string
  lockedProofsBuyer?: string
}>(
  received: T,
  messageType: string,
  ciphertext: string,
): void {
  if (messageType === TRADE_MESSAGE_TYPES.adaptorPoint) received.adaptorPoint = ciphertext
  else if (messageType === TRADE_MESSAGE_TYPES.lockedProofsSeller)
    received.lockedProofsSeller = ciphertext
  else if (messageType === TRADE_MESSAGE_TYPES.lockedProofsBuyer)
    received.lockedProofsBuyer = ciphertext
}

export function hasBothSellerCiphers(received: {
  adaptorPoint?: string
  lockedProofsSeller?: string
}): boolean {
  return !!received.adaptorPoint && !!received.lockedProofsSeller
}

function isPositiveFiniteAmount(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
