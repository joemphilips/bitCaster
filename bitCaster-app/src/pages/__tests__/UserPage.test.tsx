import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type { NostrProfileIndexerStats } from "@bitcaster/client-sdk/primalProfileIndexer";
import { UserPage } from "../UserPage";
import { ToastContainer } from "@/components/ui/Toast";
import { useSettingsStore } from "@/stores/settings";
import { useToastStore } from "@/stores/toast";
import type { Market } from "@/types/market";

type RelayBehavior =
  | ((filters: readonly Filter[], onEvent: (event: Event) => void) => void)
  | Error;
const relayBehavior = vi.hoisted(() => new Map<string, RelayBehavior>());
const relayTransport = vi.hoisted(() => ({
  queryBrowserProfileRelayFilters: vi.fn(
    async (url: string, filters: readonly Filter[], onEvent: (event: Event) => void) => {
      const behavior = relayBehavior.get(url);
      if (behavior instanceof Error) throw behavior;
      behavior?.(filters, onEvent);
    },
  ),
}));
vi.mock("@/lib/browserProfileRelay", () => relayTransport);
const readPrimalProfileStats = vi.hoisted(() =>
  vi.fn<(pubkey: string) => Promise<NostrProfileIndexerStats | null>>(),
);
vi.mock("@bitcaster/client-sdk/primalProfileIndexer", () => ({ readPrimalProfileStats }));
const verifyNip05Address = vi.hoisted(() =>
  vi.fn<(address: string, pubkey: string) => Promise<boolean>>(),
);
// Keep the real host rule: the SDK URL checks import it from this module.
vi.mock("@bitcaster/client-sdk/nip05Verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bitcaster/client-sdk/nip05Verification")>()),
  verifyNip05Address,
}));
const getMarkets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/markets", () => ({
  getMarkets,
  getMarketThumbnail: (market: { imageUrl?: string }) => market.imageUrl || null,
}));

const key = new Uint8Array(32).fill(9);
const pubkey = getPublicKey(key);
const npub = nip19.npubEncode(pubkey);
const relays = ["wss://one.example", "wss://two.example"];
const sign = (kind: number, content: string, created_at: number, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content }, key);

const profileEvent = (metadata: Record<string, unknown>) => sign(0, JSON.stringify(metadata), 50);
const followList = sign(3, "", 40, [
  ["p", "a".repeat(64)],
  ["p", "b".repeat(64)],
]);
const notes = [
  sign(1, "older note", 100),
  sign(1, "newest note", 300),
  sign(1, "middle note", 200),
];
const stats: NostrProfileIndexerStats = {
  followersCount: 1234,
  followsCount: 2,
  noteCount: 3,
  firstActivityAt: Date.UTC(2022, 11, 14) / 1000,
};
const market = {
  id: "c".repeat(64),
  title: "Will the oracle publish?",
  state: "open",
  imageUrl: "",
} as unknown as Market;

function serve(url: string, events: Event[]) {
  relayBehavior.set(url, (filters, onEvent) => {
    for (const event of events)
      if (filters.some((filter) => filter.kinds?.includes(event.kind))) onEvent(event);
  });
}

const shortNpub = `${npub.slice(0, 12)}...${npub.slice(-8)}`;

function renderPage(route = `/user/${npub}`) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/user/:pubkey" element={<UserPage />} />
        <Route path="/markets/:id" element={<div>Market page</div>} />
      </Routes>
      <ToastContainer />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  relayBehavior.clear();
  useToastStore.setState({ toasts: [] });
  useSettingsStore.setState({
    relays: relays.map((url) => ({ url, connectionStatus: "disconnected" as const })),
    profileIndexerEnabled: true,
    language: "en",
  });
  readPrimalProfileStats.mockResolvedValue(stats);
  verifyNip05Address.mockResolvedValue(false);
  getMarkets.mockResolvedValue({
    markets: [market],
    nextCursor: null,
    lastSuccessfulRefreshAt: "",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("UserPage", () => {
  it("shows the relay profile, follow count, indexer statistics, notes and created markets", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const metadata = profileEvent({
      name: "alice",
      display_name: "Alice Oracle",
      about: "I publish sports results.",
      picture: "https://img.example/alice.png",
      banner: "https://img.example/banner.jpg",
      website: "https://alice.example",
    });
    serve(relays[0]!, [metadata, followList, ...notes]);
    serve(relays[1]!, [notes[0]!]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "Alice Oracle" })).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("I publish sports results.")).toBeInTheDocument();
    const banner = screen.getByTestId("profile-banner");
    expect(banner).toHaveAttribute("src", "https://img.example/banner.jpg");
    expect(banner).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByTestId("profile-picture")).toHaveAttribute("referrerpolicy", "no-referrer");
    const website = screen.getByRole("link", { name: "alice.example" });
    expect(website).toHaveAttribute("href", "https://alice.example/");
    expect(website).toHaveAttribute("rel", "noopener noreferrer");
    expect(await screen.findByText("2 following")).toBeInTheDocument();
    expect(await screen.findByText("1,234 followers via Primal")).toBeInTheDocument();
    expect(screen.getByText("First seen by Primal in December 2022")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("profile-note")
          .map((note) => note.querySelector("[data-user-content]")),
      ).not.toContain(null),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("profile-note").map((note) => note.textContent)).toEqual([
        expect.stringContaining("newest note"),
        expect.stringContaining("middle note"),
        expect.stringContaining("older note"),
      ]),
    );
    const markets = screen.getByRole("region", { name: "Markets created by this key" });
    expect(
      await within(markets).findByRole("link", { name: /Will the oracle publish\?/ }),
    ).toHaveAttribute("href", `/markets/${market.id}`);
    expect(getMarkets).toHaveBeenCalledWith(
      expect.objectContaining({ creatorPubkey: pubkey, state: "All" }),
    );
    expect(readPrimalProfileStats).toHaveBeenCalledWith(pubkey, expect.anything());

    expect(screen.getByText(shortNpub)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy Nostr ID" }));
    expect(writeText).toHaveBeenCalledWith(npub);
    expect(await screen.findByRole("status")).toHaveTextContent("Nostr ID copied.");
  });

  it("hides indexer values without an error when the indexer fails", async () => {
    readPrimalProfileStats.mockResolvedValue(null);
    serve(relays[0]!, [profileEvent({ name: "alice" }), followList, ...notes]);
    renderPage();

    expect(await screen.findByText("2 following")).toBeInTheDocument();
    await waitFor(() => expect(readPrimalProfileStats).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("indexer-loading")).not.toBeInTheDocument());
    expect(screen.queryByText(/followers?/)).not.toBeInTheDocument();
    expect(screen.queryByText(/First seen/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/indexer|Primal/i)).not.toBeInTheDocument();
    expect(await screen.findAllByTestId("profile-note")).toHaveLength(3);
  });

  it("does not contact the indexer when the setting is off", async () => {
    useSettingsStore.setState({ profileIndexerEnabled: false });
    serve(relays[0]!, [profileEvent({ name: "alice" }), followList]);
    renderPage(`/user/${pubkey}`);

    expect(await screen.findByText("2 following")).toBeInTheDocument();
    expect(readPrimalProfileStats).not.toHaveBeenCalled();
    expect(screen.queryByText(/followers?/)).not.toBeInTheDocument();
  });

  it("reads each selected relay with one request for the profile, the follow list and the notes", async () => {
    serve(relays[0]!, [profileEvent({ name: "alice" }), followList, ...notes]);
    serve(relays[1]!, []);
    renderPage();

    expect(await screen.findByText("2 following")).toBeInTheDocument();
    expect(await screen.findAllByTestId("profile-note")).toHaveLength(3);
    expect(
      relayTransport.queryBrowserProfileRelayFilters.mock.calls.map(([url, filters]) => [
        url,
        filters.map((filter) => filter.kinds),
      ]),
    ).toEqual(relays.map((url) => [url, [[0], [3], [1]]]));
  });

  it("drops a note dated after the Date range and still shows the page", async () => {
    serve(relays[0]!, [
      profileEvent({ name: "alice" }),
      sign(1, "far future note", 9_000_000_000_000),
      ...notes,
    ]);
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("profile-note")).toHaveLength(3));
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(screen.queryByText("far future note")).not.toBeInTheDocument();
  });

  it("keeps a profile render failure inside the page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getMarkets.mockResolvedValue({
        markets: [{ ...market, state: "paused" }],
        nextCursor: null,
        lastSuccessfulRefreshAt: "",
      });
      serve(relays[0]!, [profileEvent({ name: "alice" })]);
      render(
        <MemoryRouter initialEntries={[`/user/${npub}`]}>
          <p>App shell</p>
          <Routes>
            <Route path="/user/:pubkey" element={<UserPage />} />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("This profile could not be shown.")).toBeInTheDocument();
      expect(screen.getByText("App shell")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows the short Nostr ID when the profile names have no visible character", async () => {
    serve(relays[0]!, [profileEvent({ name: "\u3164", display_name: "\u200B\u2060" })]);
    const { container } = renderPage();

    await waitFor(() =>
      expect(container.querySelector("header")).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(shortNpub);
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
    // The title already shows the short Nostr ID. The copy control does not repeat it.
    expect(screen.getAllByText(shortNpub)).toHaveLength(1);
    // The copy control sits on the heading line, not alone on its own line.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.parentElement).toContainElement(
      screen.getByRole("button", { name: "Copy Nostr ID" }),
    );
    expect(heading.parentElement).toHaveClass("flex", "items-center");
  });

  it("keeps the copy control beside the short Nostr ID when the profile has a name", async () => {
    serve(relays[0]!, [profileEvent({ display_name: "Frank" })]);
    renderPage();

    const heading = await screen.findByRole("heading", { name: "Frank" });
    const copy = screen.getByRole("button", { name: "Copy Nostr ID" });
    expect(heading).not.toContainElement(copy);
    expect(copy.parentElement).toContainElement(screen.getByText(shortNpub));
  });

  it("shows no banner placeholder without a banner and lists created markets before notes", async () => {
    serve(relays[0]!, [profileEvent({ display_name: "Carol" }), ...notes]);
    const { container } = renderPage();

    expect(await screen.findByRole("heading", { name: "Carol" })).toBeInTheDocument();
    expect(screen.queryByTestId("profile-banner")).not.toBeInTheDocument();
    expect(container.querySelector("header .bg-gradient-to-br")).toBeNull();
    const markets = screen.getByRole("region", { name: "Markets created by this key" });
    const notesRegion = screen.getByRole("region", { name: "Notes" });
    expect(markets.compareDocumentPosition(notesRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("clamps a long description on a narrow screen until the user opens it", async () => {
    const user = userEvent.setup();
    const about = Array.from({ length: 12 }, (_, line) => `Line ${line + 1} of the policy.`).join(
      "\n",
    );
    serve(relays[0]!, [profileEvent({ display_name: "Dave", about })]);
    renderPage();

    const description = await screen.findByTestId("profile-about");
    // User text keeps normal line breaking in Japanese.
    expect(description).toHaveAttribute("data-user-content");
    expect(description).toHaveClass("line-clamp-6", "sm:line-clamp-none");
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveClass("sm:hidden");

    await user.click(more);
    expect(description).not.toHaveClass("line-clamp-6");
    expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("does not clamp a short description", async () => {
    serve(relays[0]!, [profileEvent({ display_name: "Erin", about: "Short policy." })]);
    renderPage();

    expect(await screen.findByTestId("profile-about")).not.toHaveClass("line-clamp-6");
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("shows what the answering relay returns when another selected relay fails", async () => {
    relayBehavior.set(relays[0]!, new Error("relay private text"));
    serve(relays[1]!, [profileEvent({ display_name: "Bob" }), followList, notes[1]!]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "Bob" })).toBeInTheDocument();
    expect(await screen.findByText("2 following")).toBeInTheDocument();
    expect(await screen.findAllByTestId("profile-note")).toHaveLength(1);
    expect(screen.queryByText(/relay private text/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
  });

  it("states that the selected relays did not answer when every relay fails", async () => {
    relays.forEach((url) => relayBehavior.set(url, new Error("down")));
    renderPage();

    expect(
      await screen.findByText("Could not read this profile from the selected relays."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/following$/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: shortNpub })).toBeInTheDocument();
  });

  it("renders hostile profile and note content as inert text", async () => {
    const hostile = profileEvent({
      name: "<script>alert(1)</script>",
      display_name: "Evil\u202Egnp.exe",
      about: `<img src=x onerror=alert(1)> ${"x".repeat(5_000)}`,
      picture: "javascript:alert(1)",
      banner: "data:image/svg+xml,<svg onload=alert(1)>",
      website: "javascript:alert(1)",
    });
    const forged = {
      ...sign(0, JSON.stringify({ display_name: "Forged" }), 999),
      sig: "00".repeat(64),
    };
    const foreign = finalizeEvent(
      { kind: 1, created_at: 999, tags: [], content: "foreign note" },
      new Uint8Array(32).fill(10),
    );
    serve(relays[0]!, [
      hostile,
      forged,
      sign(1, "<a href='javascript:alert(1)'>click</a>\u2066", 10),
      foreign,
    ]);
    const { container } = renderPage();

    expect(await screen.findByRole("heading", { name: "Evilgnp.exe" })).toBeInTheDocument();
    expect(screen.getByText("@<script>alert(1)</script>")).toBeInTheDocument();
    expect(await screen.findByTestId("profile-note")).toHaveTextContent(
      "<a href='javascript:alert(1)'>click</a>",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(container.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(container.textContent).not.toContain("Forged");
    expect(container.textContent).not.toContain("foreign note");
    expect(screen.getByTestId("profile-about").textContent!.length).toBeLessThanOrEqual(2_001);
  });

  it("shows the NIP-05 address only after its domain maps it to this key", async () => {
    serve(relays[0]!, [profileEvent({ name: "alice", nip05: "alice@alice.example" })]);
    verifyNip05Address.mockResolvedValue(true);
    const verified = renderPage();
    expect(await screen.findByText("alice@alice.example")).toBeInTheDocument();
    expect(verifyNip05Address).toHaveBeenCalledWith(
      "alice@alice.example",
      pubkey,
      expect.anything(),
    );
    verified.unmount();

    verifyNip05Address.mockResolvedValue(false);
    renderPage();
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    await waitFor(() => expect(verifyNip05Address).toHaveBeenCalledTimes(2));
    // Drain the failed check before asserting that the address stays hidden.
    await act(async () => {
      await verifyNip05Address.mock.results[1]!.value;
    });
    expect(screen.queryByText("alice@alice.example")).not.toBeInTheDocument();
  });

  it("rejects an invalid key in the route without any network read", async () => {
    renderPage("/user/not-a-key");

    expect(await screen.findByText("This Nostr ID is invalid.")).toBeInTheDocument();
    expect(readPrimalProfileStats).not.toHaveBeenCalled();
    expect(getMarkets).not.toHaveBeenCalled();
  });
});
