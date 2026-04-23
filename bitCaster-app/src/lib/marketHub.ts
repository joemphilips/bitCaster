/**
 * SignalR client helper for the matching engine's MarketHub at /hubs/market.
 *
 * Scope:
 *   - Live order-book updates per market group (`JoinMarket` / `LeaveMarket`)
 *   - Per-user position deltas delivered to the caller's private
 *     `user:{pubkey}` group (`JoinUserChannel` — see SECURITY note below)
 *
 * Lifecycle: a single lazy HubConnection is shared across the whole app.
 * React components subscribe via `onOrderBookUpdated` / `onPositionUpdated`
 * and are returned an unsubscribe function to call on unmount. The
 * connection is only started on the first subscribe and stopped on the last
 * unsubscribe (there is no explicit tear-down call today — we rely on GC +
 * visibility changes).
 *
 * -----------------------------------------------------------------------
 * SECURITY — NIP-98 over SignalR
 * -----------------------------------------------------------------------
 * SignalR's `accessTokenFactory` is invoked on every negotiate/reconnect.
 * For TradeHub we already sign the negotiate URL with the caller's ephemeral
 * privkey (lib/nip98.ts). MarketHub's `JoinUserChannel` takes NO caller
 * argument — the server derives the pubkey from the authenticated NIP-98
 * claim (ClaimTypes.NameIdentifier). So:
 *
 *   - The FE MUST NOT pass a pubkey to `invoke('JoinUserChannel')` (doing so
 *     would just be ignored by the server, but would also hide a bug if the
 *     server were ever loosened).
 *   - The FE MUST use NDK's active signer so NIP-07 extension users can also
 *     sign the NIP-98 auth event; the raw-privkey path in lib/nip98.ts only
 *     works for nsec-mode users. We delegate to `generateNip98Header` from
 *     lib/markets.ts which already handles both signer modes.
 *   - `accessTokenFactory` may return a Promise — @microsoft/signalr awaits
 *     it. Using an async signer is therefore safe.
 */

import {
  HubConnectionBuilder,
  HubConnectionState,
  type HubConnection,
} from '@microsoft/signalr'
import type { components } from '@/generated/api'
import { generateNip98Header } from '@/lib/markets'

export type OrderBookSnapshot = components['schemas']['OrderBookSnapshot']

type OrderBookHandler = (snapshot: OrderBookSnapshot) => void
type PositionUpdateHandler = (
  userPubkey: string,
  marketId: string,
  outcome: string,
  deltaTokens: number,
) => void

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:5000'
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

// PositionUpdated is a single user-scoped stream, so one handler set is
// enough — the server already filters by group membership.
const _positionHandlers = new Set<PositionUpdateHandler>()

function buildConnection(): HubConnection {
  const conn = new HubConnectionBuilder()
    .withUrl(HUB_URL, {
      // NIP-98 signing lives in markets.ts (NDK-based); works for both
      // NIP-07 and nsec modes. We sign the negotiate URL with GET, which
      // matches the Nip98AuthenticationHandler's `u`/`method` expectations
      // for the handshake. If the active signer is absent (read-only
      // visitor) the factory throws empty and the server negotiates
      // unauthenticated — the hub allows `JoinMarket` without auth; only
      // `JoinUserChannel` requires it.
      //
      // NOTE: this mirrors `hooks/useTradeHub.ts`. The value returned here
      // is passed through by SignalR to the server — the server's
      // `Nip98AuthenticationHandler` reads `Authorization: Nostr <token>`,
      // which matches exactly what `generateNip98Header` returns. Strip
      // nothing — hand the full `Nostr <token>` string back.
      accessTokenFactory: async () => {
        try {
          return await generateNip98Header(HUB_URL, 'GET')
        } catch {
          return ''
        }
      },
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build()

  // Re-dispatch server events to per-market handler sets.
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

  conn.on(
    'PositionUpdated',
    (userPubkey: string, marketId: string, outcome: string, deltaTokens: number) => {
      for (const handler of _positionHandlers) {
        try {
          handler(userPubkey, marketId, outcome, deltaTokens)
        } catch (err) {
          console.warn('[marketHub] PositionUpdated handler threw:', err)
        }
      }
    },
  )

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
 * Join the caller's private `user:{pubkey}` group so the server can push
 * `PositionUpdated` deltas after CPMM fills. The server derives the pubkey
 * from the authenticated NIP-98 claim — this method takes no argument for
 * exactly that reason. Throws if no NDK signer is configured.
 */
export async function joinUserChannel(): Promise<void> {
  const conn = await ensureStarted()
  await conn.invoke('JoinUserChannel')
}

export async function leaveUserChannel(): Promise<void> {
  const conn = ensureConnection()
  if (conn.state !== HubConnectionState.Connected) return
  try {
    await conn.invoke('LeaveUserChannel')
  } catch (err) {
    console.warn('[marketHub] LeaveUserChannel failed:', err)
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
 * Register a handler for position deltas. Returns an unsubscribe function.
 * The handler fires only if the current user has previously called
 * `joinUserChannel()`.
 */
export function onPositionUpdated(handler: PositionUpdateHandler): () => void {
  _positionHandlers.add(handler)
  return () => {
    _positionHandlers.delete(handler)
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
  _positionHandlers.clear()
  if (conn) {
    try {
      await conn.stop()
    } catch {
      /* ignore */
    }
  }
}
