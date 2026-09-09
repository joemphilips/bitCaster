import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementGroupStatus } from "@bitcaster/client-sdk/engineClient";
import type { OrderStatusResponse } from "../orderStatus";
import { createSettlementProgressReader, settlementGroupForOrder } from "../settlementProgressReader";

vi.mock("../orderStatus", () => ({ fetchOrderStatus: vi.fn() }));
afterEach(() => vi.useRealTimers());

const statuses = ["Prepared", "SubmissionPending", "Reconciling", "Confirmed",
  "DefinitivelyRejected", "Refundable", "ExpiredBeforeSubmission", "RejectedBeforeSubmission"
] as const satisfies readonly SettlementGroupStatus[];

describe("settlement progress reader", () => {
  it.each(statuses)("preserves %s without inferring wallet recovery", async (status) => {
    const response = order(status);
    const read = vi.fn().mockResolvedValue(response);
    const reader = createSettlementProgressReader(read);
    expect(await reader("condition-Alpha", "order-1", new AbortController().signal))
      .toEqual(response.activeSettlementGroup);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a terminal summary from fills when the active group is absent", () => {
    const response = order("Refundable");
    response.fills = [{
      id: "fill-1", makerOrderId: "maker-1", takerOrderId: "order-1",
      amountSubunits: 1_000, executionPrice: 500, path: "Mint", status: "Failed",
      filledAt: "2026-09-07T00:00:00Z", settlementGroup: response.activeSettlementGroup!,
      baseAsset: "sat", divisibility: 1_000, tokenSide: "Outcome",
      quotePaymentSubunits: 500, outcomeFaceAmountSubunits: 1_000,
    }];
    response.activeSettlementGroup = null;
    expect(settlementGroupForOrder(response, response.marketId, response.orderId)?.status).toBe("Refundable");
    response.activeSettlementGroup = order("Confirmed").activeSettlementGroup;
    expect(() => settlementGroupForOrder(response, response.marketId, response.orderId)).toThrow("disagree");
  });

  it("rejects foreign order or route identities", () => {
    expect(() => settlementGroupForOrder(order(), "other-route", "order-1")).toThrow("identity");
    expect(() => settlementGroupForOrder(order(), "condition-Alpha", "other-order")).toThrow("identity");
  });

  it("keeps missing status distinct from a rejected trade", async () => {
    const reader = createSettlementProgressReader(vi.fn().mockResolvedValue(null));
    expect(await reader("condition-Alpha", "order-1", new AbortController().signal)).toBeNull();
  });

  it("retains the shared slot after a deadline until the underlying read settles", async () => {
    vi.useFakeTimers();
    let finish!: (value: OrderStatusResponse) => void;
    const pending = new Promise<OrderStatusResponse>((resolve) => { finish = resolve; });
    const read = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(order());
    const reader = createSettlementProgressReader(read);
    const first = reader("condition-Alpha", "order-1", new AbortController().signal);
    const failed = expect(first).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(read.mock.calls[0][2].aborted).toBe(true);
    for (let page = 0; page < 10; page++) {
      await expect(reader("condition-Alpha", "order-1", new AbortController().signal)).rejects.toThrow("unavailable");
    }
    expect(read).toHaveBeenCalledTimes(1);
    finish(order());
    await vi.advanceTimersByTimeAsync(0);
    expect(await reader("condition-Alpha", "order-1", new AbortController().signal)).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("cancels a page read without releasing an unresolved signer slot", async () => {
    let finish!: (value: OrderStatusResponse) => void;
    const pending = new Promise<OrderStatusResponse>((resolve) => { finish = resolve; });
    const read = vi.fn().mockReturnValue(pending);
    const reader = createSettlementProgressReader(read);
    const controller = new AbortController();
    const first = reader("condition-Alpha", "order-1", controller.signal);
    const failed = expect(first).rejects.toThrow("unavailable");
    await Promise.resolve();
    controller.abort();
    await failed;
    await expect(reader("condition-Alpha", "order-1", new AbortController().signal)).rejects.toThrow("unavailable");
    expect(read).toHaveBeenCalledTimes(1);
    finish(order());
  });
});

function order(status: SettlementGroupStatus = "Prepared"): OrderStatusResponse {
  return {
    orderId: "order-1", marketId: "condition-Alpha", status: "matched",
    remainingAmountSubunits: 0, filledAmountSubunits: 0, fills: [], amountSubunits: 1_000,
    outcomeId: "Alpha", side: "Buy", price: 500, placedAt: "2026-09-07T00:00:00Z",
    timeInForce: "FOK", tokenSide: "Outcome", baseAsset: "sat", divisibility: 1_000,
    activeSettlementGroup: { groupId: "group-1", status, revision: 1,
      coalescingDeadline: "2026-09-07T00:00:00Z", frozenAt: null },
  };
}
