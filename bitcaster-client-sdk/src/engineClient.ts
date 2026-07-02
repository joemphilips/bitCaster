import type { MarketBaseAsset } from './marketUnits.ts'

export type EngineFetch = typeof fetch

export interface EngineClientOptions {
  baseUrl: string
  fetchImpl?: EngineFetch
  authorization?: (
    request: EngineAuthorizationRequest,
  ) => string | Promise<string>
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

export interface BatchSubmitOrderRequestItem
  extends Omit<SubmitOrderRequest, 'comment'> {
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
  private readonly authorization?: (
    request: EngineAuthorizationRequest,
  ) => string | Promise<string>

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.authorization = options.authorization
  }

  async submitOrder(
    marketId: string,
    request: SubmitOrderRequest,
  ): Promise<SubmitOrderResponse> {
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

  async getOrderStatus(
    marketId: string,
    orderId: string,
  ): Promise<OrderStatusResponse | null> {
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orders/${encodePathSegment(orderId)}`,
    )
    if (response.status === 404) return null
    return (await response.json()) as OrderStatusResponse
  }

  async listMyOrders(
    conditionId: string,
    cursor?: string,
  ): Promise<ListMyOrdersResponse> {
    return listMyOrders(
      this.baseUrl,
      conditionId,
      cursor,
      this.fetchImpl,
      this.authorization,
    )
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
    const conditionId = typeof conditionIdOrNostrEvent === 'string'
      ? conditionIdOrNostrEvent
      : undefined
    const comment = typeof conditionIdOrNostrEvent === 'string'
      ? nostrEvent
      : conditionIdOrNostrEvent
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
    const response = await this.request(
      `/api/v1/${encodePathSegment(marketId)}/orderbook`,
    )
    return (await response.json()) as OrderBookSnapshot
  }

  async queryMarkets(
    params: QueryMarketsParams = {},
  ): Promise<QueryMarketsResponse> {
    const response = await this.request(
      `/api/v1/markets/query${buildMarketsQueryString(params)}`,
    )
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
      throw new EngineClientError(
        response.status,
        detail,
        problem?.code,
        problem?.detail,
      )
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

  constructor(
    status: number,
    detail: string,
    code?: string,
    problemDetail?: string,
  ) {
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
