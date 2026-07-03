import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { MarketHeader } from "../MarketHeader";
import type { YesNoMarketDetail } from "@/types/market-detail";

vi.mock("@/lib/nostr", () => ({
  fetchPublicNostrProfile: vi.fn().mockResolvedValue(null),
}));

const creatorPubkey =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const creatorNpub = nip19.npubEncode(creatorPubkey);
const shortCreatorNpub = `${creatorNpub.slice(0, 12)}...${creatorNpub.slice(-8)}`;

interface NavigatorMutable {
  clipboard?: { writeText: (text: string) => Promise<void> };
}

function makeMarket(
  overrides: Partial<YesNoMarketDetail> = {},
): YesNoMarketDetail {
  return {
    id: "abc123",
    title: "Will BTC hit 100K?",
    type: "yesno",
    imageUrl: undefined,
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "2030-12-31T23:59:59Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseUnit: "sats",
    mint: {
      collateral: "sat",
      keysetCount: 2,
    },
    creator: {
      id: creatorPubkey,
      name: `${creatorPubkey.slice(0, 8)}...${creatorPubkey.slice(-4)}`,
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: "Will BTC hit 100K?",
      source: "oracle",
      resolutionDate: "2030-12-31T23:59:59Z",
      status: "open",
    },
    priceHistory: { data: [], timeframe: "7d" },
    orderBook: { bids: [], asks: [], spread: 0 },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    ...overrides,
  };
}

describe("MarketHeader", () => {
  let originalClipboard: NavigatorMutable["clipboard"];

  beforeEach(() => {
    originalClipboard = (navigator as unknown as NavigatorMutable).clipboard;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClipboard === undefined) {
      delete (navigator as unknown as NavigatorMutable).clipboard;
    } else {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
        writable: true,
      });
    }
  });

  function renderHeader(market: YesNoMarketDetail) {
    return render(
      <MemoryRouter>
        <MarketHeader market={market} />
      </MemoryRouter>,
    );
  }

  it("renders mint metadata beside the creator card", async () => {
    renderHeader(makeMarket());

    expect(screen.getByText("Mint")).toBeInTheDocument();
    expect(screen.getByText("SAT CTF - 2 keysets")).toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("renders explicit missing mint metadata degradation", async () => {
    renderHeader(makeMarket({ mint: undefined }));

    expect(screen.getByText("Mint")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("renders engine-closed markets as closed even before mint attestation catches up", async () => {
    renderHeader(makeMarket({ state: "closed" }));

    expect(screen.getAllByText("Closed").length).toBeGreaterThan(0);
    expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("does not render an open engine market as closed only because its deadline is stale", async () => {
    renderHeader(
      makeMarket({
        state: "open",
        closingDate: "1970-01-12T13:46:40Z",
      }),
    );

    expect(screen.queryByText("Closed")).not.toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("renders the final answer prominently when closed with an outcome", async () => {
    renderHeader(
      makeMarket({
        state: "closed",
        resolution: {
          ...makeMarket().resolution,
          status: "resolved",
          finalOutcome: "Yes",
        },
      }),
    );

    expect(screen.getByText("Final Outcome")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("updates the remaining-time label while the market stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));

    renderHeader(
      makeMarket({
        closingDate: "2026-05-17T13:30:00Z",
        resolution: {
          ...makeMarket().resolution,
          resolutionDate: "2026-05-17T13:30:00Z",
        },
      }),
    );

    expect(screen.getByText("1h remaining")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
    });

    expect(screen.getByText("59m remaining")).toBeInTheDocument();
  });

  it("renders unavailable Nostr profile state and copies the full npub", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
      writable: true,
    });
    renderHeader(makeMarket());

    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Copy oracle pubkey" }),
    );

    expect(writeText).toHaveBeenCalledWith(creatorNpub);
  });

  it("does not render a copy button when the detail has no creator pubkey", () => {
    renderHeader(
      makeMarket({
        creator: {
          id: "unknown",
          name: "Unknown",
          totalMarketsCreated: 0,
          feePercent: 0,
        },
      }),
    );

    expect(screen.getByText("Oracle pubkey unavailable")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy oracle pubkey" }),
    ).not.toBeInTheDocument();
  });
});
