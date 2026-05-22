import { validateTradeCreatedProtocol } from './tradeSession.ts'

const TRADE_MESSAGE_TYPES = {
  adaptorPoint: 'adaptor-point',
  lockedProofsSeller: 'locked-proofs-seller',
  lockedProofsBuyer: 'locked-proofs-buyer',
  settlementComplete: 'settlement-complete',
} as const

type SwapCipherMessageType =
  | typeof TRADE_MESSAGE_TYPES.adaptorPoint
  | typeof TRADE_MESSAGE_TYPES.lockedProofsSeller
  | typeof TRADE_MESSAGE_TYPES.lockedProofsBuyer

type SwapRole = 'seller' | 'buyer'

const SWAP_CIPHER_MESSAGE_TYPE_VALUES = new Set<string>([
  TRADE_MESSAGE_TYPES.adaptorPoint,
  TRADE_MESSAGE_TYPES.lockedProofsSeller,
  TRADE_MESSAGE_TYPES.lockedProofsBuyer,
])

export interface SwapMessages {
  adaptorPoint?: string
  lockedProofsSeller?: string
  lockedProofsBuyer?: string
}

export interface TradeCreatedDecisionInput {
  ownEphemeralPubkey: string
  sellerPubkey: string
  buyerPubkey: string
  sellerLocktime: string | number
  buyerLocktime: string | number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
  outcomeFaceAmountSats?: number | null
  quotePaymentSats?: number | null
  minLocktimeDeltaSecs?: number
}

export type TradeCreatedDecision =
  | {
      accepted: true
      role: SwapRole
      counterpartyPubkey: string
      sellerLocktime: number
      buyerLocktime: number
    }
  | {
      accepted: false
      reason: 'foreign' | 'invalid-locktime' | 'invalid-protocol'
      error: string
      role?: SwapRole
      counterpartyPubkey?: string
      sellerLocktime: number
      buyerLocktime: number
    }

export function decideTradeCreated(
  input: TradeCreatedDecisionInput,
): TradeCreatedDecision {
  const sellerLocktime = normalizeLocktime(input.sellerLocktime)
  const buyerLocktime = normalizeLocktime(input.buyerLocktime)
  const role = decideSwapRole({
    ownEphemeralPubkey: input.ownEphemeralPubkey,
    sellerPubkey: input.sellerPubkey,
    buyerPubkey: input.buyerPubkey,
  })
  if (!role) {
    return {
      accepted: false,
      reason: 'foreign',
      error: 'TradeCreated did not list our ephemeral pubkey on either side.',
      sellerLocktime,
      buyerLocktime,
    }
  }
  const counterpartyPubkey =
    role === 'seller' ? input.buyerPubkey : input.sellerPubkey

  const protocolError = validateTradeCreatedProtocol(
    {
      sellerLocktime,
      buyerLocktime,
      settlementKind: input.settlementKind,
      sellerKeepOutcomeSetId: input.sellerKeepOutcomeSetId,
      sellerLockOutcomeSetId: input.sellerLockOutcomeSetId,
      outcomeFaceAmountSats: input.outcomeFaceAmountSats,
      quotePaymentSats: input.quotePaymentSats,
    },
    input.minLocktimeDeltaSecs,
  )
  if (protocolError) {
    return {
      accepted: false,
      reason: protocolRejectionReason(protocolError),
      error: protocolError,
      role,
      counterpartyPubkey,
      sellerLocktime,
      buyerLocktime,
    }
  }

  return {
    accepted: true,
    role,
    counterpartyPubkey,
    sellerLocktime,
    buyerLocktime,
  }
}

export type SwapMessageAction = 'none' | 'buyer-respond' | 'settlement-claim'

export interface SwapMessageDecision {
  messages: SwapMessages
  messageKey?: keyof SwapMessages
  action: SwapMessageAction
}

export function decideSwapMessage(
  input: {
    role: SwapRole | null | undefined
    messages: SwapMessages
    messageType: string
    ciphertext: string
  },
): SwapMessageDecision {
  const messages = { ...input.messages }
  if (!isSwapCipherMessageType(input.messageType)) {
    return { messages, action: 'none' }
  }

  cacheSwapCipher(messages, input.messageType, input.ciphertext)
  const messageKey = messageStoreKey(input.messageType)
  if (
    input.role === 'seller' &&
    input.messageType === TRADE_MESSAGE_TYPES.lockedProofsBuyer
  ) {
    return { messages, messageKey, action: 'settlement-claim' }
  }
  if (input.role === 'buyer' && hasBothSellerCiphers(messages)) {
    return { messages, messageKey, action: 'buyer-respond' }
  }
  return { messages, messageKey, action: 'none' }
}

export function isSettlementCompleteMessage(messageType: string): boolean {
  return messageType === TRADE_MESSAGE_TYPES.settlementComplete
}

export type TradeStateAction =
  | 'none'
  | 'settlement-claim'
  | 'finish-confirmed'
  | 'finish-failed'
  | 'finish-refunded'

export function decideTradeStateChanged(newState: string): TradeStateAction {
  switch (newState.toLowerCase()) {
    case 'settling':
      return 'settlement-claim'
    case 'confirmed':
      return 'finish-confirmed'
    case 'refunded':
      return 'finish-refunded'
    case 'failed':
    case 'cancelled':
      return 'finish-failed'
    default:
      return 'none'
  }
}

export function protocolRejectionReason(
  error: string,
): 'invalid-locktime' | 'invalid-protocol' {
  return error.includes('locktime') ? 'invalid-locktime' : 'invalid-protocol'
}

function normalizeLocktime(value: string | number): number {
  return typeof value === 'number'
    ? value
    : Math.floor(new Date(value).getTime() / 1000)
}

function messageStoreKey(
  messageType: SwapCipherMessageType,
): keyof SwapMessages {
  switch (messageType) {
    case TRADE_MESSAGE_TYPES.adaptorPoint:
      return 'adaptorPoint'
    case TRADE_MESSAGE_TYPES.lockedProofsSeller:
      return 'lockedProofsSeller'
    case TRADE_MESSAGE_TYPES.lockedProofsBuyer:
      return 'lockedProofsBuyer'
  }
}

function decideSwapRole(params: {
  ownEphemeralPubkey: string
  sellerPubkey: string
  buyerPubkey: string
}): SwapRole | null {
  const ownKey = params.ownEphemeralPubkey.toLowerCase()
  if (params.sellerPubkey.toLowerCase() === ownKey) return 'seller'
  if (params.buyerPubkey.toLowerCase() === ownKey) return 'buyer'
  return null
}

function isSwapCipherMessageType(value: string): value is SwapCipherMessageType {
  return SWAP_CIPHER_MESSAGE_TYPE_VALUES.has(value)
}

function cacheSwapCipher(
  received: SwapMessages,
  messageType: string,
  ciphertext: string,
): void {
  if (messageType === TRADE_MESSAGE_TYPES.adaptorPoint) {
    received.adaptorPoint = ciphertext
  } else if (messageType === TRADE_MESSAGE_TYPES.lockedProofsSeller) {
    received.lockedProofsSeller = ciphertext
  } else if (messageType === TRADE_MESSAGE_TYPES.lockedProofsBuyer) {
    received.lockedProofsBuyer = ciphertext
  }
}

function hasBothSellerCiphers(received: SwapMessages): boolean {
  return !!received.adaptorPoint && !!received.lockedProofsSeller
}
