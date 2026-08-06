import {
  parseMarketDivisibility,
  type CtfCollateralUnit,
  type MarketBaseAsset,
  type MarketDivisibility,
} from './marketUnits.ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  readAllocationBoundedJsonResponse,
  readAllocationBoundedTextResponse,
} from './boundedJsonResponse.ts'
import type { WalletId } from './durableCustody.ts'

export type EngineFetch = typeof fetch
export const SETTLEMENT_CAPABILITY_RESULT_RESPONSE_BYTES_MAX = 384 * 1_024
export const SETTLEMENT_CAPABILITY_RESULT_ERROR_RESPONSE_BYTES_MAX = 64 * 1_024
export const SUBMIT_ORDER_RESPONSE_BYTES_MAX = 1024 * 1024
export const CONDITION_ATTESTATION_RESPONSE_BYTES_MAX = 64 * 1_024
const SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS = 10_000
const SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS_MAX = 60_000

export interface EngineClientOptions {
  baseUrl: string
  fetchImpl?: EngineFetch
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>
  settlementResultRequestTimeoutMs?: number
}

export interface EngineAuthorizationRequest {
  url: string
  method: string
  bodyText?: string
  payloadHash?: string
}

export interface SettlementCapabilityReference {
  artifactId: string
  bindingDigest: string
}

export interface SettlementOrderContinuationReference {
  predecessorOrderId: string
  settlementGroupId: string
  settlementGroupRevision: number
  continuationRevision: number
}

export function decodeSettlementOrderContinuationReference(
  value: unknown,
): SettlementOrderContinuationReference {
  const reference = exactEngineRecord(value, [
    'predecessorOrderId',
    'settlementGroupId',
    'settlementGroupRevision',
    'continuationRevision',
  ])
  requireUuid(reference.predecessorOrderId, 'continuation predecessor order id')
  requireUuid(reference.settlementGroupId, 'continuation settlement group id')
  requirePositiveSafeInteger(reference.settlementGroupRevision, 'continuation group revision')
  requirePositiveSafeInteger(reference.continuationRevision, 'continuation revision')
  return {
    predecessorOrderId: reference.predecessorOrderId as string,
    settlementGroupId: reference.settlementGroupId as string,
    settlementGroupRevision: reference.settlementGroupRevision as number,
    continuationRevision: reference.continuationRevision as number,
  }
}

export type SettlementCapabilityState =
  | 'staged'
  | 'bindingPending'
  | 'bound'
  | 'selected'
  | 'uncertain'
  | 'terminal'
  | 'quarantined'

export type OrderLifecycleStatus =
  | 'resting'
  | 'matched'
  | 'partially_filled'
  | 'awaiting_authorization'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'evicted_capacity'
  | 'rejected_capacity'
  | 'failed'

export type OrderTimeInForce = 'GTC' | 'FOK' | 'FAK' | 'GTD'

export interface SettlementOrderIntent {
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  minimumFillAmountSubunits: number
  baseAsset: MarketBaseAsset
  collateralUnit: CtfCollateralUnit
  timeInForce: OrderTimeInForce
  expiresAt: string | null
}

export interface CreateSettlementCapabilityRequest {
  stageIdempotencyKey: string
  clientOrderId: string
  marketId: string
  orderIntent: SettlementOrderIntent
  continuation: SettlementOrderContinuationReference | null
  artifact: string
}

export interface SettlementCapabilityResponse {
  reference: SettlementCapabilityReference
  orderId: string
  clientOrderId: string
  marketId: string
  artifactDigest: string
  state: SettlementCapabilityState
  version: number
  authorizationExpiresAt: string
  stageExpiresAt: string
  settlementGroup: SettlementGroupSummary | null
}

export interface SettlementCapabilityAdmissionPolicyResponse {
  coordinatorPubkey: string
}

export interface ConditionAttestationResponse {
  readonly conditionId: string
  readonly attestedOutcome: string
  readonly oracleWitness: unknown
  readonly registeredAuthority: unknown
}

export interface SettlementCapabilityResultResponse {
  resultId: string
  reference: SettlementCapabilityReference
  operationId: string
  requestDigest: string
  envelopeDigest: string
  envelope: string
  createdAt: string
  acknowledgedAt?: string | null
  version: number
  settlementGroup: SettlementGroupSummary
}

export interface AcknowledgeSettlementCapabilityResultRequest {
  expectedVersion: number
}

export interface SubmitOrderRequest {
  settlementCapability: SettlementCapabilityReference
  comment: NostrKind1Event | null
  walletId?: WalletId
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
  amountSubunits: number
  executionPrice: number
  path: 'Complementary' | 'Mint'
  status: 'Matched' | 'Filled' | 'Failed'
  filledAt: string
  settlementGroup: SettlementGroupSummary
  tradeId?: string
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  tokenSide: 'Outcome' | 'Complement'
  quotePaymentSubunits: number
  outcomeFaceAmountSubunits: number
}

export type SettlementGroupStatus =
  | 'Prepared'
  | 'SubmissionPending'
  | 'Reconciling'
  | 'Confirmed'
  | 'DefinitivelyRejected'
  | 'Refundable'
  | 'ExpiredBeforeSubmission'

export interface SettlementGroupSummary {
  groupId: string
  status: SettlementGroupStatus
  revision: number
  coalescingDeadline: string
  frozenAt: string | null
}

export interface SettlementGroupStateChangedDelta {
  readonly orderId: string
  readonly marketId: string
  readonly settlementGroup: SettlementGroupSummary
}

export interface SubmitOrderResponse {
  orderId: string
  status: OrderLifecycleStatus
  remainingAmountSubunits: number
  fills: Fill[]
  pendingPubkeySubmissions: PendingPubkeySubmission[]
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  activeSettlementGroup: SettlementGroupSummary | null
}

export interface PendingPubkeySubmission {
  tradeId: string
  role: 'maker' | 'taker'
  fillAmount: number
  deadline: string
}

export interface BatchSubmitOrdersRequest {
  orders: BatchSubmitOrderRequestItem[]
}

export interface BatchSubmitOrderRequestItem {
  settlementCapability: SettlementCapabilityReference
  walletId?: WalletId
}

export interface BatchSubmitOrdersResponse {
  accepted: BatchSubmitOrderSuccess[]
  rejected: BatchSubmitOrderFailure[]
}

export interface BatchSubmitOrderSuccess {
  requestIndex: number
  clientOrderId: string
  marketId: string
  orderId: string
  status: OrderLifecycleStatus
  remainingAmountSubunits: number
  fills: Fill[]
  pendingPubkeySubmissions: PendingPubkeySubmission[]
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  activeSettlementGroup: SettlementGroupSummary | null
}

export interface BatchSubmitOrderFailure {
  requestIndex: number
  errorCode: BatchSubmitOrderErrorCode
}

export type BatchSubmitOrderErrorCode =
  | 'capabilityNotFound'
  | 'capabilityNotCurrent'
  | 'routeMismatch'
  | 'authorityUnavailable'
  | 'participationScoreRequired'
  | 'marketClosed'
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
  status: OrderLifecycleStatus
  remainingAmountSubunits: number
  filledAmountSubunits: number
  fills: Fill[]
  amountSubunits: number
  outcomeId: string
  side: 'Buy' | 'Sell'
  price: number
  placedAt: string
  timeInForce: OrderTimeInForce
  expiresAt?: string | null
  tradeId?: string | null
  deadline?: string | null
  tokenSide: 'Outcome' | 'Complement'
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  activeSettlementGroup: SettlementGroupSummary | null
  continuation: OrderContinuationState | null
}

export interface OrderContinuationState {
  settlementGroupId: string
  settlementGroupRevision: number
  revision: number
  status: 'open' | 'consumed' | 'declined'
}

export interface OrderEntry {
  orderId: string
  marketId: string
  conditionId: string
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  remainingAmountSubunits: number
  tokenSide: 'Outcome' | 'Complement'
  status: OrderLifecycleStatus
  placedAt: string
  filledAt?: string | null
  tradeId?: string | null
  deadline?: string | null
  pubkeySubmitted?: boolean | null
  clientOrderId?: string | null
  activeSettlementGroup: SettlementGroupSummary | null
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
  pubkey: string
  balance: number
  purchasedTotal: number
  consumedTotal: number
  penaltyTotal: number
  matchDebitScore: number
  enabled: boolean
}

export interface PayParticipationScoreEcashResponse {
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
  private readonly settlementResultRequestTimeoutMs: number

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.authorization = options.authorization
    this.settlementResultRequestTimeoutMs =
      options.settlementResultRequestTimeoutMs ?? SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.settlementResultRequestTimeoutMs) ||
      this.settlementResultRequestTimeoutMs <= 0 ||
      this.settlementResultRequestTimeoutMs > SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS_MAX
    ) {
      throw new Error('settlement capability result request timeout is invalid')
    }
  }

  async createSettlementCapability(
    request: CreateSettlementCapabilityRequest,
  ): Promise<SettlementCapabilityResponse> {
    const bodyText = JSON.stringify(request)
    const response = await this.request(
      '/api/v1/settlement-capabilities',
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
    return (await response.json()) as SettlementCapabilityResponse
  }

  async getSettlementCapabilityAdmissionPolicy(): Promise<SettlementCapabilityAdmissionPolicyResponse> {
    const response = await this.request('/api/v1/settlement-capabilities/policy')
    return decodeSettlementCapabilityAdmissionPolicy(await response.json())
  }

  async getSettlementCapability(
    reference: SettlementCapabilityReference,
  ): Promise<SettlementCapabilityResponse | null> {
    const query = new URLSearchParams({ bindingDigest: reference.bindingDigest })
    return this.getOptional<SettlementCapabilityResponse>(
      `/api/v1/settlement-capabilities/${encodePathSegment(reference.artifactId)}?${query}`,
    )
  }

  async getSettlementCapabilityResult(
    resultId: string,
    signal?: AbortSignal,
  ): Promise<SettlementCapabilityResultResponse | null> {
    return this.requestSettlementCapabilityResult(
      `/api/v1/settlement-capability-results/${encodePathSegment(resultId)}`,
      {},
      undefined,
      signal,
    )
  }

  async getSettlementCapabilityResultByOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettlementCapabilityResultResponse | null> {
    const query = new URLSearchParams({ operationId })
    return this.requestSettlementCapabilityResult(
      `/api/v1/settlement-capability-results/by-operation?${query}`,
      {},
      undefined,
      signal,
    )
  }

  async acknowledgeSettlementCapabilityResult(
    resultId: string,
    request: AcknowledgeSettlementCapabilityResultRequest,
    signal?: AbortSignal,
  ): Promise<SettlementCapabilityResultResponse | null> {
    const bodyText = JSON.stringify(request)
    return this.requestSettlementCapabilityResult(
      `/api/v1/settlement-capability-results/${encodePathSegment(resultId)}/acknowledgement`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
      signal,
    )
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
    return decodeSubmitOrderResponse(
      await readAllocationBoundedJsonResponse(response, SUBMIT_ORDER_RESPONSE_BYTES_MAX),
    )
  }

  async getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null> {
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders/${encodePathSegment(orderId)}`,
      {},
      undefined,
      true,
    )
    if (response.status === 404) return null
    return decodeOrderStatusResponse(
      await readAllocationBoundedJsonResponse(response, SUBMIT_ORDER_RESPONSE_BYTES_MAX),
    )
  }

  async declineOrderContinuation(
    marketId: string,
    orderId: string,
    expectedContinuationRevision: number,
  ): Promise<void> {
    requireUuid(orderId, 'continuation order id')
    requirePositiveSafeInteger(expectedContinuationRevision, 'continuation revision')
    const bodyText = JSON.stringify({ expectedContinuationRevision })
    await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders/${encodePathSegment(orderId)}/continuation/decline`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
    )
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
      undefined,
      true,
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

  async getParticipationScore(): Promise<ParticipationScoreResponse> {
    const response = await this.request('/api/v1/participation-score')
    return (await response.json()) as ParticipationScoreResponse
  }

  async payParticipationScoreEcash(
    amountSats: number,
    proofsToken: string,
    paymentId?: string,
  ): Promise<PayParticipationScoreEcashResponse> {
    const bodyText = JSON.stringify({
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
    return (await response.json()) as PayParticipationScoreEcashResponse
  }

  async getMarket(conditionId: string): Promise<unknown | null> {
    const response = await this.queryMarkets({
      ids: [conditionId],
      state: 'All',
      pageSize: 1,
    })
    return response.markets[0] ?? null
  }

  async getConditionAttestation(conditionId: string): Promise<ConditionAttestationResponse | null> {
    const response = await this.request(
      `/api/v1/conditions/${encodePathSegment(conditionId)}/attestation`,
      {},
      undefined,
      true,
    )
    if (response.status === 404) return null
    const value = exactEngineRecord(
      await readAllocationBoundedJsonResponse(response, CONDITION_ATTESTATION_RESPONSE_BYTES_MAX),
      ['conditionId', 'attestedOutcome', 'oracleWitness', 'registeredAuthority'],
    )
    if (typeof value.conditionId !== 'string' || typeof value.attestedOutcome !== 'string') {
      throw new Error('condition attestation response is invalid')
    }
    return {
      conditionId: value.conditionId,
      attestedOutcome: value.attestedOutcome,
      oracleWitness: value.oracleWitness,
      registeredAuthority: value.registeredAuthority,
    }
  }

  private async getOptional<T>(path: string): Promise<T | null> {
    const response = await this.request(path, {}, undefined, true)
    if (response.status === 404) return null
    return (await response.json()) as T
  }

  private async request(
    path: string,
    init: RequestInit = {},
    bodyText?: string,
    allowNotFound = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = await this.authorizedHeaders(url, init, bodyText)
    const response = await this.fetchImpl(url, { ...init, headers })
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      const detail = await response.text().catch(() => '')
      const problem = parseEngineProblem(detail)
      throw new EngineClientError(response.status, detail, problem?.code, problem?.detail)
    }
    return response
  }

  private async requestSettlementCapabilityResult(
    path: string,
    init: RequestInit,
    bodyText: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<SettlementCapabilityResultResponse | null> {
    const url = `${this.baseUrl}${path}`
    const headers = await this.authorizedHeaders(url, init, bodyText)
    const lifetime = createSettlementResultRequestLifetime(
      callerSignal,
      this.settlementResultRequestTimeoutMs,
    )
    try {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers,
          redirect: 'error',
          signal: lifetime.signal,
        })
      } catch {
        throw new Error('settlement capability result request failed')
      }
      if (lifetime.signal.aborted) {
        await response.body?.cancel().catch(() => {})
        throw new Error('settlement capability result request failed')
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      if (!response.ok) throw await boundedSettlementResultError(response)
      try {
        return await readSettlementCapabilityResultResponse(response)
      } catch (error) {
        if (lifetime.signal.aborted) {
          throw new Error('settlement capability result request failed')
        }
        throw error
      }
    } finally {
      lifetime.dispose()
    }
  }

  private async authorizedHeaders(
    url: string,
    init: RequestInit,
    bodyText: string | undefined,
  ): Promise<Record<string, string>> {
    const headers = normalizeHeaders(init.headers)
    if (this.authorization) {
      headers.Authorization = await this.authorization({
        url,
        method: init.method ?? 'GET',
        bodyText,
      })
    }
    return headers
  }
}

async function readSettlementCapabilityResultResponse(
  response: Response,
): Promise<SettlementCapabilityResultResponse> {
  return (await readAllocationBoundedJsonResponse(
    response,
    SETTLEMENT_CAPABILITY_RESULT_RESPONSE_BYTES_MAX,
  )) as SettlementCapabilityResultResponse
}

export function decodeSubmitOrderResponse(value: unknown): SubmitOrderResponse {
  const response = exactEngineRecord(value, [
    'orderId',
    'status',
    'remainingAmountSubunits',
    'fills',
    'pendingPubkeySubmissions',
    'baseAsset',
    'divisibility',
    'activeSettlementGroup',
  ])
  requireUuid(response.orderId, 'order id')
  requireOrderStatus(response.status)
  requireNonnegativeSafeInteger(response.remainingAmountSubunits, 'remaining order amount')
  const fills = boundedEngineArray(response.fills, 512, 'order fills').map(decodeFill)
  const pendingPubkeySubmissions = boundedEngineArray(
    response.pendingPubkeySubmissions,
    512,
    'pending public-key submissions',
  ).map(decodePendingPubkeySubmission)
  if (response.baseAsset !== 'sat') throw new Error('order response base asset is invalid')
  const divisibility = parseMarketDivisibility(response.divisibility)
  if (divisibility === null) throw new Error('order response divisibility is invalid')
  const activeSettlementGroup =
    response.activeSettlementGroup === null
      ? null
      : decodeSettlementGroup(response.activeSettlementGroup)
  return {
    orderId: response.orderId as string,
    status: response.status as OrderLifecycleStatus,
    remainingAmountSubunits: response.remainingAmountSubunits as number,
    fills,
    pendingPubkeySubmissions,
    baseAsset: 'sat',
    divisibility,
    activeSettlementGroup,
  }
}

export function decodeOrderStatusResponse(value: unknown): OrderStatusResponse {
  const response = exactEngineRecord(
    value,
    [
      'orderId',
      'marketId',
      'status',
      'remainingAmountSubunits',
      'filledAmountSubunits',
      'fills',
      'amountSubunits',
      'outcomeId',
      'side',
      'price',
      'placedAt',
      'timeInForce',
      'tokenSide',
      'baseAsset',
      'divisibility',
      'activeSettlementGroup',
      'continuation',
    ],
    ['expiresAt', 'tradeId', 'deadline'],
  )
  requireUuid(response.orderId, 'order id')
  if (typeof response.marketId !== 'string' || response.marketId.length < 1) {
    throw new Error('order market id is invalid')
  }
  requireOrderStatus(response.status)
  requireNonnegativeSafeInteger(response.remainingAmountSubunits, 'remaining order amount')
  requireNonnegativeSafeInteger(response.filledAmountSubunits, 'filled order amount')
  const fills = boundedEngineArray(response.fills, 512, 'order fills').map(decodeFill)
  if (response.tokenSide !== 'Outcome' && response.tokenSide !== 'Complement') {
    throw new Error('order token side is invalid')
  }
  if (response.baseAsset !== 'sat') throw new Error('order base asset is invalid')
  const divisibility = parseMarketDivisibility(response.divisibility)
  if (divisibility === null) throw new Error('order divisibility is invalid')
  const orderFields = decodeOrderStatusFields(response, divisibility)
  const activeSettlementGroup =
    response.activeSettlementGroup === null
      ? null
      : decodeSettlementGroup(response.activeSettlementGroup)
  const continuation =
    response.continuation === null ? null : decodeOrderContinuationState(response.continuation)
  return {
    orderId: response.orderId as string,
    marketId: response.marketId,
    status: response.status,
    remainingAmountSubunits: response.remainingAmountSubunits as number,
    filledAmountSubunits: response.filledAmountSubunits as number,
    fills,
    ...orderFields,
    tokenSide: response.tokenSide,
    baseAsset: 'sat',
    divisibility,
    activeSettlementGroup,
    continuation,
  }
}

function decodeOrderStatusFields(
  response: Record<string, unknown>,
  divisibility: MarketDivisibility,
): Pick<
  OrderStatusResponse,
  | 'amountSubunits'
  | 'outcomeId'
  | 'side'
  | 'price'
  | 'placedAt'
  | 'timeInForce'
  | 'expiresAt'
  | 'tradeId'
  | 'deadline'
> {
  requirePositiveSafeInteger(response.amountSubunits, 'order amount')
  if (typeof response.outcomeId !== 'string' || response.outcomeId.length === 0) {
    throw new Error('order outcome id is invalid')
  }
  if (response.side !== 'Buy' && response.side !== 'Sell') {
    throw new Error('order side is invalid')
  }
  requirePositiveSafeInteger(response.price, 'order price')
  if (response.price >= divisibility) throw new Error('order price is invalid')
  requireIsoEngineTime(response.placedAt, 'order placed time')
  if (
    response.timeInForce !== 'GTC' &&
    response.timeInForce !== 'GTD' &&
    response.timeInForce !== 'FOK' &&
    response.timeInForce !== 'FAK'
  ) {
    throw new Error('order time in force is invalid')
  }
  requireOptionalIsoEngineTime(response.expiresAt, 'order expiry')
  if (response.tradeId !== undefined && response.tradeId !== null) {
    requireUuid(response.tradeId, 'order trade id')
  }
  requireOptionalIsoEngineTime(response.deadline, 'order deadline')
  return {
    amountSubunits: response.amountSubunits,
    outcomeId: response.outcomeId,
    side: response.side,
    price: response.price,
    placedAt: response.placedAt as string,
    timeInForce: response.timeInForce,
    ...(response.expiresAt === undefined ? {} : { expiresAt: response.expiresAt as string | null }),
    ...(response.tradeId === undefined ? {} : { tradeId: response.tradeId as string | null }),
    ...(response.deadline === undefined ? {} : { deadline: response.deadline as string | null }),
  }
}

function requireOptionalIsoEngineTime(value: unknown, name: string): void {
  if (value !== undefined && value !== null) requireIsoEngineTime(value, name)
}

function decodeOrderContinuationState(value: unknown): OrderContinuationState {
  const state = exactEngineRecord(value, [
    'settlementGroupId',
    'settlementGroupRevision',
    'revision',
    'status',
  ])
  requireUuid(state.settlementGroupId, 'continuation settlement group id')
  requirePositiveSafeInteger(state.settlementGroupRevision, 'continuation group revision')
  requirePositiveSafeInteger(state.revision, 'continuation revision')
  if (state.status !== 'open' && state.status !== 'consumed' && state.status !== 'declined') {
    throw new Error('order continuation status is invalid')
  }
  return {
    settlementGroupId: state.settlementGroupId as string,
    settlementGroupRevision: state.settlementGroupRevision as number,
    revision: state.revision as number,
    status: state.status,
  }
}

function decodeFill(value: unknown): Fill {
  const fill = exactEngineRecord(
    value,
    [
      'id',
      'makerOrderId',
      'takerOrderId',
      'amountSubunits',
      'executionPrice',
      'path',
      'status',
      'filledAt',
      'settlementGroup',
      'baseAsset',
      'divisibility',
      'tokenSide',
      'quotePaymentSubunits',
      'outcomeFaceAmountSubunits',
    ],
    ['tradeId'],
  )
  requireUuid(fill.id, 'fill id')
  requireUuid(fill.makerOrderId, 'maker order id')
  requireUuid(fill.takerOrderId, 'taker order id')
  requirePositiveSafeInteger(fill.amountSubunits, 'fill amount')
  if (fill.path !== 'Complementary' && fill.path !== 'Mint') {
    throw new Error('fill path is invalid')
  }
  if (fill.status !== 'Matched' && fill.status !== 'Filled' && fill.status !== 'Failed') {
    throw new Error('fill status is invalid')
  }
  requireIsoEngineTime(fill.filledAt, 'fill time')
  if (fill.baseAsset !== 'sat') throw new Error('fill base asset is invalid')
  const divisibility = parseMarketDivisibility(fill.divisibility)
  if (divisibility === null) throw new Error('fill divisibility is invalid')
  requirePositiveSafeInteger(fill.executionPrice, 'fill execution price')
  if ((fill.executionPrice as number) >= divisibility) {
    throw new Error('fill execution price is invalid')
  }
  if (fill.tokenSide !== 'Outcome' && fill.tokenSide !== 'Complement') {
    throw new Error('fill token side is invalid')
  }
  requireNonnegativeSafeInteger(fill.quotePaymentSubunits, 'fill quote payment')
  requirePositiveSafeInteger(fill.outcomeFaceAmountSubunits, 'fill outcome amount')
  if (fill.tradeId !== undefined) requireUuid(fill.tradeId, 'fill trade id')
  return {
    id: fill.id as string,
    makerOrderId: fill.makerOrderId as string,
    takerOrderId: fill.takerOrderId as string,
    amountSubunits: fill.amountSubunits as number,
    executionPrice: fill.executionPrice as number,
    path: fill.path,
    status: fill.status,
    filledAt: fill.filledAt as string,
    settlementGroup: decodeSettlementGroup(fill.settlementGroup),
    ...(fill.tradeId === undefined ? {} : { tradeId: fill.tradeId as string }),
    baseAsset: 'sat',
    divisibility,
    tokenSide: fill.tokenSide,
    quotePaymentSubunits: fill.quotePaymentSubunits as number,
    outcomeFaceAmountSubunits: fill.outcomeFaceAmountSubunits as number,
  }
}

function decodePendingPubkeySubmission(value: unknown): PendingPubkeySubmission {
  const pending = exactEngineRecord(value, ['tradeId', 'role', 'fillAmount', 'deadline'])
  requireUuid(pending.tradeId, 'pending trade id')
  if (pending.role !== 'maker' && pending.role !== 'taker') {
    throw new Error('pending public-key role is invalid')
  }
  requirePositiveSafeInteger(pending.fillAmount, 'pending fill amount')
  requireIsoEngineTime(pending.deadline, 'pending public-key deadline')
  return {
    tradeId: pending.tradeId as string,
    role: pending.role,
    fillAmount: pending.fillAmount as number,
    deadline: pending.deadline as string,
  }
}

function decodeSettlementGroup(value: unknown): SettlementGroupSummary {
  const group = exactEngineRecord(value, [
    'groupId',
    'status',
    'revision',
    'coalescingDeadline',
    'frozenAt',
  ])
  requireUuid(group.groupId, 'settlement group id')
  if (
    group.status !== 'Prepared' &&
    group.status !== 'SubmissionPending' &&
    group.status !== 'Reconciling' &&
    group.status !== 'Confirmed' &&
    group.status !== 'DefinitivelyRejected' &&
    group.status !== 'Refundable' &&
    group.status !== 'ExpiredBeforeSubmission'
  ) {
    throw new Error('settlement group status is invalid')
  }
  requireNonnegativeSafeInteger(group.revision, 'settlement group revision')
  requireIsoEngineTime(group.coalescingDeadline, 'settlement group deadline')
  if (group.frozenAt !== null) requireIsoEngineTime(group.frozenAt, 'settlement group freeze time')
  return {
    groupId: group.groupId as string,
    status: group.status,
    revision: group.revision as number,
    coalescingDeadline: group.coalescingDeadline as string,
    frozenAt: group.frozenAt as string | null,
  }
}

export function decodeSettlementGroupStateChangedDelta(
  value: unknown,
): SettlementGroupStateChangedDelta {
  const delta = exactEngineRecord(value, ['orderId', 'marketId', 'settlementGroup'])
  requireUuid(delta.orderId, 'settlement group order id')
  if (typeof delta.marketId !== 'string' || delta.marketId.length === 0) {
    throw new Error('settlement group market id is invalid')
  }
  return {
    orderId: delta.orderId,
    marketId: delta.marketId,
    settlementGroup: decodeSettlementGroup(delta.settlementGroup),
  }
}

function requireOrderStatus(value: unknown): asserts value is OrderLifecycleStatus {
  if (
    value !== 'resting' &&
    value !== 'matched' &&
    value !== 'partially_filled' &&
    value !== 'awaiting_authorization' &&
    value !== 'filled' &&
    value !== 'cancelled' &&
    value !== 'expired' &&
    value !== 'evicted_capacity' &&
    value !== 'rejected_capacity' &&
    value !== 'failed'
  ) {
    throw new Error('order response status is invalid')
  }
}

function exactEngineRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('engine response object is invalid')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error('engine response fields are invalid')
  }
  return record
}

function boundedEngineArray(value: unknown, maximum: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} are invalid`)
  }
  return value
}

function requireUuid(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`${name} is invalid`)
  }
}

function requireNonnegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid`)
  }
}

function requirePositiveSafeInteger(value: unknown, name: string): asserts value is number {
  requireNonnegativeSafeInteger(value, name)
  if (value === 0) throw new Error(`${name} is invalid`)
}

function requireIsoEngineTime(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${name} is invalid`)
  }
}

async function boundedSettlementResultError(response: Response): Promise<EngineClientError> {
  let detail = ''
  try {
    detail = await readAllocationBoundedTextResponse(
      response,
      SETTLEMENT_CAPABILITY_RESULT_ERROR_RESPONSE_BYTES_MAX,
    )
  } catch {
    detail = ''
  }
  const problem = parseEngineProblem(detail)
  return new EngineClientError(response.status, detail, problem?.code, problem?.detail)
}

function createSettlementResultRequestLifetime(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(forwardAbort, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', forwardAbort)
    },
  }
}

function decodeSettlementCapabilityAdmissionPolicy(
  value: unknown,
): SettlementCapabilityAdmissionPolicyResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'coordinatorPubkey')
  ) {
    throw new Error('settlement capability admission policy is malformed')
  }
  const coordinatorPubkey = (value as { coordinatorPubkey?: unknown }).coordinatorPubkey
  if (typeof coordinatorPubkey !== 'string' || !/^[0-9a-f]{64}$/.test(coordinatorPubkey)) {
    throw new Error('settlement coordinator public key is malformed')
  }
  try {
    secp256k1.Point.fromHex(`02${coordinatorPubkey}`)
  } catch (error) {
    throw new Error('settlement coordinator public key is invalid', { cause: error })
  }
  return { coordinatorPubkey }
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
  const body: SubmitEphemeralPubkeyRequest & { comment?: NostrKind1Event | null } = {
    ephemeralPubkey: pubkey,
    ...(nostrEvent ? { comment: nostrEvent } : {}),
  }
  const bodyText = JSON.stringify(body)
  const query = conditionId ? `?conditionId=${encodeURIComponent(conditionId)}` : ''
  const url = `${normalizedBaseUrl}${path}${query}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) {
    headers.Authorization = await authorization({ url, method: 'POST', bodyText })
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

const RETRYABLE_ORDER_BOOK_CONFLICT =
  'Order book changed while submitting order; retry the request.'

export function isDefinitiveOrderSubmissionError(error: EngineClientError): boolean {
  if (
    error.status < 400 ||
    error.status >= 500 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429
  ) {
    return false
  }
  if (error.status !== 409) return true
  return orderSubmissionErrorDetail(error) !== RETRYABLE_ORDER_BOOK_CONFLICT
}

function orderSubmissionErrorDetail(error: EngineClientError): string {
  if (error.problemDetail !== undefined) return error.problemDetail
  const detail = error.detail.trim()
  try {
    const parsed = JSON.parse(detail) as unknown
    return typeof parsed === 'string' ? parsed : detail
  } catch {
    return detail
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
