import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedMarket } from "@/types/portfolio";
import type { DashboardStats } from "@/types/market-management";

const {
  mockUseCreatorDashboardState,
  mockNavigate,
  mockBuildOracleAttestationEvent,
  mockSignEnumAttestation,
  mockGetOracleAnnouncementEventId,
  mockSubmitOracleAttestation,
} = vi.hoisted(() => ({
  mockUseCreatorDashboardState: vi.fn(),
  mockNavigate: vi.fn(),
  mockBuildOracleAttestationEvent: vi.fn(),
  mockSignEnumAttestation: vi.fn(),
  mockGetOracleAnnouncementEventId: vi.fn(),
  mockSubmitOracleAttestation: vi.fn(),
}));

vi.mock("@/hooks/useCreatorDashboardState", () => ({
  useCreatorDashboardState: () => mockUseCreatorDashboardState(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

// The DLC attestation signature is produced by kormir against the
// announcement's committed nonce; oracleAttestation only wraps the resulting
// hex in a NIP-01 envelope.
vi.mock("@/lib/kormir", () => ({
  signEnumAttestation: (...args: unknown[]) => mockSignEnumAttestation(...args),
  getOracleAnnouncementEventId: (...args: unknown[]) => mockGetOracleAnnouncementEventId(...args),
}));

vi.mock("@/lib/oracleAttestation", () => ({
  buildOracleAttestationEvent: (...args: unknown[]) => mockBuildOracleAttestationEvent(...args),
}));

vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return {
    ...actual,
    submitOracleAttestation: (...args: unknown[]) => mockSubmitOracleAttestation(...args),
  };
});

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

beforeEach(() => {
  mockNavigate.mockReset();
  mockUseCreatorDashboardState.mockReset();
  mockBuildOracleAttestationEvent.mockReset();
  mockBuildOracleAttestationEvent.mockReturnValue({
    id: "event-id",
    pubkey: "a".repeat(64),
    createdAt: 1,
    kind: 89,
    content: "attestation-base64",
    sig: "b".repeat(128),
  });
  mockSignEnumAttestation.mockReset();
  mockSignEnumAttestation.mockResolvedValue("attestation-hex");
  mockGetOracleAnnouncementEventId.mockReset();
  mockGetOracleAnnouncementEventId.mockResolvedValue("c".repeat(64));
  mockSubmitOracleAttestation.mockReset();
  mockSubmitOracleAttestation.mockResolvedValue({ result: "Closed" });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  useCreatorMarketsStore.setState({ markets: [] });
  useSettingsStore.setState({
    nostrSignerMode: "none",
    nsecSecret: null,
    relays: [],
  });
});

describe("CreatorDashboard", () => {
  it("renders the empty state when no markets are stored", () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [] as CreatedMarket[],
      isLoading: false,
      error: null,
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
        divisibility: 10_000,
      },
    ];
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: { ...emptyStats(), activeMarketsCount: 1, totalVolumeSubunits: 100_000 },
      markets,
      isLoading: false,
      error: null,
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
          divisibility: 10_000,
        },
      ] as CreatedMarket[],
      isLoading: false,
      error: null,
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
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText(/couldn't load live volume data/i)).toBeInTheDocument();
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
        divisibility: 10_000,
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
    useCreatorMarketsStore.setState({
      markets: [
        {
          conditionId: "a".repeat(64),
          title: "Will BTC hit $150k?",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 10_000,
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
      refresh: vi.fn(),
    });

    renderDashboard();

    await user.click(screen.getByRole("button", { name: /close market/i }));

    await screen.findByText(/published oracle attestation/i);

    // Signing goes through kormir so the attestation binds to the
    // announcement's committed nonce (relay urls, event id, outcome). The
    // mirrored announcement hex is passed so a fresh profile can re-import the
    // nonce index before signing (P22 B1b).
    expect(mockSignEnumAttestation).toHaveBeenCalledWith(
      ["ws://localhost:7777"],
      "will_btc_hit_150k_abcd",
      "Yes",
      "aabbccdd",
    );
    // The kormir attestation hex is wrapped in a NIP-01 envelope signed by
    // the creator's nsec.
    expect(mockBuildOracleAttestationEvent).toHaveBeenCalledWith(
      "nsec1test",
      "attestation-hex",
      "c".repeat(64),
    );
    expect(mockSubmitOracleAttestation).toHaveBeenCalledWith("a".repeat(64), {
      id: "event-id",
      pubkey: "a".repeat(64),
      createdAt: 1,
      kind: 89,
      content: "attestation-base64",
      sig: "b".repeat(128),
    });
    expect(useCreatorMarketsStore.getState().markets[0].oracle).toMatchObject({
      attestationHex: "attestation-hex",
      attestedOutcome: "Yes",
    });
    expect(screen.getByText(/published oracle attestation/i)).toBeInTheDocument();
  });
});
