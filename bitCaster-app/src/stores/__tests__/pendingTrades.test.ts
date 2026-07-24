import { beforeEach, describe, expect, it } from "vitest";
import { usePendingTradesStore, type PendingTrade } from "../pendingTrades";

function makeTrade(orderId: string, overrides: Partial<PendingTrade> = {}): PendingTrade {
  return {
    orderId,
    marketId: "cond-Alice",
    clientOrderId: `client-${orderId}`,
    submittedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  usePendingTradesStore.setState({ byOrderId: {} });
});

describe("usePendingTradesStore", () => {
  it("stores and retrieves a pending trade by orderId", () => {
    const trade = makeTrade("order-1");
    usePendingTradesStore.getState().add(trade);

    expect(usePendingTradesStore.getState().get("order-1")).toEqual(trade);
  });

  it("add is idempotent by orderId — a second call replaces the entry", () => {
    usePendingTradesStore.getState().add(makeTrade("order-1"));
    usePendingTradesStore.getState().add(makeTrade("order-1", { submittedAt: 99 }));

    const entry = usePendingTradesStore.getState().get("order-1");
    expect(entry?.submittedAt).toBe(99);
    expect(Object.keys(usePendingTradesStore.getState().byOrderId)).toHaveLength(1);
  });

  it("remove deletes the entry and is a no-op for unknown orderIds", () => {
    usePendingTradesStore.getState().add(makeTrade("order-1"));
    usePendingTradesStore.getState().remove("order-unknown");
    expect(usePendingTradesStore.getState().get("order-1")).toBeDefined();

    usePendingTradesStore.getState().remove("order-1");
    expect(usePendingTradesStore.getState().get("order-1")).toBeUndefined();
  });
});
