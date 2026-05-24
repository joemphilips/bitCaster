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
}

export interface SubmitOrderRequest {
  outcomeId: string
  side: 'Buy' | 'Sell'
  price: number
  amountSats: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  ephemeralPubkey: string
}

export interface Fill {
  id: string
  makerOrderId: string
  takerOrderId: string
  outcomeId: string
  amountSats: number
  executionPrice: number
  path: 'Direct' | 'Complementary'
  status: 'Matched' | 'Filled' | 'Released'
  filledAt: string
  tradeId?: string
  makerEphemeralPubkey?: string
}

export interface SubmitOrderResponse {
  orderId: string
  status: string
  remainingAmountSats: number
  fills: Fill[]
  ephemeralPubkey: string
}

export interface OrderStatusResponse {
  orderId: string
  marketId: string
  status: string
  remainingAmountSats: number
  filledAmountSats: number
  fills: Fill[]
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
}

export interface QueryMarketsParams {
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  sort?: 'Newest' | 'EndingSoon' | 'Volume24h' | 'Volume30d'
  tag?: string
  creator?: string
  ids?: string[]
  search?: string
  limit?: number
  cursor?: string
}

export interface QueryMarketsResponse {
  markets: unknown[]
  nextCursor?: string | null
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

  async getMarket(conditionId: string): Promise<unknown | null> {
    const response = await this.queryMarkets({
      ids: [conditionId],
      state: 'All',
      limit: 1,
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
      throw new EngineClientError(
        response.status,
        await response.text().catch(() => ''),
      )
    }
    return response
  }
}

function buildMarketsQueryString(params: QueryMarketsParams): string {
  const query = new URLSearchParams()
  if (params.state) query.set('state', params.state)
  if (params.sort) query.set('sort', params.sort)
  if (params.tag) query.set('tag', params.tag)
  if (params.creator) query.set('creator', params.creator)
  if (params.ids?.length) query.set('ids', params.ids.join(','))
  if (params.search) query.set('search', params.search)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.cursor) query.set('cursor', params.cursor)
  const text = query.toString()
  return text ? `?${text}` : ''
}

export class EngineClientError extends Error {
  public readonly status: number
  public readonly detail: string

  constructor(status: number, detail: string) {
    super(formatEngineClientError(status, detail))
    this.name = 'EngineClientError'
    this.status = status
    this.detail = detail
  }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment)
}

function formatEngineClientError(status: number, detail: string): string {
  const trimmed = detail.trim()
  return trimmed
    ? `Engine request failed: ${status} ${trimmed}`
    : `Engine request failed: ${status}`
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
