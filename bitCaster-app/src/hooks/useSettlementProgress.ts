import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type {
  OrderLifecycleStatus,
  SettlementGroupStatus,
  SettlementGroupSummary,
} from "@bitcaster/client-sdk/engineClient";
import {
  readSettlementFailure,
  readSettlementProgress,
  type SettlementProgressRead,
} from "@/lib/settlementProgressReader";
import { listenForSettlementProgressHints } from "@/lib/settlementProgressHints";
import { isTerminalCtfRangePreparation } from "@/lib/ctfRangeOrderLifecycle";
import { knownMarketTitle } from "@/hooks/useMarketTitles";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import {
  isSpecificReason,
  orderFailureNoticeKey,
  recordOrderFailureNotice,
  useOrderFailureNotices,
  type OrderFailureReason,
} from "@/stores/orderFailureNotices";
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

export interface SettlementObservation {
  group: SettlementGroupSummary | null;
  /** The status of the engine order, or null before a read returned it. */
  orderStatus: OrderLifecycleStatus | null;
  unavailable: boolean;
}

/**
 * How the panel shows one active journal entry. `failed` is a final failure
 * with a notice and its first known reason. `refusal` is a local refusal: its
 * wallet alert shows an engine refusal; otherwise the user stopped it, and
 * the entry shows `message` until the refund. `progress` shows `message`. A
 * `final` entry ended without a trade: only its refund is still active, so it
 * has no status to refresh.
 */
export type SettlementEntryDisplay =
  | { readonly kind: "failed"; readonly reason: OrderFailureReason }
  | { readonly kind: "refusal"; readonly message: string }
  | { readonly kind: "progress"; readonly message: string; readonly final: boolean };

/** Read-only, visible-page observations. The durable journal owns membership. */
export function useSettlementProgress(
  entries: readonly SettlementProgressEntry[],
  enabled: boolean,
  scope: SettlementProgressScope,
) {
  const [observations, setObservations] = useState<Record<string, SettlementObservation>>({});
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
    // The failure reason of a rejected group never changes, so one successful
    // read is enough. A specific reason outlives the journal operation in its
    // notice; a group with no recorded reason is read once for each run.
    const withoutReason = new Set<string>();
    const readFailureOnce = async (
      entry: SettlementProgressEntry,
      group: SettlementGroupSummary | null,
    ) => {
      const orderId = entry.orderId;
      if (group === null || !hasFailureReason(group.status) || orderId === null) return;
      const key = `${entry.operationId}:${group.groupId}`;
      const notice =
        useOrderFailureNotices.getState().notices[
          orderFailureNoticeKey(scopeId, entry.operationId)
        ];
      if (withoutReason.has(key) || (notice !== undefined && isSpecificReason(notice.reason)))
        return;
      let failure: Awaited<ReturnType<typeof readSettlementFailure>>;
      try {
        failure = await readSettlementFailure(entry.marketId, orderId, controller.signal);
      } catch {
        // The generic reason stays visible; the next read tries the reason again.
        return;
      }
      if (controller.signal.aborted) return;
      if (failure === null) {
        withoutReason.add(key);
        return;
      }
      void recordOrderFailureNotice({
        scopeId,
        operationId: entry.operationId,
        orderId,
        marketId: entry.marketId,
        marketTitle: knownMarketTitle(orderId, entry.marketId),
        reason: failure.reason,
      });
    };
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
              const read = await readSettlementProgress(
                entry.marketId,
                entry.orderId,
                controller.signal,
              );
              if (controller.signal.aborted) return;
              setObservations((current) => ({
                ...current,
                [entry.operationId]:
                  read === null
                    ? unavailableObservation(current[entry.operationId])
                    : mergeRead(current[entry.operationId], read),
              }));
              await readFailureOnce(entry, read?.group ?? null);
            } catch {
              if (controller.signal.aborted) return;
              setObservations((current) => ({
                ...current,
                [entry.operationId]: unavailableObservation(current[entry.operationId]),
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
  }, [entries, enabled, scopeId, walletId, signerRevision]);

  // A final failure keeps its notice after the journal operation ends. Record
  // it before paint, so the order never shows under the in-progress heading.
  // A recorded notice is never recorded again, so no read rewrites storage.
  useLayoutEffect(() => {
    const { notices } = useOrderFailureNotices.getState();
    for (const entry of entries) {
      const reason = failureReason(
        settlementEntryDisplay(entry.lifecycleState, observations[entry.operationId], enabled),
      );
      if (
        reason === null ||
        entry.orderId === null ||
        notices[orderFailureNoticeKey(scopeId, entry.operationId)] !== undefined
      )
        continue;
      void recordOrderFailureNotice({
        scopeId,
        operationId: entry.operationId,
        orderId: entry.orderId,
        marketId: entry.marketId,
        marketTitle: knownMarketTitle(entry.orderId, entry.marketId),
        reason,
      });
    }
  }, [entries, observations, enabled, scopeId]);

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
  if (lifetime.aborted || lifecycleState === null || !isTerminalCtfRangePreparation(lifecycleState))
    return;
  const others = (current: readonly SettlementProgressEntry[]) =>
    current.filter((item) => item.operationId !== entry.operationId);
  setCompleted((current) => [...others(current), entry]);
  const timer = setTimeout(() => setCompleted(others), SETTLEMENT_COMPLETION_NOTICE_MS);
  lifetime.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

function retainEntries(
  current: Record<string, SettlementObservation>,
  entries: readonly SettlementProgressEntry[],
): Record<string, SettlementObservation> {
  return Object.fromEntries(
    entries.flatMap((entry) => {
      const observation = current[entry.operationId];
      return observation === undefined ? [] : [[entry.operationId, observation]];
    }),
  );
}

function adoptPublishedGroups(
  current: Record<string, SettlementObservation>,
  entries: readonly SettlementProgressEntry[],
  published: Readonly<Record<string, OrderSettlementObservation>>,
  walletId: string,
  signerRevision: number,
): Record<string, SettlementObservation> {
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
    next = {
      ...next,
      [entry.operationId]: { group, orderStatus: observation.status, unavailable: false },
    };
  }
  return next;
}

/** A failed read keeps the last observation and marks it stale. */
function unavailableObservation(
  previous: SettlementObservation | undefined,
): SettlementObservation {
  return {
    group: previous?.group ?? null,
    orderStatus: previous?.orderStatus ?? null,
    unavailable: true,
  };
}

/** A later read wins, except an older revision of the same group, which keeps its status. */
function mergeRead(
  previous: SettlementObservation | undefined,
  read: SettlementProgressRead,
): SettlementObservation {
  const previousGroup = previous?.group ?? null;
  const group = read.group === null ? previousGroup : latestGroup(previousGroup, read.group);
  const keepsPrevious = group !== null && group !== read.group;
  return {
    group,
    orderStatus: keepsPrevious ? (previous?.orderStatus ?? read.status) : read.status,
    unavailable: false,
  };
}

const FAILED: SettlementEntryDisplay = { kind: "failed", reason: "Unspecified" };
/** The engine cancels a public FOK only when it cannot fill within the consented total. */
const FOK_CANCELLED: SettlementEntryDisplay = { kind: "failed", reason: "FokCancelled" };

function progress(message: string, final = false): SettlementEntryDisplay {
  return { kind: "progress", message, final };
}

/** Only a final failure of an engine order gets a failure notice. */
function failureReason(display: SettlementEntryDisplay): OrderFailureReason | null {
  switch (display.kind) {
    case "failed":
      return display.reason;
    case "refusal":
    case "progress":
      return null;
    default:
      return assertNever(display);
  }
}

/**
 * What the panel shows for one active journal entry. A failure is final: a
 * failed group or a failed order ends a browser FOK order, which never rests.
 * An unavailable or pending read is not a failure.
 */
export function settlementEntryDisplay(
  lifecycleState: CtfRangeOrderPreparationLifecycle,
  observation: SettlementObservation | undefined,
  canReadStatus: boolean,
): SettlementEntryDisplay {
  switch (lifecycleState) {
    case "prepared":
      return progress("prepared");
    case "order-requested":
      return progress("orderRequested");
    case "capability-requested":
      return progress("capabilityRequested");
    case "capability-bound":
      return progress("capabilityBound");
    case "terminal":
      return progress("terminal");
    case "order-request-rejected":
    case "submission-rejected":
      return { kind: "refusal", message: "endedWithoutTrade" };
    case "order-submitted":
      if (!canReadStatus) return progress("authenticationRequired");
      if (observation?.group) return groupDisplay(observation.group.status);
      if (observation?.orderStatus) return orderStatusDisplay(observation.orderStatus);
      return progress(observation?.unavailable ? "unavailable" : "orderSubmitted");
    default:
      return assertNever(lifecycleState);
  }
}

/** The engine reports each failed group state as a `failed` order. */
function groupDisplay(status: SettlementGroupStatus): SettlementEntryDisplay {
  switch (status) {
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
    case "Confirmed":
      return progress(status);
    case "DefinitivelyRejected":
    case "Refundable":
    case "ExpiredBeforeSubmission":
    case "RejectedBeforeSubmission":
      return FAILED;
    default:
      return assertNever(status);
  }
}

/**
 * An accepted order with no settlement group. The engine fails it, for
 * example at capacity or when a bot fill is refused. A FOK that cannot fill
 * within the consented total is cancelled. Each end without a trade fails the
 * trade; only the cancellation has a known cause.
 */
function orderStatusDisplay(status: OrderLifecycleStatus): SettlementEntryDisplay {
  switch (status) {
    case "failed":
    case "rejected_capacity":
    case "evicted_capacity":
    case "expired":
      return FAILED;
    case "cancelled":
      return FOK_CANCELLED;
    case "resting":
    case "matched":
    case "partially_filled":
    case "filled":
      return progress("orderSubmitted");
    default:
      return assertNever(status);
  }
}

/** Only a definitively rejected group can carry a recorded failure reason. */
function hasFailureReason(status: SettlementGroupStatus): boolean {
  switch (status) {
    case "DefinitivelyRejected":
      return true;
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
    case "Confirmed":
    case "Refundable":
    case "ExpiredBeforeSubmission":
    case "RejectedBeforeSubmission":
      return false;
    default:
      return assertNever(status);
  }
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

function readsSettlementStatus(lifecycleState: CtfRangeOrderPreparationLifecycle): boolean {
  switch (lifecycleState) {
    case "prepared":
    case "order-requested":
    case "order-request-rejected":
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
