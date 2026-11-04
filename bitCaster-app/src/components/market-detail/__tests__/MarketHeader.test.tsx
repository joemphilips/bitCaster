import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import { MarketHeader } from "../MarketHeader";
import { ToastContainer } from "@/components/ui/Toast";
import { useToastStore } from "@/stores/toast";
import type { YesNoMarketDetail } from "@/types/market-detail";
import { fetchPublicNostrProfile } from "@/lib/nostr";

vi.mock("@/lib/nostr", () => ({
  fetchPublicNostrProfile: vi.fn().mockResolvedValue(null),
}));

const creatorPubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const creatorNpub = nip19.npubEncode(creatorPubkey);
const shortCreatorNpub = `${creatorNpub.slice(0, 12)}...${creatorNpub.slice(-8)}`;

interface NavigatorMutable {
  clipboard?: { writeText: (text: string) => Promise<void> };
}

function makeMarket(overrides: Partial<YesNoMarketDetail> = {}): YesNoMarketDetail {
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
    baseAsset: "sat",
    divisibility: 1_000,
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
  it.each([
    ["Volume", "Total traded volume so far"],
    ["Total funding", "Total funds contributed to this market's bot"],
  ])("explains %s across its icon and amount", async (label, description) => {
    const user = userEvent.setup();
    renderHeader(makeMarket());
    const control = screen.getByRole("button", { name: new RegExp(label) });
    await user.hover(control.querySelector("svg")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(description);
    await user.hover(within(control).getByRole("group"));
    expect(control).toHaveAccessibleDescription(description);
    expect(control.querySelector("[title]")).toBeNull();
  });

  let originalClipboard: NavigatorMutable["clipboard"];

  beforeEach(() => {
    originalClipboard = (navigator as unknown as NavigatorMutable).clipboard;
    useToastStore.setState({ toasts: [] });
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
        <ToastContainer />
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
    expect(screen.getByText(/Resolved on/)).toBeInTheDocument();
    expect(await screen.findByText(shortCreatorNpub)).toBeInTheDocument();
  });

  it("keeps the resolved lifecycle label without inventing a missing resolution date", async () => {
    const market = makeMarket({
      state: "closed",
      resolution: {
        ...makeMarket().resolution,
        status: "resolved",
        resolutionDate: null,
      },
    });
    renderHeader(market);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText("Resolved")).toHaveLength(2);
    expect(screen.queryByText(/Resolved on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/January 1, 1970/)).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Copy oracle Nostr ID" }));

    expect(writeText).toHaveBeenCalledWith(creatorNpub);
    expect(await screen.findByRole("status")).toHaveTextContent("Oracle Nostr ID copied.");
  });

  it("reports success only after the oracle clipboard write completes", async () => {
    const user = userEvent.setup();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => pending) },
    });
    renderHeader(makeMarket());
    await user.click(screen.getByRole("button", { name: "Copy oracle Nostr ID" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      complete();
      await pending;
    });
    expect(screen.getByRole("status")).toHaveTextContent("Oracle Nostr ID copied.");
  });

  it.each(["rejected", "unavailable"])(
    "reports an oracle copy failure when clipboard is %s",
    async (state) => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          state === "unavailable"
            ? undefined
            : { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      });
      renderHeader(makeMarket());
      await user.click(screen.getByRole("button", { name: "Copy oracle Nostr ID" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Could not copy the oracle Nostr ID.",
      );
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          type: "error",
          message: "Could not copy the oracle Nostr ID.",
        }),
      ]);
    },
  );

  it("announces the oracle copy result in Japanese", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    render(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: "ja" })}>
        <MemoryRouter>
          <MarketHeader market={makeMarket()} />
          <ToastContainer />
        </MemoryRouter>
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: "オラクルのNostr IDをコピー" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "オラクルのNostr IDをコピーしました。",
    );
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

    expect(screen.getByText("Oracle Nostr ID unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy oracle Nostr ID" })).not.toBeInTheDocument();
  });

  it("labels a missing oracle Nostr ID in Japanese", () => {
    render(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: "ja" })}>
        <MemoryRouter>
          <MarketHeader
            market={makeMarket({
              creator: { id: "unknown", name: "Unknown", totalMarketsCreated: 0, feePercent: 0 },
            })}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByText("オラクルのNostr IDを利用できません")).toBeInTheDocument();
  });

  it("links the oracle to its profile page and keeps the copy button outside the link", async () => {
    renderHeader(makeMarket());

    const link = await screen.findByRole("link", {
      name: new RegExp(shortCreatorNpub.replace(/\./g, "\\.")),
    });
    expect(link).toHaveAttribute("href", `/user/${creatorNpub}`);
    expect(link).toHaveAttribute("title", "Open the oracle's profile");
    expect(link).not.toContainElement(screen.getByRole("button", { name: "Copy oracle Nostr ID" }));
  });

  it("does not link a market without a valid oracle Nostr ID", () => {
    renderHeader(
      makeMarket({
        creator: { id: "unknown", name: "Unknown", totalMarketsCreated: 0, feePercent: 0 },
      }),
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("loads only an https oracle picture on a public host or a data image and sends no referrer", async () => {
    for (const avatar of [
      "javascript:alert(1)",
      "http://img.example/oracle.png",
      "https://127.0x1/oracle.png",
      "https://printer.local/oracle.png",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml,<svg onload=alert(1)>",
    ]) {
      vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
        pubkey: creatorPubkey,
        displayName: "Alice Oracle",
        avatar,
      });
      const unsafe = renderHeader(makeMarket());
      expect(
        await screen.findByText("Alice Oracle", { selector: "p:not(.font-mono)" }),
      ).toBeInTheDocument();
      expect(unsafe.container.querySelector("img"), avatar).toBeNull();
      unsafe.unmount();
    }

    vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
      pubkey: creatorPubkey,
      displayName: "Alice Oracle",
      avatar: "https://img.example/oracle.png",
    });
    const safe = renderHeader(makeMarket());
    await waitFor(() =>
      expect(safe.container.querySelector("img")).toHaveAttribute("referrerpolicy", "no-referrer"),
    );
    safe.unmount();

    const picture = "data:image/png;base64,AAAA";
    vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
      pubkey: creatorPubkey,
      displayName: "Alice Oracle",
      avatar: picture,
    });
    const embedded = renderHeader(makeMarket());
    await waitFor(() =>
      expect(embedded.container.querySelector("img")).toHaveAttribute("src", picture),
    );
  });

  it("shows the oracle name as bounded single-line text without invisible characters", async () => {
    vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
      pubkey: creatorPubkey,
      displayName: "Evil\u202Egnp.exe\u200B\nline",
      avatar: "",
    });
    const hostile = renderHeader(makeMarket());
    expect(
      await screen.findByText("Evilgnp.exe line", { selector: "p:not(.font-mono)" }),
    ).toBeInTheDocument();
    hostile.unmount();

    vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
      pubkey: creatorPubkey,
      displayName: "n".repeat(500),
      avatar: "",
    });
    const long = renderHeader(makeMarket());
    expect(
      await screen.findByText(`${"n".repeat(100)}…`, { selector: "p:not(.font-mono)" }),
    ).toBeInTheDocument();
    long.unmount();

    vi.mocked(fetchPublicNostrProfile).mockResolvedValueOnce({
      pubkey: creatorPubkey,
      displayName: "\u3164\u200B\u2060",
      avatar: "",
    });
    renderHeader(makeMarket());
    expect(
      await screen.findByText(shortCreatorNpub, { selector: "p.font-mono" }),
    ).toBeInTheDocument();
  });
});
