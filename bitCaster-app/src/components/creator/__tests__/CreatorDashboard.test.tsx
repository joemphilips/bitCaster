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
        within(dialog).getByRole("textbox", { name: "Public explanation (optional)" }),
        "Official final result.",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Close market with this outcome" }),
      );
      await screen.findByText(`Resolution ${selected} is confirmed by the engine and relay.`);
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
});

it.each(["chosenOutcome", "attestedOutcome"] as const)(
  "keeps an existing market's %s and explanation immutable in the common dialog",
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
    const save = vi.spyOn(useCreatorMarketsStore.getState(), "saveOracleExplanationDraft");
    const user = userEvent.setup();
    renderDashboard();
    await user.click(screen.getByRole("button", { name: "Retry saved resolution" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).getByRole("textbox")).toHaveValue("Saved explanation.");
    expect(within(dialog).getByRole("textbox")).toBeDisabled();
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(mockPublishOracleOutcome.mock.calls[0].slice(0, 3)).toEqual([
      market.id,
      "No",
      undefined,
    ]);
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  },
);

describe("saved oracle confirmation", () => {
  function importedRow(chosenOutcome: string | null = "YES") {
    return {
      conditionId: "e".repeat(64),
      available: true,
      readiness: "needs-restore",
      kind: "imported",
      title: "Imported oracle event",
      outcomes: ["YES", "NO"],
      chosenOutcome,
      status: {
        importComplete: true,
        preparationPending: false,
        noRelays: false,
        destinations: {
          mintUrl: "https://original.mint",
          engineUrl: "https://original.engine",
          relayUrls: ["wss://original.relay"],
        },
        initial: { prepared: true, acknowledgedRelays: 1, totalRelays: 1 },
        terminal: { prepared: false, deletionRequired: false, localCommitPending: false },
        publication: { relayPublished: true, engineSynchronized: false },
      },
    };
  }
  function setup(ownerKind: "created" | "imported" = "imported") {
    mockUseCreatorDashboardState.mockReturnValue({
      pubkey: "f".repeat(64),
      stats: emptyStats(),
      markets: [],
      isLoading: false,
      error: null,
      engineDataStatus: "current",
      refresh: vi.fn(),
    });
    mockLocalStatuses.mockImplementation(async ({ kind }) => ({
      rows:
        kind === ownerKind
          ? [
              {
                ...importedRow(),
                kind: ownerKind,
                status: {
                  ...importedRow().status,
                  publication: { relayPublished: true, engineSynchronized: true },
                },
              },
            ]
          : [],
      nextOffset: null,
    }));
  }
  it.each([
    ["imported", "Retry saved resolution", false],
    ["imported", "Republish exact resolution", true],
    ["created", "Retry saved resolution", false],
    ["created", "Republish exact resolution", true],
  ] as const)(
    "requires shared confirmation for %s %s with no signer",
    async (kind, label, republish) => {
      setup(kind);
      const user = userEvent.setup();
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: label }));
      const dialog = screen.getByRole("dialog", { name: "Close this market" });
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
      expect(within(dialog).queryByRole("combobox")).toBeNull();
      expect(within(dialog).getByTestId("creator-oracle-saved-outcome")).toHaveTextContent("YES");
      expect(
        within(dialog).getByRole("textbox", { name: "Public explanation (optional)" }),
      ).toBeDisabled();
      await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
      await screen.findByText("Resolution YES is confirmed by the engine and relay.");
      expect(mockPublishOracleOutcome).toHaveBeenCalledWith(
        "e".repeat(64),
        "YES",
        undefined,
        ["wss://original.relay"],
        useCreatorMarketsStore,
        undefined,
        {
          engineDelivery: "synchronize",
          republishAttestation: republish,
          requireCurrent: expect.any(Function),
        },
      );
    },
  );
  it.each(["created", "imported"] as const)(
    "cancels %s confirmation without starting publication",
    async (kind) => {
      setup(kind);
      const user = userEvent.setup();
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mockPublishOracleOutcome).not.toHaveBeenCalled();
    },
  );
  it.each(["created", "imported"] as const)(
    "discards %s late completion after a rapid identity change back",
    async (kind) => {
      setup(kind);
      let complete!: (result: unknown) => void;
      mockPublishOracleOutcome.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const user = userEvent.setup();
      renderDashboard();
      await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
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
      expect(screen.queryByText("Resolution YES is confirmed by the engine and relay.")).toBeNull();
    },
  );
  it.each(["created", "imported"] as const)(
    "invalidates %s publication guard when the dashboard unmounts",
    async (kind) => {
      setup(kind);
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
      await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
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
    setup();
    await useCreatorMarketsStore.getState().retainImportedOracleMetadata(creatorOracleMetadata);
    await useCreatorMarketsStore
      .getState()
      .markOracleImportComplete(creatorOracleMetadata.binding.conditionId);
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
    const row = {
      ...importedRow(saved ? "YES" : null),
      conditionId: creatorOracleMetadata.binding.conditionId,
      readiness: "ready",
      title: "Restored original market",
      status: { ...importedRow().status, destinations: creatorOracleMetadata.destinations },
    };
    mockLocalStatuses.mockImplementation(async ({ kind }) => ({
      rows: kind === "imported" ? [row] : [],
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
      {
        engineDelivery: "synchronize",
        republishAttestation: false,
        requireCurrent: expect.any(Function),
      },
    );
  });

  it("shows a saved imported outcome and explanation without allowing either to change", async () => {
    const row = await setupImportedDialog(true);
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).getByTestId("creator-oracle-saved-outcome")).toHaveTextContent("YES");
    expect(within(dialog).getByRole("textbox")).toHaveValue("Original public explanation.");
    expect(within(dialog).getByRole("textbox")).toBeDisabled();
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(mockPublishOracleOutcome.mock.calls[0].slice(0, 4)).toEqual([
      row.conditionId,
      "YES",
      undefined,
      creatorOracleMetadata.destinations.relayUrls,
    ]);
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
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
    expect(within(dialog).getByTestId("creator-oracle-saved-outcome")).toHaveTextContent("YES");
    await user.click(within(dialog).getByTestId("creator-oracle-confirm"));
    await waitFor(() => expect(mockPublishOracleOutcome).toHaveBeenCalledOnce());
    expect(mockPublishOracleOutcome.mock.calls[0][1]).toBe("YES");
    expect(mockPublishOracleOutcome.mock.calls[0][2]).toBeUndefined();
  });

  it("admits one publication when confirmation is activated twice before React renders", async () => {
    setup();
    let finish!: (value: unknown) => void;
    mockPublishOracleOutcome.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
    const confirm = within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm");
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockPublishOracleOutcome).toHaveBeenCalledOnce();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await act(async () => {
      finish({ failures: [], record: {} });
    });
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a new pending confirmation locked when the old identity's operation %ss",
    async (completion) => {
      setup();
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
      await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
      await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
      expect(mockPublishOracleOutcome).toHaveBeenCalledTimes(1);
      act(() => {
        useSettingsStore.setState({ nostrSignerMode: "nip07" });
        useSettingsStore.setState({ nostrSignerMode: "none" });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
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
      const cancel = within(currentDialog).getByRole("button", { name: "Cancel" });
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
      expect(
        screen.getByText("Resolution YES is confirmed by the engine and relay."),
      ).toBeVisible();
    },
  );

  it("keeps partial delivery distinct from complete delivery", async () => {
    setup();
    mockPublishOracleOutcome.mockResolvedValueOnce({ failures: ["relay"], record: {} });
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
    await user.click(within(screen.getByRole("dialog")).getByTestId("creator-oracle-confirm"));
    await screen.findByText(
      "Outcome YES is saved. Some delivery is unconfirmed. Retry the saved resolution.",
    );
    expect(screen.queryByText("Resolution YES is confirmed by the engine and relay.")).toBeNull();
  });
});
