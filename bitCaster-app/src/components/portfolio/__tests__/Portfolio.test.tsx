import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Portfolio } from "../Portfolio";
import { PositionRow } from "../PositionRow";
import type {
  PortfolioProps,
  UserProfile,
  PLChartData,
  PortfolioStats,
  Position,
  Fund,
  ActivityItem,
  CreatedMarket,
} from "@/types/portfolio";

const mockProfile: UserProfile = {
  userId: "usr-a1b2",
  displayName: "SatoshiTrader",
  avatarUrl: null,
  registeredDate: "2025-08-15T09:30:00Z",
};

const mockPLData: PLChartData = {
  "1D": [
    { timestamp: "2026-01-22T00:00:00Z", cumulativePL: 220000 },
    { timestamp: "2026-01-23T00:00:00Z", cumulativePL: 234580 },
  ],
  "1W": [
    { timestamp: "2026-01-16T00:00:00Z", cumulativePL: 242780 },
    { timestamp: "2026-01-22T00:00:00Z", cumulativePL: 234580 },
  ],
  "1M": [
    { timestamp: "2025-12-23T00:00:00Z", cumulativePL: 147230 },
    { timestamp: "2026-01-22T00:00:00Z", cumulativePL: 234580 },
  ],
  ALL: [
    { timestamp: "2025-08-15T00:00:00Z", cumulativePL: 0 },
    { timestamp: "2026-01-22T00:00:00Z", cumulativePL: 234580 },
  ],
};

const mockStats: PortfolioStats = {
  positionsValueSats: 445750,
  totalValueSats: 618750,
  predictionsCount: 8,
};

const mockPositions: Position[] = [
  {
    id: "pos-001",
    marketId: "mkt-001",
    marketTitle: "Will Bitcoin reach $100K?",
    marketImageUrl: "/images/markets/bitcoin-100k.jpg",
    baseAsset: "sat",
    divisibility: 1_000,
    mintUrl: "https://mint.bitcaster.io",
    side: "yes",
    shares: 150,
    currentValueSats: 101250,
    status: "active",
    isWinner: false,
    isLoser: false,
    isPending: false,
    acquiredDate: "2025-12-10T14:22:00Z",
  },
  {
    id: "pos-005",
    marketId: "mkt-resolved-001",
    marketTitle: "Will Ethereum merge complete?",
    marketImageUrl: "/images/markets/eth-merge.jpg",
    baseAsset: "sat",
    divisibility: 1_000,
    mintUrl: "https://mint.bitcaster.io",
    side: "yes",
    shares: 100,
    currentValueSats: 100000,
    status: "closed",
    isWinner: true,
    isLoser: false,
    isPending: false,
    closedDate: "2025-12-31T23:59:59Z",
    acquiredDate: "2025-09-20T10:30:00Z",
  },
  {
    id: "pos-006",
    marketId: "mkt-resolved-002",
    marketTitle: "Will the Fed raise rates?",
    marketImageUrl: "/images/markets/fed-rates.jpg",
    baseAsset: "sat",
    divisibility: 1_000,
    mintUrl: "https://mint.bitcaster.io",
    side: "yes",
    shares: 250,
    currentValueSats: 0,
    status: "closed",
    isWinner: false,
    isLoser: true,
    isPending: false,
    closedDate: "2025-12-18T19:00:00Z",
    acquiredDate: "2025-11-01T13:45:00Z",
  },
];

const mockFunds: Fund[] = [
  { id: "fund-001", unit: "sats", amount: 125000, mintUrl: "https://mint.bitcaster.io" },
  { id: "fund-002", unit: "sats", amount: 48000, mintUrl: "https://testnut.cashu.space" },
];

const mockActivity: ActivityItem[] = [
  {
    id: "act-001",
    walletId: "a".repeat(64),
    type: "deposit",
    baseAsset: "sat",
    amountSubunits: 500000,
    date: "2025-08-15T09:35:00Z",
    status: "completed",
    txId: "a1b2c3d4e5f6789012345678901234567890abcd",
    lightningInvoice: null,
  },
  {
    id: "act-002",
    walletId: "a".repeat(64),
    type: "Buy",
    baseAsset: "sat",
    amountSubunits: 93600,
    date: "2025-09-20T10:30:00Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    marketId: "mkt-resolved-001",
    marketTitle: "Will Ethereum merge to PoS?",
    positionId: "pos-005",
  },
];

const mockCreatedMarkets: CreatedMarket[] = [
  {
    id: "mkt-user-001",
    title: "Will Lightning reach 100K channels?",
    imageUrl: "/images/markets/lightning-channels.jpg",
    baseAsset: "sat",
    divisibility: 1_000,
    status: "active",
    createdDate: "2025-11-20T14:00:00Z",
    volume: 456200,
    creatorFeesEarned: 9124,
    creatorFeePercent: 2.0,
  },
  {
    id: "mkt-user-003",
    title: "Will Nostr reach 10M users?",
    imageUrl: "/images/markets/nostr-users.jpg",
    baseAsset: "sat",
    divisibility: 1_000,
    status: "resolved",
    createdDate: "2025-06-10T08:30:00Z",
    resolvedDate: "2025-12-31T23:59:59Z",
    volume: 892100,
    creatorFeesEarned: 17842,
    creatorFeePercent: 2.0,
  },
];

function renderPortfolio(overrides: Partial<PortfolioProps> = {}) {
  const defaultProps: PortfolioProps = {
    walletState: "ready",
    baseCurrency: "BTC",
    selectedTimeRange: "ALL",
    profile: mockProfile,
    plChartData: mockPLData,
    stats: mockStats,
    positions: mockPositions,
    funds: mockFunds,
    activity: mockActivity,
    createdMarkets: mockCreatedMarkets,
    positionsTab: "active",
    ...overrides,
  };
  return render(<Portfolio {...defaultProps} />);
}

describe("PositionRow", () => {
  it.each([
    { side: "yes", label: "Yes Alpha", color: "text-emerald-700" },
    { side: "no", label: "No Alpha", color: "text-rose-700" },
    { side: "Outcome", label: "Alpha or Gamma", color: "text-slate-700" },
  ] as const)("uses identity color for an active $side label", ({ side, label, color }) => {
    render(<PositionRow position={{ ...mockPositions[0], side, outcomeLabel: label }} />);
    expect(screen.getByText(label)).toHaveClass(color);
  });

  it("shows a categorical outcome swatch without changing Sell availability", () => {
    const position = {
      ...mockPositions[0],
      side: "Outcome" as const,
      outcomeId: "Alpha",
      outcomeLabel: "Alpha",
      outcomeColor: "#123ABC",
      canSell: true,
    };

    render(<PositionRow position={position} onSell={vi.fn()} />);

    expect(screen.getByTestId("outcome-color-swatch")).toHaveStyle({
      backgroundColor: "#123ABC",
    });
    expect(screen.getByRole("button", { name: /sell.*bitcoin/i })).toBeInTheDocument();
  });

  it("keeps a closed status neutral beside its categorical outcome swatch", () => {
    const position = {
      ...mockPositions[1],
      side: "Outcome" as const,
      outcomeId: "Alpha",
      outcomeLabel: "Alpha",
      outcomeColor: "#123ABC",
    };

    render(<PositionRow position={position} onClaim={vi.fn()} />);

    expect(screen.getByText(/Won/)).toHaveClass("bg-slate-100");
    expect(screen.getByTestId("outcome-color-swatch")).toHaveStyle({
      backgroundColor: "#123ABC",
    });
    expect(screen.getByLabelText(/claim payout.*ethereum/i)).toBeInTheDocument();
  });

  it("shows a winning payout value and Claim action without reporting profit", () => {
    const { container } = render(<PositionRow position={mockPositions[1]} onClaim={vi.fn()} />);

    expect(screen.getByText(/Won/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "100 sats" })).toBeInTheDocument();
    expect(screen.getByLabelText(/claim payout.*ethereum/i)).toBeInTheDocument();
    expect(container.querySelector(".text-xs.font-mono")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/%/);
  });

  const actionScenarios = [
    {
      action: "Sell",
      kind: "sell",
      position: mockPositions[0],
      buttonName: /sell.*bitcoin/i,
    },
    {
      action: "Claim",
      kind: "claim",
      position: mockPositions[1],
      buttonName: /claim payout.*ethereum/i,
    },
    {
      action: "Remove",
      kind: "discard",
      position: mockPositions[2],
      buttonName: /remove losing position.*fed/i,
    },
  ] as const;

  const actionInteractions = actionScenarios.flatMap((scenario) => [
    { ...scenario, interaction: "click" as const },
    { ...scenario, interaction: "Enter" as const },
    { ...scenario, interaction: "Space" as const },
  ]);

  it.each(actionInteractions)(
    "$action $interaction activates without navigating the parent row",
    async ({ kind, position, buttonName, interaction }) => {
      const onView = vi.fn();
      const onAction = vi.fn();
      const actionProps =
        kind === "sell"
          ? { onSell: onAction }
          : kind === "claim"
            ? { onClaim: onAction }
            : { onDiscard: onAction };
      const user = userEvent.setup();

      render(<PositionRow position={position} onView={onView} {...actionProps} />);
      const button = screen.getByRole("button", { name: buttonName });

      if (interaction === "click") {
        await user.click(button);
      } else {
        button.focus();
        await user.keyboard(interaction === "Enter" ? "{Enter}" : " ");
      }

      expect(onAction).toHaveBeenCalledOnce();
      expect(onAction).toHaveBeenCalledWith(position.id);
      expect(onView).not.toHaveBeenCalled();
    },
  );
});

describe("Portfolio", () => {
  describe("No Wallet State", () => {
    it("shows Get Started CTA when walletState is none", () => {
      renderPortfolio({ walletState: "none" });
      expect(screen.getByText("Welcome to bitCaster")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /get started/i })).toBeInTheDocument();
      expect(screen.queryByText("SatoshiTrader")).not.toBeInTheDocument();
    });

    it("calls onGetStarted when CTA is clicked", async () => {
      const onGetStarted = vi.fn();
      renderPortfolio({ walletState: "none", onGetStarted });
      await userEvent.click(screen.getByRole("button", { name: /get started/i }));
      expect(onGetStarted).toHaveBeenCalledOnce();
    });
  });

  describe("Full Dashboard", () => {
    it("renders profile card with display name", () => {
      renderPortfolio();
      expect(screen.getByText("SatoshiTrader")).toBeInTheDocument();
    });

    it("renders stats row", () => {
      renderPortfolio();
      expect(screen.getByText("Positions Value")).toBeInTheDocument();
      expect(screen.getByText("Total Value")).toBeInTheDocument();
      expect(screen.getByText("Predictions")).toBeInTheDocument();
    });

    it("renders deposit and withdraw buttons", () => {
      renderPortfolio();
      expect(screen.getByRole("button", { name: /deposit/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    });

    it("renders settings button", () => {
      renderPortfolio();
      expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
    });
  });

  describe("Main Tabs", () => {
    it("shows positions tab by default", () => {
      renderPortfolio();
      expect(screen.getByText("Active (1)")).toBeInTheDocument();
    });

    it("switches to funds tab", async () => {
      renderPortfolio();
      await userEvent.click(screen.getByRole("tab", { name: /funds/i }));
      expect(screen.getAllByText("Sats")).toHaveLength(2);
    });

    it("renders funds as non-interactive list rows", async () => {
      renderPortfolio();
      await userEvent.click(screen.getByRole("tab", { name: /funds/i }));

      expect(screen.getByRole("list", { name: "Funds" })).toBeInTheDocument();
      const rows = screen.getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.querySelector("button") === null)).toBe(true);
    });

    it("switches to activity tab", async () => {
      renderPortfolio();
      await userEvent.click(screen.getByRole("tab", { name: /activity/i }));
      // "Deposit" appears both as a button label and activity type label
      expect(screen.getAllByText("Deposit").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Monitoring status", () => {
    it.each([null, "unavailable"] as const)(
      "labels retained estimates and progress without claiming current local balances: %s",
      (error) => {
        renderPortfolio({
          stats: { ...mockStats, totalValueLoading: true },
          monitoring: {
            retainingDisplay: true,
            stale: true,
            incomplete: false,
            building: true,
            unvaluedAssetCount: 0,
            hasPendingOutgoing: false,
            pendingOutgoingValueMsat: null,
            error,
            assetPageError: null,
            hasMoreAssets: false,
            loadingMoreAssets: false,
            liveUpdateCoverageLimited: false,
          },
        });
        const notice = screen
          .getAllByRole("status")
          .find((element) => element.textContent?.includes("last successful"));
        expect(notice).toHaveTextContent("Showing the last successful portfolio estimate.");
        expect(notice).toHaveTextContent("It is not a spendable balance.");
        expect(notice).toHaveTextContent("Loading...");
        expect(notice).not.toHaveTextContent("Local wallet data is shown.");
        if (error) expect(notice).toHaveTextContent("Portfolio monitoring is unavailable.");
      },
    );
    it.each([true, false])("shows value-level loading only during a request: %s", (loading) => {
      renderPortfolio({
        stats: {
          ...mockStats,
          totalValueKnown: false,
          positionsValueKnown: false,
          totalValueLoading: loading,
          positionsValueLoading: loading,
        },
      });
      expect(screen.queryAllByRole("status", { name: /Total Value: Loading/ })).toHaveLength(
        loading ? 2 : 0,
      );
      expect(screen.queryAllByRole("status", { name: /Positions Value: Loading/ })).toHaveLength(
        loading ? 1 : 0,
      );
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    });
    it.each([null, 1_000])("does not add a banner for pending outgoing value %s", (value) => {
      renderPortfolio({
        monitoring: {
          stale: false,
          incomplete: false,
          building: false,
          unvaluedAssetCount: 0,
          hasPendingOutgoing: true,
          pendingOutgoingValueMsat: value,
          error: null,
          assetPageError: null,
          hasMoreAssets: false,
          loadingMoreAssets: false,
          liveUpdateCoverageLimited: false,
        },
      });

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByText("Total Value")).toBeInTheDocument();
    });

    it.each([
      ["complete", false, false, false, null],
      ["building", true, false, false, null],
      ["stale", false, true, false, "Portfolio data may be out of date."],
      ["incomplete", false, false, true, "Some portfolio records are missing."],
    ] as const)(
      "distinguishes %s data from missing price estimates",
      (_state, building, stale, incomplete, notice) => {
        renderPortfolio({
          positions: [
            ...mockPositions,
            {
              ...mockPositions[0],
              id: "unpriced-position",
              marketTitle: "Unpriced position",
              valueKnown: false,
            },
          ],
          monitoring: {
            stale,
            incomplete,
            building,
            unvaluedAssetCount: 1,
            hasPendingOutgoing: false,
            pendingOutgoingValueMsat: null,
            error: null,
            assetPageError: null,
            hasMoreAssets: false,
            loadingMoreAssets: false,
            liveUpdateCoverageLimited: false,
          },
        });

        const status = screen.getByRole("status");
        expect(status).toHaveTextContent("One position has no price estimate yet.");
        if (notice) expect(status).toHaveTextContent(notice);
        expect(status).not.toHaveTextContent("Updating");
        expect(screen.getByText("Unpriced position")).toBeInTheDocument();
        expect(
          screen.getByText("A current price is not available for this position."),
        ).toBeInTheDocument();
      },
    );
  });

  describe("Positions", () => {
    it("keeps pending removal visible after a remount", () => {
      const position: Position = {
        ...mockPositions[0],
        status: "closed",
        isWinner: false,
        isLoser: true,
        removalPending: true,
      };
      const props = { positions: [position], positionsTab: "closed" as const };
      const view = renderPortfolio(props);
      expect(screen.getByText(/Removal is not finished/)).toBeInTheDocument();
      view.unmount();
      renderPortfolio(props);
      expect(screen.getByText(/Removal is not finished/)).toBeInTheDocument();
      expect(screen.getByText(position.marketTitle)).toBeInTheDocument();
    });

    it("keeps pending Claim visible and retryable after a remount", async () => {
      const position: Position = {
        ...mockPositions[0],
        status: "closed",
        isWinner: false,
        isLoser: false,
        isPending: true,
        canClaimPayout: true,
        claimRecoveryPending: true,
      };
      const onClaimPayout = vi.fn();
      const props = { positions: [position], positionsTab: "closed" as const, onClaimPayout };
      const view = renderPortfolio(props);
      expect(screen.getByText(/The claim is not finished/)).toBeInTheDocument();
      view.unmount();
      renderPortfolio(props);
      expect(screen.getByText(/The claim is not finished/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /claim payout/i }));
      expect(onClaimPayout).toHaveBeenCalledWith(position.id);
    });
    it("shows active positions by default", () => {
      renderPortfolio();
      expect(screen.getByText("Will Bitcoin reach $100K?")).toBeInTheDocument();
    });

    it("renders complement positions with a public NOT label", () => {
      renderPortfolio({
        positions: [
          {
            id: "cond-abc-A",
            marketId: "cond-abc-A",
            marketTitle: "Which team wins?",
            marketImageUrl: "",
            baseAsset: "sat",
            divisibility: 1_000,
            mintUrl: "https://mint.bitcaster.io",
            side: "Outcome",
            outcomeId: "A",
            outcomeLabel: "A",
            shares: 10,
            currentValueSats: 10,
            status: "active",
            isWinner: false,
            isLoser: false,
            isPending: false,
            acquiredDate: "2026-01-01T00:00:00Z",
          },
          {
            id: "cond-abc-B|C",
            marketId: "cond-abc-B|C",
            marketTitle: "Which team wins?",
            marketImageUrl: "",
            baseAsset: "sat",
            divisibility: 1_000,
            mintUrl: "https://mint.bitcaster.io",
            side: "Outcome",
            outcomeId: "B|C",
            outcomeLabel: "Not A",
            shares: 25,
            currentValueSats: 25,
            status: "active",
            isWinner: false,
            isLoser: false,
            isPending: false,
            acquiredDate: "2026-01-01T00:00:00Z",
          },
        ],
      });

      expect(screen.getByText("A")).toBeInTheDocument();
      expect(screen.getByText("Not A")).toBeInTheDocument();
      expect(screen.queryByText("B|C")).not.toBeInTheDocument();
      expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();
      expect(screen.queryByText("Complement")).not.toBeInTheDocument();
    });

    it("renders closed outcome labels without protocol side words", () => {
      renderPortfolio({
        positionsTab: "closed",
        positions: [
          {
            id: "cond-abc-B|C",
            marketId: "cond-abc-B|C",
            marketTitle: "Which team wins?",
            marketImageUrl: "",
            baseAsset: "sat",
            divisibility: 1_000,
            mintUrl: "https://mint.bitcaster.io",
            side: "Outcome",
            outcomeId: "B|C",
            outcomeLabel: "Not A",
            shares: 10,
            currentValueSats: 10,
            status: "closed",
            isWinner: false,
            isLoser: false,
            isPending: false,
            acquiredDate: "2026-01-01T00:00:00Z",
          },
        ],
      });

      expect(screen.getByText("Not A")).toBeInTheDocument();
      expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();
      expect(screen.queryByText("Complement")).not.toBeInTheDocument();
      expect(screen.queryByText("B|C")).not.toBeInTheDocument();
    });

    it("uses readable fallback labels when catalogue outcome labels are missing", () => {
      renderPortfolio({
        positions: [
          {
            id: "cond-abc-B|C",
            marketId: "cond-abc-B|C",
            marketTitle: "Which team wins?",
            marketImageUrl: "",
            baseAsset: "sat",
            divisibility: 1_000,
            mintUrl: "https://mint.bitcaster.io",
            side: "Outcome",
            outcomeId: "B|C",
            shares: 10,
            currentValueSats: 10,
            status: "active",
            isWinner: false,
            isLoser: false,
            isPending: false,
            acquiredDate: "2026-01-01T00:00:00Z",
          },
          {
            id: "cond-abc-unknown",
            marketId: "cond-abc-unknown",
            marketTitle: "Unknown position",
            marketImageUrl: "",
            baseAsset: "sat",
            divisibility: 1_000,
            mintUrl: "https://mint.bitcaster.io",
            side: "Outcome",
            shares: 1,
            currentValueSats: 1,
            status: "active",
            isWinner: false,
            isLoser: false,
            isPending: false,
            acquiredDate: "2026-01-01T00:00:00Z",
          },
        ],
      });

      expect(screen.getByText("B or C")).toBeInTheDocument();
      expect(screen.getByText("Position")).toBeInTheDocument();
      expect(screen.queryByText("B|C")).not.toBeInTheDocument();
      expect(screen.queryByText("OUTCOME")).not.toBeInTheDocument();
      expect(screen.queryByText("Complement")).not.toBeInTheDocument();
    });

    it("switches to closed positions tab", async () => {
      const onPositionsTabChange = vi.fn();
      renderPortfolio({ onPositionsTabChange });
      await userEvent.click(screen.getByText("Closed (2)"));
      expect(onPositionsTabChange).toHaveBeenCalledWith("closed");
    });

    it("shows Sell button on active positions", () => {
      const onSellPosition = vi.fn();
      renderPortfolio({ onSellPosition });
      expect(screen.getByLabelText(/sell.*bitcoin/i)).toBeInTheDocument();
    });

    it("calls onSellPosition when Sell is clicked", async () => {
      const onSellPosition = vi.fn();
      renderPortfolio({ onSellPosition });
      await userEvent.click(screen.getByLabelText(/sell.*bitcoin/i));
      expect(onSellPosition).toHaveBeenCalledWith("pos-001");
    });

    it("shows Claim button on winning closed positions", async () => {
      const onClaimPayout = vi.fn();
      renderPortfolio({ positionsTab: "closed", onClaimPayout });
      // Winner classification authorizes Claim independently of displayed value.
      expect(screen.getByLabelText(/claim.*ethereum/i)).toBeInTheDocument();
    });

    it("does not show Claim button on losing closed positions", () => {
      const onClaimPayout = vi.fn();
      renderPortfolio({ positionsTab: "closed", onClaimPayout });
      // Loser classification does not authorize Claim.
      expect(screen.queryByLabelText(/claim.*fed/i)).not.toBeInTheDocument();
    });

    it("shows Remove button on losing closed positions", async () => {
      const onDiscardLostPosition = vi.fn();
      renderPortfolio({ positionsTab: "closed", onDiscardLostPosition });
      await userEvent.click(screen.getByLabelText(/remove losing position.*fed/i));
      expect(onDiscardLostPosition).toHaveBeenCalledWith("pos-006");
    });

    it("shows empty state when no positions", () => {
      renderPortfolio({ positions: [] });
      expect(screen.getByText("No active positions")).toBeInTheDocument();
    });

    it("uses explicit Won and Lost text with neutral closed-position colors", () => {
      renderPortfolio({ positionsTab: "closed", onViewPosition: vi.fn() });
      for (const label of [/Won/, /Lost/]) {
        const badge = screen.getByText(label);
        expect(badge).toHaveClass("bg-slate-100", "text-slate-700");
        const row = badge.closest('[role="button"]');
        expect(row).not.toBeNull();
        expect(row?.className).not.toMatch(/bg-(emerald|rose|amber)-/);
      }
    });

    // P22 F2 — Remove is offered for LOST positions only.
    it("shows Remove button on losing closed positions", () => {
      const onDiscardLostPosition = vi.fn();
      renderPortfolio({ positionsTab: "closed", onDiscardLostPosition });
      expect(screen.getByLabelText(/remove losing position.*fed/i)).toBeInTheDocument();
    });

    // P22 F2 guard — Remove is NEVER offered on a winner (badge/action parity).
    it("does not show Remove button on winning closed positions", () => {
      const onDiscardLostPosition = vi.fn();
      renderPortfolio({ positionsTab: "closed", onDiscardLostPosition });
      expect(screen.queryByLabelText(/remove losing position.*ethereum/i)).not.toBeInTheDocument();
    });

    it("calls onDiscardLostPosition on a lost position", async () => {
      const onDiscardLostPosition = vi.fn();
      renderPortfolio({ positionsTab: "closed", onDiscardLostPosition });
      await userEvent.click(screen.getByLabelText(/remove losing position.*fed/i));
      expect(onDiscardLostPosition).toHaveBeenCalledWith("pos-006");
    });
  });

  describe("Funds Tab", () => {
    it("renders fund rows with correct info", async () => {
      renderPortfolio();
      await userEvent.click(screen.getByRole("tab", { name: /funds/i }));
      expect(screen.getByText("mint.bitcaster.io")).toBeInTheDocument();
      expect(screen.getByText("testnut.cashu.space")).toBeInTheDocument();
    });

    it("shows empty state when no funds", async () => {
      renderPortfolio({ funds: [] });
      await userEvent.click(screen.getByRole("tab", { name: /funds/i }));
      expect(screen.getByText("No funds")).toBeInTheDocument();
    });
  });

  describe("Activity Tab", () => {
    it("renders activity items", async () => {
      renderPortfolio();
      await userEvent.click(screen.getByRole("tab", { name: /activity/i }));
      // Activity type labels appear along with the Deposit button
      expect(screen.getByText("Buy")).toBeInTheDocument();
      expect(screen.getByText("Will Ethereum merge to PoS?")).toBeInTheDocument();
    });

    it("shows empty state when no activity", async () => {
      renderPortfolio({ activity: [] });
      await userEvent.click(screen.getByRole("tab", { name: /activity/i }));
      expect(screen.getByText("No activity yet")).toBeInTheDocument();
    });
  });

  describe("P/L Chart", () => {
    it("calls onTimeRangeChange when time range is clicked", async () => {
      const onTimeRangeChange = vi.fn();
      renderPortfolio({ onTimeRangeChange });
      await userEvent.click(screen.getByRole("button", { name: "1W" }));
      expect(onTimeRangeChange).toHaveBeenCalledWith("1W");
    });
  });

  describe("My Markets", () => {
    it("renders created markets section", () => {
      renderPortfolio();
      expect(screen.getByText("My Markets (2)")).toBeInTheDocument();
      expect(screen.getByText("Will Lightning reach 100K channels?")).toBeInTheDocument();
    });

    it("hides section when no created markets", () => {
      renderPortfolio({ createdMarkets: [] });
      expect(screen.queryByText(/my markets/i)).not.toBeInTheDocument();
    });

    it("collapses and expands", async () => {
      renderPortfolio();
      expect(screen.getByText("Will Lightning reach 100K channels?")).toBeInTheDocument();
      // Click the collapse button (My Markets header)
      await userEvent.click(screen.getByText("My Markets (2)"));
      expect(screen.queryByText("Will Lightning reach 100K channels?")).not.toBeInTheDocument();
      // Expand again
      await userEvent.click(screen.getByText("My Markets (2)"));
      expect(screen.getByText("Will Lightning reach 100K channels?")).toBeInTheDocument();
    });

    it("shows Claim Fees button on resolved markets with fees", () => {
      const onClaimCreatorFees = vi.fn();
      renderPortfolio({ onClaimCreatorFees });
      expect(screen.getByText("Claim Fees")).toBeInTheDocument();
    });

    it("calls onClaimCreatorFees when Claim Fees is clicked", async () => {
      const onClaimCreatorFees = vi.fn();
      renderPortfolio({ onClaimCreatorFees });
      await userEvent.click(screen.getByText("Claim Fees"));
      expect(onClaimCreatorFees).toHaveBeenCalledWith("mkt-user-003");
    });
  });

  describe("Callbacks", () => {
    it("shows one shared asset-page control and calls it", async () => {
      const onLoadMoreAssets = vi.fn();
      renderPortfolio({
        monitoring: {
          stale: false,
          incomplete: true,
          building: false,
          unvaluedAssetCount: 0,
          hasPendingOutgoing: false,
          pendingOutgoingValueMsat: null,
          error: null,
          assetPageError: null,
          hasMoreAssets: true,
          loadingMoreAssets: false,
          liveUpdateCoverageLimited: false,
        },
        onLoadMoreAssets,
      });

      await userEvent.click(screen.getByRole("button", { name: "Load more" }));

      expect(onLoadMoreAssets).toHaveBeenCalledOnce();
    });

    it("keeps the quiet coverage note visible after the final page", async () => {
      const user = userEvent.setup();
      renderPortfolio({
        monitoring: {
          stale: false,
          incomplete: false,
          building: false,
          unvaluedAssetCount: 0,
          hasPendingOutgoing: false,
          pendingOutgoingValueMsat: null,
          error: null,
          assetPageError: null,
          hasMoreAssets: false,
          loadingMoreAssets: false,
          liveUpdateCoverageLimited: true,
        },
      });

      expect(screen.getByRole("note")).toHaveTextContent(
        "Live updates cover the first page. Reload Portfolio and load later pages again to update their values.",
      );
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: "Funds" }));
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("calls onDeposit when Deposit is clicked", async () => {
      const onDeposit = vi.fn();
      renderPortfolio({ onDeposit });
      await userEvent.click(screen.getByRole("button", { name: /deposit/i }));
      expect(onDeposit).toHaveBeenCalledOnce();
    });

    it("calls onWithdraw when Withdraw is clicked", async () => {
      const onWithdraw = vi.fn();
      renderPortfolio({ onWithdraw });
      await userEvent.click(screen.getByRole("button", { name: /withdraw/i }));
      expect(onWithdraw).toHaveBeenCalledOnce();
    });

    it("calls onOpenSettings when settings icon is clicked", async () => {
      const onOpenSettings = vi.fn();
      renderPortfolio({ onOpenSettings });
      await userEvent.click(screen.getByRole("button", { name: /settings/i }));
      expect(onOpenSettings).toHaveBeenCalledOnce();
    });
  });
});
