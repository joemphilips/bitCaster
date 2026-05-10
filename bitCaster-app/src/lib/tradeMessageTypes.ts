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
