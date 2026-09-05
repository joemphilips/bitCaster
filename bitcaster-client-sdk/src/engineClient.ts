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
import {
  ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
  ASSET_MONITORING_RESPONSE_BYTES_MAX,
  canonicalizeAssetMonitoringReportRequest,
  decodeAssetMonitoringAssetsQuery,
  decodeAssetMonitoringAssetsResponse,
  decodeAssetMonitoringHistoryQuery,
  decodeAssetMonitoringHistoryResponse,
  decodeAssetMonitoringPortfolioQuery,
  decodeAssetMonitoringPortfolioResponse,
  decodeAssetMonitoringSummaryResponse,
  decodeAssetMonitoringWalletId,
  type AssetMonitoringAssetsQuery,
  type AssetMonitoringAssetsResponse,
  type AssetMonitoringHistoryQuery,
  type AssetMonitoringHistoryResponse,
  type AssetMonitoringPortfolioQuery,
  type AssetMonitoringPortfolioResponse,
  type AssetMonitoringReportRequest,
  type AssetMonitoringSummaryResponse,
} from './assetMonitoring.ts'
import type { WalletId } from './durableCustody.ts'
import {
  decodeDurableRecipientDeliveryStatus,
  decodeDurableRecipientDeliverySubmission,
  type DurableRecipientDeliveryStatus,
  type DurableRecipientDeliverySubmission,
} from './durableRecipientDelivery.ts'
import {
  canonicalizePreviewFokOrderRequest,
  decodePreviewFokOrderResponse,
  FOK_PREVIEW_RESPONSE_BYTES_MAX,
  type PreviewFokOrderRequest,
  type PreviewFokOrderResponse,
} from './fokOrderPreview.ts'

export type EngineFetch = typeof fetch
export const SETTLEMENT_CAPABILITY_RESULT_RESPONSE_BYTES_MAX = 384 * 1_024
export const SETTLEMENT_CAPABILITY_RESULT_ERROR_RESPONSE_BYTES_MAX = 64 * 1_024
export const SUBMIT_ORDER_RESPONSE_BYTES_MAX = 1024 * 1024
export const CONDITION_ATTESTATION_RESPONSE_BYTES_MAX = 64 * 1_024
export const DURABLE_RECIPIENT_DELIVERY_RESPONSE_BYTES_MAX = 64 * 1_024
const SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS = 10_000
const SETTLEMENT_CAPABILITY_RESULT_REQUEST_TIMEOUT_MS_MAX = 60_000
const DURABLE_RECIPIENT_DELIVERY_REQUEST_TIMEOUT_MS = 10_000
const DURABLE_RECIPIENT_DELIVERY_REQUEST_TIMEOUT_MS_MAX = 60_000

export interface EngineClientOptions {
  baseUrl: string
  fetchImpl?: EngineFetch
  authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>
  settlementResultRequestTimeoutMs?: number
  durableRecipientDeliveryRequestTimeoutMs?: number
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
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'evicted_capacity'
  | 'rejected_capacity'
  | 'failed'

export type OrderTimeInForce = 'GTC' | 'FOK' | 'FAK' | 'GTD'
export type SettlementCapabilityTimeInForce = 'FOK'

export interface SettlementOrderIntent {
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  minimumFillAmountSubunits: number
  baseAsset: MarketBaseAsset
  collateralUnit: CtfCollateralUnit
  timeInForce: SettlementCapabilityTimeInForce
  expiresAt: string | null
}

export interface CreateSettlementCapabilityRequest {
  stageIdempotencyKey: string
  clientOrderId: string
  marketId: string
  orderIntent: SettlementOrderIntent
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

export interface MatchedDelta {
  readonly marketId: string
  readonly fillId: string
  readonly makerOrderId: string
  readonly takerOrderId: string
  readonly executionPrice: number
  readonly amountSubunits: number
  readonly path: 'Complementary' | 'Mint'
  readonly matchedAt: string
  readonly baseAsset: MarketBaseAsset
  readonly collateralUnit: 'msat'
  readonly divisibility: MarketDivisibility
  readonly quotePaymentSubunits: number
  readonly outcomeFaceAmountSubunits: number
  readonly tokenSide: 'Outcome' | 'Complement'
}

export interface OrderLifecycleChangedDelta {
  readonly orderId: string
  readonly marketId: string
  readonly status: OrderLifecycleStatus
  readonly remainingAmountSubunits: number
  readonly baseAsset: MarketBaseAsset
  readonly collateralUnit: 'msat'
  readonly divisibility: MarketDivisibility
  readonly activeSettlementGroup: SettlementGroupSummary | null
}

export interface SubmitOrderResponse {
  orderId: string
  status: OrderLifecycleStatus
  remainingAmountSubunits: number
  fills: Fill[]
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  activeSettlementGroup: SettlementGroupSummary | null
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
  | 'marketClosed'
  | 'bookRejected'

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
  tokenSide: 'Outcome' | 'Complement'
  baseAsset: MarketBaseAsset
  divisibility: MarketDivisibility
  activeSettlementGroup: SettlementGroupSummary | null
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
  enabled: boolean
}

export class BitcasterEngineClient {
  private readonly baseUrl: string
  private readonly fetchImpl: EngineFetch
  private readonly authorization?: (request: EngineAuthorizationRequest) => string | Promise<string>
  private readonly settlementResultRequestTimeoutMs: number
  private readonly durableRecipientDeliveryRequestTimeoutMs: number

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
    this.durableRecipientDeliveryRequestTimeoutMs =
      options.durableRecipientDeliveryRequestTimeoutMs ??
      DURABLE_RECIPIENT_DELIVERY_REQUEST_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.durableRecipientDeliveryRequestTimeoutMs) ||
      this.durableRecipientDeliveryRequestTimeoutMs <= 0 ||
      this.durableRecipientDeliveryRequestTimeoutMs >
        DURABLE_RECIPIENT_DELIVERY_REQUEST_TIMEOUT_MS_MAX
    ) {
      throw new Error('durable recipient delivery request timeout is invalid')
    }
  }

  async submitAssetMonitoringReport(request: AssetMonitoringReportRequest): Promise<void> {
    const bodyText = JSON.stringify(canonicalizeAssetMonitoringReportRequest(request))
    await this.request(
      '/api/v1/asset-monitoring/reports',
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
      false,
      ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
    )
  }

  async getAssetMonitoringSummary(walletId: string): Promise<AssetMonitoringSummaryResponse> {
    const query = new URLSearchParams({ walletId: decodeAssetMonitoringWalletId(walletId) })
    const response = await this.request(
      `/api/v1/asset-monitoring/summary?${query}`,
      {},
      undefined,
      false,
      ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
    )
    return decodeAssetMonitoringSummaryResponse(
      await readAllocationBoundedJsonResponse(response, ASSET_MONITORING_RESPONSE_BYTES_MAX),
    )
  }

  async getAssetMonitoringAssets(
    queryInput: AssetMonitoringAssetsQuery,
  ): Promise<AssetMonitoringAssetsResponse> {
    const query = assetMonitoringAssetsQueryString(decodeAssetMonitoringAssetsQuery(queryInput))
    const response = await this.request(
      `/api/v1/asset-monitoring/assets?${query}`,
      {},
      undefined,
      false,
      ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
    )
    return decodeAssetMonitoringAssetsResponse(
      await readAllocationBoundedJsonResponse(response, ASSET_MONITORING_RESPONSE_BYTES_MAX),
    )
  }

  async getAssetMonitoringHistory(
    queryInput: AssetMonitoringHistoryQuery,
  ): Promise<AssetMonitoringHistoryResponse> {
    const query = assetMonitoringHistoryQueryString(decodeAssetMonitoringHistoryQuery(queryInput))
    const response = await this.request(
      `/api/v1/asset-monitoring/history?${query}`,
      {},
      undefined,
      false,
      ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
    )
    return decodeAssetMonitoringHistoryResponse(
      await readAllocationBoundedJsonResponse(response, ASSET_MONITORING_RESPONSE_BYTES_MAX),
    )
  }

  async getPortfolio(
    queryInput: AssetMonitoringPortfolioQuery,
  ): Promise<AssetMonitoringPortfolioResponse> {
    const query = assetMonitoringPortfolioQueryString(
      decodeAssetMonitoringPortfolioQuery(queryInput),
    )
    const response = await this.request(
      `/api/v1/portfolio?${query}`,
      {},
      undefined,
      false,
      ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX,
    )
    return decodeAssetMonitoringPortfolioResponse(
      await readAllocationBoundedJsonResponse(response, ASSET_MONITORING_RESPONSE_BYTES_MAX),
    )
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

  async previewFokOrder(
    request: PreviewFokOrderRequest,
    signal?: AbortSignal,
  ): Promise<PreviewFokOrderResponse> {
    const bodyText = JSON.stringify(canonicalizePreviewFokOrderRequest(request))
    const response = await this.request(
      '/api/v1/orders/preview',
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
        signal,
      },
      bodyText,
      false,
      FOK_PREVIEW_RESPONSE_BYTES_MAX,
    )
    return decodePreviewFokOrderResponse(
      await readAllocationBoundedJsonResponse(response, FOK_PREVIEW_RESPONSE_BYTES_MAX),
      request,
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

  async getDurableRecipientDeliveryStatus(
    deliveryId: string,
  ): Promise<DurableRecipientDeliveryStatus | null> {
    return this.requestDurableRecipientDelivery(
      `/api/v1/cashu-deliveries/${encodePathSegment(deliveryId)}`,
      {},
      undefined,
      true,
      async (response) => {
        if (response.status === 404) return null
        return decodeDurableRecipientDeliveryStatus(
          await readAllocationBoundedJsonResponse(
            response,
            DURABLE_RECIPIENT_DELIVERY_RESPONSE_BYTES_MAX,
          ),
        )
      },
    )
  }

  async submitDurableRecipientDelivery(
    submission: DurableRecipientDeliverySubmission,
  ): Promise<DurableRecipientDeliveryStatus> {
    const exact = decodeDurableRecipientDeliverySubmission(submission)
    const bodyText = JSON.stringify(exact)
    return this.requestDurableRecipientDelivery(
      `/api/v1/cashu-deliveries/${encodePathSegment(exact.deliveryId)}`,
      {
        method: 'POST',
        body: bodyText,
        headers: { 'content-type': 'application/json' },
      },
      bodyText,
      false,
      async (response) =>
        decodeDurableRecipientDeliveryStatus(
          await readAllocationBoundedJsonResponse(
            response,
            DURABLE_RECIPIENT_DELIVERY_RESPONSE_BYTES_MAX,
          ),
        ),
    )
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
    errorResponseBytesMax?: number,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = await this.authorizedHeaders(url, init, bodyText)
    const response = await this.fetchImpl(url, { ...init, headers })
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      const detail =
        errorResponseBytesMax === undefined
          ? await response.text().catch(() => '')
          : await readAllocationBoundedTextResponse(response, errorResponseBytesMax).catch(() => '')
      const problem = parseEngineProblem(detail)
      throw new EngineClientError(
        response.status,
        detail,
        problem?.code,
        problem?.detail,
        response.status === 429 ? parseRetryAfterHeader(response.headers.get('retry-after')) : undefined,
      )
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
    const lifetime = createBoundedRequestLifetime(
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

  private async requestDurableRecipientDelivery<T>(
    path: string,
    init: RequestInit,
    bodyText: string | undefined,
    allowNotFound: boolean,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers = await this.authorizedHeaders(url, init, bodyText)
    const lifetime = createBoundedRequestLifetime(
      undefined,
      this.durableRecipientDeliveryRequestTimeoutMs,
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
        throw new Error('durable recipient delivery request failed')
      }
      if (lifetime.signal.aborted) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('durable recipient delivery request failed')
      }
      if (!response.ok && !(allowNotFound && response.status === 404)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`durable recipient delivery request failed: HTTP ${response.status}`)
      }
      if (allowNotFound && response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
      }
      try {
        return await read(response)
      } catch (error) {
        if (lifetime.signal.aborted) {
          throw new Error('durable recipient delivery request failed')
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

function assetMonitoringAssetsQueryString(queryInput: AssetMonitoringAssetsQuery): string {
  const query = new URLSearchParams({ walletId: queryInput.walletId })
  if (queryInput.pageSize !== undefined) query.set('pageSize', String(queryInput.pageSize))
  if (queryInput.cursor !== undefined) query.set('cursor', queryInput.cursor)
  return query.toString()
}

function assetMonitoringHistoryQueryString(queryInput: AssetMonitoringHistoryQuery): string {
  const query = new URLSearchParams({ walletId: queryInput.walletId })
  if (queryInput.timeframe !== undefined) query.set('timeframe', queryInput.timeframe)
  return query.toString()
}

function assetMonitoringPortfolioQueryString(queryInput: AssetMonitoringPortfolioQuery): string {
  const query = new URLSearchParams({ walletId: queryInput.walletId })
  if (queryInput.timeframe !== undefined) query.set('timeframe', queryInput.timeframe)
  if (queryInput.pageSize !== undefined) query.set('pageSize', String(queryInput.pageSize))
  return query.toString()
}

export function decodeSubmitOrderResponse(value: unknown): SubmitOrderResponse {
  const response = exactEngineRecord(value, [
    'orderId',
    'status',
    'remainingAmountSubunits',
    'fills',
    'baseAsset',
    'divisibility',
    'activeSettlementGroup',
  ])
  requireUuid(response.orderId, 'order id')
  requireOrderStatus(response.status)
  requireNonnegativeSafeInteger(response.remainingAmountSubunits, 'remaining order amount')
  const fills = boundedEngineArray(response.fills, 512, 'order fills').map(decodeFill)
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
    ],
    ['expiresAt'],
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
  }
}

function decodeOrderStatusFields(
  response: Record<string, unknown>,
  divisibility: MarketDivisibility,
): Pick<
  OrderStatusResponse,
  'amountSubunits' | 'outcomeId' | 'side' | 'price' | 'placedAt' | 'timeInForce' | 'expiresAt'
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
  return {
    amountSubunits: response.amountSubunits,
    outcomeId: response.outcomeId,
    side: response.side,
    price: response.price,
    placedAt: response.placedAt as string,
    timeInForce: response.timeInForce,
    ...(response.expiresAt === undefined ? {} : { expiresAt: response.expiresAt as string | null }),
  }
}

function requireOptionalIsoEngineTime(value: unknown, name: string): void {
  if (value !== undefined && value !== null) requireIsoEngineTime(value, name)
}

function decodeFill(value: unknown): Fill {
  const fill = exactEngineRecord(value, [
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
  ])
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
    baseAsset: 'sat',
    divisibility,
    tokenSide: fill.tokenSide,
    quotePaymentSubunits: fill.quotePaymentSubunits as number,
    outcomeFaceAmountSubunits: fill.outcomeFaceAmountSubunits as number,
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

export function decodeMatchedDelta(value: unknown): MatchedDelta {
  const delta = exactEngineRecord(value, [
    'marketId',
    'fillId',
    'makerOrderId',
    'takerOrderId',
    'executionPrice',
    'amountSubunits',
    'path',
    'matchedAt',
    'baseAsset',
    'collateralUnit',
    'divisibility',
    'quotePaymentSubunits',
    'outcomeFaceAmountSubunits',
    'tokenSide',
  ])
  if (typeof delta.marketId !== 'string' || delta.marketId.length === 0) {
    throw new Error('matched market id is invalid')
  }
  requireUuid(delta.fillId, 'matched fill id')
  requireUuid(delta.makerOrderId, 'matched maker order id')
  requireUuid(delta.takerOrderId, 'matched taker order id')
  requirePositiveSafeInteger(delta.executionPrice, 'matched execution price')
  requirePositiveSafeInteger(delta.amountSubunits, 'matched amount')
  if (delta.path !== 'Complementary' && delta.path !== 'Mint') {
    throw new Error('matched path is invalid')
  }
  requireIsoEngineTime(delta.matchedAt, 'matched time')
  if (delta.baseAsset !== 'sat') throw new Error('matched base asset is invalid')
  if (delta.collateralUnit !== 'msat') throw new Error('matched collateral unit is invalid')
  const divisibility = parseMarketDivisibility(delta.divisibility)
  if (divisibility === null || (delta.executionPrice as number) >= divisibility) {
    throw new Error('matched divisibility is invalid')
  }
  requirePositiveSafeInteger(delta.quotePaymentSubunits, 'matched quote payment')
  requirePositiveSafeInteger(delta.outcomeFaceAmountSubunits, 'matched outcome amount')
  if (delta.tokenSide !== 'Outcome' && delta.tokenSide !== 'Complement') {
    throw new Error('matched token side is invalid')
  }
  return {
    marketId: delta.marketId,
    fillId: delta.fillId,
    makerOrderId: delta.makerOrderId,
    takerOrderId: delta.takerOrderId,
    executionPrice: delta.executionPrice,
    amountSubunits: delta.amountSubunits,
    path: delta.path,
    matchedAt: delta.matchedAt,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility,
    quotePaymentSubunits: delta.quotePaymentSubunits,
    outcomeFaceAmountSubunits: delta.outcomeFaceAmountSubunits,
    tokenSide: delta.tokenSide,
  }
}

export function decodeOrderLifecycleChangedDelta(value: unknown): OrderLifecycleChangedDelta {
  const delta = exactEngineRecord(value, [
    'orderId',
    'marketId',
    'status',
    'remainingAmountSubunits',
    'baseAsset',
    'collateralUnit',
    'divisibility',
    'activeSettlementGroup',
  ])
  requireUuid(delta.orderId, 'order lifecycle order id')
  if (typeof delta.marketId !== 'string' || delta.marketId.length === 0) {
    throw new Error('order lifecycle market id is invalid')
  }
  requireOrderStatus(delta.status)
  requireNonnegativeSafeInteger(delta.remainingAmountSubunits, 'order lifecycle remaining amount')
  if (delta.baseAsset !== 'sat') throw new Error('order lifecycle base asset is invalid')
  if (delta.collateralUnit !== 'msat') throw new Error('order lifecycle collateral unit is invalid')
  const divisibility = parseMarketDivisibility(delta.divisibility)
  if (divisibility === null) throw new Error('order lifecycle divisibility is invalid')
  return {
    orderId: delta.orderId as string,
    marketId: delta.marketId,
    status: delta.status,
    remainingAmountSubunits: delta.remainingAmountSubunits as number,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility,
    activeSettlementGroup:
      delta.activeSettlementGroup === null
        ? null
        : decodeSettlementGroup(delta.activeSettlementGroup),
  }
}

function requireOrderStatus(value: unknown): asserts value is OrderLifecycleStatus {
  if (
    value !== 'resting' &&
    value !== 'matched' &&
    value !== 'partially_filled' &&
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

function createBoundedRequestLifetime(
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
  public readonly retryAfterSeconds?: number

  constructor(
    status: number,
    detail: string,
    code?: string,
    problemDetail?: string,
    retryAfterSeconds?: number,
  ) {
    super(formatEngineClientError(status, detail, code, problemDetail))
    this.name = 'EngineClientError'
    this.status = status
    this.detail = detail
    this.code = code
    this.problemDetail = problemDetail
    this.retryAfterSeconds = retryAfterSeconds
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

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds : undefined
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
