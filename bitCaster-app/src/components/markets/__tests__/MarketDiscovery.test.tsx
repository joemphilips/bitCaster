import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { MarketDiscovery } from "../MarketDiscovery";
import type { Market, CategoryTag } from "@/types/market";
import { disconnect } from "@/lib/marketHub";

const signalrMock = vi.hoisted(() => {
  const connection = {
    state: "Disconnected",
    start: vi.fn(async () => {
      connection.state = "Connected";
    }),
    stop: vi.fn(async () => {
      connection.state = "Disconnected";
    }),
    invoke: vi.fn(async (_method: string, _marketId: string) => undefined),
    on: vi.fn(),
    onreconnected: vi.fn((handler: () => void) => {
      connection.reconnectedHandler = handler;
    }),
    reconnectedHandler: undefined as undefined | (() => void),
  };
  const registeredHandlers = new Map<string, (payload: unknown) => void>();
  connection.on.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
    registeredHandlers.set(eventName, handler);
  });
  return { connection, registeredHandlers };
});

vi.mock("@microsoft/signalr", () => ({
  HubConnectionBuilder: class {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      return signalrMock.connection;
    }
  },
  HubConnectionState: {
    Connected: "Connected",
    Disconnected: "Disconnected",
    Reconnecting: "Reconnecting",
  },
}));

const intersectionObservers: TestIntersectionObserver[] = [];

class TestIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  readonly observe = vi.fn((target: Element) => this.targets.add(target));
  readonly unobserve = vi.fn((target: Element) => this.targets.delete(target));
  readonly disconnect = vi.fn(() => this.targets.clear());
  readonly takeRecords = vi.fn(() => []);

  constructor(
    private readonly callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {
    intersectionObservers.push(this);
  }

  trigger(target: Element, isIntersecting: boolean): void {
    this.callback(
      [
        {
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(async () => {
  cleanup();
  await disconnect();
  signalrMock.connection.state = "Disconnected";
  signalrMock.connection.start.mockReset().mockImplementation(async () => {
    signalrMock.connection.state = "Connected";
  });
  signalrMock.connection.stop.mockReset().mockImplementation(async () => {
    signalrMock.connection.state = "Disconnected";
  });
  signalrMock.connection.invoke.mockReset().mockResolvedValue(undefined);
  signalrMock.connection.on.mockClear();
  signalrMock.connection.onreconnected.mockClear();
  signalrMock.connection.reconnectedHandler = undefined;
  signalrMock.registeredHandlers.clear();
  intersectionObservers.length = 0;
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(async () => {
  cleanup();
  await disconnect();
  vi.unstubAllGlobals();
});

const testCategoryTags: CategoryTag[] = [{ id: "sports", label: "Sports", marketCount: 10 }];

const testMarkets: Market[] = [
  {
    id: "test-001",
    title: "Will Bitcoin reach $100K?",
    type: "yesno",
    state: "open",
    imageUrl: "",
    categoryTags: ["crypto"],
    metaTags: ["trending"],
    currentOdds: { yes: 6_000, no: 4_000 },
    volume: 1000,
    liquidity: 500,
    liquiditySubunits: 500,
    ammBotBudgetSubunits: 500,
    volumeLifetimeSubunits: 1000,
    closingDate: "2026-12-31T23:59:59Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    creatorFeePercent: 2,
    baseMarket: "sats",
    baseAsset: "sat",
    divisibility: 1_000,
  },
  {
    id: "test-002",
    title: "NBA Championship Winner",
    type: "categorical",
    state: "open",
    imageUrl: "",
    categoryTags: ["sports"],
    metaTags: [],
    outcomes: [
      { id: "lakers", label: "Lakers", odds: 5_000 },
      { id: "celtics", label: "Celtics", odds: 5_000 },
    ],
    volume: 500,
    liquidity: 200,
    liquiditySubunits: 200,
    ammBotBudgetSubunits: 200,
    volumeLifetimeSubunits: 500,
    closingDate: "2026-06-30T23:59:59Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    creatorFeePercent: 1.5,
    baseMarket: "sats",
    baseAsset: "sat",
    divisibility: 1_000,
  },
];

function makeFundingMarket(id = "funding-condition"): Market {
  const source = testMarkets.find((market) => market.type === "categorical");
  if (!source || source.type !== "categorical") throw new Error("Categorical fixture is missing.");
  return {
    ...source,
    id,
    registeredPrimitiveOutcomeIds: ["North Star", "south"],
    outcomes: [
      { id: "North Star", label: "North Star", odds: null },
      { id: "south", label: "south", odds: null },
    ],
    ammBotBudgetSubunits: 1_000,
    fundingRevision: "0001",
  };
}

function triggerFundingTarget(conditionId: string, isIntersecting: boolean, targetIndex = 0): void {
  const target = screen.getAllByTestId(`market-funding-target-${conditionId}`)[targetIndex];
  if (!target) throw new Error(`Funding target ${conditionId} was not rendered.`);
  const observer = intersectionObservers.find((candidate) => candidate.targets.has(target));
  if (!observer) throw new Error(`Funding target ${conditionId} was not observed.`);
  act(() => observer.trigger(target, isIntersecting));
}

function FundingDiscovery({ markets }: { markets: Market[] }) {
  return (
    <MarketDiscovery
      categoryTags={testCategoryTags}
      markets={markets}
      selectedTags={[]}
      sort="trending"
      onSortChange={vi.fn()}
    />
  );
}

describe("MarketDiscovery", () => {
  it("applies the joined funding snapshot and rejects stale REST without a page reload", async () => {
    const market = makeFundingMarket();
    const routeMarketId = `${market.id}-North Star`;
    let fundingHandlerRegisteredWhenJoined = false;
    signalrMock.connection.invoke.mockImplementation(async (method, _marketId) => {
      if (method === "JoinMarket") {
        fundingHandlerRegisteredWhenJoined =
          signalrMock.registeredHandlers.has("MarketFundingUpdated");
        signalrMock.registeredHandlers.get("MarketFundingUpdated")?.({
          conditionId: market.id,
          ammBotBudgetSubunits: 2_500,
          fundingRevision: "0002",
        });
      }
    });

    const view = render(<FundingDiscovery markets={[market]} />);
    triggerFundingTarget(market.id, true);

    await waitFor(() =>
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", routeMarketId),
    );
    expect(fundingHandlerRegisteredWhenJoined).toBe(true);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("market-bot-budget")).getByRole("group", {
          name: "2.5 sats",
        }),
      ).toBeInTheDocument();
    });

    view.rerender(
      <FundingDiscovery
        markets={[{ ...market, ammBotBudgetSubunits: 0, fundingRevision: null }]}
      />,
    );
    expect(
      within(screen.getByTestId("market-bot-budget")).getByRole("group", {
        name: "2.5 sats",
      }),
    ).toBeInTheDocument();

    act(() => {
      signalrMock.registeredHandlers.get("MarketFundingUpdated")?.({
        conditionId: market.id,
        ammBotBudgetSubunits: 4_000,
        fundingRevision: "0003",
      });
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("market-bot-budget")).getByRole("group", {
          name: "4 sats",
        }),
      ).toBeInTheDocument();
    });

    view.unmount();
    await waitFor(() => {
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("LeaveMarket", routeMarketId);
    });
  });

  it("prunes a removed market observation and leaves its exact registered route", async () => {
    const market = makeFundingMarket("removed-funding-condition");
    const routeMarketId = `${market.id}-North Star`;
    signalrMock.connection.invoke.mockImplementation(async (method) => {
      if (method === "JoinMarket") {
        signalrMock.registeredHandlers.get("MarketFundingUpdated")?.({
          conditionId: market.id,
          ammBotBudgetSubunits: 2_500,
          fundingRevision: "0002",
        });
      }
    });

    const view = render(<FundingDiscovery markets={[market]} />);
    triggerFundingTarget(market.id, true);
    await waitFor(() =>
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", routeMarketId),
    );
    await waitFor(() => {
      expect(
        within(screen.getByTestId("market-bot-budget")).getByRole("group", {
          name: "2.5 sats",
        }),
      ).toBeInTheDocument();
    });

    view.rerender(<FundingDiscovery markets={[]} />);
    await waitFor(() => {
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("LeaveMarket", routeMarketId);
    });
    view.rerender(
      <FundingDiscovery
        markets={[{ ...market, ammBotBudgetSubunits: 0, fundingRevision: null }]}
      />,
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("market-bot-budget")).getByRole("group", {
          name: "0 sats",
        }),
      ).toBeInTheDocument();
    });
    expect(
      signalrMock.connection.invoke.mock.calls.filter(([method]) => method === "JoinMarket"),
    ).toHaveLength(1);
  });

  it("defers a canceled pending join's leave and preserves a concurrent visible subscriber", async () => {
    const market = makeFundingMarket("shared-funding-condition");
    const routeMarketId = `${market.id}-North Star`;
    let resolveStart: (() => void) | undefined;
    signalrMock.connection.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = () => {
            signalrMock.connection.state = "Connected";
            resolve();
          };
        }),
    );
    signalrMock.connection.invoke.mockImplementation(async (method) => {
      if (method === "JoinMarket") {
        signalrMock.registeredHandlers.get("MarketFundingUpdated")?.({
          conditionId: market.id,
          ammBotBudgetSubunits: 3_000,
          fundingRevision: "0002",
        });
      }
    });

    const first = render(<FundingDiscovery markets={[market]} />);
    const second = render(<FundingDiscovery markets={[market]} />);
    triggerFundingTarget(market.id, true, 0);
    triggerFundingTarget(market.id, true, 1);
    await waitFor(() => expect(signalrMock.connection.start).toHaveBeenCalledOnce());

    first.unmount();
    expect(signalrMock.connection.invoke).not.toHaveBeenCalledWith("LeaveMarket", routeMarketId);
    await act(async () => {
      resolveStart?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", routeMarketId),
    );
    expect(signalrMock.connection.invoke).not.toHaveBeenCalledWith("LeaveMarket", routeMarketId);
    expect(
      within(second.container.querySelector('[data-testid="market-bot-budget"]')!).getByRole(
        "group",
        { name: "3 sats" },
      ),
    ).toBeInTheDocument();

    second.unmount();
    await waitFor(() => {
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("LeaveMarket", routeMarketId);
    });
    expect(
      signalrMock.connection.invoke.mock.calls.filter(([method]) => method === "LeaveMarket"),
    ).toHaveLength(1);
  });

  it("releases the hub reference reserved by a failed asynchronous join", async () => {
    const market = makeFundingMarket("retry-funding-condition");
    const routeMarketId = `${market.id}-North Star`;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    signalrMock.connection.start.mockRejectedValueOnce(new Error("temporary connection failure"));

    const view = render(<FundingDiscovery markets={[market]} />);
    triggerFundingTarget(market.id, true);
    await waitFor(() => expect(warning).toHaveBeenCalled());

    await act(async () => {
      triggerFundingTarget(market.id, false);
      await Promise.resolve();
    });
    await act(async () => {
      triggerFundingTarget(market.id, true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(signalrMock.connection.start).toHaveBeenCalledTimes(2);
      expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", routeMarketId);
    });
    view.unmount();
    warning.mockRestore();
  });

  it("renders SortBar (Row 1), TagBar (Row 2), and market grid", () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />,
    );

    // Row 1 — sort buttons live in their own bar
    expect(screen.getByTestId("market-sort-trending")).toBeInTheDocument();
    expect(screen.getByTestId("market-sort-popular")).toBeInTheDocument();
    expect(screen.getByTestId("market-sort-new")).toBeInTheDocument();

    // Row 2 — category tags
    expect(screen.getByText("Sports")).toBeInTheDocument();

    // Cards rendered
    expect(screen.getByText("Will Bitcoin reach $100K?")).toBeInTheDocument();
  });

  it("shows empty state when markets array is empty", () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={[]}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />,
    );

    expect(screen.getByText("No markets found")).toBeInTheDocument();
  });

  it("keeps discovery controls mounted while a request is loading or fails", () => {
    const { rerender } = render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={[]}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        status="loading"
        statusMessage="Loading markets..."
      />,
    );

    expect(screen.getByTestId("market-discovery-bar")).toBeInTheDocument();
    expect(screen.getByText("Loading markets...")).toBeInTheDocument();

    rerender(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={[]}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        status="error"
        statusMessage="The catalogue is unavailable."
      />,
    );

    expect(screen.getByTestId("market-discovery-bar")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The catalogue is unavailable.");
  });

  it("shows the page-local scope notice when advanced filters are active without tags", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    render(
      <MarketDiscovery
        categoryTags={[]}
        markets={[]}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        onClearAll={onClearAll}
      />,
    );

    await user.click(screen.getByTitle("Show filters"));
    await user.click(screen.getByRole("button", { name: "Yes/No" }));

    expect(
      screen.getByText("Tag counts and advanced filters apply only to the currently loaded page."),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("market-discovery-clear-all"));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it("renders sort pills and category chips on a single discovery row (Issue 5.1)", () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />,
    );

    const row = screen.getByTestId("market-discovery-bar");
    const trendingPill = screen.getByTestId("market-sort-trending");
    const sportsChip = screen.getByText("Sports").closest("button")!;

    // Both must live inside the same flex row — proven by walking up
    // from each leaf and asserting they share the discovery-bar parent.
    expect(row).toContainElement(trendingPill);
    expect(row).toContainElement(sportsChip);
  });

  it("stacks discovery controls on mobile and keeps tags in their own scroll lane", () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("market-discovery-bar")).toHaveClass("flex-col");
    expect(screen.getByTestId("market-discovery-bar")).toHaveClass("md:flex-row");
    expect(screen.getByTestId("market-tag-bar")).toHaveClass("min-w-0");
    expect(screen.getByTestId("market-tag-scroller")).toHaveClass("overflow-x-auto");
  });

  it("forwards SortBar interactions to onSortChange (T4.2.a)", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={onSortChange}
      />,
    );

    await user.click(screen.getByTestId("market-sort-new"));
    expect(onSortChange).toHaveBeenCalledWith("new");
  });

  it('hides the "Loading more" sentinel when hasMore is false (last page)', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.queryByText("Loading more markets…")).not.toBeInTheDocument();
    // i18n key resolves to "Loading more markets…" in default locale
    // Guard against key mismatches by also checking aria-label absence.
    const pulsingDivs = document.querySelectorAll(".animate-pulse");
    expect(Array.from(pulsingDivs).some((el) => el.textContent?.includes("Loading"))).toBe(false);
  });

  it('shows the "Loading more" sentinel when hasMore is true', () => {
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        hasMore={true}
        onLoadMore={vi.fn()}
      />,
    );

    const pulsingDivs = document.querySelectorAll(".animate-pulse");
    // At least one animate-pulse element with loading text must be present.
    expect(Array.from(pulsingDivs).some((el) => el.textContent?.length ?? 0 > 0)).toBe(true);
  });

  it("forwards the include-closed filter toggle", async () => {
    const user = userEvent.setup();
    const onIncludeClosedChange = vi.fn();
    render(
      <MarketDiscovery
        categoryTags={testCategoryTags}
        markets={testMarkets}
        selectedTags={[]}
        sort="trending"
        onSortChange={vi.fn()}
        onIncludeClosedChange={onIncludeClosedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.click(screen.getByLabelText("Include closed"));

    expect(onIncludeClosedChange).toHaveBeenCalledWith(true);
  });
});
