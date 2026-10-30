import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type {
  SettlementGroupStatus,
  SettlementGroupSummary,
} from "@bitcaster/client-sdk/engineClient";
import { readSettlementProgress } from "@/lib/settlementProgressReader";
import { listenForSettlementProgressHints } from "@/lib/settlementProgressHints";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import {
  useOrderSettlementObservations,
  type OrderSettlementObservation,
} from "@/stores/orderSettlementObservations";

/** A success message can close automatically. This matches the success toast. */
export const SETTLEMENT_COMPLETION_NOTICE_MS = 4_000;

export interface SettlementProgressEntry {
  operationId: string;
  marketId: string;
  lifecycleState: CtfRangeOrderPreparationLifecycle;
  orderId: string | null;
}

/** The wallet and signer that own the visible journal page. */
export interface SettlementProgressScope {
  readonly scopeId: string;
  readonly walletId: string;
  readonly signerRevision: number;
}

interface Observation {
  group: SettlementGroupSummary | null;
  unavailable: boolean;
}

/** Read-only, visible-page observations. The durable journal owns membership. */
export function useSettlementProgress(
  entries: readonly SettlementProgressEntry[],
  enabled: boolean,
  scope: SettlementProgressScope,
) {
  const [observations, setObservations] = useState<Record<string, Observation>>({});
  const [completed, setCompleted] = useState<readonly SettlementProgressEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const { scopeId, walletId, signerRevision } = scope;

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let again = false;
    setObservations((current) => retainEntries(current, entries));
    setLoading(false);
    // The order status reader publishes the same authoritative group that
    // reports a filled order. Use it so this page does not keep an older read.
    const adoptPublished = (published: Readonly<Record<string, OrderSettlementObservation>>) => {
      if (!enabled || controller.signal.aborted) return;
      setObservations((current) =>
        adoptPublishedGroups(current, entries, published, walletId, signerRevision),
      );
    };
    adoptPublished(useOrderSettlementObservations.getState().byOrderId);
    const stopObserving = useOrderSettlementObservations.subscribe((state, previous) => {
      if (state.byOrderId !== previous.byOrderId) adoptPublished(state.byOrderId);
    });
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
              setObservations((current) => {
                const previous = current[entry.operationId]?.group ?? null;
                return {
                  ...current,
                  [entry.operationId]: {
                    group: group === null ? previous : latestGroup(previous, group),
                    unavailable: group === null,
                  },
                };
              });
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
      stopObserving();
      refreshRef.current = () => {};
    };
  }, [entries, enabled, walletId, signerRevision]);

  // The completion notice outlives a page change, but not this component.
  const lifetimeRef = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime.signal;
    return () => lifetime.abort();
  }, []);
  // Render-time facts of the entries that the next effect run can remove.
  const shownRef = useRef<readonly SettlementProgressEntry[]>([]);
  const observationsRef = useRef(observations);
  observationsRef.current = observations;
  useEffect(() => {
    const confirmed = shownRef.current.filter(
      (entry) =>
        !entries.some((next) => next.operationId === entry.operationId) &&
        confirmsTrade(observationsRef.current[entry.operationId]?.group ?? null),
    );
    shownRef.current = entries;
    const lifetime = lifetimeRef.current;
    if (lifetime === null) return;
    for (const entry of confirmed) void showCompletion(entry, scopeId, lifetime, setCompleted);
  }, [entries, scopeId]);

  return { observations, completed, loading, refresh };
}

/**
 * Only the durable terminal journal shows that the wallet finished the trade.
 * An entry can also leave the visible page without a terminal journal.
 */
async function showCompletion(
  entry: SettlementProgressEntry,
  scopeId: string,
  lifetime: AbortSignal,
  setCompleted: Dispatch<SetStateAction<readonly SettlementProgressEntry[]>>,
): Promise<void> {
  let lifecycleState: CtfRangeOrderPreparationLifecycle | null;
  try {
    lifecycleState =
      (await readCtfRangePreparation(scopeId, entry.operationId))?.lifecycleState ?? null;
  } catch {
    return;
  }
  if (lifetime.aborted || lifecycleState === null || !isTerminal(lifecycleState)) return;
  const others = (current: readonly SettlementProgressEntry[]) =>
    current.filter((item) => item.operationId !== entry.operationId);
  setCompleted((current) => [...others(current), entry]);
  const timer = setTimeout(() => setCompleted(others), SETTLEMENT_COMPLETION_NOTICE_MS);
  lifetime.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

function retainEntries(
  current: Record<string, Observation>,
  entries: readonly SettlementProgressEntry[],
): Record<string, Observation> {
  return Object.fromEntries(
    entries.flatMap((entry) => {
      const observation = current[entry.operationId];
      return observation === undefined ? [] : [[entry.operationId, observation]];
    }),
  );
}

function adoptPublishedGroups(
  current: Record<string, Observation>,
  entries: readonly SettlementProgressEntry[],
  published: Readonly<Record<string, OrderSettlementObservation>>,
  walletId: string,
  signerRevision: number,
): Record<string, Observation> {
  let next = current;
  for (const entry of entries) {
    if (!readsSettlementStatus(entry.lifecycleState) || entry.orderId === null) continue;
    const observation = published[entry.orderId];
    if (
      !observation?.group ||
      observation.walletId !== walletId ||
      observation.signerRevision !== signerRevision ||
      observation.marketId !== entry.marketId ||
      observation.orderId !== entry.orderId
    )
      continue;
    const previous = next[entry.operationId];
    const group = latestGroup(previous?.group ?? null, observation.group);
    if (group !== observation.group || (previous?.group === group && !previous.unavailable))
      continue;
    next = { ...next, [entry.operationId]: { group, unavailable: false } };
  }
  return next;
}

/** A later read wins, except an older revision of the same group. */
function latestGroup(
  previous: SettlementGroupSummary | null,
  next: SettlementGroupSummary,
): SettlementGroupSummary {
  return previous !== null && previous.groupId === next.groupId && previous.revision > next.revision
    ? previous
    : next;
}

/** A public FOK order is filled after its settlement group is `Confirmed`. */
function confirmsTrade(group: SettlementGroupSummary | null): boolean {
  if (group === null) return false;
  const status: SettlementGroupStatus = group.status;
  switch (status) {
    case "Confirmed":
      return true;
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
    case "DefinitivelyRejected":
    case "Refundable":
    case "ExpiredBeforeSubmission":
    case "RejectedBeforeSubmission":
      return false;
    default:
      return assertNever(status);
  }
}

function isTerminal(lifecycleState: CtfRangeOrderPreparationLifecycle): boolean {
  switch (lifecycleState) {
    case "terminal":
      return true;
    case "prepared":
    case "capability-requested":
    case "capability-bound":
    case "order-submitted":
    case "submission-rejected":
      return false;
    default:
      return assertNever(lifecycleState);
  }
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
  throw new Error(`Unhandled settlement progress value: ${value}`);
}
