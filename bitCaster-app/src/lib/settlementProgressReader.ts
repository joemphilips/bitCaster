import type {
  OrderLifecycleStatus,
  OrderSettlementFailure,
  SettlementGroupSummary,
} from "@bitcaster/client-sdk/engineClient";
import {
  fetchOrderSettlementFailure,
  fetchOrderStatus,
  type OrderStatusResponse,
} from "./orderStatus";

const READ_DEADLINE_MS = 15_000;

/** Runs one read at a time. The slot stays occupied until the read settles, including uncancellable signing. */
export type SettlementReadSlot = <T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export function createSettlementReadSlot(): SettlementReadSlot {
  let occupied = false;
  return async <T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (occupied) throw new Error("Settlement status is unavailable.");
    occupied = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, READ_DEADLINE_MS);
    let rejectAborted!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new Error("Settlement status is unavailable."));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    const work = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const result = await read(controller.signal);
        controller.signal.throwIfAborted();
        return result;
      })
      .finally(() => {
        occupied = false;
      });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  };
}

/**
 * The order status and its settlement group. The engine can end an accepted
 * order with no group, for example when it fails the order, so the status
 * stays next to the group.
 */
export interface SettlementProgressRead {
  readonly status: OrderLifecycleStatus;
  readonly group: SettlementGroupSummary | null;
}

/** One slot survives page and wallet changes, including uncancellable signing. */
export function createSettlementProgressReader(
  read = fetchOrderStatus,
  slot: SettlementReadSlot = createSettlementReadSlot(),
) {
  return (
    marketId: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<SettlementProgressRead | null> =>
    slot(signal, async (readSignal) => {
      const response = await read(marketId, orderId, readSignal);
      return response === null
        ? null
        : {
            status: response.status,
            group: settlementGroupForOrder(response, marketId, orderId),
          };
    });
}

/** Reads why the settlement of one order failed. Null when the engine records no reason or no order. */
export function createSettlementFailureReader(
  read = fetchOrderSettlementFailure,
  slot: SettlementReadSlot = createSettlementReadSlot(),
) {
  return (
    marketId: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<OrderSettlementFailure | null> =>
    slot(
      signal,
      async (readSignal) => (await read(marketId, orderId, readSignal))?.failure ?? null,
    );
}

// Status and failure reads share one slot, so the page never signs two reads at once.
const sharedSlot = createSettlementReadSlot();
export const readSettlementProgress = createSettlementProgressReader(fetchOrderStatus, sharedSlot);
export const readSettlementFailure = createSettlementFailureReader(
  fetchOrderSettlementFailure,
  sharedSlot,
);

export function settlementGroupForOrder(
  response: OrderStatusResponse,
  marketId: string,
  orderId: string,
): SettlementGroupSummary | null {
  if (response.marketId !== marketId || response.orderId !== orderId) {
    throw new Error("Settlement status identity is invalid.");
  }
  const groups = response.fills.map((fill) => fill.settlementGroup);
  if (response.activeSettlementGroup) groups.push(response.activeSettlementGroup);
  const first = groups[0];
  if (!first) return null;
  for (const group of groups) {
    if (
      !group ||
      group.groupId !== first.groupId ||
      group.revision !== first.revision ||
      group.status !== first.status ||
      group.frozenAt !== first.frozenAt ||
      group.coalescingDeadline !== first.coalescingDeadline
    ) {
      throw new Error("Settlement status summaries disagree.");
    }
  }
  return first;
}
