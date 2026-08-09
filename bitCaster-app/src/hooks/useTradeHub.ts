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
 * BackoffRetryPolicy and exposes `joinOrder` / `joinTrade` /
 * `sendSwapMessage` to callers.
 */

import { useEffect, useRef, useCallback } from "react";
import {
  HubConnectionBuilder,
  HubConnectionState,
  HttpTransportType,
  type HubConnection,
} from "@microsoft/signalr";
import { resolveHubServerUrl } from "@/lib/hubUrl";
import { tradeHubUrl } from "@/lib/nip98";
import { generateNip98Header } from "@/lib/markets";
import type { TradeMessageType } from "@/lib/tradeMessageTypes";
import {
  decodePortfolioInvalidatedDelta,
  decodeSettlementGroupStateChangedDelta,
  type PortfolioInvalidatedDelta,
  type SettlementGroupStateChangedDelta,
} from "@bitcaster/client-sdk/engineClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwapMessage {
  tradeId: string;
  messageType: string;
  ciphertext: string;
}

export interface TradeCreatedPayload {
  tradeId: string;
  sellerPubkey: string;
  buyerPubkey: string;
  sellerLocktime: string; // ISO-8601 from DateTimeOffset
  buyerLocktime: string;
  marketId?: string;
  fillAmountSubunits?: number;
  outcomeFaceAmountSubunits?: number | null;
  quotePaymentSubunits?: number | null;
  settlementKind?: string | null;
  sellerKeepOutcomeSetId?: string | null;
  sellerLockOutcomeSetId?: string | null;
  baseAsset?: string | null;
  collateralUnit?: string | null;
  divisibility?: number | null;
  tokenSide?: string | null;
}

export interface TradeHubCallbacks {
  onSwapMessageReceived?: (msg: SwapMessage) => void;
  onTradeStateChanged?: (tradeId: string, newState: string) => void;
  onTradeCreated?: (payload: TradeCreatedPayload) => void;
  onSettlementGroupStateChanged?: (delta: SettlementGroupStateChangedDelta) => void;
  onPortfolioInvalidated?: (delta: PortfolioInvalidatedDelta) => void;
  onError?: (err: Error) => void;
}

export interface TradeHubActions {
  joinOrder: (marketId: string, orderId: string) => Promise<void>;
  joinTrade: (tradeId: string) => Promise<void>;
  sendSwapMessage: (
    tradeId: string,
    messageType: TradeMessageType,
    ciphertext: string,
  ) => Promise<void>;
  connectionState: () => HubConnectionState;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SERVER_URL = resolveHubServerUrl();
const INITIAL_START_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWithInitialRetry(
  connection: HubConnection,
  onError: (err: Error) => void,
  isStopped: () => boolean,
): Promise<void> {
  let attempt = 0;
  while (!isStopped()) {
    try {
      await connection.start();
      return;
    } catch (err) {
      if (isStopped()) return;
      onError(err instanceof Error ? err : new Error(String(err)));
      const delay =
        INITIAL_START_RETRY_DELAYS_MS[Math.min(attempt, INITIAL_START_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      if (delay > 0) await sleep(delay);
    }
  }
}

export async function generateTradeHubAccessToken(hubUrl: string): Promise<string> {
  return (await generateNip98Header(hubUrl, "GET")).replace(/^Nostr\s+/, "");
}

/**
 * Connect to the TradeHub and register event handlers.
 *
 * @param enabled - Pass true for an authenticated TradeHub session.
 *   Authentication uses the same configured signer path as REST order
 *   submission, so NIP-07 users can settle trades without exposing a raw nsec.
 * @param callbacks - event handlers wired to the SignalR hub events
 * @returns { joinOrder, joinTrade, sendSwapMessage, connectionState }
 */
export function useTradeHub(enabled: boolean, callbacks: TradeHubCallbacks): TradeHubActions {
  const connectionRef = useRef<HubConnection | null>(null);
  // Keep callbacks in a ref so the connection closure always sees the latest
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!enabled) return;

    const hubUrl = tradeHubUrl(SERVER_URL);
    let stopped = false;

    const connection = new HubConnectionBuilder()
      .withUrl(hubUrl, {
        transport: HttpTransportType.WebSockets,
        accessTokenFactory: () => generateTradeHubAccessToken(hubUrl),
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .build();

    connection.on(
      "SwapMessageReceived",
      (tradeId: string, messageType: string, ciphertext: string) => {
        callbacksRef.current.onSwapMessageReceived?.({
          tradeId,
          messageType,
          ciphertext,
        });
      },
    );

    connection.on("TradeStateChanged", (tradeId: string, newState: string) => {
      callbacksRef.current.onTradeStateChanged?.(tradeId, newState);
    });

    connection.on(
      "TradeCreated",
      (
        tradeId: string,
        sellerPubkey: string,
        buyerPubkey: string,
        sellerLocktime: string,
        buyerLocktime: string,
        marketId?: string,
        fillAmountSubunits?: number,
        outcomeFaceAmountSubunits?: number | null,
        quotePaymentSubunits?: number | null,
        settlementKind?: string | null,
        sellerKeepOutcomeSetId?: string | null,
        sellerLockOutcomeSetId?: string | null,
        baseAsset?: string | null,
        collateralUnit?: string | null,
        divisibility?: number | null,
        tokenSide?: string | null,
      ) => {
        callbacksRef.current.onTradeCreated?.({
          tradeId,
          sellerPubkey,
          buyerPubkey,
          sellerLocktime,
          buyerLocktime,
          marketId,
          fillAmountSubunits,
          outcomeFaceAmountSubunits,
          quotePaymentSubunits,
          settlementKind,
          sellerKeepOutcomeSetId,
          sellerLockOutcomeSetId,
          baseAsset,
          collateralUnit,
          divisibility,
          tokenSide,
        });
      },
    );

    connection.on("SettlementGroupStateChanged", (delta: unknown) => {
      try {
        callbacksRef.current.onSettlementGroupStateChanged?.(
          decodeSettlementGroupStateChangedDelta(delta),
        );
      } catch {
        callbacksRef.current.onError?.(new Error("Settlement-group update is invalid."));
      }
    });

    connection.on("PortfolioInvalidated", (delta: unknown) => {
      try {
        callbacksRef.current.onPortfolioInvalidated?.(decodePortfolioInvalidatedDelta(delta));
      } catch {
        callbacksRef.current.onError?.(new Error("Portfolio invalidation is invalid."));
      }
    });

    connection.onclose((err) => {
      if (err) callbacksRef.current.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    connection.onreconnecting((err) => {
      if (err) callbacksRef.current.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    connectionRef.current = connection;

    void startWithInitialRetry(
      connection,
      (err) => callbacksRef.current.onError?.(err),
      () => stopped,
    );

    return () => {
      stopped = true;
      connection.stop().catch(() => {
        /* ignore teardown errors */
      });
      connectionRef.current = null;
    };
  }, [enabled]);

  /**
   * Wait up to ~60 s for the SignalR connection to reach
   * {@link HubConnectionState.Connected}. The connection lifecycle is async
   * (negotiation may take several seconds, transient failures retry via
   * `withAutomaticReconnect`); a caller that fires immediately on store
   * change otherwise races the start sequence and fails the join with
   * "TradeHub not connected", leaving the swap in a permanent `failed`
   * step that no later state change recovers.
   */
  const waitForConnected = useCallback(async (timeoutMs = 60_000): Promise<HubConnection> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const conn = connectionRef.current;
      if (conn?.state === HubConnectionState.Connected) return conn;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("TradeHub not connected");
  }, []);

  const joinTrade = useCallback(
    async (tradeId: string) => {
      const conn = await waitForConnected();
      await conn.invoke("JoinTrade", tradeId);
    },
    [waitForConnected],
  );

  const joinOrder = useCallback(
    async (marketId: string, orderId: string) => {
      const conn = await waitForConnected();
      await conn.invoke("JoinOrder", marketId, orderId);
    },
    [waitForConnected],
  );

  const sendSwapMessage = useCallback(
    async (tradeId: string, messageType: TradeMessageType, ciphertext: string) => {
      const conn = await waitForConnected();
      await conn.invoke("SendSwapMessage", tradeId, messageType, ciphertext);
    },
    [waitForConnected],
  );

  const connectionState = useCallback(() => {
    return connectionRef.current?.state ?? HubConnectionState.Disconnected;
  }, []);

  return { joinOrder, joinTrade, sendSwapMessage, connectionState };
}
