import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityConditionId, useActivityCatalogue } from "../useActivityCatalogue";
import type { ActivityItem } from "@/types/portfolio";
import type { MarketCatalogueEntry } from "@/lib/markets";

const walletId = "a".repeat(64);
const empty = new Map<string, MarketCatalogueEntry>();
function activity(index: number): ActivityItem {
  return {
    id: String(index),
    walletId,
    marketId: `${index.toString(16).padStart(64, "0")}-Blue-team`,
    type: "Buy",
    amountSubunits: 1,
    baseAsset: "sat",
    date: "2026-10-08",
    status: "completed",
    txId: null,
    lightningInvoice: null,
  };
}
function reply(ids: string[]) {
  return {
    ok: true,
    json: async () => ({
      markets: ids.map((conditionId) => ({
        conditionId,
        title: `Title ${conditionId}`,
        outcomes: ["YES", "NO"],
      })),
    }),
  } as Response;
}
afterEach(() => vi.unstubAllGlobals());

describe("display-only activity catalogue", () => {
  it("renders every record immediately and bounds enrichment to 500 conditions in sequential batches of 50", async () => {
    const records = Array.from({ length: 502 }, (_, index) => activity(index));
    const frozen = JSON.stringify(records);
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      const ids = new URL(url, "http://local").searchParams.get("ids")!.split(",");
      expect(ids).toHaveLength(50);
      active--;
      return reply(ids);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ rows, available }) => useActivityCatalogue(rows, walletId, available),
      {
        initialProps: { rows: records, available: empty },
      },
    );
    expect(result.current).toHaveLength(502);
    expect(result.current[0].activityMarket).toBeUndefined();
    await waitFor(() => expect(result.current[499].activityMarket?.title).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(peak).toBe(1);
    expect(result.current[500].activityMarket).toBeUndefined();
    expect(result.current[501].activityMarket).toBeUndefined();
    expect(JSON.stringify(records)).toBe(frozen);
    rerender({ rows: [...records], available: new Map(empty) });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("reuses available entries and keeps failed batches as unmodified fallback records", async () => {
    const records = [activity(1), activity(2)];
    const available = new Map([
      [
        activityConditionId(records[0].marketId)!,
        { title: "Known title", outcomes: ["YES", "NO"] } as MarketCatalogueEntry,
      ],
    ]);
    const fetchMock = vi.fn().mockRejectedValue(new Error("unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useActivityCatalogue(records, walletId, available));
    expect(result.current[0].activityMarket?.title).toBe("Known title");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(new URL(fetchMock.mock.calls[0][0], "http://local").searchParams.get("ids")).toBe(
      activityConditionId(records[1].marketId),
    );
    expect(result.current[1]).toBe(records[1]);
  });

  it.each(["wallet", "selection"] as const)(
    "aborts a stale %s request and rejects its late result",
    async (change) => {
      let resolveFirst!: (response: Response) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(async () => reply(["2".padStart(64, "0")]));
      vi.stubGlobal("fetch", fetchMock);
      const first = [activity(1)];
      const { result, rerender } = renderHook(
        ({ wallet, rows }) => useActivityCatalogue(rows, wallet, empty),
        {
          initialProps: { wallet: walletId, rows: first },
        },
      );
      const next = [activity(2)];
      rerender({ wallet: change === "wallet" ? "b".repeat(64) : walletId, rows: next });
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      await waitFor(() => expect(result.current[0].activityMarket?.title).toContain("0002"));
      await act(async () => resolveFirst(reply(["1".padStart(64, "0")])));
      expect(result.current[0].id).toBe("2");
      expect(result.current[0].activityMarket?.title).toContain("0002");
      expect(first[0]).not.toHaveProperty("activityMarket");
    },
  );

  it("does not refetch available metadata when unrelated live prices change", () => {
    const records = [activity(1)];
    const id = activityConditionId(records[0].marketId)!;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const entry = {
      conditionId: id,
      title: "Historical title",
      outcomes: ["YES", "NO"],
    } as MarketCatalogueEntry;
    const { result, rerender } = renderHook(
      ({ available }) => useActivityCatalogue(records, walletId, available),
      {
        initialProps: { available: new Map([[id, entry]]) },
      },
    );
    rerender({ available: new Map([[id, { ...entry, latestConfirmedTrades: [] }]]) });
    expect(result.current[0].activityMarket?.title).toBe("Historical title");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(records[0]).not.toHaveProperty("activityMarket");
  });

  it("validates the whole condition prefix without splitting hyphenated outcomes", () => {
    expect(activityConditionId(`${"f".repeat(64)}-Blue-team`)).toBe("f".repeat(64));
    expect(activityConditionId("../market")).toBeNull();
    expect(activityConditionId(`${"f".repeat(64)}garbage`)).toBeNull();
  });
});
