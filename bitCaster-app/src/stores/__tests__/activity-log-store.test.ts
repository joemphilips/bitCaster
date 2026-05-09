import { beforeEach, describe, expect, it } from "vitest";
import { activityLogsEqual, useActivityLogStore } from "../activity-log";
import type { ActivityItem } from "@/types/portfolio";

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
  useActivityLogStore.setState({ items: [] });
});

describe("useActivityLogStore", () => {
  it("replace sorts newest first and caps the persisted activity feed", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.getState().replace([older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("replace reorders an equal item set when dates require it", () => {
    const older = item({ id: "older", date: "2026-05-08T00:00:00.000Z" });
    const newer = item({ id: "newer", date: "2026-05-09T00:00:00.000Z" });

    useActivityLogStore.setState({ items: [older, newer] });
    useActivityLogStore.getState().replace([older, newer]);

    expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("clear empties the activity feed", () => {
    useActivityLogStore.setState({ items: [item()] });
    useActivityLogStore.getState().clear();
    expect(useActivityLogStore.getState().items).toEqual([]);
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
