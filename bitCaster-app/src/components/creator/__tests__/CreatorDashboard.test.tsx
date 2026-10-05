import { installCreatorDocumentLocks, seedCreatorMarkets } from "@/test/creatorDocumentLocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedMarket } from "@/types/portfolio";
import type { DashboardStats } from "@/types/market-management";

const { mockUseCreatorDashboardState, mockNavigate, mockPublishOracleOutcome } = vi.hoisted(() => ({
  mockUseCreatorDashboardState: vi.fn(),
  mockNavigate: vi.fn(),
  mockPublishOracleOutcome: vi.fn(),
}));

vi.mock("@/hooks/useCreatorDashboardState", () => ({
  useCreatorDashboardState: () => mockUseCreatorDashboardState(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/oracleAttestation", () => ({
  publishBrowserOracleOutcome: (...args: unknown[]) => mockPublishOracleOutcome(...args),
}));

import { CreatorDashboard } from "../CreatorDashboard";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

function emptyStats(): DashboardStats {
  return {
    activeMarketsCount: 0,
    resolvedMarketsCount: 0,
    refundedMarketsCount: 0,
    totalVolumeSubunits: 0,
    totalFeesEarnedSats: 0,
    totalFeesClaimedSats: 0,
    totalFeesUnclaimedSats: 0,
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <CreatorDashboard />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  installCreatorDocumentLocks();
  mockNavigate.mockReset();
  mockUseCreatorDashboardState.mockReset();
  mockPublishOracleOutcome.mockReset();
  mockPublishOracleOutcome.mockResolvedValue({ failures: [], record: {} });
  await seedCreatorMarkets({ markets: [] });
  useSettingsStore.setState({
    nostrSignerMode: "none",
    nsecSecret: null,
    relays: [],
  });
});

describe("CreatorDashboard", () => {
  it.each([
    ["unavailable", "—", "Engine state and volume unavailable"],
    ["stale", "75 sats", "Last known engine state and volume"],
  ])(
    "labels %s volume honestly instead of showing a fresh zero",
    (engineDataStatus, value, label) => {
      mockUseCreatorDashboardState.mockReturnValue({
        pubkey: "a".repeat(64),
        stats: { ...emptyStats(), totalVolumeSubunits: 75_000 },
        markets: [
          {
            id: "c".repeat(64),
            title: "Known closed market",
            imageUrl: "",
            status: "resolved",
            createdDate: "2026-04-10T00:00:00.000Z",
            volume: 75_000,
            creatorFeesEarned: 0,
            creatorFeePercent: 0,
            baseAsset: "sat",
            divisibility: 1_000,
            engineDataStatus: "stale",
          },
          ...(engineDataStatus === "unavailable"
            ? [
                {
                  id: "d".repeat(64),
                  title: "Never-enriched market",
                  imageUrl: "",
                  status: "unknown",
                  createdDate: "2026-04-10T00:00:00.000Z",
                  volume: 0,
                  creatorFeesEarned: 0,
                  creatorFeePercent: 0,
                  baseAsset: "sat",
                  divisibility: 1_000,
                  engineDataStatus: "unavailable",
                },
              ]
            : []),
        ] as CreatedMarket[],
        isLoading: false,
        error: engineDataStatus === "unavailable" ? "offline" : null,
        refresh: vi.fn(),
        engineDataStatus,
      });
      renderDashboard();
      const volumeCard = screen.getByText("Total Volume").parentElement!.parentElement!;
      expect(within(volumeCard).getByText(value)).toBeInTheDocument();
      expect(within(volumeCard).getByText(label)).toBeInTheDocument();
      if (engineDataStatus === "unavailable")
        expect(within(volumeCard).queryByText("75 sats")).not.toBeInTheDocument();
    },
  );

  it("renders the empty state when no markets are stored", () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByRole("heading", { name: /create your first market/i })).toBeInTheDocument();
    // Both the header CTA and the empty-state CTA are rendered.
    expect(screen.getAllByRole("button", { name: /create market/i }).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("prompts to configure a wallet when no pubkey is available", () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: null,
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText(/set up a wallet/i)).toBeInTheDocument();
  });

  it("renders created markets and aggregate stats", () => {
    const markets: CreatedMarket[] = [
      {
        id: "a".repeat(64),
        title: "Will BTC hit $150k?",
        imageUrl: "",
        status: "active",
        createdDate: "2026-04-10T00:00:00.000Z",
        volume: 100_000,
        creatorFeesEarned: 0,
        creatorFeePercent: 0.02,
        baseAsset: "sat",
        divisibility: 1_000,
      },
    ];
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1, totalVolumeSubunits: 100_000 },
      markets,
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText("Will BTC hit $150k?")).toBeInTheDocument();
    expect(screen.getByText(/my markets/i)).toBeInTheDocument();
    // Active markets stat card shows "1"
    expect(screen.getByText("Active Markets")).toBeInTheDocument();
  });

  it("navigates to /creator/new when the create CTA is clicked", async () => {
    const user = userEvent.setup();
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    // Click the first "Create Market" button (header CTA).
    const buttons = screen.getAllByRole("button", { name: /create market/i });
    await user.click(buttons[0]);
    expect(mockNavigate).toHaveBeenCalledWith("/creator/new");
  });

  it("navigates to the market detail page when a My Markets row is clicked", async () => {
    const user = userEvent.setup();
    const marketId = "b".repeat(64);
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1 },
      markets: [
        {
          id: marketId,
          title: "Clickable creator market",
          imageUrl: "",
          status: "active",
          createdDate: "2026-04-10T00:00:00.000Z",
          volume: 0,
          creatorFeesEarned: 0,
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 1_000,
        },
      ] as CreatedMarket[],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    await user.click(screen.getByText("Clickable creator market"));

    expect(mockNavigate).toHaveBeenCalledWith(`/markets/${marketId}`);
  });

  it("switches to the analytics tab and shows the coming-soon placeholder", async () => {
    const user = userEvent.setup();
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    await user.click(screen.getByRole("button", { name: /analytics/i }));
    expect(screen.getByRole("heading", { name: /analytics coming soon/i })).toBeInTheDocument();
  });

  it("surfaces the backend error banner when fetch fails", () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: "engine unreachable",
      engineDataStatus: "unavailable",
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getAllByText("Engine state and volume unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/engine unreachable/i)).toBeInTheDocument();
  });

  it("publishes a creator-owned oracle attestation from a created market row", async () => {
    const user = userEvent.setup();
    const markets: CreatedMarket[] = [
      {
        id: "a".repeat(64),
        title: "Will BTC hit $150k?",
        imageUrl: "",
        status: "active",
        createdDate: "2026-04-10T00:00:00.000Z",
        volume: 0,
        creatorFeesEarned: 0,
        creatorFeePercent: 0,
        baseAsset: "sat",
        divisibility: 1_000,
        oracle: {
          type: "self",
          eventId: "will_btc_hit_150k_abcd",
          announcementEventId: "c".repeat(64),
          outcomes: ["Yes", "No"],
          announcementHex: "aabbccdd",
        },
      },
    ];
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "nsec1test",
      relays: [{ url: "ws://localhost:7777", connectionStatus: "connected" }],
    });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: "a".repeat(64),
          title: "Will BTC hit $150k?",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 1_000,
          oracle: {
            type: "self",
            eventId: "will_btc_hit_150k_abcd",
            announcementEventId: "c".repeat(64),
            outcomes: ["Yes", "No"],
          },
        },
      ],
    });
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1 },
      markets,
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });

    renderDashboard();

    await user.click(screen.getByRole("button", { name: /close market/i }));

    const dialog = screen.getByRole("dialog", { name: "Resolve this market" });
    expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByRole("textbox", { name: "Public explanation (optional)" }),
      "Official final result.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm and deliver saved resolution" }),
    );
    await screen.findByText("Resolution Yes is confirmed by the engine and relay.");
    expect(mockPublishOracleOutcome).toHaveBeenCalledWith(
      "a".repeat(64),
      "Yes",
      "Official final result.",
      ["ws://localhost:7777"],
    );
    expect(useCreatorMarketsStore.getState().markets[0].oracle?.explanationDraft).toBe(
      "Official final result.",
    );
  });
});
