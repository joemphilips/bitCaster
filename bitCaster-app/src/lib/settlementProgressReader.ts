import type { SettlementGroupSummary } from "@bitcaster/client-sdk/engineClient";
import { fetchOrderStatus, type OrderStatusResponse } from "./orderStatus";

const READ_DEADLINE_MS = 15_000;

/** One slot survives page and wallet changes, including uncancellable signing. */
export function createSettlementProgressReader(read = fetchOrderStatus) {
  let occupied = false;
  return async (
    marketId: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<SettlementGroupSummary | null> => {
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
    const work = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const response = await read(marketId, orderId, controller.signal);
      controller.signal.throwIfAborted();
      return response === null ? null : settlementGroupForOrder(response, marketId, orderId);
    }).finally(() => { occupied = false; });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  };
}

export const readSettlementProgress = createSettlementProgressReader();

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
    if (!group || group.groupId !== first.groupId || group.revision !== first.revision ||
        group.status !== first.status || group.frozenAt !== first.frozenAt ||
        group.coalescingDeadline !== first.coalescingDeadline) {
      throw new Error("Settlement status summaries disagree.");
    }
  }
  return first;
}
