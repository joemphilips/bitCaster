import type { MarketBaseAsset } from './marketUnits.ts'
import {
  decodeDurableRecipientDeliveryEvidence,
  type DurableRecipientDeliveryEvidence,
} from './durableRecipientDelivery.ts'
import {
  participationScoreRecipientProductBinding,
  requireDurableRecipientProductBinding,
} from './durableRecipientProductBinding.ts'
import { normalizeDurableWalletMintUrl } from './durableWalletMintUrl.ts'

export type EngineFetch = typeof fetch

export interface EngineClientOptions {
  baseUrl: string
  fetchImpl?: EngineFetch
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>
}

export interface EngineAuthorizationRequest {
  url: string
  method: string
  bodyText?: string
  payloadHash?: string
}

export interface SubmitOrderRequest {
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  clientOrderId: string
  comment?: NostrKind1Event | null
}

export interface NostrKind1Event {
  id: string
  pubkey: string
  createdAt: number
  kind: 1
  tags: string[][]
  content: string
  sig: string
}

export interface Fill {
  id: string
  makerOrderId: string
  takerOrderId: string
  outcomeId: string
  amountSubunits: number
  executionPrice: number
  path: 'Complementary' | 'Mint'
  status: 'Matched' | 'Filled' | 'Failed'
  filledAt: string
  tradeId?: string
  baseAsset: MarketBaseAsset
  divisibility: number
  tokenSide: 'Outcome' | 'Complement'
  quotePaymentSubunits?: number | null
  outcomeFaceAmountSubunits?: number | null
}

export interface SubmitOrderResponse {
  orderId: string
  status: string
  remainingAmountSubunits: number
  fills: Fill[]
  pendingPubkeySubmissions?: PendingPubkeySubmission[]
  baseAsset: MarketBaseAsset
  divisibility: number
}

export interface PendingPubkeySubmission {
  tradeId: string
  role: 'maker' | 'taker'
  fillAmountSubunits: number
  fillAmount?: number
  deadline: string
}

export interface BatchSubmitOrdersRequest {
  orders: BatchSubmitOrderRequestItem[]
}

export interface BatchSubmitOrderRequestItem extends Omit<SubmitOrderRequest, 'comment'> {
  marketId: string
  expiresAt?: string | null
}

export interface BatchSubmitOrdersResponse {
  results: BatchSubmitOrderResult[]
}

export interface BatchSubmitOrderResult {
  requestIndex: number
  clientOrderId?: string | null
  success: boolean
  marketId: string
  orderId?: string | null
  status: string
  remainingAmountSubunits: number
  fills: Fill[]
  pendingPubkeySubmissions?: PendingPubkeySubmission[]
  baseAsset: MarketBaseAsset
  divisibility: number
  errorCode?: BatchSubmitOrderErrorCode | null
  errorMessage?: string | null
}

export type BatchSubmitOrderErrorCode =
  | 'invalidMarket'
  | 'invalidOutcome'
  | 'invalidTokenSide'
  | 'invalidSide'
  | 'invalidPrice'
  | 'invalidAmount'
  | 'invalidTimeInForce'
  | 'duplicateClientOrderId'
  | 'unsupportedOrder'
  | 'bookRejected'

export interface SubmitEphemeralPubkeyRequest {
  ephemeralPubkey: string
}

export interface SubmitEphemeralPubkeyResponse {
  tradeId: string
  role: string
  bothReceived: boolean
}

export interface BatchCancelOrdersRequest {
  orderIds: string[]
}

export interface BatchCancelOrdersResponse {
  canceled: string[]
  notCanceled: Record<string, BatchCancelOrderFailure>
}

export interface BatchCancelOrderFailure {
  errorCode: BatchCancelOrderErrorCode
  errorMessage: string
}

export type BatchCancelOrderErrorCode =
  | 'notFoundOrNotActiveOrNotAuthorized'
  | 'duplicateOrderId'
  | 'invalidOrderId'
  | 'bookRejected'

export interface EngineProblem {
  code?: string
  detail?: string
}

export interface OrderStatusResponse {
  orderId: string
  marketId: string
  status: string
  remainingAmountSubunits: number
  filledAmountSubunits: number
  fills: Fill[]
  tokenSide: 'Outcome' | 'Complement'
  baseAsset: MarketBaseAsset
  divisibility: number
}

export interface OrderEntry {
  orderId: string
  marketId: string
  conditionId: string
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  remainingAmountSubunits: number
  tokenSide: 'Outcome' | 'Complement'
  status: 'Resting' | 'Filled' | 'Cancelled' | 'Matched' | string
  placedAt: string
  filledAt?: string | null
  tradeId?: string | null
  deadline?: string | null
  pubkeySubmitted?: boolean | null
  clientOrderId?: string | null
}

export interface ListMyOrdersResponse {
  orders: OrderEntry[]
  nextCursor?: string | null
}

export interface LevelDto {
  price: number
  amount: number
}

export interface OrderBookSnapshot {
  marketId: string
  bids: LevelDto[]
  asks: LevelDto[]
  spread?: number | null
  depthLimit?: number | null
}

export interface QueryMarketsParams {
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  sort?: 'Trending' | 'Popular' | 'New'
  tag?: string
  /** @deprecated Use creatorPubkey; OpenAPI wire name is creator_pubkey. */
  creator?: string
  creatorPubkey?: string
  ids?: string[]
  search?: string
  /** @deprecated Use pageSize; OpenAPI wire name is page_size. */
  limit?: number
  pageSize?: number
  cursor?: string
}

export interface QueryMarketsResponse {
  markets: unknown[]
  nextCursor?: string | null
}

export type PriceHistoryTimeframe = '1h' | '24h' | '7d' | '30d' | 'all'

export interface MarketPriceHistoryPoint {
  timestamp: string
  price: number
  volumeSubunits: number
}

export interface MarketOutcomePriceHistory {
  outcomeId: string
  data: MarketPriceHistoryPoint[]
}

export interface MarketPriceHistoryResponse {
  conditionId: string
  timeframe: PriceHistoryTimeframe
  outcomes: MarketOutcomePriceHistory[]
}

export interface MarketComment {
  commentId: string
  content: string
  createdAt: string
  authorPubkey: string
}

export interface MarketCommentsResponse {
  conditionId: string
  comments: MarketComment[]
}

export interface ParticipationScoreResponse {
  accountSubject: string
  balance: number
  purchasedTotal: number
  consumedTotal: number
  penaltyTotal: number
  matchDebitScore: number
  enabled: boolean
}

export interface MarketFundingPaymentStatusResponse {
  schemaVersion: 1
  depositId: string
  conditionId: string
  accountSubject: string
  recipientKind: 'matching-engine'
  purpose: 'market-funding'
  destinationId: string
  productBinding: string
  mintUrl: string
  unit: 'sat' | 'msat' | 'usd'
  creditPolicy: 'net-of-receive-fee'
  tokenDigest: string
  encodedTokenBytes: number
  receiptOperationId: string | null
  receivedAt: string | null
  state: 'requested' | 'paid' | 'credited' | 'failed'
  method: 'ecash'
  amountSubunits: number
  creditedAmountSubunits: number | null
  receiveFeeAmountSubunits: number | null
  businessEventId: string | null
  creditedAt: string | null
  requestedAt: string
  updatedAt: string
  failureReason: string | null
}

export interface SubmitMarketFundingEcashRequest {
  accountSubject: string
  conditionId: string
  depositId: string
  amountSubunits: number
  proofsToken: string
  mintUrl: string
  unit: 'sat' | 'msat' | 'usd'
  divisibility: number
  creatorPubkey?: string | null
  fundAmm?: boolean
}

export interface SubmitMarketFundingEcashResponse {
  depositId: string
  state: 'requested' | 'paid' | 'credited' | 'failed'
}

export function marketFundingStatusToDeliveryEvidence(
  value: unknown,
): DurableRecipientDeliveryEvidence {
  const status = decodeMarketFundingPaymentStatus(value)
  const request = {
    schemaVersion: status.schemaVersion,
    deliveryId: status.depositId,
    accountSubject: status.accountSubject,
    recipientKind: status.recipientKind,
    purpose: status.purpose,
    destinationId: status.destinationId,
    productBinding: status.productBinding,
    mintUrl: status.mintUrl,
    unit: status.unit,
    requestedAmount: String(status.amountSubunits),
    creditPolicy: { kind: 'net-of-receive-fee' as const },
    tokenDigest: status.tokenDigest,
    encodedTokenBytes: status.encodedTokenBytes,
  }
  if (
    status.state === 'requested' ||
    (status.state === 'failed' && status.receiptOperationId === null)
  ) {
    return { kind: 'not-found' }
  }
  const receipt = requireMarketFundingReceipt(status)
  if (status.state === 'paid' || status.state === 'failed') {
    return decodeDurableRecipientDeliveryEvidence({
      kind: 'received',
      request,
      receiptOperationId: receipt.receiptOperationId,
      receivedAtMs: Date.parse(receipt.receivedAt),
    })
  }
  return decodeDurableRecipientDeliveryEvidence({
    kind: 'credited',
    request,
    receiptOperationId: receipt.receiptOperationId,
    receivedAtMs: Date.parse(receipt.receivedAt),
    creditedAmount: String(status.creditedAmountSubunits),
    creditVerification: {
      kind: 'net-of-receive-fee',
      receiveFeeAmount: String(status.receiveFeeAmountSubunits),
    },
    businessEventId: status.businessEventId,
    creditedAtMs: Date.parse(status.creditedAt!),
  })
}

export function decodeMarketFundingPaymentStatus(
  value: unknown,
): MarketFundingPaymentStatusResponse {
  const status = requireExactObject(
    value,
    MARKET_FUNDING_STATUS_FIELDS,
    'Market funding payment status',
  )
  if (
    status.schemaVersion !== 1 ||
    status.recipientKind !== 'matching-engine' ||
    status.purpose !== 'market-funding' ||
    status.creditPolicy !== 'net-of-receive-fee' ||
    status.method !== 'ecash'
  ) {
    throw new Error('Market funding payment route is invalid')
  }
  const depositId = requireUuid(status.depositId, 'deposit id')
  const conditionId = requireBoundedText(status.conditionId, 'condition id', 512)
  const destinationId = requireBoundedText(status.destinationId, 'destination id', 512)
  if (destinationId !== conditionId) {
    throw new Error('Market funding payment destination is invalid')
  }
  const state = requireMarketFundingState(status.state)
  const receivedAt = requireNullableTimestampText(
    status.receivedAt,
    'received time',
  )
  const requestedAt = requireTimestampText(status.requestedAt, 'requested time')
  const updatedAt = requireTimestampText(status.updatedAt, 'updated time')
  const result: MarketFundingPaymentStatusResponse = {
    schemaVersion: 1,
    depositId,
    conditionId,
    accountSubject: requireBoundedText(status.accountSubject, 'account subject', 512),
    recipientKind: 'matching-engine',
    purpose: 'market-funding',
    destinationId,
    productBinding: requireDurableRecipientProductBinding(status.productBinding),
    mintUrl: normalizeDurableWalletMintUrl(status.mintUrl),
    unit: requireMarketFundingUnit(status.unit),
    creditPolicy: 'net-of-receive-fee',
    tokenDigest: requireLowerHexDigest(status.tokenDigest),
    encodedTokenBytes: requireBoundedPositiveInteger(
      status.encodedTokenBytes,
      'encoded token bytes',
      65_536,
    ),
    receiptOperationId: requireNullableBoundedText(
      status.receiptOperationId,
      'receipt operation id',
      512,
    ),
    receivedAt,
    state,
    method: 'ecash',
    amountSubunits: requirePositiveSafeInteger(status.amountSubunits, 'deposit amount'),
    creditedAmountSubunits: requireNullablePositiveSafeInteger(
      status.creditedAmountSubunits,
      'credited amount',
    ),
    receiveFeeAmountSubunits: requireNullableNonNegativeSafeInteger(
      status.receiveFeeAmountSubunits,
      'receive fee',
    ),
    businessEventId: requireNullableBoundedText(
      status.businessEventId,
      'business event id',
      512,
    ),
    creditedAt: requireNullableTimestampText(status.creditedAt, 'credited time'),
    requestedAt,
    updatedAt,
    failureReason: requireNullableBoundedText(
      status.failureReason,
      'failure reason',
      2_048,
    ),
  }
  assertMarketFundingPaymentResult(result)
  return result
}

const MARKET_FUNDING_STATUS_FIELDS = [
  'schemaVersion',
  'depositId',
  'conditionId',
  'accountSubject',
  'recipientKind',
  'purpose',
  'destinationId',
  'productBinding',
  'mintUrl',
  'unit',
  'creditPolicy',
  'tokenDigest',
  'encodedTokenBytes',
  'receiptOperationId',
  'receivedAt',
  'state',
  'method',
  'amountSubunits',
  'creditedAmountSubunits',
  'receiveFeeAmountSubunits',
  'businessEventId',
  'creditedAt',
  'requestedAt',
  'updatedAt',
  'failureReason',
] as const

function assertMarketFundingPaymentResult(
  status: MarketFundingPaymentStatusResponse,
): void {
  const expectedReceiptOperationId =
    `${status.conditionId}/${status.depositId}/ecash-receive`
  if (Date.parse(status.updatedAt) < Date.parse(status.requestedAt)) {
    throw new Error('Market funding update precedes its request')
  }
  const hasReceipt =
    status.receiptOperationId !== null || status.receivedAt !== null
  if (hasReceipt) {
    if (
      status.receiptOperationId !== expectedReceiptOperationId ||
      status.receivedAt === null ||
      Date.parse(status.receivedAt) < Date.parse(status.requestedAt) ||
      Date.parse(status.receivedAt) > Date.parse(status.updatedAt)
    ) {
      throw new Error('Market funding receipt is misbound')
    }
  }
  if (
    (status.state === 'paid' || status.state === 'credited') &&
    !hasReceipt
  ) {
    throw new Error('Market funding receipt is missing')
  }
  if (status.state === 'requested' && hasReceipt) {
    throw new Error('Market funding requested result has receipt authority')
  }
  if (status.state === 'requested' || status.state === 'paid') {
    if (
      status.creditedAmountSubunits !== null ||
      status.receiveFeeAmountSubunits !== null ||
      status.businessEventId !== null ||
      status.creditedAt !== null ||
      status.failureReason !== null
    ) {
      throw new Error('Market funding nonterminal result is invalid')
    }
    return
  }
  if (status.state === 'failed') {
    if (
      status.creditedAmountSubunits !== null ||
      status.receiveFeeAmountSubunits !== null ||
      status.businessEventId !== null ||
      status.creditedAt !== null ||
      status.failureReason === null
    ) {
      throw new Error('Market funding failure result is invalid')
    }
    return
  }
  const receipt = requireMarketFundingReceipt(status)
  if (
    status.creditedAmountSubunits === null ||
    status.receiveFeeAmountSubunits === null ||
    status.businessEventId !==
      `market-deposit-credit/${status.conditionId}/${status.depositId}` ||
    status.creditedAt === null ||
    status.failureReason !== null ||
    status.creditedAmountSubunits + status.receiveFeeAmountSubunits !==
      status.amountSubunits ||
    Date.parse(status.creditedAt) < Date.parse(receipt.receivedAt)
  ) {
    throw new Error('Market funding credit result is invalid')
  }
}

function requireMarketFundingReceipt(
  status: MarketFundingPaymentStatusResponse,
): { receiptOperationId: string; receivedAt: string } {
  if (status.receiptOperationId === null || status.receivedAt === null) {
    throw new Error('Market funding receipt is missing')
  }
  return {
    receiptOperationId: status.receiptOperationId,
    receivedAt: status.receivedAt,
  }
}

function requireMarketFundingState(
  value: unknown,
): MarketFundingPaymentStatusResponse['state'] {
  if (
    value === 'requested' ||
    value === 'paid' ||
    value === 'credited' ||
    value === 'failed'
  ) {
    return value
  }
  throw new Error('Market funding payment state is invalid')
}

function requireMarketFundingUnit(
  value: unknown,
): MarketFundingPaymentStatusResponse['unit'] {
  if (value === 'sat' || value === 'msat' || value === 'usd') return value
  throw new Error('Market funding payment unit is invalid')
}

function requireMarketFundingDivisibility(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > 2_147_483_647
  ) {
    throw new Error('Market funding divisibility is invalid')
  }
  return value as number
}

export interface ParticipationScorePaymentStatusResponse {
  schemaVersion: 1
  paymentId: string
  status: 'credited'
  accountSubject: string
  recipientKind: 'matching-engine'
  purpose: 'participation-score'
  destinationId: 'participation-score'
  mintUrl: string
  unit: 'sat'
  amountSats: number
  tokenDigest: string
  encodedTokenBytes: number
  receiptOperationId: string
  receivedAt: string
  creditedScore: number
  businessEventId: string
  creditedAt: string
}

type ParticipationScorePaymentRequestFields = Pick<
  ParticipationScorePaymentStatusResponse,
  | 'paymentId'
  | 'accountSubject'
  | 'recipientKind'
  | 'purpose'
  | 'destinationId'
  | 'mintUrl'
  | 'unit'
  | 'amountSats'
  | 'tokenDigest'
  | 'encodedTokenBytes'
>

type ParticipationScorePaymentResultFields = Pick<
  ParticipationScorePaymentStatusResponse,
  'receiptOperationId' | 'receivedAt' | 'creditedScore' | 'businessEventId' | 'creditedAt'
>

export function scorePaymentStatusToDeliveryEvidence(
  value: unknown,
): DurableRecipientDeliveryEvidence {
  const status = decodeParticipationScorePaymentStatus(value)
  return decodeDurableRecipientDeliveryEvidence({
    kind: 'credited',
    request: {
      schemaVersion: status.schemaVersion,
      deliveryId: status.paymentId,
      accountSubject: status.accountSubject,
      recipientKind: status.recipientKind,
      purpose: status.purpose,
      destinationId: status.destinationId,
      productBinding: participationScoreRecipientProductBinding(),
      mintUrl: status.mintUrl,
      unit: status.unit,
      requestedAmount: String(status.amountSats),
      creditPolicy: { kind: 'exact-amount' },
      tokenDigest: status.tokenDigest,
      encodedTokenBytes: status.encodedTokenBytes,
    },
    receiptOperationId: status.receiptOperationId,
    receivedAtMs: Date.parse(status.receivedAt),
    creditedAmount: String(status.creditedScore),
    creditVerification: { kind: 'exact-amount' },
    businessEventId: status.businessEventId,
    creditedAtMs: Date.parse(status.creditedAt),
  })
}

export function decodeParticipationScorePaymentStatus(
  value: unknown,
): ParticipationScorePaymentStatusResponse {
  const status = requireExactObject(
    value,
    SCORE_STATUS_FIELDS,
    'Participation Score payment status',
  )
  if (status.schemaVersion !== 1 || status.status !== 'credited') {
    throw new Error('Participation Score payment status version or state is invalid')
  }
  const request = decodeScorePaymentRequest(status)
  const result = decodeScorePaymentResult(status, request)
  assertScorePaymentEvidence(request, result)
  return { schemaVersion: 1, status: 'credited', ...request, ...result }
}

const SCORE_STATUS_FIELDS = [
  'schemaVersion',
  'paymentId',
  'status',
  'accountSubject',
  'recipientKind',
  'purpose',
  'destinationId',
  'mintUrl',
  'unit',
  'amountSats',
  'tokenDigest',
  'encodedTokenBytes',
  'receiptOperationId',
  'receivedAt',
  'creditedScore',
  'businessEventId',
  'creditedAt',
] as const

function decodeScorePaymentRequest(
  status: Record<string, unknown>,
): ParticipationScorePaymentRequestFields {
  if (
    status.recipientKind !== 'matching-engine' ||
    status.purpose !== 'participation-score' ||
    status.destinationId !== 'participation-score' ||
    status.unit !== 'sat'
  ) {
    throw new Error('Participation Score payment route is invalid')
  }
  return {
    paymentId: requireUuid(status.paymentId, 'payment id'),
    accountSubject: requireBoundedText(status.accountSubject, 'account subject', 512),
    recipientKind: status.recipientKind,
    purpose: status.purpose,
    destinationId: status.destinationId,
    mintUrl: requireBoundedText(status.mintUrl, 'mint URL', 2_048),
    unit: status.unit,
    amountSats: requirePositiveSafeInteger(status.amountSats, 'payment amount'),
    tokenDigest: requireLowerHexDigest(status.tokenDigest),
    encodedTokenBytes: requireBoundedPositiveInteger(
      status.encodedTokenBytes,
      'encoded token bytes',
      65_536,
    ),
  }
}

function decodeScorePaymentResult(
  status: Record<string, unknown>,
  request: ParticipationScorePaymentRequestFields,
): ParticipationScorePaymentResultFields {
  const creditedScore = requirePositiveSafeInteger(status.creditedScore, 'credited Score')
  if (creditedScore !== request.amountSats) {
    throw new Error('Participation Score credit does not match its payment amount')
  }
  const receiptOperationId = requireBoundedText(
    status.receiptOperationId,
    'receipt operation id',
    512,
  )
  const businessEventId = requireUuid(status.businessEventId, 'business event id')
  if (
    receiptOperationId !== `score-receipt/${request.paymentId}` ||
    businessEventId !== request.paymentId
  ) {
    throw new Error('Participation Score payment result is misbound')
  }
  const receivedAt = requireTimestampText(status.receivedAt, 'received time')
  const creditedAt = requireTimestampText(status.creditedAt, 'credited time')
  if (Date.parse(creditedAt) < Date.parse(receivedAt)) {
    throw new Error('Participation Score credit precedes its receipt')
  }
  return {
    receiptOperationId,
    receivedAt,
    creditedScore,
    businessEventId,
    creditedAt,
  }
}

function assertScorePaymentEvidence(
  request: ParticipationScorePaymentRequestFields,
  result: ParticipationScorePaymentResultFields,
): void {
  const evidence = decodeDurableRecipientDeliveryEvidence({
    kind: 'credited',
    request: {
      schemaVersion: 1,
      deliveryId: request.paymentId,
      accountSubject: request.accountSubject,
      recipientKind: request.recipientKind,
      purpose: request.purpose,
      destinationId: request.destinationId,
      productBinding: participationScoreRecipientProductBinding(),
      mintUrl: request.mintUrl,
      unit: request.unit,
      requestedAmount: String(request.amountSats),
      creditPolicy: { kind: 'exact-amount' },
      tokenDigest: request.tokenDigest,
      encodedTokenBytes: request.encodedTokenBytes,
    },
    receiptOperationId: result.receiptOperationId,
    receivedAtMs: Date.parse(result.receivedAt),
    creditedAmount: String(result.creditedScore),
    creditVerification: { kind: 'exact-amount' },
    businessEventId: result.businessEventId,
    creditedAtMs: Date.parse(result.creditedAt),
  })
  if (evidence.kind !== 'credited') {
    throw new Error('Participation Score delivery evidence is invalid')
  }
}

export type PayParticipationScoreEcashResponse =
  | {
      paymentId: string
      status: 'pending'
      amountSats: number
      creditedScore?: never
      creditedAt?: never
    }
  | {
      paymentId: string
      status: 'credited'
      amountSats: number
      creditedScore: number
      creditedAt: string
    }

export class BitcasterEngineClient {
  private readonly baseUrl: string
  private readonly fetchImpl: EngineFetch
  private readonly authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.authorization = options.authorization
  }

  async submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    const bodyText = JSON.stringify(request)
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    return (await response.json()) as SubmitOrderResponse
  }

  async getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null> {
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders/${encodePathSegment(orderId)}`,
    )
    if (response.status === 404) return null
    return (await response.json()) as OrderStatusResponse
  }

  async listMyOrders(conditionId: string, cursor?: string): Promise<ListMyOrdersResponse> {
    return listMyOrders(this.baseUrl, conditionId, cursor, this.fetchImpl, this.authorization)
  }

  async batchSubmitOrders(
    conditionId: string,
    request: BatchSubmitOrdersRequest,
  ): Promise<BatchSubmitOrdersResponse> {
    const bodyText = JSON.stringify(request)
    const response = await this.request(
      `/api/v1/conditions/${encodePathSegment(conditionId)}/orders/batch`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    return (await response.json()) as BatchSubmitOrdersResponse
  }

  async batchCancelOrders(
    conditionId: string,
    request: BatchCancelOrdersRequest,
  ): Promise<BatchCancelOrdersResponse> {
    const bodyText = JSON.stringify(request)
    const response = await this.request(
      `/api/v1/conditions/${encodePathSegment(conditionId)}/orders/cancel-batch`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    return (await response.json()) as BatchCancelOrdersResponse
  }

  async submitEphemeralPubkey(
    tradeId: string,
    pubkey: string,
    conditionIdOrNostrEvent?: string | NostrKind1Event | null,
    nostrEvent?: NostrKind1Event | null,
  ): Promise<SubmitEphemeralPubkeyResponse> {
    const conditionId =
      typeof conditionIdOrNostrEvent === 'string' ? conditionIdOrNostrEvent : undefined
    const comment =
      typeof conditionIdOrNostrEvent === 'string' ? nostrEvent : conditionIdOrNostrEvent
    return submitEphemeralPubkey(
      this.baseUrl,
      tradeId,
      pubkey,
      comment,
      this.fetchImpl,
      this.authorization,
      conditionId,
    )
  }

  async cancelOrder(marketId: string, orderId: string): Promise<boolean> {
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders/${encodePathSegment(orderId)}`,
      { method: 'DELETE' },
    )
    return response.status !== 404
  }

  async getOrderBook(marketId: string): Promise<OrderBookSnapshot> {
    const response = await this.request(`/api/v1/${encodePathSegment(marketId)}/orderbook`)
    return (await response.json()) as OrderBookSnapshot
  }

  async queryMarkets(params: QueryMarketsParams = {}): Promise<QueryMarketsResponse> {
    const response = await this.request(`/api/v1/markets/query${buildMarketsQueryString(params)}`)
    return (await response.json()) as QueryMarketsResponse
  }

  async getMarketPriceHistory(
    conditionId: string,
    timeframe: PriceHistoryTimeframe = '7d',
  ): Promise<MarketPriceHistoryResponse> {
    const query = new URLSearchParams({ timeframe })
    const response = await this.request(
      `/api/v1/markets/${encodePathSegment(conditionId)}/price-history?${query}`,
    )
    return (await response.json()) as MarketPriceHistoryResponse
  }

  async getMarketComments(conditionId: string): Promise<MarketCommentsResponse> {
    const response = await this.request(
      `/api/v1/markets/${encodePathSegment(conditionId)}/comments`,
    )
    return (await response.json()) as MarketCommentsResponse
  }

  async getMarketFundingPayment(
    conditionId: string,
    depositId: string,
  ): Promise<MarketFundingPaymentStatusResponse | null> {
    const expectedConditionId = requireBoundedText(conditionId, 'condition id', 512)
    const expectedDepositId = requireUuid(depositId, 'deposit id')
    const response = await this.request(
      `/api/v1/markets/${encodePathSegment(expectedConditionId)}/deposit/${encodePathSegment(expectedDepositId)}`,
    )
    if (response.status === 404) return null
    const status = decodeMarketFundingPaymentStatus(await response.json())
    if (
      status.depositId !== expectedDepositId ||
      status.conditionId !== expectedConditionId
    ) {
      throw new Error('Market funding payment status does not match its request')
    }
    return status
  }

  async submitMarketFundingEcash(
    request: SubmitMarketFundingEcashRequest,
  ): Promise<SubmitMarketFundingEcashResponse> {
    const accountSubject = requireBoundedText(
      request.accountSubject,
      'account subject',
      512,
    )
    const conditionId = requireBoundedText(request.conditionId, 'condition id', 512)
    const depositId = requireUuid(request.depositId, 'deposit id')
    const amountSubunits = requirePositiveSafeInteger(
      request.amountSubunits,
      'deposit amount',
    )
    const mintUrl = normalizeDurableWalletMintUrl(request.mintUrl)
    const unit = requireMarketFundingUnit(request.unit)
    const divisibility = requireMarketFundingDivisibility(request.divisibility)
    const proofsToken = requireBoundedText(request.proofsToken, 'proofs token', 65_536)
    const bodyText = JSON.stringify({
      accountSubject,
      depositId,
      amountSubunits,
      proofsToken,
      mintUrl,
      unit,
      divisibility,
      ...(request.creatorPubkey ? { creatorPubkey: request.creatorPubkey } : {}),
      fundAmm: request.fundAmm ?? false,
    })
    const response = await this.request(
      `/api/v1/markets/${encodePathSegment(conditionId)}/deposit/ecash`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    const result = requireExactObject(
      await response.json(),
      ['depositId', 'state'],
      'Market funding payment response',
    )
    const responseDepositId = requireUuid(result.depositId, 'deposit id')
    if (responseDepositId !== depositId) {
      throw new Error('Market funding payment response does not match its request')
    }
    return {
      depositId: responseDepositId,
      state: requireMarketFundingState(result.state),
    }
  }

  async getParticipationScore(): Promise<ParticipationScoreResponse> {
    const response = await this.request('/api/v1/participation-score')
    return (await response.json()) as ParticipationScoreResponse
  }

  async getParticipationScorePayment(
    paymentId: string,
  ): Promise<ParticipationScorePaymentStatusResponse | null> {
    const response = await this.request(
      `/api/v1/participation-score/payments/${encodePathSegment(paymentId)}`,
    )
    if (response.status === 404) return null
    const status = decodeParticipationScorePaymentStatus(await response.json())
    if (status.paymentId !== paymentId) {
      throw new Error('Participation Score payment status does not match its request')
    }
    return status
  }

  async payParticipationScoreEcash(
    accountSubject: string,
    amountSats: number,
    proofsToken: string,
    paymentId?: string,
  ): Promise<PayParticipationScoreEcashResponse> {
    const expectedAccountSubject = requireBoundedText(
      accountSubject,
      'account subject',
      512,
    )
    const bodyText = JSON.stringify({
      accountSubject: expectedAccountSubject,
      amountSats,
      proofsToken,
      ...(paymentId ? { paymentId } : {}),
    })
    const response = await this.request(
      '/api/v1/participation-score/ecash',
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    const result = decodePayParticipationScoreEcashResponse(await response.json())
    if (
      result.amountSats !== amountSats ||
      (paymentId !== undefined && result.paymentId !== paymentId)
    ) {
      throw new Error('Participation Score payment response does not match its request')
    }
    return result
  }

  async getMarket(conditionId: string): Promise<unknown | null> {
    const response = await this.queryMarkets({
      ids: [conditionId],
      state: 'All',
      pageSize: 1,
    })
    return response.markets[0] ?? null
  }

  private async request(
    path: string,
    init: RequestInit = {},
    bodyText?: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = normalizeHeaders(init.headers)
    if (this.authorization) {
      headers.Authorization = await this.authorization({
        url,
        method: init.method ?? 'GET',
        bodyText,
      })
    }
    const response = await this.fetchImpl(url, { ...init, headers })
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '')
      const problem = parseEngineProblem(detail)
      throw new EngineClientError(response.status, detail, problem?.code, problem?.detail)
    }
    return response
  }
}

export async function submitEphemeralPubkey(
  baseUrl: string,
  tradeId: string,
  pubkey: string,
  nostrEvent?: NostrKind1Event | null,
  fetchImpl: EngineFetch = fetch,
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>,
  conditionId?: string,
): Promise<SubmitEphemeralPubkeyResponse> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const path = `/api/v1/trades/${encodePathSegment(tradeId)}/ephemeral-pubkey`
  const body: SubmitEphemeralPubkeyRequest & {
    comment?: NostrKind1Event | null
  } = {
    ephemeralPubkey: pubkey,
    ...(nostrEvent ? { comment: nostrEvent } : {}),
  }
  const bodyText = JSON.stringify(body)
  const query = conditionId ? `?conditionId=${encodeURIComponent(conditionId)}` : ''
  const url = `${normalizedBaseUrl}${path}${query}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) {
    headers.Authorization = await authorization({
      url,
      method: 'POST',
      bodyText,
    })
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    body: bodyText,
    headers,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const problem = parseEngineProblem(detail)
    throw new EngineClientError(response.status, detail, problem?.code, problem?.detail)
  }
  if (response.status === 204) {
    return { tradeId, role: '', bothReceived: false }
  }
  const text = await response.text()
  if (!text.trim()) return { tradeId, role: '', bothReceived: false }
  return JSON.parse(text) as SubmitEphemeralPubkeyResponse
}

export async function listMyOrders(
  baseUrl: string,
  conditionId: string,
  cursor?: string,
  fetchImpl: EngineFetch = fetch,
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>,
): Promise<ListMyOrdersResponse> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const query = new URLSearchParams({ conditionId })
  if (cursor) query.set('cursor', cursor)
  const path = `/api/v1/orders/mine?${query}`
  const url = `${normalizedBaseUrl}${path}`
  const headers: Record<string, string> = {}
  if (authorization) {
    headers.Authorization = await authorization({ url, method: 'GET' })
  }
  const response = await fetchImpl(url, { method: 'GET', headers })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const problem = parseEngineProblem(detail)
    throw new EngineClientError(response.status, detail, problem?.code, problem?.detail)
  }
  return (await response.json()) as ListMyOrdersResponse
}

function buildMarketsQueryString(params: QueryMarketsParams): string {
  const query = new URLSearchParams()
  if (params.state) query.set('state', params.state)
  if (params.sort) query.set('sort', params.sort)
  if (params.tag) query.set('tag', params.tag)
  const creatorPubkey = params.creatorPubkey ?? params.creator
  if (creatorPubkey) query.set('creator_pubkey', creatorPubkey)
  if (params.ids?.length) query.set('ids', params.ids.join(','))
  if (params.search) query.set('search', params.search)
  const pageSize = params.pageSize ?? params.limit
  if (pageSize !== undefined) query.set('page_size', String(pageSize))
  if (params.cursor) query.set('cursor', params.cursor)
  const text = query.toString()
  return text ? `?${text}` : ''
}

export class EngineClientError extends Error {
  public readonly status: number
  public readonly detail: string
  public readonly code?: string
  public readonly problemDetail?: string

  constructor(status: number, detail: string, code?: string, problemDetail?: string) {
    super(formatEngineClientError(status, detail, code, problemDetail))
    this.name = 'EngineClientError'
    this.status = status
    this.detail = detail
    this.code = code
    this.problemDetail = problemDetail
  }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment)
}

function formatEngineClientError(
  status: number,
  detail: string,
  code?: string,
  problemDetail?: string,
): string {
  if (problemDetail) {
    return code
      ? `Engine request failed: ${status} ${code}: ${problemDetail}`
      : `Engine request failed: ${status} ${problemDetail}`
  }
  const trimmed = detail.trim()
  return trimmed
    ? `Engine request failed: ${status} ${trimmed}`
    : `Engine request failed: ${status}`
}

function parseEngineProblem(text: string): EngineProblem | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const body = parsed as {
      code?: unknown
      detail?: unknown
      Code?: unknown
      Detail?: unknown
    }
    const code =
      typeof body.code === 'string'
        ? body.code
        : typeof body.Code === 'string'
          ? body.Code
          : undefined
    const detail =
      typeof body.detail === 'string'
        ? body.detail
        : typeof body.Detail === 'string'
          ? body.Detail
          : undefined
    return code || detail ? { code, detail } : null
  } catch {
    return null
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function decodePayParticipationScoreEcashResponse(
  value: unknown,
): PayParticipationScoreEcashResponse {
  const response = requireObject(value, 'Participation Score payment response')
  if (response.status === 'pending') {
    requireExactFields(response, ['paymentId', 'status', 'amountSats'])
    return {
      paymentId: requireUuid(response.paymentId, 'payment id'),
      status: 'pending',
      amountSats: requirePositiveSafeInteger(response.amountSats, 'payment amount'),
    }
  }
  if (response.status === 'credited') {
    requireExactFields(response, [
      'paymentId',
      'status',
      'amountSats',
      'creditedScore',
      'creditedAt',
    ])
    const amountSats = requirePositiveSafeInteger(response.amountSats, 'payment amount')
    const creditedScore = requirePositiveSafeInteger(response.creditedScore, 'credited Score')
    if (creditedScore !== amountSats) {
      throw new Error('Participation Score credit does not match its payment amount')
    }
    return {
      paymentId: requireUuid(response.paymentId, 'payment id'),
      status: 'credited',
      amountSats,
      creditedScore,
      creditedAt: requireTimestampText(response.creditedAt, 'credited time'),
    }
  }
  throw new Error('Participation Score payment response state is invalid')
}

function requireExactObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  const record = requireObject(value, name)
  requireExactFields(record, fields)
  return record
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireExactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error('Participation Score response fields are invalid')
  }
}

function requireUuid(value: unknown, name: string): string {
  const text = requireBoundedText(value, name, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`Participation Score ${name} is invalid`)
  }
  return text.toLowerCase()
}

function requireBoundedText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Participation Score ${name} is invalid`)
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  return requireBoundedPositiveInteger(value, name, Number.MAX_SAFE_INTEGER)
}

function requireBoundedPositiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`Participation Score ${name} is invalid`)
  }
  return value as number
}

function requireNullablePositiveSafeInteger(
  value: unknown,
  name: string,
): number | null {
  return value === null ? null : requirePositiveSafeInteger(value, name)
}

function requireNullableNonNegativeSafeInteger(
  value: unknown,
  name: string,
): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Engine ${name} is invalid`)
  }
  return value as number
}

function requireLowerHexDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Participation Score token digest is invalid')
  }
  return value
}

function requireNullableBoundedText(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  return value === null ? null : requireBoundedText(value, name, maxLength)
}

function requireTimestampText(value: unknown, name: string): string {
  const text = requireBoundedText(value, name, 64)
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Participation Score ${name} is invalid`)
  }
  return text
}

function requireNullableTimestampText(
  value: unknown,
  name: string,
): string | null {
  return value === null ? null : requireTimestampText(value, name)
}
