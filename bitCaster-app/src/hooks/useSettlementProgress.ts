import { useCallback, useEffect, useRef, useState } from "react";
import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type { SettlementGroupSummary } from "@bitcaster/client-sdk/engineClient";
import { readSettlementProgress } from "@/lib/settlementProgressReader";
import { listenForSettlementProgressHints } from "@/lib/settlementProgressHints";

export interface SettlementProgressEntry {
  operationId: string;
  marketId: string;
  lifecycleState: CtfRangeOrderPreparationLifecycle;
  orderId: string | null;
}

interface Observation {
  group: SettlementGroupSummary | null;
  unavailable: boolean;
}

/** Read-only, visible-page observations. The durable journal owns membership. */
export function useSettlementProgress(
  entries: readonly SettlementProgressEntry[],
  enabled: boolean,
) {
  const [observations, setObservations] = useState<Record<string, Observation>>({});
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let again = false;
    setObservations({});
    setLoading(false);
    const run = async () => {
      if (!enabled || controller.signal.aborted) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      setLoading(true);
      try {
        do {
          again = false;
          for (const entry of entries) {
            if (controller.signal.aborted) return;
            if (!readsSettlementStatus(entry.lifecycleState) || entry.orderId === null) continue;
            try {
              const group = await readSettlementProgress(
                entry.marketId,
                entry.orderId,
                controller.signal,
              );
              if (controller.signal.aborted) return;
              setObservations((current) => ({
                ...current,
                [entry.operationId]: {
                  group: group ?? current[entry.operationId]?.group ?? null,
                  unavailable: group === null,
                },
              }));
            } catch {
              if (controller.signal.aborted) return;
              setObservations((current) => ({
                ...current,
                [entry.operationId]: {
                  group: current[entry.operationId]?.group ?? null,
                  unavailable: true,
                },
              }));
            }
          }
        } while (again && !controller.signal.aborted);
      } finally {
        running = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    refreshRef.current = () => {
      void run();
    };
    const stop = listenForSettlementProgressHints((hint) => {
      if (
        hint === null ||
        entries.some(
          (entry) =>
            readsSettlementStatus(entry.lifecycleState) &&
            entry.orderId === hint.orderId &&
            entry.marketId === hint.marketId,
        )
      )
        void run();
    });
    void run();
    return () => {
      controller.abort();
      stop();
      refreshRef.current = () => {};
    };
  }, [entries, enabled]);

  return { observations, loading, refresh };
}

function readsSettlementStatus(lifecycleState: CtfRangeOrderPreparationLifecycle): boolean {
  switch (lifecycleState) {
    case "prepared":
    case "capability-requested":
    case "capability-bound":
    case "submission-rejected":
    case "terminal":
      return false;
    case "order-submitted":
      return true;
    default:
      return assertNever(lifecycleState);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CTF range preparation lifecycle: ${value}`);
}
