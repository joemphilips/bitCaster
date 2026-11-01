import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketCatalogueEntry } from "@/lib/markets";
import { useLikedMarketStateStore } from "@/lib/likedMarketClose";
import { useBookmarkStore } from "@/stores/bookmarks";
import { useNotificationsStore } from "@/stores/notifications";
import { useLikedMarketCloseReconcile } from "../useLikedMarketCloseReconcile";
import { useLikedMarkets } from "../useLikedMarkets";

// Engine catalogue bounds from the public contract: at most 100 IDs per
// query, `page_size` in [1, 50] with a default of 20. A filtered query returns
// one page only; the matches after that page need a cursor.
const ENGINE_IDS_MAX = 100;
const ENGINE_PAGE_SIZE_DEFAULT = 20;
const ENGINE_PAGE_SIZE_MAX = 50;

const BOOKMARK_COUNT = 120;

function conditionId(index: number): string {
  return index.toString(16).padStart(64, "0");
}

const bookmarkIds = Array.from({ length: BOOKMARK_COUNT }, (_, index) => conditionId(index));

function catalogueEntry(id: string, state: "open" | "closed"): MarketCatalogueEntry {
  return {
    conditionId: id,
    outcomes: ["YES", "NO"],
    title: `Market ${id.slice(-4)}`,
    thumbnailUrl: null,
    creatorPubkey: null,
    deadline: "2030-12-31T23:59:59Z",
    state,
    createdAt: "2026-01-01T00:00:00Z",
    volume24hSubunits: 0,
    volume30dSubunits: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    fundingRevision: null,
    volumeLifetimeSubunits: 0,
    baseAsset: "sat",
    divisibility: 1_000,
    categoryTags: [],
    lastSuccessfulRefreshAt: "2026-11-01T00:00:00Z",
    latestConfirmedTrades: [],
  };
}

function stubEngineCatalogue(catalogue: ReadonlyMap<string, MarketCatalogueEntry>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/v1/markets/query");
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      const rawPageSize = url.searchParams.get("page_size");
      const pageSize = rawPageSize === null ? ENGINE_PAGE_SIZE_DEFAULT : Number(rawPageSize);
      if (
        ids.length > ENGINE_IDS_MAX ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > ENGINE_PAGE_SIZE_MAX
      ) {
        return new Response(JSON.stringify({ title: "Bad Request" }), { status: 400 });
      }
      const matches = ids.flatMap((id) => {
        const entry = catalogue.get(id);
        return entry ? [entry] : [];
      });
      return new Response(
        JSON.stringify({
          markets: matches.slice(0, pageSize),
          nextCursor: matches.length > pageSize ? "next-page" : null,
          lastSuccessfulRefreshAt: "2026-11-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  useBookmarkStore.setState({ markets: [...bookmarkIds] });
  useLikedMarketStateStore.setState({ states: {} });
  useNotificationsStore.setState({ items: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liked markets beyond one engine catalogue page", () => {
  it("loads every one of 120 bookmarks in bookmark order", async () => {
    stubEngineCatalogue(new Map(bookmarkIds.map((id) => [id, catalogueEntry(id, "open")])));

    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.markets.length).toBe(BOOKMARK_COUNT);
    expect(result.current.markets.map((market) => market.id)).toEqual(bookmarkIds);
  });

  it("lets the close reconcile see every one of 120 bookmarks", async () => {
    // The user saw every bookmark open earlier. Every tenth bookmark has
    // closed since, spread over the whole list.
    useLikedMarketStateStore.setState({
      states: Object.fromEntries(bookmarkIds.map((id) => [id, "open" as const])),
    });
    const closedIds = bookmarkIds.filter((_, index) => index % 10 === 9);
    const closed = new Set(closedIds);
    stubEngineCatalogue(
      new Map(
        bookmarkIds.map((id) => [id, catalogueEntry(id, closed.has(id) ? "closed" : "open")]),
      ),
    );

    renderHook(() => useLikedMarketCloseReconcile());
    // The reconcile adds its notices in one pass; the first notice marks
    // that the pass has run.
    await waitFor(() => expect(useNotificationsStore.getState().items.length).toBeGreaterThan(0));

    const notices = useNotificationsStore.getState().items;
    expect(notices.length).toBe(closedIds.length);
    expect(notices.every((notice) => notice.kind === "market_closed")).toBe(true);
    expect(notices.map((notice) => notice.conditionId).sort()).toEqual([...closedIds].sort());
    const seen = useLikedMarketStateStore.getState().states;
    expect(Object.keys(seen).length).toBe(BOOKMARK_COUNT);
    expect(bookmarkIds.every((id) => seen[id] === (closed.has(id) ? "closed" : "open"))).toBe(true);
  });
});
