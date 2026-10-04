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
}

// One active read keeps one pending invalidation. Source positions remain opaque.
function subscribeSnapshot<T>(
  market: MarketDetail,
  read: (options: MarketSnapshotReadOptions) => Promise<T>,
  apply: (response: T) => void,
  invalidate: () => void = () => {},
  commentChanges = false,
): () => void {
  const controller = new AbortController();
  let generation = 0;
  let inFlight = false;
  let dirty = false;
  let minimumEventOrder: string | undefined;
  const run = async () => {
    inFlight = true;
    do {
      dirty = false;
      const requestGeneration = generation;
      try {
        const response = await read({
          minimumEventOrder,
          refresh: true,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && requestGeneration === generation) apply(response);
      } catch {
        // An unavailable read must preserve the displayed snapshot.
      }
    } while (dirty && !controller.signal.aborted);
    inFlight = false;
  };
  const changed = (eventOrder?: string) => {
    if (controller.signal.aborted) return;
    if (eventOrder !== undefined && eventOrder === minimumEventOrder) return;
    generation += 1;
    minimumEventOrder = eventOrder;
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
  useEffect(() => {
    const market = latest.current.market;
    if (!market) return;
    return subscribeSnapshot(
      market,
      (options) => fetchMarketPriceHistory(market.id, inputs.timeframe, options),
      (response) => {
        if (
          latest.current.market?.id === market.id &&
          latest.current.timeframe === inputs.timeframe &&
          response.conditionId === market.id
        )
          latest.current.onHistory(response);
      },
      () => latest.current.onInvalidateHistory(),
    );
  }, [marketId, inputs.timeframe]);
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
