import { useCallback, useEffect, useRef } from "react";
import {
  HubConnectionBuilder,
  HubConnectionState,
  HttpTransportType,
  type HubConnection,
} from "@microsoft/signalr";
import {
  decodeOrderLifecycleChangedDelta,
  decodeSettlementGroupStateChangedDelta,
  type OrderLifecycleChangedDelta,
  type SettlementGroupStateChangedDelta,
} from "@bitcaster/client-sdk/engineClient";
import { resolveHubServerUrl } from "@/lib/hubUrl";
import { orderHubUrl } from "@/lib/nip98";
import { generateNip98Header } from "@/lib/markets";

export interface OrderHubCallbacks {
  onOrderLifecycleChanged?: (delta: OrderLifecycleChangedDelta) => void;
  onSettlementGroupStateChanged?: (delta: SettlementGroupStateChangedDelta) => void;
  onReconnected?: () => void;
  onError?: (error: Error) => void;
}

export interface OrderHubActions {
  joinOrder: (marketId: string, orderId: string) => Promise<void>;
}

const SERVER_URL = resolveHubServerUrl();
const INITIAL_START_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startWithInitialRetry(
  connection: HubConnection,
  onError: (error: Error) => void,
  isStopped: () => boolean,
): Promise<void> {
  let attempt = 0;
  while (!isStopped()) {
    try {
      await connection.start();
      return;
    } catch (error) {
      if (isStopped()) return;
      onError(error instanceof Error ? error : new Error(String(error)));
      const delay =
        INITIAL_START_RETRY_DELAYS_MS[Math.min(attempt, INITIAL_START_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      if (delay > 0) await sleep(delay);
    }
  }
}

async function restartAfterClose(
  connection: HubConnection,
  onError: (error: Error) => void,
  onReconnected: () => void,
  isStopped: () => boolean,
): Promise<void> {
  await startWithInitialRetry(connection, onError, isStopped);
  if (!isStopped() && connection.state === HubConnectionState.Connected) onReconnected();
}

export async function generateOrderHubAccessToken(hubUrl: string): Promise<string> {
  return (await generateNip98Header(hubUrl, "GET")).replace(/^Nostr\s+/, "");
}

export function useOrderHub(enabled: boolean, callbacks: OrderHubCallbacks): OrderHubActions {
  const connectionRef = useRef<HubConnection | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!enabled) return;

    const hubUrl = orderHubUrl(SERVER_URL);
    let stopped = false;
    const connection = new HubConnectionBuilder()
      .withUrl(hubUrl, {
        transport: HttpTransportType.WebSockets,
        accessTokenFactory: () => generateOrderHubAccessToken(hubUrl),
      })
      .withAutomaticReconnect([0, 2_000, 5_000, 10_000, 30_000])
      .build();

    connection.on("SettlementGroupStateChanged", (delta: unknown) => {
      try {
        callbacksRef.current.onSettlementGroupStateChanged?.(
          decodeSettlementGroupStateChangedDelta(delta),
        );
      } catch {
        callbacksRef.current.onError?.(new Error("Settlement-group update is invalid."));
      }
    });
    connection.on("OrderLifecycleChanged", (delta: unknown) => {
      try {
        callbacksRef.current.onOrderLifecycleChanged?.(decodeOrderLifecycleChangedDelta(delta));
      } catch {
        callbacksRef.current.onError?.(new Error("Order lifecycle update is invalid."));
      }
    });
    connection.onreconnected(() => callbacksRef.current.onReconnected?.());
    connection.onclose((error) => {
      if (error)
        callbacksRef.current.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (stopped) return;
      void restartAfterClose(
        connection,
        (restartError) => callbacksRef.current.onError?.(restartError),
        () => callbacksRef.current.onReconnected?.(),
        () => stopped,
      );
    });
    connection.onreconnecting((error) => {
      if (error)
        callbacksRef.current.onError?.(error instanceof Error ? error : new Error(String(error)));
    });

    connectionRef.current = connection;
    void startWithInitialRetry(
      connection,
      (error) => callbacksRef.current.onError?.(error),
      () => stopped,
    );

    return () => {
      stopped = true;
      connection.stop().catch(() => {});
      connectionRef.current = null;
    };
  }, [enabled]);

  const waitForConnected = useCallback(async (): Promise<HubConnection> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const connection = connectionRef.current;
      if (connection?.state === HubConnectionState.Connected) return connection;
      await sleep(100);
    }
    throw new Error("Order hub is not connected.");
  }, []);

  const joinOrder = useCallback(
    async (marketId: string, orderId: string) => {
      await (await waitForConnected()).invoke("JoinOrder", marketId, orderId);
    },
    [waitForConnected],
  );

  return { joinOrder };
}
