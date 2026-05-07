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
import { resolveHubServerUrl } from '@/lib/hubUrl'

export type OrderBookSnapshot = components['schemas']['OrderBookSnapshot']

type OrderBookHandler = (snapshot: OrderBookSnapshot) => void

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

  return conn
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
  const conn = await ensureStarted()
  await conn.invoke('JoinMarket', marketId)
}

export async function leaveMarket(marketId: string): Promise<void> {
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
 * Tear down the singleton connection. Mostly for tests and hot-reload
 * scenarios; normal app runs never call this.
 */
export async function disconnect(): Promise<void> {
  const conn = _connection
  _connection = null
  _startPromise = null
  _orderBookHandlers.clear()
  if (conn) {
    try {
      await conn.stop()
    } catch {
      /* ignore */
    }
  }
}
