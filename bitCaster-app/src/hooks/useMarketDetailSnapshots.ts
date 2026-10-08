import { useEffect, useRef } from "react";
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
} from "@/lib/marketHub";
import { outcomeSetIdsForMarketBooks, outcomeSetMarketId } from "@/lib/outcomeSets";
import type { ChartTimeframe, MarketDetail } from "@/types/market-detail";
import type { MarketSnapshotReadOptions } from "@bitcaster/client-sdk/engineClient";

interface SnapshotInputs {
  market: MarketDetail | null;
  timeframe: ChartTimeframe;
  onHistory: (response: MarketPriceHistoryResponse) => void;
  onComments: (response: MarketCommentsResponse) => void;
  onInvalidateHistory: () => void;
  onHistoryStatus?: (status: NonNullable<MarketDetail["priceHistoryStatus"]>) => void;
}

// One active read keeps one pending invalidation. Source positions remain opaque.
function subscribeSnapshot<T>(
  market: MarketDetail,
  read: (options: MarketSnapshotReadOptions) => Promise<T>,
  apply: (response: T) => void,
  invalidate: () => void = () => {},
  commentChanges = false,
  observation?: {
    initialEventOrder?: string;
    onEventOrder: (eventOrder: string) => void;
    onStatus: (status: "refreshing" | "ready" | "unavailable") => void;
  },
): () => void {
  const controller = new AbortController();
  let generation = 0;
  let inFlight = false;
  let dirty = false;
  let minimumEventOrder = observation?.initialEventOrder;
  const run = async () => {
    inFlight = true;
    do {
      dirty = false;
      const requestGeneration = generation;
      observation?.onStatus("refreshing");
      try {
        const response = await read({
          minimumEventOrder,
          refresh: true,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && requestGeneration === generation) {
          apply(response);
          observation?.onStatus("ready");
        }
      } catch {
        // An unavailable read must preserve the displayed snapshot.
        if (!controller.signal.aborted && requestGeneration === generation)
          observation?.onStatus("unavailable");
      }
    } while (dirty && !controller.signal.aborted);
    inFlight = false;
  };
  const changed = (eventOrder?: string) => {
    if (controller.signal.aborted) return;
    if (eventOrder !== undefined && eventOrder === minimumEventOrder) return;
    generation += 1;
    if (eventOrder !== undefined) {
      minimumEventOrder = eventOrder;
      observation?.onEventOrder(eventOrder);
    }
    dirty = true;
    invalidate();
    if (!inFlight) void run();
  };
  const firstOutcome = outcomeSetIdsForMarketBooks(market)[0];
  const cleanups = [
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
  void run();
  return () => {
    controller.abort();
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
    eventOrder?: string;
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
      (options) => {
        const current = latest.current.market;
        return fetchMarketPriceHistory(market.id, inputs.timeframe, {
          ...options,
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
        }
      },
      () => {
        if (historySource.current.contextKey === priceContextKey)
          latest.current.onInvalidateHistory();
      },
      false,
      {
        initialEventOrder: historySource.current.eventOrder,
        onEventOrder: (eventOrder) => {
          if (historySource.current.contextKey === priceContextKey)
            historySource.current.eventOrder = eventOrder;
        },
        onStatus: (status) => {
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
      },
    );
  }, [marketId, inputs.timeframe, priceContextKey]);
  useEffect(() => {
    const market = latest.current.market;
    if (!market) return;
    return subscribeSnapshot(
      market,
      (options) => fetchMarketComments(market.id, options),
      (response) => {
        if (latest.current.market?.id === market.id && response.conditionId === market.id)
          latest.current.onComments(response);
      },
      undefined,
      true,
    );
  }, [marketId]);
}
