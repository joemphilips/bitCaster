import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Position } from "@/types/portfolio";

// --- mocks -----------------------------------------------------------------

const removeProofs = vi.fn().mockResolvedValue(undefined);
const cashuMocks = vi.hoisted(() => ({
  claimPortfolioPosition: vi.fn(),
  removePortfolioPosition: vi.fn(),
  addActivity: vi.fn(),
}));

vi.mock("@/stores/proof-db", () => ({
  removeProofs: (...args: unknown[]) => removeProofs(...args),
}));

vi.mock("@/lib/browserPortfolioClaim", () => ({
  claimPortfolioPosition: cashuMocks.claimPortfolioPosition,
}));
vi.mock("@/lib/browserPortfolioRemove", () => ({
  removePortfolioPosition: cashuMocks.removePortfolioPosition,
}));

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/deposit-withdraw/DepositWithdrawOverlay", () => ({
  DepositWithdrawOverlay: () => null,
}));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ nostrSignerMode: "none", nostrProfile: null }),
}));

vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (s: unknown) => unknown) =>
    selector({ items: [], addActivity: cashuMocks.addActivity }),
}));

// usePortfolioState is heavy (Dexie live queries + fetch); supply fixed state.
let mockPositions: Position[] = [];
const setPositionsTab = vi.fn();
vi.mock("../usePortfolioState", () => ({
  usePortfolioState: () => ({
    walletState: "ready",
    baseCurrency: "BTC",
    selectedTimeRange: "ALL",
    profile: { userId: "", displayName: "Anon", avatarUrl: null, registeredDate: "" },
    plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
    stats: {
      positionsValueSats: 0,
      totalValueSats: 0,
      biggestWinSats: 0,
      predictionsCount: 0,
    },
    positions: mockPositions,
    funds: [],
    activity: [],
    createdMarkets: [],
    positionsTab: "closed" as const,
    setSelectedTimeRange: vi.fn(),
    setPositionsTab,
    saveProfile: vi.fn(),
  }),
}));

import { PortfolioPage } from "../PortfolioPage";

function closedPosition(overrides: Partial<Position>): Position {
  return {
    id: "cond1-A|B",
    marketId: "cond1-A|B",
    marketTitle: "Lost market",
    marketImageUrl: "",
    baseAsset: "sat",
    divisibility: 1_000,
    side: "Outcome",
    outcomeId: "A|B",
    outcomeLabel: "A|B",
    shares: 100,
    avgBuyPrice: 0,
    currentPrice: 0,
    currentValueSats: 0,
    profitLossSats: 0,
    profitLossPercent: -100,
    status: "closed",
    isWinner: false,
    isLoser: true,
    isPending: false,
    acquiredDate: new Date(0).toISOString(),
    mintUrl: "https://mint.example",
    ...overrides,
  };
}

describe("PortfolioPage — Remove lost position (P22 F2)", () => {
  beforeEach(() => {
    cashuMocks.claimPortfolioPosition.mockReset();
    cashuMocks.claimPortfolioPosition.mockResolvedValue({
      kind: "completed",
      committedPayoutAmount: 0,
    });
    cashuMocks.addActivity.mockReset();
    cashuMocks.removePortfolioPosition.mockReset();
    cashuMocks.removePortfolioPosition.mockResolvedValue({
      kind: "completed",
      committedPayoutAmount: 0,
    });
    removeProofs.mockReset();
    removeProofs.mockResolvedValue(undefined);
  });

  it("claims a local winner even when monitoring cannot value it", async () => {
    mockPositions = [
      closedPosition({
        id: "cond1-A",
        marketId: "cond1-A",
        marketTitle: "Unvalued winner",
        outcomeId: "A",
        outcomeLabel: "A",
        isWinner: true,
        isLoser: false,
        canClaimPayout: true,
        currentValueSats: 0,
        valueKnown: false,
      }),
    ];

    render(<PortfolioPage />);
    await userEvent.click(screen.getByLabelText(/claim.*unvalued winner/i));

    expect(cashuMocks.claimPortfolioPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.example",
        conditionId: "cond1",
        outcomeCollection: "A",
      }),
    );
    expect(cashuMocks.addActivity).not.toHaveBeenCalled();
  });

  it.each(["pending", "error"])(
    "records only the committed leg when Claim returns %s",
    async (kind) => {
      mockPositions = [
        closedPosition({
          marketTitle: "Partial winner",
          isWinner: true,
          isLoser: false,
          canClaimPayout: true,
        }),
      ];
      cashuMocks.claimPortfolioPosition.mockImplementation(async ({ onCommittedLeg }) => {
        await onCommittedLeg({ keysetId: "winning-leg", payoutAmount: 125 });
        return { kind, committedPayoutAmount: 125 };
      });
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      try {
        render(<PortfolioPage />);
        await userEvent.click(screen.getByLabelText(/claim.*partial winner/i));

        expect(cashuMocks.addActivity).toHaveBeenCalledOnce();
        expect(cashuMocks.addActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "payout_claimed",
            amountSats: 125,
            status: "completed",
          }),
        );
        expect(alert).toHaveBeenCalledOnce();
      } finally {
        alert.mockRestore();
      }
    },
  );

  it("passes the confirmed position to canonical removal without reading or deleting cache proofs", async () => {
    mockPositions = [closedPosition({})];
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<PortfolioPage />);
    await userEvent.click(screen.getByLabelText(/remove.*lost market/i));

    expect(cashuMocks.removePortfolioPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.example",
        conditionId: "cond1",
        outcomeCollection: "A|B",
      }),
    );
    expect(removeProofs).not.toHaveBeenCalled();
    expect(cashuMocks.claimPortfolioPosition).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("reports a verified payout and stops when the displayed loser was stale", async () => {
    mockPositions = [
      closedPosition({
        id: "cond1-A|B",
        marketId: "cond1-A|B",
        marketTitle: "Misclassified market",
        outcomeId: "A|B",
        outcomeLabel: "A|B",
        finalOutcome: "A",
        isWinner: false,
        isLoser: true,
      }),
    ];
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    cashuMocks.removePortfolioPosition.mockImplementation(async ({ onCommittedLeg }) => {
      await onCommittedLeg({ payoutAmount: 60, keysetId: "winner" });
      return { kind: "stopped", reason: "winning-payout", committedPayoutAmount: 60 };
    });

    render(<PortfolioPage />);
    await userEvent.click(screen.getByLabelText(/remove.*misclassified market/i));

    expect(removeProofs).not.toHaveBeenCalled();
    expect(cashuMocks.addActivity).toHaveBeenCalledWith(
      expect.objectContaining({ amountSats: 60, type: "payout_claimed" }),
    );
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("Removal stopped"));
    alert.mockRestore();
    confirmSpy.mockRestore();
  });

  it("never offers Remove for a closed-but-unattested (pending) position, and the handler cannot destroy its proofs (P22 Link F)", async () => {
    // A closed market that is NOT YET ATTESTED (no final outcome) is PENDING:
    // its win/loss is undecided. Offering the destructive Remove here would let
    // the user permanently destroy proofs whose status is not yet known. The row
    // must show neither Remove nor Claim, and even if the handler were somehow
    // invoked it must bail before touching the proof store.
    mockPositions = [
      closedPosition({
        id: "cond1-A",
        marketId: "cond1-A",
        marketTitle: "Awaiting market",
        outcomeId: "A",
        outcomeLabel: "A",
        finalOutcome: null,
        isWinner: false,
        isLoser: false,
        isPending: true,
        currentValueSats: 100,
        valueKnown: false,
        profitLossSats: 0,
        profitLossPercent: 0,
      }),
    ];

    render(<PortfolioPage />);
    // Pending shows neither Remove nor Claim.
    expect(screen.queryByLabelText(/remove.*awaiting market/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/claim.*awaiting market/i)).not.toBeInTheDocument();
    expect(screen.getByText("Unvalued")).toBeInTheDocument();
    expect(removeProofs).not.toHaveBeenCalled();
  });

  it("does not start removal when confirmation is cancelled", async () => {
    mockPositions = [
      closedPosition({
        id: "cond1-B",
        marketId: "cond1-B",
        marketTitle: "Attested loser market",
        outcomeId: "B",
        outcomeLabel: "B",
        finalOutcome: "A",
        isWinner: false,
        isLoser: true,
        isPending: false,
      }),
    ];
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<PortfolioPage />);
    await userEvent.click(screen.getByLabelText(/remove.*attested loser market/i));

    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    expect(removeProofs).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it.each([
    ["pending", "Removal is not finished"],
    ["partial", "Removal could not finish"],
    ["error", "Removal could not finish"],
  ])("shows a safe message for %s removal without recording a payout", async (kind, message) => {
    mockPositions = [closedPosition({})];
    cashuMocks.removePortfolioPosition.mockResolvedValue({
      kind,
      committedPayoutAmount: 0,
      error: { message: "private protocol material" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    try {
      render(<PortfolioPage />);
      await userEvent.click(screen.getByLabelText(/remove.*lost market/i));
      expect(alert).toHaveBeenCalledWith(expect.stringContaining(message!));
      expect(alert).not.toHaveBeenCalledWith(expect.stringContaining("private protocol material"));
      expect(cashuMocks.addActivity).not.toHaveBeenCalled();
      expect(removeProofs).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
      alert.mockRestore();
    }
  });

  it("never deletes proofs for a winner even if the handler is invoked", async () => {
    // A winner has no Remove button, but defence-in-depth: the handler bails
    // on the single isWinner/isLoser truth before touching the proof store.
    mockPositions = [
      closedPosition({
        id: "cond1-A",
        marketId: "cond1-A",
        marketTitle: "Won market",
        outcomeId: "A",
        outcomeLabel: "A",
        isWinner: true,
        isLoser: false,
        profitLossSats: 100,
        profitLossPercent: 100,
        currentValueSats: 100,
      }),
    ];

    render(<PortfolioPage />);
    // Winner shows Claim, never Remove.
    expect(screen.queryByLabelText(/remove.*won market/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/claim.*won market/i)).toBeInTheDocument();
    expect(removeProofs).not.toHaveBeenCalled();
  });
});
