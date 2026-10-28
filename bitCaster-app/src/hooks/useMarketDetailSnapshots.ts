import { useEffect, useRef } from "react";
import { createDisplayResyncRepair } from "@bitcaster/client-sdk/displayResync";
import {
  fetchMarketComments,
  fetchMarketPriceHistory,
  type MarketCommentsResponse,
  type MarketPriceHistoryResponse,
} from "@/lib/markets";
import {
  onConfirmedTradeRecorded,
  onMarketCommentsChanged,
  onMarketRejoined,
  onMarketResyncRequired,
} from "@/lib/marketHub";
import { outcomeSetIdsForMarketBooks, outcomeSetMarketId } from "@/lib/outcomeSets";
import type { ChartTimeframe, MarketDetail } from "@/types/market-detail";

interface SnapshotInputs {
  market: MarketDetail | null;
  timeframe: ChartTimeframe;
  onHistory: (response: MarketPriceHistoryResponse) => void;
  onComments: (response: MarketCommentsResponse) => void;
  onInvalidateHistory: () => void;
  onHistoryStatus?: (status: NonNullable<MarketDetail["priceHistoryStatus"]>) => void;
}

interface SnapshotRead {
  signal: AbortSignal;
  /** The latest notified source position. It is opaque. */
  eventOrder?: string;
}

// One active read keeps one pending invalidation. Source positions remain opaque.
function subscribeSnapshot<T>(
  market: MarketDetail,
  read: (request: SnapshotRead) => Promise<T>,
  apply: (response: T) => void,
  invalidate: () => void = () => {},
  commentChanges = false,
  onStatus?: (status: "refreshing" | "ready" | "unavailable") => void,
): () => void {
  const controller = new AbortController();
  let generation = 0;
  let eventOrder: string | undefined;
  const repair = createDisplayResyncRepair({
    initialJitterMs: 250,
    repair: async (signal) => {
      signal.throwIfAborted();
      const requestGeneration = generation;
      onStatus?.("refreshing");
      try {
        const response = await read({ eventOrder, signal: controller.signal });
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        // A newer demand already owns the next coordinator pass. Never apply
        // an older response, even when the transport ignores cancellation.
        if (requestGeneration !== generation) return;
        apply(response);
        onStatus?.("ready");
      } catch (error) {
        if (!controller.signal.aborted && requestGeneration === generation)
          onStatus?.("unavailable");
        throw error;
      }
    },
  });
  const changed = (notifiedEventOrder?: string) => {
    if (controller.signal.aborted) return;
    // A page in several outcome groups gets one copy from each. Compare positions only for equality.
    if (notifiedEventOrder !== undefined && notifiedEventOrder === eventOrder) return;
    generation += 1;
    if (notifiedEventOrder !== undefined) eventOrder = notifiedEventOrder;
    invalidate();
    repair.invalidate();
  };
  const resync = (token: string) => {
    // An ignored duplicate must not invalidate the active read: it owns no
    // follow-up demand. Scheduling starts in a microtask after this generation.
    if (controller.signal.aborted || !repair.request(token)) return;
    generation += 1;
    invalidate();
  };
  const firstOutcome = outcomeSetIdsForMarketBooks(market)[0];
  const cleanups = [
    onMarketResyncRequired(market.id, resync),
    onConfirmedTradeRecorded(market.id, (message) => {
      if (message.conditionId === market.id) changed(message.latestConfirmedTrade.eventOrder);
    }),
    ...(commentChanges
      ? [
          onMarketCommentsChanged(market.id, (message) => {
            if (message.conditionId === market.id) changed(message.eventOrder);
          }),
        ]
      : []),
    ...(firstOutcome
      ? [onMarketRejoined(outcomeSetMarketId(market.id, firstOutcome), () => changed())]
      : []),
  ];
  repair.invalidate();
  return () => {
    controller.abort();
    void repair.dispose();
    for (const cleanup of cleanups) cleanup();
  };
}

export function useMarketDetailSnapshots(inputs: SnapshotInputs): void {
  const latest = useRef(inputs);
  latest.current = inputs;
  const marketId = inputs.market?.id;
  const priceContextKey = JSON.stringify([
    marketId,
    inputs.market?.type,
    inputs.market?.divisibility,
    inputs.market?.registeredPrimitiveOutcomeIds,
  ]);
  const historySource = useRef<{
    contextKey: string;
    asOfByRange: Partial<Record<ChartTimeframe, string>>;
  }>({ contextKey: priceContextKey, asOfByRange: {} });
  if (historySource.current.contextKey !== priceContextKey) {
    historySource.current = { contextKey: priceContextKey, asOfByRange: {} };
  }
  useEffect(() => {
    const market = latest.current.market;
    if (!market) return;
    return subscribeSnapshot(
      market,
      // The engine notifies a trade after this history includes it. The read
      // returns the latest applied history, so it sends no source position.
      ({ signal }) => {
        const current = latest.current.market;
        return fetchMarketPriceHistory(market.id, inputs.timeframe, {
          signal,
          minimumAsOf:
            historySource.current.asOfByRange[inputs.timeframe] ??
            (current?.priceHistory.timeframe === inputs.timeframe
              ? current.priceHistory.asOf
              : undefined),
          outcomeIds: market.registeredPrimitiveOutcomeIds,
          divisibility: market.divisibility,
        });
      },
      (response) => {
        if (
          historySource.current.contextKey === priceContextKey &&
          latest.current.market?.id === market.id &&
          latest.current.timeframe === inputs.timeframe &&
          response.conditionId === market.id &&
          response.timeframe === inputs.timeframe
        ) {
          historySource.current.asOfByRange[inputs.timeframe] = response.asOf;
          latest.current.onHistory(response);
        } else {
          throw new Error("History repair does not match the active display scope.");
        }
      },
      () => {
        if (historySource.current.contextKey === priceContextKey)
          latest.current.onInvalidateHistory();
      },
      false,
      (status) => {
        if (
          historySource.current.contextKey !== priceContextKey ||
          latest.current.market?.id !== market.id ||
          latest.current.timeframe !== inputs.timeframe
        )
          return;
        const hasSnapshot = Boolean(latest.current.market.priceHistory.asOf);
        latest.current.onHistoryStatus?.(
          status === "refreshing" && !hasSnapshot ? "loading" : status,
        );
      },
    );
  }, [marketId, inputs.timeframe, priceContextKey]);
  useEffect(() => {
    const market = latest.current.market;
    if (!market) return;
    return subscribeSnapshot(
      market,
      ({ eventOrder, signal }) =>
        fetchMarketComments(market.id, { minimumEventOrder: eventOrder, refresh: true, signal }),
      (response) => {
        if (latest.current.market?.id !== market.id || response.conditionId !== market.id)
          throw new Error("Comment repair does not match the active display scope.");
        latest.current.onComments(response);
      },
      undefined,
      true,
    );
  }, [marketId]);
}
