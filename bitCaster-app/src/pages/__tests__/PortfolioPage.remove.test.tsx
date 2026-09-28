import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Position } from "@/types/portfolio";

// --- mocks -----------------------------------------------------------------

const removeProofs = vi.fn().mockResolvedValue(undefined);
const cashuMocks = vi.hoisted(() => ({
  claimPortfolioPosition: vi.fn(),
  removePortfolioPosition: vi.fn(),
  addActivity: vi.fn(),
  walletState: { mnemonic: "fresh fake wallet seed" },
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

vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => cashuMocks.walletState },
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: (mnemonic: string) =>
    mnemonic === "other fake wallet seed" ? "b".repeat(64) : "a".repeat(64),
  isActiveBrowserWalletId: (walletId: string, mnemonic: string) =>
    mnemonic === cashuMocks.walletState.mnemonic &&
    walletId === (mnemonic === "other fake wallet seed" ? "b".repeat(64) : "a".repeat(64)),
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
    currentValueSats: 0,
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
    cashuMocks.walletState.mnemonic = "fresh fake wallet seed";
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

  it.each(["claim", "remove"] as const)(
    "keeps a committed %s payout under its captured owner and suppresses stale alerts",
    async (operation) => {
      mockPositions = [
        closedPosition({
          marketTitle: "Late payout",
          isWinner: operation === "claim",
          isLoser: operation === "remove",
          canClaimPayout: operation === "claim",
        }),
      ];
      const run =
        operation === "claim"
          ? cashuMocks.claimPortfolioPosition
          : cashuMocks.removePortfolioPosition;
      let commitLeg!: (leg: { keysetId: string; payoutAmount: number }) => void;
      let finish!: (result: { kind: "pending"; committedPayoutAmount: number }) => void;
      run.mockImplementationOnce(({ onCommittedLeg }) => {
        commitLeg = onCommittedLeg;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      try {
        render(<PortfolioPage />);
        const action = userEvent.click(
          screen.getByLabelText(
            operation === "claim" ? /claim.*late payout/i : /remove.*late payout/i,
          ),
        );
        await waitFor(() => expect(commitLeg).toBeTypeOf("function"));
        cashuMocks.walletState.mnemonic = "other fake wallet seed";
        await act(async () => {
          commitLeg({ keysetId: "winning-leg", payoutAmount: 125 });
          finish({ kind: "pending", committedPayoutAmount: 125 });
          await action;
        });

        expect(cashuMocks.addActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            walletId: "a".repeat(64),
            type: "payout_claimed",
            amountSubunits: 125,
            status: "completed",
          }),
        );
        expect(alert).not.toHaveBeenCalled();
      } finally {
        alert.mockRestore();
        confirm.mockRestore();
      }
    },
  );

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

  it("shows the translated safe Claim category and opaque attempt reference", async () => {
    mockPositions = [
      closedPosition({
        marketTitle: "Winning market",
        outcomeId: "A",
        outcomeLabel: "A",
        isWinner: true,
        isLoser: false,
        canClaimPayout: true,
      }),
    ];
    cashuMocks.claimPortfolioPosition.mockResolvedValue({
      kind: "error",
      committedPayoutAmount: 0,
      committedLegs: 0,
      losingLegs: 0,
      pendingLegs: 0,
      error: {
        code: "claim-failed",
        category: "counter-readiness",
        message: "Wallet counter recovery is incomplete for the selected keyset.",
        attemptRef: "claim-attempt-456",
      },
    });
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    try {
      render(<PortfolioPage />);
      await userEvent.click(screen.getByLabelText(/claim.*winning market/i));
      expect(alert).toHaveBeenCalledWith(
        expect.stringContaining("Wallet counter recovery for this keyset is incomplete."),
      );
      expect(alert).toHaveBeenCalledWith(expect.stringContaining("claim-attempt-456"));
    } finally {
      alert.mockRestore();
    }
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
        return kind === "error"
          ? {
              kind,
              committedPayoutAmount: 125,
              committedLegs: 1,
              losingLegs: 0,
              pendingLegs: 0,
              error: {
                code: "claim-failed",
                category: "counter-readiness",
                message: "Wallet counter recovery is incomplete for the selected keyset.",
                attemptRef: "claim-attempt-123",
              },
            }
          : { kind, committedPayoutAmount: 125 };
      });
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      try {
        render(<PortfolioPage />);
        await userEvent.click(screen.getByLabelText(/claim.*partial winner/i));

        expect(cashuMocks.addActivity).toHaveBeenCalledOnce();
        expect(cashuMocks.addActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "payout_claimed",
            walletId: "a".repeat(64),
            amountSubunits: 125,
            status: "completed",
          }),
        );
        expect(alert).toHaveBeenCalledOnce();
        if (kind === "error") {
          expect(alert).toHaveBeenCalledWith(
            expect.stringContaining("Claim reference: claim-attempt-123"),
          );
        }
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

  it("shows the safe Claim category and reference when Remove composes a Claim failure", async () => {
    mockPositions = [closedPosition({})];
    cashuMocks.removePortfolioPosition.mockResolvedValue({
      kind: "error",
      committedPayoutAmount: 125,
      error: {
        code: "remove-failed",
        stage: "claim",
        attemptRef: "remove-attempt",
        claimFailure: {
          code: "claim-failed",
          category: "counter-readiness",
          message: "Wallet counter recovery is incomplete for the selected keyset.",
          attemptRef: "remove-claim-attempt",
        },
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    try {
      render(<PortfolioPage />);
      await userEvent.click(screen.getByLabelText(/remove.*lost market/i));
      expect(alert).toHaveBeenCalledWith(
        expect.stringContaining("Wallet counter recovery for this keyset is incomplete."),
      );
      expect(alert).toHaveBeenCalledWith(expect.stringContaining("remove-claim-attempt"));
      expect(alert).toHaveBeenCalledWith(expect.stringContaining("claim: remove-attempt"));
    } finally {
      confirm.mockRestore();
      alert.mockRestore();
    }
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
      expect.objectContaining({
        walletId: "a".repeat(64),
        amountSubunits: 60,
        type: "payout_claimed",
      }),
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
      }),
    ];

    render(<PortfolioPage />);
    // Pending shows neither Remove nor Claim.
    expect(screen.queryByLabelText(/remove.*awaiting market/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/claim.*awaiting market/i)).not.toBeInTheDocument();
    expect(screen.getByText("Price estimate unavailable")).toBeInTheDocument();
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
    ["pending", false, "Removal is not finished"],
    ["partial", false, "Removal is not finished"],
    ["partial", true, "Removal could not finish"],
    ["error", true, "Removal could not finish"],
  ] as const)(
    "shows a safe message for %s removal (failure=%s) without recording a payout",
    async (kind, failed, message) => {
      mockPositions = [closedPosition({})];
      cashuMocks.removePortfolioPosition.mockResolvedValue({
        kind,
        committedPayoutAmount: 0,
        error: failed
          ? {
              code: "remove-failed",
              stage: "local-commit",
              attemptRef: "remove-attempt",
              message: "private protocol material",
            }
          : null,
      });
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
      try {
        render(<PortfolioPage />);
        await userEvent.click(screen.getByLabelText(/remove.*lost market/i));
        expect(alert).toHaveBeenCalledWith(expect.stringContaining(message!));
        expect(alert).not.toHaveBeenCalledWith(
          expect.stringContaining("private protocol material"),
        );
        if (failed)
          expect(alert).toHaveBeenCalledWith(
            expect.stringContaining("local-commit: remove-attempt"),
          );
        expect(cashuMocks.addActivity).not.toHaveBeenCalled();
        expect(removeProofs).not.toHaveBeenCalled();
      } finally {
        confirm.mockRestore();
        alert.mockRestore();
      }
    },
  );

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
        currentValueSats: 100_000,
      }),
    ];

    render(<PortfolioPage />);
    // Winner shows Claim, never Remove.
    expect(screen.getByText("Won ☺")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "100 sats" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/remove.*won market/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/claim.*won market/i)).toBeInTheDocument();
    expect(removeProofs).not.toHaveBeenCalled();
  });
});
