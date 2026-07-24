import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market } from "@/types/market";
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

import { LikedMarkets } from "../LikedMarkets";

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

function makeResult(markets: Market[]) {
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

describe("LikedMarkets (P5.1)", () => {
  it("renders the empty state when the user has no bookmarks", async () => {
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a")]));
    render(<LikedMarkets />);
    expect(await screen.findByTestId("liked-markets-empty")).toBeInTheDocument();
  });

  it("renders one card per bookmarked market with click-through", async () => {
    mockGetMarkets.mockResolvedValue(
      makeResult([makeMarket("a", "Alpha"), makeMarket("b", "Beta")]),
    );
    useBookmarkStore.setState({ markets: ["a", "b"] });
    const user = userEvent.setup();
    const onViewMarket = vi.fn();
    render(<LikedMarkets onViewMarket={onViewMarket} />);

    await waitFor(() => {
      expect(screen.getByTestId("liked-markets-scroller")).toBeInTheDocument();
    });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();

    await user.click(screen.getByTestId("liked-market-card-a"));
    expect(onViewMarket).toHaveBeenCalledWith("a");
  });

  it("shows an error message when the bulk fetch fails", async () => {
    mockGetMarkets.mockRejectedValue(new Error("boom"));
    useBookmarkStore.setState({ markets: ["a"] });
    render(<LikedMarkets />);
    expect(await screen.findByTestId("liked-markets-error")).toBeInTheDocument();
  });

  it("hides the native scrollbar and preserves list semantics inside a HorizontalPager", async () => {
    // Issue 3 — the scroller must use the shared `<HorizontalPager>` so
    // overflowing bookmarks paginate by chevron rather than exposing the
    // OS scrollbar.
    mockGetMarkets.mockResolvedValue(makeResult([makeMarket("a"), makeMarket("b")]));
    useBookmarkStore.setState({ markets: ["a", "b"] });
    render(<LikedMarkets />);

    const scroller = await screen.findByTestId("liked-markets-scroller");
    expect(scroller).toHaveAttribute("role", "list");
    expect(scroller).toHaveAccessibleName("Liked Markets");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(scroller.className).toContain("scrollbar-hide");
    expect(scroller.style.scrollbarWidth).toBe("none");
    expect(scroller).not.toHaveStyle({ overflowX: "scroll" });
  });
});
