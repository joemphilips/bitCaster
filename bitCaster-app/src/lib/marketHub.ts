/**
 * SignalR client helper for the matching engine's MarketHub at /hubs/market.
 *
 * Scope: live order-book updates per market group (`JoinMarket` /
 * `LeaveMarket`). Per-user position pushes are deliberately not part of
 * this client — see P08 (no server-side per-user bookkeeping). Trade
 * settlement runs on TradeHub via `useTradeHub`.
 *
 * Lifecycle: a single lazy HubConnection is shared across the whole app.
 * React components subscribe via `onOrderBookUpdated` and are returned an
 * unsubscribe function to call on unmount. The connection is only started
 * on the first subscribe (there is no explicit tear-down call today — we
 * rely on GC + visibility changes).
 */

import {
  HubConnectionBuilder,
  HubConnectionState,
  type HubConnection,
} from '@microsoft/signalr'
import type { components } from '@/generated/api'
import { debounce, type DebouncedFunction } from '@/lib/debounce'
import { resolveHubServerUrl } from '@/lib/hubUrl'
import { refreshOrderBook } from '@/lib/orderBookRefresh'

export type OrderBookSnapshot = components['schemas']['OrderBookSnapshot']
export type MarketStatusChanged = components['schemas']['MarketStatusChanged']
export interface TradeExecuted {
  tradeId: string
  executionPrice: number
  amountSubunits: number
  side: string
  timestamp: string
}

export interface Matched {
  tradeId: string
  makerOrderId: string
  takerOrderId: string
  executionPrice: number
  amountSubunits: number
  path: string
  matchedAt: string
}

export function parseTradeExecuted(
  payload: unknown,
): { marketId: string; trade: TradeExecuted } | null {
  const raw = payload as Record<string, unknown>
  const marketId =
    typeof raw.marketId === 'string'
      ? raw.marketId
      : typeof raw.MarketId === 'string'
        ? raw.MarketId
        : null
  const executionPrice =
    typeof raw.executionPrice === 'number'
      ? raw.executionPrice
      : typeof raw.ExecutionPrice === 'number'
        ? raw.ExecutionPrice
        : null
  const amountSubunits =
    typeof raw.amountSubunits === 'number'
      ? raw.amountSubunits
      : typeof raw.AmountSubunits === 'number'
        ? raw.AmountSubunits
        : typeof raw.faceAmountSubunits === 'number'
          ? raw.faceAmountSubunits
          : typeof raw.FaceAmountSubunits === 'number'
            ? raw.FaceAmountSubunits
            : null
  const tradeId =
    typeof raw.tradeId === 'string'
      ? raw.tradeId
      : typeof raw.TradeId === 'string'
        ? raw.TradeId
        : undefined
  const side =
    typeof raw.side === 'string'
      ? raw.side
      : typeof raw.Side === 'string'
        ? raw.Side
        : ''
  const timestamp =
    typeof raw.timestamp === 'string'
      ? raw.timestamp
      : typeof raw.Timestamp === 'string'
        ? raw.Timestamp
        : typeof raw.matchedAt === 'string'
          ? raw.matchedAt
          : typeof raw.MatchedAt === 'string'
            ? raw.MatchedAt
            : new Date().toISOString()

  if (!marketId || !tradeId || executionPrice == null || amountSubunits == null) return null
  const trade = { tradeId, executionPrice, amountSubunits, side, timestamp }
  return {
    marketId,
    trade,
  }
}

export function parseMatched(
  payload: unknown,
): { marketId: string; match: Matched } | null {
  const raw = payload as Record<string, unknown>
  const marketId =
    typeof raw.marketId === 'string'
      ? raw.marketId
      : typeof raw.MarketId === 'string'
        ? raw.MarketId
        : null
  const tradeId =
    typeof raw.tradeId === 'string'
      ? raw.tradeId
      : typeof raw.TradeId === 'string'
        ? raw.TradeId
        : null
  const makerOrderId =
    typeof raw.makerOrderId === 'string'
      ? raw.makerOrderId
      : typeof raw.MakerOrderId === 'string'
        ? raw.MakerOrderId
        : null
  const takerOrderId =
    typeof raw.takerOrderId === 'string'
      ? raw.takerOrderId
      : typeof raw.TakerOrderId === 'string'
        ? raw.TakerOrderId
        : null
  const executionPrice =
    typeof raw.executionPrice === 'number'
      ? raw.executionPrice
      : typeof raw.ExecutionPrice === 'number'
        ? raw.ExecutionPrice
        : null
  const amountSubunits =
    typeof raw.amountSubunits === 'number'
      ? raw.amountSubunits
      : typeof raw.AmountSubunits === 'number'
        ? raw.AmountSubunits
        : null
  const path =
    typeof raw.path === 'string'
      ? raw.path
      : typeof raw.Path === 'string'
        ? raw.Path
        : ''
  const matchedAt =
    typeof raw.matchedAt === 'string'
      ? raw.matchedAt
      : typeof raw.MatchedAt === 'string'
        ? raw.MatchedAt
        : new Date().toISOString()

  if (!marketId || !tradeId || !makerOrderId || !takerOrderId || executionPrice == null || amountSubunits == null) {
    return null
  }
  return {
    marketId,
    match: { tradeId, makerOrderId, takerOrderId, executionPrice, amountSubunits, path, matchedAt },
  }
}

type OrderBookHandler = (snapshot: OrderBookSnapshot) => void
type MarketStatusHandler = (status: MarketStatusChanged) => void
type TradeExecutedHandler = (trade: TradeExecuted) => void
type MatchedHandler = (match: Matched) => void
type MarketRejoinedHandler = () => void

const SERVER_URL = resolveHubServerUrl()
const HUB_URL = `${SERVER_URL}/hubs/market`

// ---------------------------------------------------------------------------
// Singleton connection state
// ---------------------------------------------------------------------------

let _connection: HubConnection | null = null
let _startPromise: Promise<void> | null = null

// Per-market handlers. We keep a Set so two components watching the same
// market don't stomp on each other's subscriptions, and so the last unsubscribe
// can cleanly leave the server group.
const _orderBookHandlers = new Map<string, Set<OrderBookHandler>>()
const _tradeExecutedHandlers = new Map<string, Set<TradeExecutedHandler>>()
const _matchedHandlers = new Map<string, Set<MatchedHandler>>()
const _marketJoinCounts = new Map<string, number>()
const _desiredMarketJoins = new Set<string>()
const _marketRejoinedHandlers = new Map<string, Set<MarketRejoinedHandler>>()
const _rejoinRefreshers = new Map<string, DebouncedFunction<[]>>()

// Per-condition lifecycle handlers. The server fans MarketStatusChanged out to
// every per-outcome group of the condition, so a client joined to any one
// outcome group receives it; we key handlers by conditionId.
const _marketStatusHandlers = new Map<string, Set<MarketStatusHandler>>()

function buildConnection(): HubConnection {
  // Order-book updates are public — no NIP-98 needed on this hub.
  const conn = new HubConnectionBuilder()
    .withUrl(HUB_URL)
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build()

  conn.on('OrderBookUpdated', (snapshot: OrderBookSnapshot) => {
    const handlers = _orderBookHandlers.get(snapshot.marketId)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(snapshot)
      } catch (err) {
        console.warn('[marketHub] OrderBookUpdated handler threw:', err)
      }
    }
  })

  conn.on('TradeExecuted', (payload: unknown) => {
    const parsed = parseTradeExecuted(payload)
    if (!parsed) return

    const handlers = _tradeExecutedHandlers.get(parsed.marketId)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(parsed.trade)
      } catch (err) {
        console.warn('[marketHub] TradeExecuted handler threw:', err)
      }
    }
  })

  conn.on('Matched', (payload: unknown) => {
    const parsed = parseMatched(payload)
    if (!parsed) return

    const handlers = _matchedHandlers.get(parsed.marketId)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(parsed.match)
      } catch (err) {
        console.warn('[marketHub] Matched handler threw:', err)
      }
    }
  })

  conn.on('MarketStatusChanged', (status: MarketStatusChanged) => {
    const handlers = _marketStatusHandlers.get(status.conditionId)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(status)
      } catch (err) {
        console.warn('[marketHub] MarketStatusChanged handler threw:', err)
      }
    }
  })

  conn.onreconnected(() => {
    void rejoinMarketsAfterReconnect(conn)
  })

  return conn
}

async function rejoinMarketsAfterReconnect(conn: HubConnection): Promise<void> {
  const markets = Array.from(_desiredMarketJoins)
  await Promise.all(markets.map(async (marketId) => {
    try {
      await conn.invoke('JoinMarket', marketId)
      requestRecoveryRefresh(marketId)
    } catch (err) {
      console.warn('[marketHub] JoinMarket after reconnect failed:', err)
    }
  }))
}

function requestRecoveryRefresh(marketId: string): void {
  let refresh = _rejoinRefreshers.get(marketId)
  if (!refresh) {
    refresh = debounce(() => {
      const handlers = _marketRejoinedHandlers.get(marketId)
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          try {
            handler()
          } catch (err) {
            console.warn('[marketHub] reconnect refresh handler threw:', err)
          }
        }
        return
      }

      void refreshOrderBook(marketId).catch((err) => {
        console.warn('[marketHub] reconnect order-book refresh failed:', err)
      })
    }, 200)
    _rejoinRefreshers.set(marketId, refresh)
  }
  refresh()
}

function ensureConnection(): HubConnection {
  if (!_connection) _connection = buildConnection()
  return _connection
}

async function ensureStarted(): Promise<HubConnection> {
  const conn = ensureConnection()
  if (conn.state === HubConnectionState.Connected) return conn
  if (!_startPromise) {
    _startPromise = conn.start().catch((err) => {
      // Reset so a later caller can retry (e.g. after user logs in).
      _startPromise = null
      throw err
    })
  }
  await _startPromise
  return conn
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function joinMarket(marketId: string): Promise<void> {
  _desiredMarketJoins.add(marketId)
  const currentCount = _marketJoinCounts.get(marketId) ?? 0
  if (currentCount > 0) {
    _marketJoinCounts.set(marketId, currentCount + 1)
    return
  }
  _marketJoinCounts.set(marketId, 1)
  const conn = await ensureStarted()
  await conn.invoke('JoinMarket', marketId)
}

export async function leaveMarket(marketId: string): Promise<void> {
  const currentCount = _marketJoinCounts.get(marketId) ?? 0
  if (currentCount > 1) {
    _marketJoinCounts.set(marketId, currentCount - 1)
    return
  }
  _marketJoinCounts.delete(marketId)
  _desiredMarketJoins.delete(marketId)
  const conn = ensureConnection()
  if (conn.state !== HubConnectionState.Connected) return
  try {
    await conn.invoke('LeaveMarket', marketId)
  } catch (err) {
    // Best-effort — a disconnected hub will throw but we don't want React
    // cleanup to crash.
    console.warn('[marketHub] LeaveMarket failed:', err)
  }
}

/**
 * Register a handler for order-book updates on a specific market. Returns
 * an unsubscribe function — call on component unmount.
 */
export function onOrderBookUpdated(
  marketId: string,
  handler: OrderBookHandler,
): () => void {
  let set = _orderBookHandlers.get(marketId)
  if (!set) {
    set = new Set()
    _orderBookHandlers.set(marketId, set)
  }
  set.add(handler)
  return () => {
    const s = _orderBookHandlers.get(marketId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) _orderBookHandlers.delete(marketId)
  }
}

/**
 * Register a handler for lifecycle changes (e.g. open -> closed) on a
 * condition. The server broadcasts to every per-outcome group of the
 * condition, so the caller must be joined to at least one of the condition's
 * outcome markets (via {@link joinMarket}) to receive these. Returns an
 * unsubscribe function — call on component unmount.
 */
export function onMarketStatusChanged(
  conditionId: string,
  handler: MarketStatusHandler,
): () => void {
  let set = _marketStatusHandlers.get(conditionId)
  if (!set) {
    set = new Set()
    _marketStatusHandlers.set(conditionId, set)
  }
  set.add(handler)
  return () => {
    const s = _marketStatusHandlers.get(conditionId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) _marketStatusHandlers.delete(conditionId)
  }
}

export function onTradeExecuted(
  marketId: string,
  handler: TradeExecutedHandler,
): () => void {
  let set = _tradeExecutedHandlers.get(marketId)
  if (!set) {
    set = new Set()
    _tradeExecutedHandlers.set(marketId, set)
  }
  set.add(handler)
  return () => {
    const s = _tradeExecutedHandlers.get(marketId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) _tradeExecutedHandlers.delete(marketId)
  }
}

export function onMatched(
  marketId: string,
  handler: MatchedHandler,
): () => void {
  let set = _matchedHandlers.get(marketId)
  if (!set) {
    set = new Set()
    _matchedHandlers.set(marketId, set)
  }
  set.add(handler)
  return () => {
    const s = _matchedHandlers.get(marketId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) _matchedHandlers.delete(marketId)
  }
}

export function onMarketRejoined(
  marketId: string,
  handler: MarketRejoinedHandler,
): () => void {
  let set = _marketRejoinedHandlers.get(marketId)
  if (!set) {
    set = new Set()
    _marketRejoinedHandlers.set(marketId, set)
  }
  set.add(handler)
  return () => {
    const s = _marketRejoinedHandlers.get(marketId)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) _marketRejoinedHandlers.delete(marketId)
  }
}

/**
 * Tear down the singleton connection. Mostly for tests and hot-reload
 * scenarios; normal app runs never call this.
 */
export async function disconnect(): Promise<void> {
  const conn = _connection
  _connection = null
  _startPromise = null
  _orderBookHandlers.clear()
  _tradeExecutedHandlers.clear()
  _matchedHandlers.clear()
  _marketStatusHandlers.clear()
  _marketRejoinedHandlers.clear()
  for (const refresh of _rejoinRefreshers.values()) refresh.cancel()
  _rejoinRefreshers.clear()
  _marketJoinCounts.clear()
  _desiredMarketJoins.clear()
  if (conn) {
    try {
      await conn.stop()
    } catch {
      /* ignore */
    }
  }
}
