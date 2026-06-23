import { validateTradeCreatedProtocol } from './tradeSession.ts'
import {
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  DEFAULT_MARKET_BASE_ASSET,
  defaultMarketDivisibility,
  parseMarketBaseAsset,
  parseMarketDivisibility,
  quotePaymentSubunits,
  validateWholeShareFaceAmount,
  type MarketBaseAsset,
} from './marketUnits.ts'

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
  outcomeFaceAmountSubunits?: number | null
  quotePaymentSubunits?: number | null
  baseAsset?: string | null
  divisibility?: number | null
  expectedBaseAsset?: string | null
  expectedDivisibility?: number | null
  expectedOrder?: TradeCreatedExpectedOrder | null
  requireExpectedOrder?: boolean
  minLocktimeDeltaSecs?: number
}

export interface TradeCreatedExpectedOrder {
  side: 'Buy' | 'Sell' | 'bid' | 'ask'
  tokenSide?: 'Outcome' | 'Complement' | null
  priceSubunits: number
  amountSubunits: number
  quotePolicy?: 'limit' | 'exact'
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

  const settlementMetadataError = validateTradeCreatedSettlementAmounts(input, role)
  if (settlementMetadataError) {
    return {
      accepted: false,
      reason: 'invalid-protocol',
      error: settlementMetadataError,
      role,
      counterpartyPubkey,
      sellerLocktime,
      buyerLocktime,
    }
  }

  const protocolError = validateTradeCreatedProtocol(
    {
      sellerLocktime,
      buyerLocktime,
      settlementKind: input.settlementKind,
      sellerKeepOutcomeSetId: input.sellerKeepOutcomeSetId,
      sellerLockOutcomeSetId: input.sellerLockOutcomeSetId,
      outcomeFaceAmountSubunits: input.outcomeFaceAmountSubunits,
      quotePaymentSubunits: input.quotePaymentSubunits,
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

function validateTradeCreatedSettlementAmounts(
  input: TradeCreatedDecisionInput,
  role: SwapRole,
): string | null {
  const unit = resolveSettlementUnit(input)
  if (unit.error) return unit.error
  const { baseAsset, divisibility, expectedBaseAsset, expectedDivisibility } = unit
  const expectedUnitSpecified = expectedBaseAsset != null && expectedDivisibility != null
  const isDefaultUnit = isDefaultSettlementUnit(baseAsset, divisibility)
  if (!expectedUnitSpecified && !isDefaultUnit) {
    return 'TradeCreated carries a non-default unit but the local expected unit is missing.'
  }
  if (expectedBaseAsset != null && baseAsset !== expectedBaseAsset) {
    return `Trade unit mismatch: expected ${expectedBaseAsset}, received ${baseAsset}.`
  }
  if (expectedDivisibility != null && divisibility !== expectedDivisibility) {
    return `Trade divisibility mismatch: expected ${expectedDivisibility}, received ${divisibility}.`
  }

  const canonicalBaseAsset = expectedBaseAsset ?? baseAsset
  const canonicalDivisibility = expectedDivisibility ?? divisibility
  const isDefault = isDefaultSettlementUnit(canonicalBaseAsset, canonicalDivisibility)
  if (!isDefault) {
    if (!isPositiveInteger(input.outcomeFaceAmountSubunits)) {
      return 'Trade settlement metadata is missing outcome face subunits.'
    }
    if (!isPositiveInteger(input.quotePaymentSubunits)) {
      return 'Trade settlement metadata is missing quote payment subunits.'
    }
  }
  if (
    input.outcomeFaceAmountSubunits != null &&
    input.outcomeFaceAmountSubunits != null &&
    input.outcomeFaceAmountSubunits !== input.outcomeFaceAmountSubunits
  ) {
    return 'Trade settlement metadata has inconsistent outcome face amounts.'
  }
  if (
    input.quotePaymentSubunits != null &&
    input.quotePaymentSubunits != null &&
    input.quotePaymentSubunits !== input.quotePaymentSubunits
  ) {
    return 'Trade settlement metadata has inconsistent quote payment amounts.'
  }
  const orderError = validateExpectedOrderEconomics({
    role,
    settlementKind: input.settlementKind,
    order: input.expectedOrder,
    required: input.requireExpectedOrder,
    baseAsset: canonicalBaseAsset,
    divisibility: canonicalDivisibility,
    outcomeFaceAmountSubunits: input.outcomeFaceAmountSubunits ?? input.outcomeFaceAmountSubunits,
    quotePaymentSubunits: input.quotePaymentSubunits ?? input.quotePaymentSubunits,
  })
  if (orderError) return orderError
  return null
}

function isDefaultSettlementUnit(baseAsset: MarketBaseAsset, divisibility: number): boolean {
  if (baseAsset === DEFAULT_MARKET_BASE_ASSET && (divisibility === 100 || divisibility === 1_000)) {
    return true
  }
  return divisibility === defaultMarketDivisibility(baseAsset)
}

function resolveSettlementUnit(input: TradeCreatedDecisionInput): {
  baseAsset: MarketBaseAsset
  divisibility: number
  expectedBaseAsset: MarketBaseAsset | null
  expectedDivisibility: number | null
  error: string | null
} {
  const baseAsset = parseOptionalBaseAsset(input.baseAsset, 'Trade unit')
  if (baseAsset.error) return { ...defaultResolvedUnit(), error: baseAsset.error }
  const legacyDefaultDivisibility =
    input.divisibility == null &&
    input.outcomeFaceAmountSubunits == null &&
    input.quotePaymentSubunits == null &&
    (input.outcomeFaceAmountSubunits != null || input.quotePaymentSubunits != null)
      ? 1_000
      : input.divisibility
  const divisibility = parseOptionalDivisibility(legacyDefaultDivisibility, 'Trade divisibility')
  if (divisibility.error) return { ...defaultResolvedUnit(), error: divisibility.error }
  const expectedBaseAsset = parseExpectedBaseAsset(input.expectedBaseAsset)
  if (expectedBaseAsset.error) return { ...defaultResolvedUnit(), error: expectedBaseAsset.error }
  const expectedDivisibility = parseExpectedDivisibility(input.expectedDivisibility)
  if (expectedDivisibility.error) return { ...defaultResolvedUnit(), error: expectedDivisibility.error }

  return {
    baseAsset: baseAsset.value,
    divisibility: divisibility.value,
    expectedBaseAsset: expectedBaseAsset.value,
    expectedDivisibility: expectedDivisibility.value,
    error: null,
  }
}

function defaultResolvedUnit(): {
  baseAsset: MarketBaseAsset
  divisibility: number
  expectedBaseAsset: MarketBaseAsset | null
  expectedDivisibility: number | null
} {
  return {
    baseAsset: DEFAULT_MARKET_BASE_ASSET,
    divisibility: DEFAULT_SAT_MARKET_DIVISIBILITY,
    expectedBaseAsset: null,
    expectedDivisibility: null,
  }
}

function parseOptionalBaseAsset(
  value: string | null | undefined,
  label: string,
): { value: MarketBaseAsset; error: string | null } {
  if (value == null || value.trim() === '') {
    return { value: DEFAULT_MARKET_BASE_ASSET, error: null }
  }
  const parsed = parseMarketBaseAsset(value)
  return parsed
    ? { value: parsed, error: null }
    : { value: DEFAULT_MARKET_BASE_ASSET, error: `${label} is unsupported.` }
}

function parseExpectedBaseAsset(
  value: string | null | undefined,
): { value: MarketBaseAsset | null; error: string | null } {
  if (value == null || value.trim() === '') return { value: null, error: null }
  const parsed = parseMarketBaseAsset(value)
  return parsed
    ? { value: parsed, error: null }
    : { value: null, error: 'Expected trade unit is unsupported.' }
}

function parseOptionalDivisibility(
  value: number | null | undefined,
  label: string,
): { value: number; error: string | null } {
  if (value == null) return { value: DEFAULT_SAT_MARKET_DIVISIBILITY, error: null }
  const parsed = parseMarketDivisibility(value)
  return parsed
    ? { value: parsed, error: null }
    : { value: DEFAULT_SAT_MARKET_DIVISIBILITY, error: `${label} is unsupported.` }
}

function parseExpectedDivisibility(
  value: number | null | undefined,
): { value: number | null; error: string | null } {
  if (value == null) return { value: null, error: null }
  const parsed = parseMarketDivisibility(value)
  return parsed
    ? { value: parsed, error: null }
    : { value: null, error: 'Expected trade divisibility is unsupported.' }
}

function validateExpectedOrderEconomics(input: {
  role: SwapRole
  settlementKind?: string | null
  order?: TradeCreatedExpectedOrder | null
  required?: boolean
  baseAsset: MarketBaseAsset
  divisibility: number
  outcomeFaceAmountSubunits?: number | null
  quotePaymentSubunits?: number | null
}): string | null {
  const order = input.order
  if (!order) {
    return input.required
      ? 'Expected order economics are missing for this local trade.'
      : null
  }
  if (!isPositiveInteger(order.priceSubunits) || order.priceSubunits >= input.divisibility) {
    return 'Expected order price is out of range.'
  }
  const shareFace = input.divisibility
  if (!validateWholeShareFaceAmount(order.amountSubunits, shareFace)) {
    return 'Expected order amount is not a positive whole-share amount.'
  }
  const faceAmount = input.outcomeFaceAmountSubunits
  const quotePayment = input.quotePaymentSubunits
  if (!isPositiveInteger(faceAmount)) return 'Trade settlement metadata is missing outcome face subunits.'
  if (!isPositiveInteger(quotePayment)) return 'Trade settlement metadata is missing quote payment subunits.'
  if (!validateWholeShareFaceAmount(faceAmount, shareFace)) {
    return 'Trade outcome face amount is not a whole market share.'
  }
  if (faceAmount > order.amountSubunits) {
    return 'Trade outcome face amount exceeds the submitted order amount.'
  }

  const side = normalizeOrderSide(order.side)
  if (input.role === 'buyer') {
    if (side !== 'buy') return 'Trade role does not match the submitted order side.'
    const maxQuote = quotePaymentSubunits({
      faceAmountSubunits: faceAmount,
      priceNumerator: order.priceSubunits,
      divisibility: input.divisibility,
    })
    if (order.quotePolicy === 'exact' ? quotePayment !== maxQuote : quotePayment > maxQuote) {
      return 'Trade quote payment exceeds the submitted order price.'
    }
    return null
  }

  // Polymarket complementary matching is Buy-vs-Buy on complementary outcomes.
  // In bitCaster that produces Mint settlement: one buy order becomes the CTF
  // swap seller that splits collateral, regardless of whether its tokenSide is
  // Outcome, Complement, or omitted. tokenSide describes which token the maker
  // wants to keep, not whether the maker may take the swap seller role.
  const mintBidSeller = input.settlementKind === 'Mint' && side === 'buy'
  if (side !== 'sell' && !mintBidSeller) {
    return 'Trade role does not match the submitted order side.'
  }
  const effectiveSellerPrice = mintBidSeller
    ? input.divisibility - order.priceSubunits
    : order.priceSubunits
  const minQuote = quotePaymentSubunits({
    faceAmountSubunits: faceAmount,
    priceNumerator: effectiveSellerPrice,
    divisibility: input.divisibility,
  })
  if (order.quotePolicy === 'exact' ? quotePayment !== minQuote : quotePayment < minQuote) {
    return 'Trade quote payment does not satisfy the submitted order price.'
  }
  return null
}

function normalizeOrderSide(side: TradeCreatedExpectedOrder['side']): 'buy' | 'sell' {
  return side === 'bid' || side === 'Buy' ? 'buy' : 'sell'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
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

  const messageKey = messageStoreKey(input.messageType)
  const alreadyHadMessage = Boolean(messages[messageKey])
  cacheSwapCipher(messages, input.messageType, input.ciphertext)
  if (
    input.role === 'seller' &&
    input.messageType === TRADE_MESSAGE_TYPES.lockedProofsBuyer
  ) {
    return { messages, messageKey, action: 'settlement-claim' }
  }
  if (
    input.role === 'buyer' &&
    hasBothSellerCiphers(messages) &&
    !messages.lockedProofsBuyer &&
    !alreadyHadMessage
  ) {
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
