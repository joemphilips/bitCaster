import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market } from "@/types/market";
import type { GetMarketsParams, GetMarketsResult } from "@/lib/markets";
import { useBookmarkStore } from "@/stores/bookmarks";

const { mockGetMarkets } = vi.hoisted(() => ({
  mockGetMarkets: vi.fn(),
}));

vi.mock("@/lib/markets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/markets")>("@/lib/markets");
  return {
    ...actual,
    getMarkets: (...args: unknown[]) => mockGetMarkets(...args),
  };
});

import { useLikedMarkets } from "../useLikedMarkets";

function makeMarket(id: string, title = `Market ${id}`): Market {
  const now = new Date().toISOString();
  return {
    id,
    title,
    type: "yesno",
    state: "open",
    imageUrl: "",
    categoryTags: [],
    metaTags: [],
    currentOdds: { yes: 50, no: 50 },
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: now,
    createdDate: now,
    activeSince: now,
    creatorFeePercent: 0,
    baseMarket: "sats",
  } as Market;
}

function makeResult(markets: Market[]): GetMarketsResult {
  return {
    markets,
    nextCursor: null,
    lastSuccessfulRefreshAt: "2026-05-02T09:58:00Z",
  };
}

beforeEach(() => {
  mockGetMarkets.mockReset();
  useBookmarkStore.setState({ markets: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLikedMarkets", () => {
  it("returns the intersection of bookmark IDs and the engine bulk-fetch result", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("b"), makeMarket("c")]));
    useBookmarkStore.setState({ markets: ["b", "c"] });

    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.markets.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("passes the bookmark IDs to the engine via ?ids= bulk-fetch (ADR-009)", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a")]));
    useBookmarkStore.setState({ markets: ["a"] });

    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetMarkets).toHaveBeenCalledTimes(1);
    const call = mockGetMarkets.mock.calls[0][0] as GetMarketsParams;
    expect(call.ids).toEqual(["a"]);
    // Liked markets include closed ones — the user wants to revisit them.
    expect(call.state).toBe("All");
  });

  it("drops bookmark IDs the engine does not return (likely retracted)", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a")]));
    useBookmarkStore.setState({ markets: ["a", "gone"] });

    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markets.map((m) => m.id)).toEqual(["a"]);
  });

  it("deduplicates bookmark IDs (T5.1.d)", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a")]));
    // Inject a duplicate via setState even though `toggle` would not — the
    // hook must defend against arbitrary store snapshots so a stale Nostr
    // sync that landed two of the same e-tag does not render twice.
    useBookmarkStore.setState({ markets: ["a", "a"] });

    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markets).toHaveLength(1);
  });

  it("returns the empty list and skips the bulk fetch when bookmarks is empty", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a")]));
    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markets).toEqual([]);
    expect(mockGetMarkets).not.toHaveBeenCalled();
  });

  it("surfaces fetch failures via error and clears markets", async () => {
    mockGetMarkets.mockRejectedValue(new Error("boom"));
    useBookmarkStore.setState({ markets: ["a"] });
    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Failed to load markets");
    expect(result.current.markets).toEqual([]);
  });

  it("reacts to bookmark toggles after the initial fetch", async () => {
    // Initial bookmarks empty → no engine fetch fires per the hook contract
    // (avoids a wasted /markets/query roundtrip on a fresh wallet). Toggling
    // `b` triggers the first engine call, which resolves to a single market.
    mockGetMarkets.mockResolvedValueOnce(makeResult([makeMarket("b")]));
    const { result } = renderHook(() => useLikedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.markets).toEqual([]);
    expect(mockGetMarkets).not.toHaveBeenCalled();

    act(() => {
      useBookmarkStore.getState().toggle("b");
    });
    await waitFor(() => {
      expect(result.current.markets.map((m) => m.id)).toEqual(["b"]);
    });
  });
});
