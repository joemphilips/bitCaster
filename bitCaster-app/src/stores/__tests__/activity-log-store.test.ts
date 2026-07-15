import { beforeEach, describe, expect, it } from "vitest";
import { activityLogsEqual, useActivityLogStore } from "../activity-log";
import type { ActivityItem } from "@/types/portfolio";

const WALLET_A = "a".repeat(64);
const WALLET_B = "b".repeat(64);

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    type: "deposit",
    amountSats: 1000,
    date: "2026-05-09T00:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.removeItem("bitcaster-activity-log");
  useActivityLogStore.setState({
    activeWalletId: null,
    items: [],
    itemsByWalletId: {},
  });
});

describe("useActivityLogStore", () => {
  it("replace sorts newest first and caps the persisted activity feed", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.getState().activateWallet(WALLET_A);
    useActivityLogStore.getState().replaceForWallet(WALLET_A, [older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("replace reorders an equal item set when dates require it", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.setState({
      activeWalletId: WALLET_A,
      items: [older, newer],
      itemsByWalletId: { [WALLET_A]: [older, newer] },
    });
    useActivityLogStore.getState().replaceForWallet(WALLET_A, [older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("clear empties the activity feed", () => {
    useActivityLogStore.setState({
      activeWalletId: WALLET_A,
      items: [item()],
      itemsByWalletId: { [WALLET_A]: [item()] },
    });
    useActivityLogStore.getState().clear();
    expect(useActivityLogStore.getState().items).toEqual([]);
  });

  it("switches seed-derived partitions without merging their history", () => {
    const first = item({ id: "wallet-a" });
    const second = item({ id: "wallet-b" });
    const store = useActivityLogStore.getState();

    store.addActivityForWallet(WALLET_A, {
      type: first.type,
      amountSats: first.amountSats,
      status: first.status,
    });
    store.replaceForWallet(WALLET_A, [first]);
    store.replaceForWallet(WALLET_B, [second]);

    store.activateWallet(WALLET_A);
    expect(useActivityLogStore.getState().items.map(({ id }) => id)).toEqual([
      "wallet-a",
    ]);
    store.activateWallet(WALLET_B);
    expect(useActivityLogStore.getState().items.map(({ id }) => id)).toEqual([
      "wallet-b",
    ]);
    store.activateWallet(WALLET_A);
    expect(useActivityLogStore.getState().items.map(({ id }) => id)).toEqual([
      "wallet-a",
    ]);
  });

  it("strictly decodes persisted wallet partitions during hydration", async () => {
    const valid = item({ id: "valid", baseAsset: "usd" });
    localStorage.setItem(
      "bitcaster-activity-log",
      JSON.stringify({
        version: 2,
        state: {
          itemsByWalletId: {
            [WALLET_A]: [
              valid,
              { ...item({ id: "unknown-asset" }), baseAsset: "btc" },
              { ...item({ id: "fractional" }), amountSats: 1.5 },
            ],
            invalid: [item({ id: "invalid-wallet" })],
            [WALLET_B]: Array.from({ length: 501 }, (_, index) =>
              item({ id: `oversized-${index}` }),
            ),
          },
        },
      }),
    );

    await useActivityLogStore.persist.rehydrate();

    expect(useActivityLogStore.getState().itemsByWalletId).toEqual({
      [WALLET_A]: [valid],
    });
    useActivityLogStore.getState().activateWallet(WALLET_A);
    expect(useActivityLogStore.getState().items).toEqual([valid]);
  });
});

describe("activityLogsEqual", () => {
  it("returns true for identical logs regardless of order", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    expect(activityLogsEqual([a, b], [b, a])).toBe(true);
  });

  it("returns false when an activity field differs", () => {
    const a = item({ amountSats: 1 });
    const b = item({ amountSats: 2 });
    expect(activityLogsEqual([a], [b])).toBe(false);
  });
});
