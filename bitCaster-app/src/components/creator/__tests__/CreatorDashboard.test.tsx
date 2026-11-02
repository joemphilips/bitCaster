import { installCreatorDocumentLocks, seedCreatorMarkets } from "@/test/creatorDocumentLocks";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedMarket } from "@/types/portfolio";
import type { DashboardStats } from "@/types/market-management";

const { mockUseCreatorDashboardState, mockNavigate, mockPublishOracleOutcome, mockLocalStatuses } =
  vi.hoisted(() => ({
    mockUseCreatorDashboardState: vi.fn(),
    mockNavigate: vi.fn(),
    mockLocalStatuses: vi.fn(),
    mockPublishOracleOutcome: vi.fn(),
  }));

vi.mock("@/lib/browserOracleBackupAccess", () => ({
  localBrowserOracleBackupStatuses: (...args: unknown[]) => mockLocalStatuses(...args),
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

import { creatorOracleMetadata, creatorOraclePublication } from "@/test/creatorOracleFixture";
import { CreatorDashboard } from "../CreatorDashboard";
import i18n from "@/i18n";
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
  mockLocalStatuses.mockReset();
  mockLocalStatuses.mockResolvedValue({ rows: [], nextOffset: null });
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
    ["stale", "75 sats", "Traded"],
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
        isLoading: engineDataStatus === "stale",
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
      // A refresh of known engine data has one list-level indicator, not one label per row.
      expect(screen.queryByText(/Last known/)).not.toBeInTheDocument();
      expect(screen.queryAllByText("Updating…")).toHaveLength(engineDataStatus === "stale" ? 1 : 0);
    },
  );

  it("shows no updating indicator when a refresh of known data failed", () => {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: { ...emptyStats(), totalVolumeSubunits: 75_000 },
      markets: [],
      isLoading: false,
      error: "offline",
      refresh: vi.fn(),
      engineDataStatus: "stale",
    });
    renderDashboard();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
    expect(screen.getByText("Engine state and volume unavailable")).toBeInTheDocument();
  });

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
      stats: {
        ...emptyStats(),
        activeMarketsCount: 1,
        totalVolumeSubunits: 100_000,
      },
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

  it.each(["Yes", "No", "Gamma"])(
    "publishes exactly %s selected inside the creator dialog",
    async (selected) => {
      const outcomes = selected === "Gamma" ? ["Alpha", "Beta", "Gamma"] : ["Yes", "No"];
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
            outcomes,
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
              outcomes,
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

      const dialog = screen.getByRole("dialog", { name: "Close this market" });
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
      expect(within(dialog).getByText("Will BTC hit $150k?", { exact: true })).toBeVisible();
      expect(within(dialog).getByTestId("creator-oracle-confirm")).toBeDisabled();
      await user.selectOptions(within(dialog).getByRole("combobox"), selected);
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
      await user.type(
        within(dialog).getByRole("textbox", {
          name: "Public explanation (optional)",
        }),
        "Official final result.",
      );
      expect(
        within(dialog).getByText("Publishing the oracle result closes this market.", {
          exact: true,
        }),
      ).toBeVisible();
      await user.click(
        within(dialog).getByRole("button", {
          name: "Close market with this outcome",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByText(/confirmed by the engine|relay/i)).toBeNull();
      expect(mockPublishOracleOutcome).toHaveBeenCalledWith(
        "a".repeat(64),
        selected,
        "Official final result.",
        ["ws://localhost:7777"],
        useCreatorMarketsStore,
        undefined,
        { engineDelivery: "synchronize", requireCurrent: expect.any(Function) },
      );
      expect(useCreatorMarketsStore.getState().markets[0].oracle?.explanationDraft).toBe(
        "Official final result.",
      );
    },
  );

  it("shows the explanation byte limit only in an error next to the field", async () => {
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
    const dialog = screen.getByRole("dialog", { name: "Close this market" });
    const field = within(dialog).getByRole("textbox", { name: "Public explanation (optional)" });
    const confirm = within(dialog).getByTestId("creator-oracle-confirm");
    await user.selectOptions(within(dialog).getByRole("combobox"), "Yes");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(confirm).toBeEnabled();

    // 1,366 three-byte characters are 4,098 UTF-8 bytes.
    fireEvent.change(field, { target: { value: "あ".repeat(1_366) } });

    const message = "The explanation is too long. Shorten it.";
    const error = within(dialog).getByRole("alert");
    expect(error).toHaveTextContent(message);
    expect(error).not.toHaveTextContent(/UTF-8|bytes/);
    // The same field error style as the other form limits.
    expect(error).toHaveClass("text-red-500", "dark:text-red-400");
    expect(field).toHaveClass("border-red-400");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(message);
    expect(confirm).toBeDisabled();

    fireEvent.change(field, { target: { value: "a".repeat(4_096) } });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(confirm).toBeEnabled();
    expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
  });

  it("names the outcome field without the title and marks both actions disabled while closing", async () => {
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
    let finishPublication!: () => void;
    mockPublishOracleOutcome.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPublication = () => resolve({ failures: [], record: {} });
      }),
    );
    renderDashboard();
    await user.click(screen.getByRole("button", { name: /close market/i }));
    const dialog = screen.getByRole("dialog", { name: "Close this market" });

    expect(within(dialog).getByRole("combobox", { name: "Winning outcome" })).toBeVisible();
    expect(within(dialog).getAllByText(/Will BTC hit \$150k\?/)).toHaveLength(1);

    await user.selectOptions(within(dialog).getByRole("combobox"), "Yes");
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const closing = within(dialog).getByRole("button", { name: "Closing..." });
    for (const action of [cancel, closing]) {
      expect(action).toBeDisabled();
      expect(action).toHaveClass("disabled:cursor-not-allowed", "disabled:opacity-30");
    }
    await act(async () => finishPublication());
  });
});

it.each(["chosenOutcome", "attestedOutcome"] as const)(
  "delivers an existing market's saved %s automatically without a retry dialog",
  async (savedField) => {
    const market: CreatedMarket = {
      id: "a".repeat(64),
      title: "Saved creator result",
      imageUrl: "",
      status: "resolved",
      createdDate: "2026-04-10T00:00:00.000Z",
      volume: 0,
      creatorFeesEarned: 0,
      creatorFeePercent: 0,
      baseAsset: "sat",
      divisibility: 1000,
      oracle: {
        type: "self",
        eventId: "saved-event",
        outcomes: ["Yes", "No"],
        [savedField]: "No",
        explanationDraft: "Saved explanation.",
      },
    };
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "a".repeat(64),
      stats: emptyStats(),
      markets: [market],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByText("Sending result…")).toBeVisible();
    expect(screen.queryByRole("button", { name: /close market|retry|republish/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
  },
);

describe("oracle owner confirmation", () => {
  const ownerId = creatorOracleMetadata.binding.conditionId;
  function importedRow(chosenOutcome: string | null = null) {
    return {
      conditionId: ownerId,
      available: true,
      readiness: "ready",
      kind: "imported",
      title: "Imported oracle event",
      outcomes: ["YES", "NO"],
      chosenOutcome,
      signed: chosenOutcome !== null,
      publicationState: chosenOutcome === null ? null : "publishing",
      status: {
        importComplete: true,
        preparationPending: false,
        noRelays: false,
        destinations: creatorOracleMetadata.destinations,
        initial: { prepared: true, acknowledgedRelays: 1, totalRelays: 1 },
        terminal: {
          prepared: false,
          replacementAcknowledgedRelays: 0,
          deletionRequired: false,
          deletionAcknowledgedRelays: 0,
          localCommitPending: false,
        },
        binding: { oraclePubkey: "f".repeat(64) },
        publication: { relayPublished: false, engineSynchronized: false },
      },
    };
  }
  function marketRow(
    row: ReturnType<typeof importedRow>,
    kind: "created" | "imported" = "imported",
  ): CreatedMarket {
    const common = {
      id: row.conditionId,
      title: row.title,
      imageUrl: "",
      status: "unknown" as const,
      engineDataStatus: "unavailable" as const,
      baseAsset: "sat" as const,
      divisibility: 1_000 as const,
    };
    return kind === "imported"
      ? {
          ...common,
          oracleOwnerKind: "imported",
          createdDate: null,
          volume: null,
          creatorFeesEarned: null,
          creatorFeePercent: null,
        }
      : {
          ...common,
          oracleOwnerKind: "created",
          createdDate: "2026-10-08",
          volume: 0,
          creatorFeesEarned: 0,
          creatorFeePercent: 0,
          oracle: {
            type: "self",
            eventId: "created-event",
            outcomes: row.outcomes,
            destinations: row.status.destinations,
          },
        };
  }
  /** The first choice saves its explanation draft, so the owner must exist in the store. */
  async function setup(ownerKind: "created" | "imported" = "imported") {
    if (ownerKind === "imported") {
      await useCreatorMarketsStore.getState().retainImportedOracleMetadata(creatorOracleMetadata);
      await useCreatorMarketsStore.getState().markOracleImportComplete(ownerId);
    } else
      await seedCreatorMarkets({
        markets: [
          {
            conditionId: ownerId,
            title: "Imported oracle event",
            thumbnailUrl: null,
            createdAt: "2026-10-08T00:00:00.000Z",
            creatorFeePercent: 0,
            baseAsset: "sat",
            divisibility: 1_000,
            oracle: {
              type: "self",
              eventId: "created-event",
              outcomes: ["YES", "NO"],
              destinations: creatorOracleMetadata.destinations,
            },
          },
        ],
      });
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "f".repeat(64),
      stats: emptyStats(),
      markets: [marketRow(importedRow(), ownerKind)],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });
    mockLocalStatuses.mockImplementation(async () => ({
      rows: [{ ...importedRow(), kind: ownerKind }],
      nextOffset: null,
    }));
  }
  /** Open the first-choice dialog, select an outcome, and return the dialog. */
  async function chooseOutcome(user: ReturnType<typeof userEvent.setup>, outcome = "YES") {
    await user.click(await screen.findByRole("button", { name: "Close market" }));
    const dialog = screen.getByRole("dialog", { name: "Close this market" });
    await user.selectOptions(within(dialog).getByRole("combobox"), outcome);
    return dialog;
  }
  it.each(["imported", "created"] as const)(
    "requires confirmation for a %s first choice and offers no exact retry",
    async (kind) => {
      await setup(kind);
      const user = userEvent.setup();
      renderDashboard();
      expect(await screen.findByRole("button", { name: "Close market" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: /retry|republish/i })).toBeNull();
      const dialog = await chooseOutcome(user);
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
      expect(within(dialog).getByTestId("creator-oracle-confirm")).toHaveTextContent(
        "Close market with this outcome",
      );
      await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(mockPublishOracleOutcome).toHaveBeenCalledWith(
        ownerId,
        "YES",
        "",
        creatorOracleMetadata.destinations.relayUrls,
        useCreatorMarketsStore,
        undefined,
        { engineDelivery: "synchronize", requireCurrent: expect.any(Function) },
      );
    },
  );
  it.each(["created", "imported"] as const)(
    "cancels %s confirmation without starting publication",
    async (kind) => {
      await setup(kind);
      const user = userEvent.setup();
      renderDashboard();
      await chooseOutcome(user);
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Cancel",
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
    },
  );
  it.each(["created", "imported"] as const)(
    "discards %s late completion after a rapid identity change back",
    async (kind) => {
      await setup(kind);
      let complete!: (result: unknown) => void;
      mockPublishOracleOutcome.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const user = userEvent.setup();
      renderDashboard();
      await chooseOutcome(user);
      await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
      act(() => {
        useSettingsStore.setState({ nostrSignerMode: "nip07" });
        useSettingsStore.setState({ nostrSignerMode: "none" });
      });
      await act(async () => {
        complete({ failures: [] });
        await Promise.resolve();
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it.each(["created", "imported"] as const)(
    "invalidates %s publication guard when the dashboard unmounts",
    async (kind) => {
      await setup(kind);
      let proceed!: () => void;
      const nextStage = vi.fn();
      mockPublishOracleOutcome.mockImplementationOnce(
        async (_id, _outcome, _text, _relays, _store, _read, { requireCurrent }) => {
          await new Promise<void>((resolve) => {
            proceed = resolve;
          });
          requireCurrent();
          nextStage();
          return { failures: [] };
        },
      );
      const user = userEvent.setup();
      const view = renderDashboard();
      await chooseOutcome(user);
      await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
      view.unmount();
      await act(async () => {
        proceed();
        await Promise.resolve();
      });
      expect(nextStage.mock.calls.length === 0).toBe(true);
    },
  );

  async function setupImportedDialog(saved = false) {
    await setup();
    if (saved) {
      await useCreatorMarketsStore
        .getState()
        .saveOracleExplanationDraft(
          creatorOracleMetadata.binding.conditionId,
          "Original public explanation.",
        );
      await useCreatorMarketsStore
        .getState()
        .saveOraclePublication(creatorOracleMetadata.binding.conditionId, creatorOraclePublication);
    }
    const row = { ...importedRow(saved ? "YES" : null), title: "Restored original market" };
    mockUseCreatorDashboardState.mockReturnValue({
      ...mockUseCreatorDashboardState(),
      markets: [marketRow(row)],
    });
    mockLocalStatuses.mockImplementation(async () => ({
      rows: [row],
      nextOffset: null,
    }));
    return row;
  }

  it("keeps fresh imported choice and explanation local until confirmation, and resets them after cancel", async () => {
    const row = await setupImportedDialog();
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "Close market" }));
    let dialog = screen.getByRole("dialog", { name: "Close this market" });
    expect(within(dialog).getByText(row.title, { exact: true })).toBeVisible();
    expect(within(dialog).getByTestId("creator-oracle-confirm")).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole("combobox"), "NO");
    await user.type(within(dialog).getByRole("textbox"), "Unsaved explanation.");
    expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
    expect(useCreatorMarketsStore.getState().importedOracles[0].explanationDraft).toBeUndefined();
    expect(useCreatorMarketsStore.getState().importedOracles[0].publication).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close market" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox")).toHaveValue("");
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
    await user.selectOptions(within(dialog).getByRole("combobox"), "NO");
    await user.type(within(dialog).getByRole("textbox"), "Confirmed explanation.");
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(mockPublishOracleOutcome).toHaveBeenCalledWith(
      row.conditionId,
      "NO",
      "Confirmed explanation.",
      creatorOracleMetadata.destinations.relayUrls,
      useCreatorMarketsStore,
      undefined,
      { engineDelivery: "synchronize", requireCurrent: expect.any(Function) },
    );
  });

  it("shows a saved imported outcome without a dialog and keeps its explanation", async () => {
    await setupImportedDialog(true);
    renderDashboard();
    expect(await screen.findByText("Outcome: YES · Sending result…")).toBeVisible();
    expect(screen.queryByRole("button", { name: /close market|retry|republish/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
    expect(useCreatorMarketsStore.getState().importedOracles[0].explanationDraft).toBe(
      "Original public explanation.",
    );
  });

  it("locks an open unsaved dialog when an immutable choice arrives", async () => {
    await setupImportedDialog();
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "Close market" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByRole("combobox"), "NO");
    await user.type(within(dialog).getByRole("textbox"), "Unsaved text must not become immutable.");
    await act(async () => {
      await useCreatorMarketsStore
        .getState()
        .saveOraclePublication(creatorOracleMetadata.binding.conditionId, creatorOraclePublication);
    });
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByTestId("creator-oracle-saved-outcome")).toHaveTextContent("YES");
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(mockPublishOracleOutcome.mock.calls[0][1]).toBe("YES");
    expect(mockPublishOracleOutcome.mock.calls[0][2]).toBeUndefined();
  });

  it("admits one publication when confirmation is activated twice before React renders", async () => {
    await setup();
    let finish!: (value: unknown) => void;
    mockPublishOracleOutcome.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDashboard();
    await chooseOutcome(user);
    const confirm = within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm");
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The first choice saves its draft before publication starts.
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    ).toBeDisabled();
    await act(async () => {
      finish({ failures: [], record: {} });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockPublishOracleOutcome).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a new pending confirmation locked when the old identity's operation %ss",
    async (completion) => {
      await setup();
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: Error) => void;
      let resolveNew!: (value: unknown) => void;
      mockPublishOracleOutcome
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
        );
      const user = userEvent.setup();
      renderDashboard();
      await chooseOutcome(user);
      await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(1);
      act(() => {
        useSettingsStore.setState({ nostrSignerMode: "nip07" });
        useSettingsStore.setState({ nostrSignerMode: "none" });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      await chooseOutcome(user);
      const currentDialog = screen.getByRole("dialog");
      const confirm = within(currentDialog).getByTestId("creator-oracle-confirm");
      await user.click(confirm);
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (completion === "resolve") resolveOld({ failures: [], record: {} });
        else rejectOld(new Error("Old identity operation failed"));
      });
      expect(screen.getByRole("dialog")).toBe(currentDialog);
      expect(confirm).toBeDisabled();
      const cancel = within(currentDialog).getByRole("button", {
        name: "Cancel",
      });
      expect(cancel).toBeDisabled();
      await user.click(confirm);
      await user.click(cancel);
      fireEvent(currentDialog, new Event("cancel", { bubbles: false, cancelable: true }));
      expect(screen.getByRole("dialog")).toBe(currentDialog);
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => {
        resolveNew({ failures: [], record: {} });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("retranslates a retained publication error when the language changes without publishing again", async () => {
    await setup();
    mockPublishOracleOutcome.mockRejectedValueOnce(new Error("Unavailable"));
    const english = i18n.t("creator.oracleRecoveryRequired", { lng: "en" });
    const japanese = i18n.t("creator.oracleRecoveryRequired", { lng: "ja" });
    const user = userEvent.setup();
    renderDashboard();
    try {
      await chooseOutcome(user);
      await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
      expect((await screen.findAllByText(english)).length).toBeGreaterThan(0);
      await act(async () => {
        await i18n.changeLanguage("ja");
      });
      expect(screen.queryByText(english)).toBeNull();
      expect(screen.getAllByText(japanese).length).toBeGreaterThan(0);
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(1);
      await act(async () => {
        await i18n.changeLanguage("en");
      });
      expect(screen.getAllByText(english).length).toBeGreaterThan(0);
      expect(screen.queryByText(japanese)).toBeNull();
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });
});
