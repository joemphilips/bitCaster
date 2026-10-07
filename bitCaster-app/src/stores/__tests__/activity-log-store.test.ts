import { beforeEach, describe, expect, it } from "vitest";
import { activityLogsEqual, decodeActivityItem, useActivityLogStore } from "../activity-log";
import type { ActivityItem } from "@/types/portfolio";

const WALLET_A = "a".repeat(64);
const WALLET_B = "b".repeat(64);

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    walletId: WALLET_A,
    type: "deposit",
    amountSubunits: 1000,
    baseAsset: "sat",
    date: "2026-05-09T00:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.removeItem("bitcaster-activity-log");
  useActivityLogStore.setState({ items: [] });
});

describe("useActivityLogStore", () => {
  it("retains two exact order-linked fill records across local reload and compares order identity", async () => {
    const fills = ["first", "second"].map((fillId) =>
      item({
        id: `trade:${WALLET_A}:${fillId}`,
        type: "Buy",
        marketId: "condition-YES",
        tradeDetails: {
          orderId: "one",
          fillId,
          outcomeId: "YES",
          tokenSide: "Outcome",
          faceAmountSubunits: 1000,
          divisibility: 1000,
        },
      }),
    );
    fills.forEach((fill) => useActivityLogStore.getState().upsertConfirmedTrade(fill));
    const saved = localStorage.getItem("bitcaster-activity-log")!;
    useActivityLogStore.setState({ items: [] });
    localStorage.setItem("bitcaster-activity-log", saved);
    await useActivityLogStore.persist.rehydrate();
    expect(activityLogsEqual(useActivityLogStore.getState().items, fills)).toBe(true);
    expect(useActivityLogStore.getState().items).toHaveLength(2);
    const changed = { ...fills[0], tradeDetails: { ...fills[0].tradeDetails!, orderId: "two" } };
    expect(activityLogsEqual([fills[0]], [changed])).toBe(false);
    for (const orderId of ["", " one", null, 1]) {
      expect(
        decodeActivityItem({ ...fills[0], tradeDetails: { ...fills[0].tradeDetails, orderId } }),
      ).toBeNull();
    }
  });
  it("replace sorts newest first and caps the persisted activity feed", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.getState().replace([older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual(["newer", "older"]);
  });

  it("keeps the browser display cache at 500 rows after shared extraction", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      item({ id: String(index), date: new Date(index * 1_000).toISOString() }),
    );
    useActivityLogStore.getState().replace(rows);
    expect(useActivityLogStore.getState().items).toHaveLength(500);
    expect(useActivityLogStore.getState().items[0].id).toBe("500");
    expect(useActivityLogStore.getState().items.at(-1)!.id).toBe("1");
    const saved = localStorage.getItem("bitcaster-activity-log")!;
    useActivityLogStore.setState({ items: [] });
    localStorage.setItem("bitcaster-activity-log", saved);
    await useActivityLogStore.persist.rehydrate();
    expect(useActivityLogStore.getState().items).toHaveLength(500);
  });

  it("replace reorders an equal item set when dates require it", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.setState({ items: [older, newer] });
    useActivityLogStore.getState().replace([older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual(["newer", "older"]);
  });

  it("clear empties the activity feed", () => {
    useActivityLogStore.setState({ items: [item()] });
    useActivityLogStore.getState().clear();
    expect(useActivityLogStore.getState().items).toEqual([]);
  });

  it("upserts a confirmed fill once by its wallet-scoped stable id", () => {
    const fillId = "22222222-2222-4222-8222-222222222222";
    const trade = item({
      id: `trade:${WALLET_A}:${fillId}`,
      type: "Buy",
      amountSubunits: 1_250,
      date: "2026-05-10T00:00:00.000Z",
      marketId: "condition-YES",
      tradeDetails: {
        fillId,
        outcomeId: "YES",
        tokenSide: "Complement",
        faceAmountSubunits: 2_500,
        divisibility: 1_000,
      },
    });

    useActivityLogStore.getState().upsertConfirmedTrade(trade);
    useActivityLogStore.getState().upsertConfirmedTrade(trade);

    expect(useActivityLogStore.getState().items).toEqual([trade]);
  });

  it("keeps the same fill identity separate for different wallets", () => {
    const fillId = "22222222-2222-4222-8222-222222222222";
    const a = item({
      id: `trade:${WALLET_A}:${fillId}`,
      type: "Buy",
      marketId: "condition-YES",
      tradeDetails: {
        fillId,
        outcomeId: "YES",
        tokenSide: "Outcome",
        faceAmountSubunits: 1_000,
        divisibility: 1_000,
      },
    });
    const b = { ...a, id: `trade:${WALLET_B}:${fillId}`, walletId: WALLET_B };

    useActivityLogStore.getState().upsertConfirmedTrade(a);
    useActivityLogStore.getState().upsertConfirmedTrade(b);

    expect(useActivityLogStore.getState().items).toEqual([b, a]);
  });
});

describe("activityLogsEqual", () => {
  it("returns true for identical logs regardless of order", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    expect(activityLogsEqual([a, b], [b, a])).toBe(true);
  });

  it("returns false when an activity field differs", () => {
    const a = item({ amountSubunits: 1 });
    const b = item({ amountSubunits: 2 });
    expect(activityLogsEqual([a], [b])).toBe(false);
  });

  it("compares the exact trade metadata used for encrypted sync", () => {
    const a = item({
      id: `trade:${WALLET_A}:fill-id`,
      type: "Buy",
      marketId: "condition-YES",
      tradeDetails: {
        fillId: "fill-id",
        outcomeId: "YES",
        tokenSide: "Outcome",
        faceAmountSubunits: 1_000,
        divisibility: 1_000,
      },
    });
    const b = {
      ...a,
      tradeDetails: { ...a.tradeDetails!, faceAmountSubunits: 2_000 },
    };

    expect(activityLogsEqual([a], [b])).toBe(false);
  });

  it("compares records by wallet and id", () => {
    expect(activityLogsEqual([item()], [item({ walletId: WALLET_B })])).toBe(false);
  });
});

describe("decodeActivityItem", () => {
  it("keeps legacy ownership unknown and maps legacy amountSats to amountSubunits", () => {
    expect(
      decodeActivityItem({
        id: "legacy",
        type: "deposit",
        amountSats: 4_200,
        baseAsset: "sat",
        date: "2026-05-09T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      }),
    ).toEqual({
      id: "legacy",
      type: "deposit",
      amountSubunits: 4_200,
      baseAsset: "sat",
      date: "2026-05-09T00:00:00.000Z",
      status: "completed",
      txId: null,
      lightningInvoice: null,
    });
  });

  it("rejects malformed explicit wallet identities", () => {
    expect(decodeActivityItem({ ...item(), walletId: "unknown" })).toBeNull();
  });

  it("rejects trade metadata that is not bound to its wallet-scoped fill id", () => {
    const trade = item({
      id: "trade:wrong-wallet:fill-id",
      type: "Buy",
      marketId: "condition-YES",
      tradeDetails: {
        fillId: "fill-id",
        outcomeId: "YES",
        tokenSide: "Outcome",
        faceAmountSubunits: 1_000,
        divisibility: 1_000,
      },
    });

    expect(decodeActivityItem(trade)).toBeNull();
  });

  it("rehydrates local legacy activity without guessing ownership", async () => {
    const legacy = {
      id: "legacy-local",
      type: "deposit",
      amountSats: 1_250,
      baseAsset: "sat",
      date: "2026-05-09T00:00:00.000Z",
      status: "completed",
      txId: null,
      lightningInvoice: null,
    };
    localStorage.setItem(
      "bitcaster-activity-log",
      JSON.stringify({ state: { items: [legacy] }, version: 0 }),
    );

    await useActivityLogStore.persist.rehydrate();

    expect(useActivityLogStore.getState().items).toEqual([
      {
        id: legacy.id,
        type: legacy.type,
        amountSubunits: legacy.amountSats,
        baseAsset: legacy.baseAsset,
        date: legacy.date,
        status: legacy.status,
        txId: legacy.txId,
        lightningInvoice: legacy.lightningInvoice,
      },
    ]);
    expect(useActivityLogStore.getState().items[0]?.walletId).toBeUndefined();
  });
});
