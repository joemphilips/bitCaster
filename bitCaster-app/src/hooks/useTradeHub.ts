/**
 * SignalR hook for the bitCaster TradeHub at /hubs/trade.
 *
 * Handles connection lifecycle, NIP-98 authentication, and the three
 * server-to-client events used by the atomic-swap protocol:
 *
 *   SwapMessageReceived  — encrypted swap protocol message from counterparty
 *   TradeStateChanged    — lifecycle transition (Matched → Settling → …)
 *   TradeCreated         — initial trade details (pubkeys + locktimes)
 *
 * The hook manages reconnection automatically via SignalR's built-in
 * BackoffRetryPolicy and exposes `joinTrade` / `sendSwapMessage` to callers.
 */

import { useEffect, useRef, useCallback } from 'react'
import {
  HubConnectionBuilder,
  HubConnectionState,
  HttpTransportType,
  type HubConnection,
} from '@microsoft/signalr'
import { resolveHubServerUrl } from '@/lib/hubUrl'
import { generateNip98AuthHeader, tradeHubUrl } from '@/lib/nip98'
import type { TradeMessageType } from '@/lib/tradeMessageTypes'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwapMessage {
  tradeId: string
  messageType: string
  ciphertext: string
}

export interface TradeCreatedPayload {
  tradeId: string
  sellerPubkey: string
  buyerPubkey: string
  sellerLocktime: string // ISO-8601 from DateTimeOffset
  buyerLocktime: string
  marketId?: string
  fillAmountSats?: number
  outcomeFaceAmountSats?: number
  quotePaymentSats?: number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
}

export interface TradeHubCallbacks {
  onSwapMessageReceived?: (msg: SwapMessage) => void
  onTradeStateChanged?: (tradeId: string, newState: string) => void
  onTradeCreated?: (payload: TradeCreatedPayload) => void
  onError?: (err: Error) => void
}

export interface TradeHubActions {
  joinTrade: (tradeId: string) => Promise<void>
  sendSwapMessage: (
    tradeId: string,
    messageType: TradeMessageType,
    ciphertext: string,
  ) => Promise<void>
  connectionState: () => HubConnectionState
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SERVER_URL = resolveHubServerUrl()
const INITIAL_START_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startWithInitialRetry(
  connection: HubConnection,
  onError: (err: Error) => void,
  isStopped: () => boolean,
): Promise<void> {
  let attempt = 0
  while (!isStopped()) {
    try {
      await connection.start()
      return
    } catch (err) {
      if (isStopped()) return
      onError(err instanceof Error ? err : new Error(String(err)))
      const delay =
        INITIAL_START_RETRY_DELAYS_MS[
          Math.min(attempt, INITIAL_START_RETRY_DELAYS_MS.length - 1)
        ]
      attempt += 1
      if (delay > 0) await sleep(delay)
    }
  }
}

export function generateTradeHubAccessToken(
  privateKey: Uint8Array,
  hubUrl: string,
): string {
  return generateNip98AuthHeader(privateKey, hubUrl, 'GET').replace(
    /^Nostr\s+/,
    '',
  )
}

/**
 * Connect to the TradeHub and register event handlers.
 *
 * @param ephemeralPrivkey - 32-byte private key used for NIP-98 token signing.
 *   Pass `null` to defer connection (e.g. while the wallet is not yet set up).
 * @param callbacks - event handlers wired to the SignalR hub events
 * @returns { joinTrade, sendSwapMessage, connectionState }
 */
export function useTradeHub(
  ephemeralPrivkey: Uint8Array | null,
  callbacks: TradeHubCallbacks,
): TradeHubActions {
  const connectionRef = useRef<HubConnection | null>(null)
  // Keep callbacks in a ref so the connection closure always sees the latest
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    if (!ephemeralPrivkey) return

    const hubUrl = tradeHubUrl(SERVER_URL)
    const privkey = ephemeralPrivkey // stable reference for this effect run
    let stopped = false

    const connection = new HubConnectionBuilder()
      .withUrl(hubUrl, {
        transport: HttpTransportType.WebSockets,
        accessTokenFactory: () => generateTradeHubAccessToken(privkey, hubUrl),
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .build()

    connection.on(
      'SwapMessageReceived',
      (tradeId: string, messageType: string, ciphertext: string) => {
        callbacksRef.current.onSwapMessageReceived?.({
          tradeId,
          messageType,
          ciphertext,
        })
      },
    )

    connection.on('TradeStateChanged', (tradeId: string, newState: string) => {
      callbacksRef.current.onTradeStateChanged?.(tradeId, newState)
    })

    connection.on(
      'TradeCreated',
      (
        tradeId: string,
        sellerPubkey: string,
        buyerPubkey: string,
        sellerLocktime: string,
        buyerLocktime: string,
        marketId?: string,
        fillAmountSats?: number,
        outcomeFaceAmountSats?: number,
        quotePaymentSats?: number,
        settlementKind?: string | null,
        sellerKeepOutcomeSetId?: string | null,
        sellerLockOutcomeSetId?: string | null,
      ) => {
        callbacksRef.current.onTradeCreated?.({
          tradeId,
          sellerPubkey,
          buyerPubkey,
          sellerLocktime,
          buyerLocktime,
          marketId,
          fillAmountSats,
          outcomeFaceAmountSats,
          quotePaymentSats,
          settlementKind,
          sellerKeepOutcomeSetId,
          sellerLockOutcomeSetId,
        })
      },
    )

    connection.onclose((err) => {
      if (err)
        callbacksRef.current.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        )
    })

    connection.onreconnecting((err) => {
      if (err)
        callbacksRef.current.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        )
    })

    connectionRef.current = connection

    void startWithInitialRetry(
      connection,
      (err) => callbacksRef.current.onError?.(err),
      () => stopped,
    )

    return () => {
      stopped = true
      connection.stop().catch(() => {
        /* ignore teardown errors */
      })
      connectionRef.current = null
    }
  }, [ephemeralPrivkey]) // reconnect when key changes

  /**
   * Wait up to ~60 s for the SignalR connection to reach
   * {@link HubConnectionState.Connected}. The connection lifecycle is async
   * (negotiation may take several seconds, transient failures retry via
   * `withAutomaticReconnect`); a caller that fires immediately on store
   * change otherwise races the start sequence and fails the join with
   * "TradeHub not connected", leaving the swap in a permanent `failed`
   * step that no later state change recovers.
   */
  const waitForConnected = useCallback(
    async (timeoutMs = 60_000): Promise<HubConnection> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const conn = connectionRef.current
        if (conn?.state === HubConnectionState.Connected) return conn
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('TradeHub not connected')
    },
    [],
  )

  const joinTrade = useCallback(
    async (tradeId: string) => {
      const conn = await waitForConnected()
      await conn.invoke('JoinTrade', tradeId)
    },
    [waitForConnected],
  )

  const sendSwapMessage = useCallback(
    async (
      tradeId: string,
      messageType: TradeMessageType,
      ciphertext: string,
    ) => {
      const conn = await waitForConnected()
      await conn.invoke('SendSwapMessage', tradeId, messageType, ciphertext)
    },
    [waitForConnected],
  )

  const connectionState = useCallback(() => {
    return connectionRef.current?.state ?? HubConnectionState.Disconnected
  }, [])

  return { joinTrade, sendSwapMessage, connectionState }
}
