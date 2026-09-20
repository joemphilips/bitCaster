import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketsPage } from "@/pages/MarketsPage";
import { getMarkets } from "@/lib/markets";
import type { Market } from "@/types/market";

vi.mock("@/lib/markets", () => ({
  getMarkets: vi.fn(),
  getMarketThumbnail: vi.fn(() => ""),
  filterMarkets: vi.fn((markets) => markets),
}));

const mockedGetMarkets = vi.mocked(getMarkets);

type MarketsResult = Awaited<ReturnType<typeof getMarkets>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeMarket(id: string, title: string, categoryTags = ["sports"]): Market {
  return {
    id,
    title,
    type: "yesno",
    state: "open",
    imageUrl: "",
    categoryTags,
    metaTags: [],
    currentOdds: { yes: 600, no: 400 },
    volume: 1_000,
    liquidity: 500,
    liquiditySubunits: 500,
    ammBotBudgetSubunits: 500,
    volumeLifetimeSubunits: 1_000,
    closingDate: "2026-12-31T23:59:59Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    creatorFeePercent: 2,
    baseMarket: "sats",
    baseAsset: "sat",
    divisibility: 1_000,
  };
}

function SearchNavigationProbe() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/markets?search=new")}>Change search</button>;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

describe("MarketsPage", () => {
  beforeEach(() => {
    mockedGetMarkets.mockReset();
  });

  it("shows a create-market empty state when the catalogue response is valid but empty", async () => {
    mockedGetMarkets.mockResolvedValue({
      markets: [],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date("2026-07-02T00:00:00Z").toISOString(),
    });

    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <MarketsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading markets...")).toBeInTheDocument();
    expect(screen.getByTestId("market-discovery-bar")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("No markets yet")).toBeInTheDocument();
    });

    expect(screen.getByText("Create one to get started.")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Failed to load markets. Please check that the matching engine is running.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create market/i })).toBeInTheDocument();
  });

  it("shows a catalogue-refreshing state while an empty catalogue has no successful refresh timestamp", async () => {
    mockedGetMarkets.mockResolvedValue({
      markets: [],
      nextCursor: null,
      lastSuccessfulRefreshAt: "0001-01-01T00:00:00+00:00",
    });

    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <MarketsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Catalogue refreshing...")).toBeInTheDocument();
    });

    expect(screen.getByTestId("market-discovery-bar")).toBeInTheDocument();
    expect(screen.queryByText("No markets yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create market/i })).not.toBeInTheDocument();
  });

  it("distinguishes no search matches from an empty catalogue", async () => {
    mockedGetMarkets.mockResolvedValue({
      markets: [],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date("2026-07-02T00:00:00Z").toISOString(),
    });

    render(
      <MemoryRouter initialEntries={["/markets?search=bitcoin"]}>
        <MarketsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("No markets match these filters.")).toBeInTheDocument();
    });

    expect(screen.queryByText("No markets yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create market/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("market-discovery-clear-all")).toBeInTheDocument();
  });

  it("keeps the engine-unavailable response in the error state", async () => {
    mockedGetMarkets.mockRejectedValue(new Error("HTTP 503"));

    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <MarketsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Failed to load markets. Please check that the matching engine is running.",
        ),
      ).toBeInTheDocument();
    });

    expect(screen.getByTestId("market-discovery-bar")).toBeInTheDocument();
    expect(screen.queryByText("No markets yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("keeps a selected tag removable after the response no longer contains that tag", async () => {
    const user = userEvent.setup();
    const emptyResponse: MarketsResult = {
      markets: [],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date("2026-07-02T00:00:00Z").toISOString(),
    };
    mockedGetMarkets
      .mockResolvedValueOnce({
        markets: [makeMarket("sports-1", "Sports market")],
        nextCursor: null,
        lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
      })
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValue(emptyResponse);

    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <MarketsPage />
      </MemoryRouter>,
    );

    const sportsTag = await screen.findByRole("button", { name: /sports1/ });
    await user.click(sportsTag);
    await waitFor(() =>
      expect(screen.getByText("No markets match these filters.")).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: /sports0/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("market-tag-clear")).toBeInTheDocument();

    await user.click(screen.getByTestId("market-tag-clear"));
    expect(screen.queryByTestId("market-tag-clear")).not.toBeInTheDocument();
  });

  it("clears tags, advanced filters, and the URL search together", async () => {
    const user = userEvent.setup();
    mockedGetMarkets.mockResolvedValue({
      markets: [makeMarket("sports-1", "Sports market")],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    });

    render(
      <MemoryRouter initialEntries={["/markets?search=bitcoin"]}>
        <MarketsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByText("Sports market");
    await user.click(screen.getByRole("button", { name: /sports1/ }));
    await user.click(screen.getByTitle("Show filters"));
    await user.click(screen.getByRole("button", { name: "Yes/No" }));
    await user.click(screen.getByTestId("market-filter-clear-all"));

    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toBe(""));
    const latestCall = mockedGetMarkets.mock.calls.at(-1)?.[0];
    expect(latestCall?.search).toBeUndefined();
    expect(latestCall?.tags).toBeUndefined();
    expect(latestCall?.state).toBe("Open");
    expect(screen.queryByTestId("market-discovery-clear-all")).not.toBeInTheDocument();
    expect(screen.queryByTestId("market-filter-clear-all")).not.toBeInTheDocument();
  });

  it("makes clear all reachable when only the URL search and a tag are active", async () => {
    const user = userEvent.setup();
    mockedGetMarkets.mockResolvedValue({
      markets: [makeMarket("sports-1", "Sports market")],
      nextCursor: null,
      lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    });

    render(
      <MemoryRouter initialEntries={["/markets?search=bitcoin"]}>
        <MarketsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByText("Sports market");
    await user.click(screen.getByRole("button", { name: /sports1/ }));
    await user.click(screen.getByTestId("market-discovery-clear-all"));

    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toBe(""));
    const latestCall = mockedGetMarkets.mock.calls.at(-1)?.[0];
    expect(latestCall?.search).toBeUndefined();
    expect(latestCall?.tags).toBeUndefined();
  });

  it("does not let an old query response overwrite the current query", async () => {
    const first = deferred<MarketsResult>();
    const second = deferred<MarketsResult>();
    mockedGetMarkets
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(
      <MemoryRouter initialEntries={["/markets?search=old"]}>
        <MarketsPage />
        <SearchNavigationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mockedGetMarkets).toHaveBeenCalledTimes(1));
    await userEvent.setup().click(screen.getByRole("button", { name: "Change search" }));
    await waitFor(() => expect(mockedGetMarkets).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        markets: [makeMarket("new", "New query market")],
        nextCursor: null,
        lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
      });
      await second.promise;
    });
    expect(screen.getByText("New query market")).toBeInTheDocument();

    await act(async () => {
      first.resolve({
        markets: [makeMarket("old", "Old query market")],
        nextCursor: null,
        lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
      });
      await first.promise;
    });
    expect(screen.queryByText("Old query market")).not.toBeInTheDocument();
    expect(screen.getByText("New query market")).toBeInTheDocument();
  });

  it("does not append a stale pagination response after a new query starts", async () => {
    let paginationCallback: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class TestIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          paginationCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof IntersectionObserver,
    );

    const initial = Promise.resolve<MarketsResult>({
      markets: [makeMarket("initial", "Initial market")],
      nextCursor: "page-2",
      lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    });
    const pagination = deferred<MarketsResult>();
    const currentQuery = deferred<MarketsResult>();
    mockedGetMarkets
      .mockImplementationOnce(() => initial)
      .mockImplementationOnce(() => pagination.promise)
      .mockImplementationOnce(() => currentQuery.promise);

    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <MarketsPage />
        <SearchNavigationProbe />
      </MemoryRouter>,
    );

    await screen.findByText("Initial market");
    await act(async () => {
      paginationCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() => expect(mockedGetMarkets).toHaveBeenCalledTimes(2));

    await userEvent.setup().click(screen.getByRole("button", { name: "Change search" }));
    await waitFor(() => expect(mockedGetMarkets).toHaveBeenCalledTimes(3));

    await act(async () => {
      currentQuery.resolve({
        markets: [makeMarket("current", "Current query market")],
        nextCursor: null,
        lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
      });
      await currentQuery.promise;
    });
    expect(screen.getByText("Current query market")).toBeInTheDocument();

    await act(async () => {
      pagination.resolve({
        markets: [makeMarket("stale-page", "Stale page market")],
        nextCursor: null,
        lastSuccessfulRefreshAt: new Date("2026-07-01T00:00:00Z").toISOString(),
      });
      await pagination.promise;
    });
    expect(screen.queryByText("Stale page market")).not.toBeInTheDocument();
    expect(screen.getByText("Current query market")).toBeInTheDocument();
  });
});
