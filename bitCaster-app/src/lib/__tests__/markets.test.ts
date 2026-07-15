import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchMarketDetail,
  filterMarkets,
  getMarkets,
  getTagValue,
  getTagValues,
  extractCategoryTagIds,
  getMarketThumbnail,
  getDepositStatus,
  mapCatalogueEntryToMarket,
  requestEcashDeposit,
  submitOrder,
  windowPriceHistory,
  applyMarketPriceHistory,
  priceNumeratorToPercent,
} from "../markets";
import type { MarketCatalogueEntry } from "../markets";
import type { FilterState, Market } from "@/types/market";
import type { MarketDetail } from "@/types/market-detail";

vi.mock("@/lib/nostr", () => ({
  getNdk: () => ({
    signer: {
      sign: vi.fn(),
    },
  }),
}));

vi.mock("@nostr-dev-kit/ndk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@nostr-dev-kit/ndk")>();
  return {
    ...mod,
    NDKEvent: class MockNDKEvent {
      kind = 0;
      created_at = 0;
      content = "";
      tags: string[][] = [];
      async sign() {
        // no-op
      }
      rawEvent() {
        return {
          kind: this.kind,
          created_at: this.created_at,
          content: this.content,
          tags: this.tags,
          id: "mock",
          pubkey: "mock",
          sig: "mock",
        };
      }
    },
  };
});

const yesNoEntry: MarketCatalogueEntry = {
  conditionId: "abc123",
  outcomes: ["YES", "NO"],
  title: "Will BTC hit 100K?",
  thumbnailUrl: null,
  creatorPubkey: null,
  deadline: "2030-12-31T23:59:59Z",
  state: "open",
  createdAt: "2026-01-01T00:00:00Z",
  volume24hSubunits: 12_000,
  volume30dSubunits: 340_000,
  liquiditySubunits: 88_000,
    ammBotBudgetSubunits: 88_000,
  volumeLifetimeSubunits: 980_000,
  baseAsset: "sat",
  divisibility: 1_000,
  lastTradedPrice: 0.62,
  initialProbabilities: { Yes: 62, No: 38 },
  categoryTags: ["crypto"],
  lastSuccessfulRefreshAt: "2026-05-02T09:58:00Z",
};

const categoricalEntry: MarketCatalogueEntry = {
  conditionId: "def456",
  outcomes: ["Alice", "Bob", "Charlie"],
  title: "Who wins the election?",
  thumbnailUrl: null,
  creatorPubkey: null,
  deadline: "2030-12-31T23:59:59Z",
  state: "open",
  createdAt: "2026-02-01T00:00:00Z",
  volume24hSubunits: 0,
  volume30dSubunits: 0,
  liquiditySubunits: 12_000,
    ammBotBudgetSubunits: 12_000,
  volumeLifetimeSubunits: 45_000,
  baseAsset: "sat",
  divisibility: 1_000,
  lastTradedPrice: null,
  initialProbabilities: {},
  categoryTags: ["politics"],
  lastSuccessfulRefreshAt: "2026-05-02T09:58:00Z",
};

const creatorPubkey =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("mapCatalogueEntryToMarket", () => {
  it("maps a 2-outcome YES/NO entry to a yesno market", () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry);

    expect(market.id).toBe("abc123");
    expect(market.title).toBe("Will BTC hit 100K?");
    expect(market.type).toBe("yesno");
    expect(market.baseAsset).toBe("sat");
    expect(market.divisibility).toBe(1_000);
    expect(market.baseMarket).toBe("sats");
    if (market.type === "yesno") {
      expect(market.currentOdds).toEqual({ yes: 62, no: 38 });
    }
  });

  it("prefers last traded price for yes/no list odds, falling back to creator initial probabilities", () => {
    // With lastTradedPrice present, list odds use it (not initial probabilities)
    const marketWithTrades = mapCatalogueEntryToMarket({
      ...yesNoEntry,
      divisibility: 1_000,
      lastTradedPrice: 620,
      initialProbabilities: { Yes: 77, No: 23 },
    });

    expect(marketWithTrades.type).toBe("yesno");
    if (marketWithTrades.type === "yesno") {
      // lastTradedPrice=620 with D=1000 → 62%
      expect(marketWithTrades.currentOdds.yes).toBe(62);
    }

    // Without lastTradedPrice, falls back to initial probabilities
    const marketNoTrades = mapCatalogueEntryToMarket({
      ...yesNoEntry,
      divisibility: 1_000,
      lastTradedPrice: null,
      initialProbabilities: { Yes: 77, No: 23 },
    });

    expect(marketNoTrades.type).toBe("yesno");
    if (marketNoTrades.type === "yesno") {
      expect(marketNoTrades.currentOdds).toEqual({ yes: 77, no: 23 });
    }
  });

  it("preserves finalOutcome from the catalogue entry for closed market cards", () => {
    const market = mapCatalogueEntryToMarket({
      ...yesNoEntry,
      state: "closed",
      finalOutcome: "No",
    });

    expect(market.state).toBe("closed");
    expect(market.finalOutcome).toBe("No");
  });

  it("falls back to 50/50 when a yes/no market has no traded price", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const market = mapCatalogueEntryToMarket({
      ...yesNoEntry,
      lastTradedPrice: null,
      initialProbabilities: {},
    });

    expect(market.type).toBe("yesno");
    if (market.type === "yesno") {
      expect(market.currentOdds).toEqual({ yes: 50, no: 50 });
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("maps a >2 outcome entry to a categorical market", () => {
    const market = mapCatalogueEntryToMarket(categoricalEntry);

    expect(market.id).toBe("def456");
    expect(market.type).toBe("categorical");
    if (market.type === "categorical") {
      expect(market.outcomes).toHaveLength(3);
      expect(market.outcomes[0].label).toBe("Alice");
    }
  });

  it("uses lifetime catalogue metrics for displayed market stats", () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry);
    expect(market.volume).toBe(980_000);
    expect(market.volumeLifetimeSubunits).toBe(980_000);
    expect(market.liquidity).toBe(88_000);
    expect(market.liquiditySubunits).toBe(88_000);
  });

  it('falls back to "Untitled Market" when title is null', () => {
    const market = mapCatalogueEntryToMarket({ ...yesNoEntry, title: null });
    expect(market.title).toBe("Untitled Market");
  });

  it("preserves engine category tags", () => {
    const market = mapCatalogueEntryToMarket(yesNoEntry);
    expect(market.categoryTags).toEqual(["crypto"]);
  });

  it("uses createdAt as closingDate when deadline is null", () => {
    const market = mapCatalogueEntryToMarket({ ...yesNoEntry, deadline: null });
    expect(market.closingDate).toBe("2026-01-01T00:00:00Z");
  });
});

describe("tag helpers (mintd condition mapping — detail page only)", () => {
  it("getTagValue returns first value for key", () => {
    const tags = [
      ["description", "hello"],
      ["n", "BTC"],
    ];
    expect(getTagValue(tags, "description")).toBe("hello");
    expect(getTagValue(tags, "n")).toBe("BTC");
    expect(getTagValue(tags, "missing")).toBeUndefined();
  });

  it("getTagValues returns all values after key", () => {
    const tags = [["n", "BTC", "ETH"]];
    expect(getTagValues(tags, "n")).toEqual(["BTC", "ETH"]);
    expect(getTagValues(tags, "missing")).toEqual([]);
  });

  it("extractCategoryTagIds excludes known keys", () => {
    const tags = [
      ["description", "x"],
      ["n", "BTC"],
      ["category", "crypto"],
      ["sport", "NBA"],
    ];
    expect(extractCategoryTagIds(tags)).toEqual(["crypto", "NBA"]);
  });
});

describe("filterMarkets (client-side stop-gap)", () => {
  const markets: Market[] = [
    mapCatalogueEntryToMarket(yesNoEntry),
    mapCatalogueEntryToMarket(categoricalEntry),
  ];

  const baseFilter: FilterState = {
    searchQuery: "",
    selectedTags: [],
    marketTypes: [],
    volumeRange: {},
  };

  it("returns all markets with empty filter", () => {
    const result = filterMarkets(markets, baseFilter);
    expect(result).toHaveLength(2);
  });

  it("filters by search query", () => {
    const result = filterMarkets(markets, {
      ...baseFilter,
      searchQuery: "btc",
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Will BTC hit 100K?");
  });

  it("filters by market type", () => {
    const result = filterMarkets(markets, {
      ...baseFilter,
      marketTypes: ["categorical"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("categorical");
  });
});

describe("getMarketThumbnail (T4.3.c)", () => {
  it("returns the engine thumbnail URL when imageUrl resolved", () => {
    const url = getMarketThumbnail({
      id: "cond1",
      imageUrl: "/api/v1/cond1/thumbnail",
    });
    expect(url).toBe("/api/v1/cond1/thumbnail");
  });

  it("returns null when imageUrl is empty string (no broken url() in CSS)", () => {
    expect(getMarketThumbnail({ id: "cond1", imageUrl: "" })).toBeNull();
  });

  it("returns null when imageUrl is whitespace-only", () => {
    expect(getMarketThumbnail({ id: "cond1", imageUrl: "   " })).toBeNull();
  });

  it("returns null when imageUrl is omitted entirely", () => {
    expect(getMarketThumbnail({ id: "cond1" })).toBeNull();
  });
});

describe("getMarkets (engine catalogue proxy wiring)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  function makeResponse(): Response {
    const body = {
      markets: [yesNoEntry],
      nextCursor: null,
      lastSuccessfulRefreshAt: yesNoEntry.lastSuccessfulRefreshAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(() => Promise.resolve(makeResponse()));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function lastCallUrl(): string {
    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
      string,
    ];
    return url;
  }

  it("hits /api/v1/markets/query (NOT the deprecated /v1/conditions mintd path)", async () => {
    await getMarkets();
    const url = lastCallUrl();
    expect(url).toMatch(/^\/api\/v1\/markets\/query/);
    expect(url).not.toMatch(/\/v1\/conditions/);
  });

  it("forwards the sort dimension as the engine `sort=` enum (Trending|Popular|New)", async () => {
    await getMarkets({ sort: "new" });
    expect(lastCallUrl()).toContain("sort=New");
    await getMarkets({ sort: "popular" });
    expect(lastCallUrl()).toContain("sort=Popular");
    await getMarkets({ sort: "trending" });
    expect(lastCallUrl()).toContain("sort=Trending");
  });

  it("forwards repeatable tag filters as multiple ?tag= params (OR semantics)", async () => {
    await getMarkets({ tags: ["politics", "tech"] });
    const url = lastCallUrl();
    expect(url).toContain("tag=politics");
    expect(url).toContain("tag=tech");
  });

  it("forwards bulk-fetch IDs as a single comma-joined ?ids= param", async () => {
    await getMarkets({ ids: ["abc", "def", "123"] });
    expect(lastCallUrl()).toContain("ids=abc%2Cdef%2C123");
  });

  it("forwards the cursor and page_size for follow-up pages", async () => {
    await getMarkets({ cursor: "opaque-hmac", pageSize: 50 });
    const url = lastCallUrl();
    expect(url).toContain("cursor=opaque-hmac");
    expect(url).toContain("page_size=50");
  });

  it("forwards normalized search text as ?search=", async () => {
    await getMarkets({ search: "  bitcoin oracle  " });
    expect(lastCallUrl()).toContain("search=bitcoin+oracle");
  });

  it("shapes the response into Market objects with engine-derived fields", async () => {
    const result = await getMarkets();
    expect(result.markets).toHaveLength(1);
    expect(result.markets[0].id).toBe("abc123");
    expect(result.markets[0].volumeLifetimeSubunits).toBe(980_000);
    expect(result.markets[0].volume).toBe(980_000);
    expect(result.markets[0].liquiditySubunits).toBe(88_000);
    expect(result.nextCursor).toBeNull();
    expect(result.lastSuccessfulRefreshAt).toBe(
      yesNoEntry.lastSuccessfulRefreshAt,
    );
  });

  it("throws on non-2xx so the page can render an error/retry affordance", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(getMarkets()).rejects.toThrow(/Failed to query markets: 500/);
  });
});

describe("legacy mintd-list path (markets list) is fully removed", () => {
  it("no longer exports a fetchMarkets() function", async () => {
    const mod = await import("../markets");
    expect(Object.prototype.hasOwnProperty.call(mod, "fetchMarkets")).toBe(
      false,
    );
  });

  it("no longer exports a mapConditionToMarket() function", async () => {
    const mod = await import("../markets");
    expect(
      Object.prototype.hasOwnProperty.call(mod, "mapConditionToMarket"),
    ).toBe(false);
  });
});

describe("deposit API normalization", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes engine deposit status to the generated contract shape", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          depositId: "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a",
          conditionId: "deadbeef",
          state: "credited",
          method: "ecash",
          amountSubunits: 1000,
          creditedAmountSubunits: 999,
          requestedAt: "2026-05-17T06:05:06.200Z",
          updatedAt: "2026-05-17T06:05:10.660Z",
          failureReason: null,
        }),
        { status: 200 },
      ),
    );

    await expect(
      getDepositStatus("deadbeef", "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a"),
    ).resolves.toMatchObject({
      state: "credited",
      method: "ecash",
      creditedAmountSubunits: 999,
    });
  });

  it("normalizes ecash deposit creation state", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          depositId: "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a",
          state: "requested",
        }),
        { status: 200 },
      ),
    );

    await expect(
      requestEcashDeposit(
        "deadbeef",
        "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a",
        1000,
        "cashu-token",
      ),
    ).resolves.toMatchObject({ state: "requested" });
    const body = JSON.parse(
      ((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string),
    );
    expect(body).toMatchObject({
      depositId: "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a",
      amountSubunits: 1000,
      proofsToken: "cashu-token",
    });
  });

  it("does not copy a rejected deposit response body into the error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("server echoed cashuBsecret-token", { status: 409 }),
    );

    const failure = requestEcashDeposit(
      "deadbeef",
      "7db4b1b4-e9f6-40b4-84e3-d8b1fae15e3a",
      1000,
      "cashuBsecret-token",
    );

    const error = await failure.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ecash deposit request failed (409)");
    expect((error as Error).message).not.toContain("cashuBsecret-token");
  });
});

describe("submitOrder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ orderId: "order-1" }), { status: 200 }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("submits an authenticated order without a maker heartbeat preflight", async () => {
    await submitOrder("cond-123-YES", {
      outcomeId: "YES",
      tokenSide: "Outcome",
      side: "Buy",
      price: 50,
      amountSubunits: 100,
      timeInForce: "GTC",
      clientOrderId: "client-order-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toContain(
      "/api/v1/cond-123-YES/orders",
    );
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      clientOrderId: "client-order-1",
    });
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Nostr /,
    );
  });
});

/**
 * Phase 2 + Phase 7 of the P7 staging-fix plan, tightened after the P18 local
 * smoke: `fetchMarketDetail` renders from the engine catalogue first and uses
 * mintd only as fallback/enrichment. Stale mint rows must never override the
 * engine's public title, lifecycle (`state`), or thumbnail (`imageUrl`).
 */
describe("fetchMarketDetail (engine merge — ADR-009 Amendment 2026-05-04)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  const defaultKeysets: Record<string, string> = {
    Yes: "00".repeat(32),
    No: "11".repeat(32),
  };

  const categoricalCompositeKeysets: Record<string, string> = {
    A: "00".repeat(32),
    "B|C": "01".repeat(32),
    B: "02".repeat(32),
    "A|C": "03".repeat(32),
    C: "04".repeat(32),
    "A|B": "05".repeat(32),
  };

  const categoricalComplementFirstKeysets: Record<string, string> = {
    "B|C": "01".repeat(32),
    A: "00".repeat(32),
    B: "02".repeat(32),
    "A|C": "03".repeat(32),
    C: "04".repeat(32),
    "A|B": "05".repeat(32),
  };

  function mintdConditionsResponse(
    keysets: Record<string, string> = defaultKeysets,
  ): Response {
    return new Response(
      JSON.stringify({
        conditions: [
          {
            condition_id: "abc123",
            tags: [
              ["title", "Will BTC hit 100K?"],
              [
                "description",
                "Resolve YES only if BTC trades above $100,000 before close.",
              ],
              ["t", "crypto"],
            ],
            threshold: 1,
            announcements: ["ann1"],
            keysets,
            attestation: {
              status: "pending",
              winning_outcome: null,
              attested_at: null,
            },
          },
        ],
      }),
      { status: 200 },
    );
  }

  function engineQueryResponse(
    state: "open" | "closed",
    thumbnailUrl: string | null,
    creatorPubkey: string | null = null,
    outcomes: string[] = ["Yes", "No"],
  ): Response {
    return new Response(
      JSON.stringify({
        markets: [
          {
            conditionId: "abc123",
            outcomes,
            title: "Will BTC hit 100K?",
            description: "Creator supplied detailed resolution rules.",
            thumbnailUrl,
            creatorPubkey,
            deadline: null,
            closedAt: null,
            finalOutcome: null,
            state,
            createdAt: "2026-01-01T00:00:00Z",
            volume24hSubunits: 5000,
            volume30dSubunits: 50000,
            liquiditySubunits: 75000,
    ammBotBudgetSubunits: 75000,
            volumeLifetimeSubunits: 250000,
            lastTradedPrice: null,
            categoryTags: ["crypto"],
            lastSuccessfulRefreshAt: "2026-05-04T00:00:00Z",
          },
        ],
        nextCursor: null,
        lastSuccessfulRefreshAt: "2026-05-04T00:00:00Z",
      }),
      { status: 200 },
    );
  }

  function emptyMetadataResponse(): Response {
    return new Response("not found", { status: 404 });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("open", "/api/v1/abc123/thumbnail");
      if (url.includes("/metadata")) return emptyMetadataResponse();
      throw new Error(`unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("merges engine state into the detail (Phase 2 lifecycle authority)", async () => {
    const detail = await fetchMarketDetail("abc123");
    expect(detail.state).toBe("open");
  });

  it("merges engine thumbnailUrl into imageUrl (Phase 7 thumbnail data path)", async () => {
    const detail = await fetchMarketDetail("abc123");
    expect(detail.imageUrl).toBe("/api/v1/abc123/thumbnail");
  });

  it("does not block engine detail rendering on mintd display metadata", async () => {
    const detail = await fetchMarketDetail("abc123");
    expect(detail.mint).toEqual({ collateral: "sat", keysetCount: 0 });
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("uses engine registration outcomes for categorical display labels", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions"))
        return mintdConditionsResponse(categoricalComplementFirstKeysets);
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("open", null, null, ["A", "B", "C"]);
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");

    expect(detail.type).toBe("categorical");
    const labels = detail.outcomes?.map((outcome) => outcome.label) ?? [];
    expect(labels).toEqual(["A", "B", "C"]);
    expect(labels).not.toContain("B|C");
  });

  it("issues exactly one engine request and fails fast when the market is not yet indexed", async () => {
    // fetchMarketDetail is a single-shot: no retry loop, no delay. A newly
    // registered market that the engine has not indexed yet surfaces as "not
    // found" so the page renders without any timer blocking. The page's
    // post-paint needsEngineDetailRefresh polling loop handles the catch-up.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/markets/query")) {
        return new Response(
          JSON.stringify({
            markets: [],
            nextCursor: null,
            lastSuccessfulRefreshAt: "2026-05-04T00:00:00Z",
          }),
          { status: 200 },
        );
      }
      return emptyMetadataResponse();
    });

    await expect(fetchMarketDetail("abc123")).rejects.toThrow(
      "Market not found: abc123",
    );
    // Only one engine query — no retry loop.
    const engineCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/api/v1/markets/query"),
    );
    expect(engineCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("regression: fetchMarketDetail blocking path issues exactly one backend request", async () => {
    // Perf contract: first paint blocks on AT MOST ONE backend request.
    // Any retry / fan-out must happen in the post-paint enrichment path.
    const detail = await fetchMarketDetail("abc123");
    const engineCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/api/v1/markets/query"),
    );
    expect(engineCalls).toHaveLength(1);
    expect(detail.id).toBe("abc123");
  });

  it("fails closed when the engine entry lacks creator outcome metadata", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions"))
        return mintdConditionsResponse(categoricalCompositeKeysets);
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("open", null, null, []);
      return emptyMetadataResponse();
    });

    await expect(fetchMarketDetail("abc123")).rejects.toThrow(
      "Market abc123 is missing outcome metadata",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("does not let metadata overwrite catalogue-derived market metrics", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("open", "/api/v1/abc123/thumbnail");
      if (url.includes("/metadata")) {
        return new Response(
          JSON.stringify({
            marketId: "abc123",
            totalVolumeSubunits: 0,
            totalTrades: 0,
            totalLiquiditySubunits: 0,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const detail = await fetchMarketDetail("abc123");

    expect(detail.volumeLifetimeSubunits).toBe(250_000);
    expect(detail.volume).toBe(250_000);
    expect(detail.liquiditySubunits).toBe(75_000);
    expect(detail.liquidity).toBe(75_000);
  });

  it("renders engine detail when mintd has a stale row for the same condition id", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) {
        return new Response(
          JSON.stringify({
            conditions: [
              {
                condition_id: "abc123",
                tags: [["description", "Stale mint title"]],
                threshold: 1,
                announcements: ["ann1"],
                keysets: defaultKeysets,
                attestation: {
                  status: "attested",
                  winning_outcome: "No",
                  attested_at: 1,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("open", "/api/v1/abc123/thumbnail");
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");

    expect(detail.title).toBe("Will BTC hit 100K?");
    expect(detail.state).toBe("open");
    expect(detail.resolution.status).toBe("open");
    expect(detail.resolution.finalOutcome).toBeUndefined();
  });

  it("maps engine creatorPubkey into the detail creator card identity", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        return engineQueryResponse(
          "open",
          "/api/v1/abc123/thumbnail",
          creatorPubkey,
        );
      }
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");
    expect(detail.creator.id).toBe(creatorPubkey);
    expect(detail.creator.name).toBe(
      `${creatorPubkey.slice(0, 8)}...${creatorPubkey.slice(-4)}`,
    );
  });

  it("preserves oracle identity while explicitly degrading missing mint metadata", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse({});
      if (url.includes("/api/v1/markets/query")) {
        return engineQueryResponse(
          "open",
          "/api/v1/abc123/thumbnail",
          creatorPubkey,
        );
      }
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");
    expect(detail.creator.id).toBe(creatorPubkey);
    expect(detail.mint).toEqual({ collateral: "sat", keysetCount: 0 });
  });

  it('regression: engine state="closed" overrides mintd attestation="pending"', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query"))
        return engineQueryResponse("closed", null);
      return emptyMetadataResponse();
    });
    const detail = await fetchMarketDetail("abc123");
    expect(detail.state).toBe("closed");
    // Mintd attestation is pending → resolution status surfaces as 'open' (a
    // PENDING resolution, not the engine lifecycle); the engine win is the
    // load-bearing assertion above.
    expect(detail.resolution.status).toBe("open");
  });

  it("fails closed when the engine query fails instead of reconstructing from mintd keysets", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query"))
        return new Response("boom", { status: 500 });
      return emptyMetadataResponse();
    });
    await expect(fetchMarketDetail("abc123")).rejects.toThrow(
      "Market not found: abc123",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("does not reconstruct categorical display labels from mintd keysets", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions"))
        return mintdConditionsResponse(categoricalCompositeKeysets);
      if (url.includes("/api/v1/markets/query"))
        return new Response("boom", { status: 500 });
      return emptyMetadataResponse();
    });

    await expect(fetchMarketDetail("abc123")).rejects.toThrow(
      "Market not found: abc123",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("does not use mintd description tags as market detail fallback", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) {
        return new Response(
          JSON.stringify({
            conditions: [
              {
                condition_id: "abc123",
                tags: [
                  ["title", "Will BTC hit 100K?"],
                  [
                    "description",
                    "Resolve YES only if the oracle attests BTC traded above $100,000 before close.",
                  ],
                  ["t", "crypto"],
                ],
                threshold: 1,
                announcements: ["ann1"],
                keysets: defaultKeysets,
                attestation: {
                  status: "pending",
                  winning_outcome: null,
                  attested_at: null,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/markets/query"))
        return new Response("boom", { status: 500 });
      return emptyMetadataResponse();
    });

    await expect(fetchMarketDetail("abc123")).rejects.toThrow(
      "Market not found: abc123",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/v1/conditions");
  });

  it("queries the engine catalogue with state=All so closed markets surface", async () => {
    await fetchMarketDetail("abc123");
    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    const queryCall = calls.find((u) => u.includes("/api/v1/markets/query"));
    expect(queryCall).toBeDefined();
    expect(queryCall!).toContain("state=All");
    expect(queryCall!).toContain("ids=abc123");
  });

  it("normalises engine state casing — defensive against the NSwag PascalCase emit", async () => {
    // Producer bug: NSwag-generated DTOs ship `[JsonConverter(typeof(
    // JsonStringEnumConverter<T>))]` per-property which overrides the global
    // naming policy and emits "Open" / "Closed" instead of the spec's "open"
    // / "closed". Until the producer is fixed upstream, the frontend
    // normalises at the boundary so the detail page's exhaustive switch
    // does not fall through to assertNever on every staging load.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        // Mimic the production engine wire form (capitalised).
        const body = await engineQueryResponse("open", null).json();
        body.markets[0].state = "Open";
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return emptyMetadataResponse();
    });
    const detail = await fetchMarketDetail("abc123");
    // Normalised to lowercase so useMarketState's switch matches.
    expect(detail.state).toBe("open");
  });

  it("falls back when engine state is an unrecognised value (logs a soft fail)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        const body = await engineQueryResponse("open", null).json();
        body.markets[0].state = "Settling";
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return emptyMetadataResponse();
    });
    const detail = await fetchMarketDetail("abc123");
    // Unrecognised value → undefined → useMarketState renders Open (safe
    // pre-fetch default). Better than throwing on every page load.
    expect(detail.state).toBeUndefined();
  });

  it('promotes engine.deadline into closingDate so MarketHeader stops rendering "Closed" against the mintd-only "now" placeholder', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        const body = await engineQueryResponse("open", null).json();
        body.markets[0].deadline = "2030-12-31T23:59:59Z";
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return emptyMetadataResponse();
    });
    const detail = await fetchMarketDetail("abc123");
    expect(detail.closingDate).toBe("2030-12-31T23:59:59Z");
  });

  it("keeps closingDate null when engine.deadline is null so unknown deadlines never decay into Closed", async () => {
    // Default engineQueryResponse already has deadline: null
    const detail = await fetchMarketDetail("abc123");
    expect(detail.closingDate).toBeNull();
  });

  it("uses engine.closedAt as the closed-market resolution date", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        const body = await engineQueryResponse("closed", null).json();
        body.markets[0].deadline = "2030-12-31T23:59:59Z";
        body.markets[0].closedAt = "2031-01-01T00:05:00Z";
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");

    expect(detail.state).toBe("closed");
    expect(detail.resolution.resolutionDate).toBe("2031-01-01T00:05:00Z");
  });

  it("uses engine registration description as resolution criteria", async () => {
    const detail = await fetchMarketDetail("abc123");
    expect(detail.resolution.criteria).toBe(
      "Creator supplied detailed resolution rules.",
    );
  });

  it("surfaces engine finalOutcome for oracle-closed markets", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/conditions")) return mintdConditionsResponse();
      if (url.includes("/api/v1/markets/query")) {
        const body = await engineQueryResponse("closed", null).json();
        body.markets[0].closedAt = "2031-01-01T00:05:00Z";
        body.markets[0].finalOutcome = "Yes";
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return emptyMetadataResponse();
    });

    const detail = await fetchMarketDetail("abc123");

    expect(detail.resolution.status).toBe("resolved");
    expect(detail.resolution.finalOutcome).toBe("Yes");
  });
});

describe("windowPriceHistory (P22 Link D timeframe windowing)", () => {
  const makePoint = (timestamp: string, price: number) => ({
    timestamp,
    price,
  });

  it('caps the "all" timeframe to the newest retained points', () => {
    const history = {
      timeframe: "all" as const,
      data: Array.from({ length: 1002 }, (_, index) =>
        makePoint(
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          index,
        ),
      ),
    };
    const result = windowPriceHistory(history);
    expect(result.data).toHaveLength(1000);
    expect(result.data[0].price).toBe(2);
    expect(result.data.at(-1)?.price).toBe(1001);
  });

  it("trims points older than the window, anchored on the newest sample", () => {
    const history = {
      timeframe: "24h" as const,
      data: [
        makePoint("2026-05-10T10:00:00Z", 5),
        makePoint("2026-05-20T10:00:00Z", 10),
        makePoint("2026-05-24T20:00:00Z", 15),
        makePoint("2026-05-25T06:00:00Z", 18),
        makePoint("2026-05-25T10:00:00Z", 20),
      ],
    };
    const result = windowPriceHistory(history);
    expect(result.data.map((p) => p.price)).toEqual([10, 15, 18, 20]);
  });

  it("returns the series untouched when an empty timeframe is given", () => {
    const history = { timeframe: "7d" as const, data: [] };
    expect(windowPriceHistory(history).data).toHaveLength(0);
  });
});

describe("price history normalization", () => {
  it("normalizes raw price numerators to percentages", () => {
    expect(priceNumeratorToPercent(50, 100)).toBe(50);
    expect(priceNumeratorToPercent(500, 1_000)).toBe(50);
    expect(priceNumeratorToPercent(500, 100)).toBe(100);
  });

  it("applies market divisibility when mapping fetched history", () => {
    const market = {
      ...mapCatalogueEntryToMarket({ ...yesNoEntry, divisibility: 1_000 }),
      priceHistory: { timeframe: "7d" as const, data: [] },
      orderBook: { bids: [], asks: [], spread: 0 },
      recentTrades: [],
      comments: [],
      relatedMarkets: [],
      baseUnit: "sats",
      creator: {
        id: "creator",
        name: "creator",
        totalMarketsCreated: 0,
        feePercent: 0,
      },
      resolution: {
        criteria: "criteria",
        source: "oracle" as const,
        resolutionDate: "2026-01-01T00:00:00Z",
        status: "open" as const,
      },
    };

    const updated = applyMarketPriceHistory(market as unknown as MarketDetail, {
      conditionId: "abc123",
      timeframe: "7d",
      outcomes: [
        {
          outcomeId: "Yes",
          data: [
            {
              timestamp: "2026-05-25T10:00:00Z",
              price: 500,
              volumeSubunits: 10,
              source: "fill",
            },
          ],
        },
      ],
    });

    expect(updated.priceHistory.data[0].price).toBe(50);
  });
});
