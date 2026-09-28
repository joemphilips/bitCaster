import { beforeEach, describe, expect, it } from "vitest";
import { usePendingTradesStore, type NewPendingTrade, type PendingTrade } from "../pendingTrades";

const WALLET_ID = "a".repeat(64);

function makeTrade(orderId: string, overrides: Partial<PendingTrade> = {}): NewPendingTrade {
  return {
    orderId,
    walletId: WALLET_ID,
    marketId: "cond-Alice",
    clientOrderId: `client-${orderId}`,
    submittedAt: 1_700_000_000_000,
    baseAsset: "sat",
    divisibility: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.removeItem("bitcaster-pending-trades");
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

  it("removes only an order owned by the supplied wallet", () => {
    usePendingTradesStore.getState().add(makeTrade("order-1"));
    usePendingTradesStore.getState().remove("order-1", "b".repeat(64));
    expect(usePendingTradesStore.getState().get("order-1")).toBeDefined();

    usePendingTradesStore.getState().remove("order-1", WALLET_ID);
    expect(usePendingTradesStore.getState().get("order-1")).toBeUndefined();
  });

  it("keeps unscoped legacy orders unresolved and visible as a switch blocker", () => {
    const legacy = makeTrade("legacy-order");
    delete (legacy as Partial<PendingTrade>).walletId;
    usePendingTradesStore.setState({ byOrderId: { [legacy.orderId]: legacy } });

    expect(usePendingTradesStore.getState().hasUnscopedPending()).toBe(true);
    usePendingTradesStore.getState().remove(legacy.orderId, WALLET_ID);
    expect(usePendingTradesStore.getState().get(legacy.orderId)).toBeDefined();
  });

  it("rehydrates legacy orders without assigning them to a wallet", async () => {
    const legacy = makeTrade("legacy-persisted");
    delete (legacy as Partial<PendingTrade>).walletId;
    localStorage.setItem(
      "bitcaster-pending-trades",
      JSON.stringify({ state: { byOrderId: { [legacy.orderId]: legacy } }, version: 0 }),
    );

    await usePendingTradesStore.persist.rehydrate();

    expect(usePendingTradesStore.getState().get(legacy.orderId)).toEqual(legacy);
    expect(usePendingTradesStore.getState().hasUnscopedPending()).toBe(true);
  });

  it("retains an unresolved order older than seven days after storage rehydration", async () => {
    const oldTrade = makeTrade("old-unresolved", {
      submittedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000,
    });
    localStorage.setItem(
      "bitcaster-pending-trades",
      JSON.stringify({ state: { byOrderId: { [oldTrade.orderId]: oldTrade } }, version: 0 }),
    );

    await usePendingTradesStore.persist.rehydrate();

    expect(usePendingTradesStore.getState().get(oldTrade.orderId)).toEqual(oldTrade);
    expect(usePendingTradesStore.getState().hasPendingForWallet(WALLET_ID)).toBe(true);
  });
});
