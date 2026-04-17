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
import { generateNip98AuthHeader, tradeHubUrl } from '@/lib/nip98'

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
  sellerLocktime: string  // ISO-8601 from DateTimeOffset
  buyerLocktime: string
}

export interface TradeHubCallbacks {
  onSwapMessageReceived?: (msg: SwapMessage) => void
  onTradeStateChanged?: (tradeId: string, newState: string) => void
  onTradeCreated?: (payload: TradeCreatedPayload) => void
  onError?: (err: Error) => void
}

export interface TradeHubActions {
  joinTrade: (tradeId: string) => Promise<void>
  sendSwapMessage: (tradeId: string, messageType: string, ciphertext: string) => Promise<void>
  connectionState: () => HubConnectionState
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:5000'

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
    const privkey = ephemeralPrivkey  // stable reference for this effect run

    const connection = new HubConnectionBuilder()
      .withUrl(hubUrl, {
        transport: HttpTransportType.WebSockets,
        accessTokenFactory: () =>
          generateNip98AuthHeader(privkey, hubUrl, 'GET'),
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .build()

    connection.on('SwapMessageReceived', (tradeId: string, messageType: string, ciphertext: string) => {
      callbacksRef.current.onSwapMessageReceived?.({ tradeId, messageType, ciphertext })
    })

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
      ) => {
        callbacksRef.current.onTradeCreated?.({
          tradeId,
          sellerPubkey,
          buyerPubkey,
          sellerLocktime,
          buyerLocktime,
        })
      },
    )

    connection.onclose((err) => {
      if (err) callbacksRef.current.onError?.(err instanceof Error ? err : new Error(String(err)))
    })

    connection.onreconnecting((err) => {
      if (err) callbacksRef.current.onError?.(err instanceof Error ? err : new Error(String(err)))
    })

    connectionRef.current = connection

    connection.start().catch((err: unknown) => {
      callbacksRef.current.onError?.(err instanceof Error ? err : new Error(String(err)))
    })

    return () => {
      connection.stop().catch(() => { /* ignore teardown errors */ })
      connectionRef.current = null
    }
  }, [ephemeralPrivkey])  // reconnect when key changes

  const joinTrade = useCallback(async (tradeId: string) => {
    const conn = connectionRef.current
    if (!conn || conn.state !== HubConnectionState.Connected) {
      throw new Error('TradeHub not connected')
    }
    await conn.invoke('JoinTrade', tradeId)
  }, [])

  const sendSwapMessage = useCallback(
    async (tradeId: string, messageType: string, ciphertext: string) => {
      const conn = connectionRef.current
      if (!conn || conn.state !== HubConnectionState.Connected) {
        throw new Error('TradeHub not connected')
      }
      await conn.invoke('SendSwapMessage', tradeId, messageType, ciphertext)
    },
    [],
  )

  const connectionState = useCallback(() => {
    return connectionRef.current?.state ?? HubConnectionState.Disconnected
  }, [])

  return { joinTrade, sendSwapMessage, connectionState }
}
