import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Position } from "@/types/portfolio";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";

// --- mocks -----------------------------------------------------------------

const removeProofs = vi.fn().mockResolvedValue(undefined);
const cashuMocks = vi.hoisted(() => {
  const walletListeners = new Set<
    (current: { mnemonic: string }, previous: { mnemonic: string }) => void
  >();
  const walletState = new Proxy(
    { mnemonic: "fresh fake wallet seed" },
    {
      set(target, property, value) {
        const previous = { ...target };
        Reflect.set(target, property, value);
        walletListeners.forEach((listener) => listener({ ...target }, previous));
        return true;
      },
    },
  );
  return {
    claimPortfolioPosition: vi.fn(),
    removePortfolioPosition: vi.fn(),
    addActivity: vi.fn(),
    walletState,
    walletListeners,
  };
});

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

vi.mock("@/stores/settings", () => {
  const state = { nostrSignerMode: "none", nostrProfile: null, relays: [] };
  return {
    useSettingsStore: Object.assign((selector: (s: unknown) => unknown) => selector(state), {
      getState: () => state,
      subscribe: () => () => {},
    }),
  };
});

vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (s: unknown) => unknown) =>
    selector({ items: [], addActivity: cashuMocks.addActivity }),
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => cashuMocks.walletState,
    subscribe: (
      listener: (current: { mnemonic: string }, previous: { mnemonic: string }) => void,
    ) => {
      cashuMocks.walletListeners.add(listener);
      return () => cashuMocks.walletListeners.delete(listener);
    },
  },
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => cashuMocks.walletState.mnemonic,
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
    marketImageUrl: "/test-market.svg",
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

type Operation = "claim" | "remove";
const coordinator = (operation: Operation) =>
  operation === "claim" ? cashuMocks.claimPortfolioPosition : cashuMocks.removePortfolioPosition;
function positionFor(operation: Operation, overrides: Partial<Position> = {}) {
  return closedPosition({
    isWinner: operation === "claim",
    isLoser: operation === "remove",
    canClaimPayout: operation === "claim",
    ...overrides,
  });
}
const removalConfirmation = () => screen.getByTestId("position-removal-confirmation");
const actionDialog = () => screen.getByRole("dialog", { name: "Position action" });
async function startAction(operation: Operation, confirm = true) {
  await userEvent.click(
    screen.getByLabelText(
      operation === "claim" ? /claim payout for/i : /remove losing position for/i,
    ),
  );
  if (operation === "remove" && confirm) {
    await userEvent.click(within(removalConfirmation()).getByRole("button", { name: "Remove" }));
  }
}
function expectCommittedPayout(amount = 125) {
  expect(cashuMocks.addActivity).toHaveBeenCalledOnce();
  expect(cashuMocks.addActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      walletId: "a".repeat(64),
      type: "payout_claimed",
      amountSubunits: amount,
      status: "completed",
    }),
  );
}
const claimFailure = {
  code: "claim-failed",
  category: "counter-readiness",
  message: "private protocol material",
  attemptRef: "claim-attempt-456",
  operationRef: "operation-789",
};
const removeFailure = {
  code: "remove-failed",
  stage: "local-commit",
  attemptRef: "remove-attempt",
  message: "private protocol material",
};

describe("PortfolioPage position action dialogs", () => {
  beforeEach(() => {
    cashuMocks.walletState.mnemonic = "fresh fake wallet seed";
    for (const operation of ["claim", "remove"] as const) {
      coordinator(operation).mockReset();
      coordinator(operation).mockResolvedValue({ kind: "completed", committedPayoutAmount: 0 });
    }
    cashuMocks.addActivity.mockReset();
    removeProofs.mockReset();
    removeProofs.mockResolvedValue(undefined);
    mockPositions = [closedPosition({})];
  });

  it.each(["claim", "remove"] as const)(
    "shows %s progress and keeps a late committed payout under its captured wallet",
    async (operation) => {
      mockPositions = [positionFor(operation)];
      let commit!: (leg: { keysetId: string; payoutAmount: number }) => void;
      let finish!: (result: { kind: "pending"; committedPayoutAmount: number }) => void;
      coordinator(operation).mockImplementationOnce(({ onCommittedLeg }) => {
        commit = onCommittedLeg;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const view = render(<PortfolioPage />);
      await startAction(operation);
      expect(screen.getByRole("status")).toHaveTextContent(
        operation === "claim" ? "Claiming your payout" : "Removing the position",
      );
      // A repeated action must not start another coordinator.
      if (operation === "claim") await userEvent.click(screen.getByLabelText(/claim payout for/i));
      else expect(screen.queryByLabelText(/remove losing position for/i)).not.toBeInTheDocument();
      expect(coordinator(operation)).toHaveBeenCalledOnce();
      cashuMocks.walletState.mnemonic = "other fake wallet seed";
      view.rerender(<PortfolioPage />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      await act(async () => {
        commit({ keysetId: "winning-leg", payoutAmount: 125 });
        finish({ kind: "pending", committedPayoutAmount: 125 });
      });
      expectCommittedPayout();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("keeps slow removal in place and synchronously rejects duplicate confirmation", async () => {
    let finish!: (value: { kind: string; committedPayoutAmount: number }) => void;
    cashuMocks.removePortfolioPosition.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PortfolioPage />);
    await startAction("remove", false);
    const confirm = within(removalConfirmation()).getByRole("button", { name: "Remove" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(cashuMocks.removePortfolioPosition).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Removing the position");
    await act(async () => finish({ kind: "completed", committedPayoutAmount: 0 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("invalidates confirmation across batched wallet A to B to A", async () => {
    render(<PortfolioPage />);
    await startAction("remove", false);
    const confirm = within(removalConfirmation()).getByRole("button", { name: "Remove" });
    act(() => {
      cashuMocks.walletState.mnemonic = "other fake wallet seed";
      cashuMocks.walletState.mnemonic = "fresh fake wallet seed";
      fireEvent.click(confirm);
    });
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId("position-removal-confirmation")).not.toBeInTheDocument();
  });

  it.each(["claim", "remove"] as const)(
    "keeps a newer operation busy after stale %s completion",
    async (kind) => {
      mockPositions = [positionFor(kind)];
      const finish: Array<(value: { kind: string; committedPayoutAmount: number }) => void> = [];
      coordinator(kind).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
      render(<PortfolioPage />);
      await startAction(kind);
      act(() => {
        cashuMocks.walletState.mnemonic = "other fake wallet seed";
        cashuMocks.walletState.mnemonic = "fresh fake wallet seed";
      });
      await startAction(kind);
      expect(coordinator(kind)).toHaveBeenCalledTimes(2);
      await act(async () => finish[0]({ kind: "pending", committedPayoutAmount: 0 }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        kind === "claim" ? "Claiming your payout" : "Removing the position",
      );
      await act(async () => finish[1]({ kind: "completed", committedPayoutAmount: 0 }));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("does not publish stale removal feedback after unmount", async () => {
    let finish!: (value: { kind: string; committedPayoutAmount: number }) => void;
    cashuMocks.removePortfolioPosition.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<PortfolioPage />);
    await startAction("remove");
    view.unmount();
    await act(async () => finish({ kind: "pending", committedPayoutAmount: 0 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("claims an unvalued local winner with the exact canonical target", async () => {
    mockPositions = [
      positionFor("claim", {
        id: "cond1-A",
        marketId: "cond1-A",
        outcomeId: "A",
        outcomeLabel: "A",
        currentValueSats: 0,
        valueKnown: false,
      }),
    ];
    render(<PortfolioPage />);
    await startAction("claim");
    expect(cashuMocks.claimPortfolioPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.example",
        conditionId: "cond1",
        outcomeCollection: "A",
      }),
    );
    expect(cashuMocks.addActivity).not.toHaveBeenCalled();
  });

  it("keeps the irreversible deletion warning in the Japanese confirmation", async () => {
    render(
      <I18nextProvider i18n={i18n.cloneInstance({ lng: "ja" })}>
        <PortfolioPage />
      </I18nextProvider>,
    );
    await userEvent.click(screen.getByLabelText(/ハズレのポジションを削除/));
    const dialog = removalConfirmation();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("このハズレのポジションをウォレットから削除しますか？");
    expect(dialog).toHaveTextContent("ローカルの CTF プルーフは削除され、元に戻せません。");
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
  });

  it("passes the explicitly confirmed target to removal without deleting cached proofs", async () => {
    render(<PortfolioPage />);
    await startAction("remove", false);
    expect(removalConfirmation()).toHaveTextContent("cannot be undone");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    await userEvent.click(within(removalConfirmation()).getByRole("button", { name: "Remove" }));
    expect(cashuMocks.removePortfolioPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.example",
        conditionId: "cond1",
        outcomeCollection: "A|B",
      }),
    );
    expect(removeProofs).not.toHaveBeenCalled();
    expect(cashuMocks.claimPortfolioPosition).not.toHaveBeenCalled();
  });

  it.each(["Cancel", "Escape"] as const)(
    "makes no coordinator call after %s",
    async (dismissal) => {
      render(<PortfolioPage />);
      await startAction("remove", false);
      if (dismissal === "Cancel") {
        await userEvent.click(
          within(removalConfirmation()).getByRole("button", { name: "Cancel" }),
        );
      } else {
        fireEvent.keyDown(removalConfirmation(), { key: "Escape" });
      }
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
      expect(cashuMocks.claimPortfolioPosition).not.toHaveBeenCalled();
      expect(removeProofs).not.toHaveBeenCalled();
    },
  );

  it("discards an open confirmation when the wallet changes, even if it later changes back", async () => {
    const view = render(<PortfolioPage />);
    await startAction("remove", false);
    const staleConfirm = within(removalConfirmation()).getByRole("button", {
      name: "Remove",
    });
    cashuMocks.walletState.mnemonic = "other fake wallet seed";
    // A click before React sees the new wallet must also be fenced.
    fireEvent.click(staleConfirm);
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    view.rerender(<PortfolioPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    cashuMocks.walletState.mnemonic = "fresh fake wallet seed";
    view.rerender(<PortfolioPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
  });

  it.each([
    { mintUrl: "https://other-mint.example" },
    { marketId: "other-condition-A|B" },
    { outcomeLabel: "B" },
    { isWinner: true },
    { isPending: true },
  ])("revalidates the confirmed position after it changes: %j", async (changed) => {
    const view = render(<PortfolioPage />);
    await startAction("remove", false);
    const confirm = within(removalConfirmation()).getByRole("button", { name: "Remove" });
    mockPositions = [closedPosition(changed)];
    view.rerender(<PortfolioPage />);
    if (screen.queryByTestId("position-removal-confirmation"))
      await userEvent.click(within(removalConfirmation()).getByRole("button", { name: "Remove" }));
    else fireEvent.click(confirm);
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
    expect(removeProofs).not.toHaveBeenCalled();
  });

  it.each(["claim", "remove"] as const)(
    "shows safe copyable %s failure details until explicit dismissal, without expiry",
    async (operation) => {
      mockPositions = [positionFor(operation)];
      coordinator(operation).mockResolvedValue({
        kind: "error",
        committedPayoutAmount: 0,
        error:
          operation === "claim" ? claimFailure : { ...removeFailure, stage: "claim", claimFailure },
      });
      const view = render(<PortfolioPage />);
      await startAction(operation);
      const message = within(actionDialog()).getByText(
        /Wallet counter recovery for this keyset is incomplete/,
      );
      expect(message).toHaveClass("select-text", "whitespace-pre-wrap");
      expect(message).toHaveTextContent("Claim reference: claim-attempt-456");
      expect(message).toHaveTextContent("Saved operation: operation-789");
      if (operation === "remove")
        expect(message).toHaveTextContent("Removal reference: claim: remove-attempt");
      expect(actionDialog()).not.toHaveTextContent("private protocol material");
      vi.useFakeTimers();
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        view.rerender(<PortfolioPage />);
        expect(actionDialog()).toHaveTextContent("claim-attempt-456");
      } finally {
        vi.useRealTimers();
      }
      await userEvent.click(within(actionDialog()).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(cashuMocks.addActivity).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "error"] as const)(
    "records only the committed Claim leg for %s",
    async (kind) => {
      mockPositions = [positionFor("claim")];
      cashuMocks.claimPortfolioPosition.mockImplementation(async ({ onCommittedLeg }) => {
        await onCommittedLeg({ keysetId: "winning-leg", payoutAmount: 125 });
        return { kind, committedPayoutAmount: 125, error: claimFailure };
      });
      render(<PortfolioPage />);
      await startAction("claim");
      expectCommittedPayout();
      expect(actionDialog()).toHaveTextContent(
        kind === "error" ? "claim-attempt-456" : "The claim is not finished",
      );
    },
  );

  it.each(["completed", "pending"])(
    "shows the unverified oracle warning after a %s Claim until explicit dismissal",
    async (kind) => {
      mockPositions = [positionFor("claim")];
      cashuMocks.claimPortfolioPosition.mockResolvedValue({
        kind,
        committedPayoutAmount: 0,
        oracleEvidence: {
          status: "unverified",
          reason: "unavailable",
          warning:
            "The mint reports this outcome, but we have not verified evidence from the intended oracle.",
        },
      });
      const view = render(<PortfolioPage />);
      await startAction("claim");
      expect(actionDialog()).toHaveTextContent(
        "The mint reports this outcome, but we have not verified evidence from the intended oracle.",
      );
      vi.useFakeTimers();
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        view.rerender(<PortfolioPage />);
        expect(actionDialog()).toHaveTextContent("evidence from the intended oracle");
      } finally {
        vi.useRealTimers();
      }
      await userEvent.click(within(actionDialog()).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it.each(["pending", "error", "stopped", "partial", "completed"] as const)(
    "keeps the oracle warning and committed activity after %s Remove",
    async (kind) => {
      cashuMocks.removePortfolioPosition.mockImplementation(async ({ onCommittedLeg }) => {
        await onCommittedLeg({ payoutAmount: 60, keysetId: "winner" });
        return {
          kind,
          committedPayoutAmount: 60,
          error: kind === "error" || kind === "partial" ? removeFailure : null,
          oracleEvidence: {
            status: "unverified",
            reason: "unavailable",
            warning:
              "The mint reports this outcome, but we have not verified evidence from the intended oracle.",
          },
        };
      });
      const view = render(<PortfolioPage />);
      await startAction("remove");
      expectCommittedPayout(60);
      expect(actionDialog()).toHaveTextContent("evidence from the intended oracle");
      if (kind === "pending") expect(actionDialog()).toHaveTextContent("Removal is not finished");
      if (kind === "stopped") expect(actionDialog()).toHaveTextContent("Removal stopped");
      if (kind === "error" || kind === "partial")
        expect(actionDialog()).toHaveTextContent("local-commit: remove-attempt");
      vi.useFakeTimers();
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        view.rerender(<PortfolioPage />);
        expect(actionDialog()).toHaveTextContent("evidence from the intended oracle");
      } finally {
        vi.useRealTimers();
      }
      await userEvent.click(within(actionDialog()).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expectCommittedPayout(60);
      expect(removeProofs).not.toHaveBeenCalled();
    },
  );

  it("records a verified payout and stops when the displayed loser was stale", async () => {
    cashuMocks.removePortfolioPosition.mockImplementation(async ({ onCommittedLeg }) => {
      await onCommittedLeg({ payoutAmount: 60, keysetId: "winner" });
      return { kind: "stopped", reason: "winning-payout", committedPayoutAmount: 60 };
    });
    render(<PortfolioPage />);
    await startAction("remove");
    expectCommittedPayout(60);
    expect(actionDialog()).toHaveTextContent("Removal stopped");
    expect(removeProofs).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", false, "Removal is not finished"],
    ["partial", false, "Removal is not finished"],
    ["partial", true, "Removal could not finish"],
    ["error", true, "Removal could not finish"],
  ] as const)(
    "shows safe %s removal details (failure=%s) without inventing a payout",
    async (kind, failed, text) => {
      cashuMocks.removePortfolioPosition.mockResolvedValue({
        kind,
        committedPayoutAmount: 0,
        error: failed ? removeFailure : null,
      });
      render(<PortfolioPage />);
      await startAction("remove");
      expect(actionDialog()).toHaveTextContent(text);
      expect(actionDialog()).not.toHaveTextContent("evidence from the intended oracle");
      expect(actionDialog()).not.toHaveTextContent("private protocol material");
      if (failed) expect(actionDialog()).toHaveTextContent("local-commit: remove-attempt");
      expect(cashuMocks.addActivity).not.toHaveBeenCalled();
      expect(removeProofs).not.toHaveBeenCalled();
    },
  );

  it.each(["claim", "remove"] as const)(
    "does not expose a thrown %s protocol error",
    async (operation) => {
      mockPositions = [positionFor(operation)];
      coordinator(operation).mockRejectedValue(new Error("private protocol material cashuAsecret"));
      render(<PortfolioPage />);
      await startAction(operation);
      expect(actionDialog()).toHaveTextContent(
        operation === "claim" ? "The claim did not finish" : "Removal could not finish",
      );
      expect(actionDialog()).not.toHaveTextContent("private protocol material");
      expect(actionDialog()).not.toHaveTextContent("cashuAsecret");
    },
  );

  it("dismisses an old-wallet message on wallet change", async () => {
    cashuMocks.removePortfolioPosition.mockResolvedValue({
      kind: "pending",
      committedPayoutAmount: 0,
    });
    const view = render(<PortfolioPage />);
    await startAction("remove");
    expect(actionDialog()).toHaveTextContent("Removal is not finished");
    cashuMocks.walletState.mnemonic = "other fake wallet seed";
    view.rerender(<PortfolioPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["claim", "remove"] as const)(
    "keeps the durable %s recovery status after the message is dismissed and rerendered",
    async (operation) => {
      mockPositions = [positionFor(operation)];
      coordinator(operation).mockResolvedValue({ kind: "pending", committedPayoutAmount: 0 });
      const view = render(<PortfolioPage />);
      await startAction(operation);
      mockPositions = [
        positionFor(operation, {
          claimRecoveryPending: operation === "claim",
          removalPending: operation === "remove",
        }),
      ];
      view.rerender(<PortfolioPage />);
      await userEvent.click(within(actionDialog()).getByRole("button", { name: "Close" }));
      view.rerender(<PortfolioPage />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        operation === "claim" ? "The claim is not finished" : "Removal is not finished",
      );
      expect(coordinator(operation)).toHaveBeenCalledOnce();
    },
  );

  it.each(["winner", "pending"] as const)("never offers Remove for a %s position", (kind) => {
    mockPositions = [
      closedPosition({
        isWinner: kind === "winner",
        isLoser: false,
        isPending: kind === "pending",
        finalOutcome: kind === "pending" ? null : "A",
        valueKnown: kind !== "pending",
        currentValueSats: kind === "winner" ? 100_000 : 100,
      }),
    ];
    render(<PortfolioPage />);
    expect(screen.queryByLabelText(/remove losing position for/i)).not.toBeInTheDocument();
    if (kind === "winner") {
      expect(screen.getByText("Won")).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "100 sats" })).toBeInTheDocument();
      expect(screen.getByLabelText(/claim payout for/i)).toBeInTheDocument();
    } else {
      expect(screen.queryByLabelText(/claim payout for/i)).not.toBeInTheDocument();
      expect(screen.getByText("Price estimate unavailable")).toBeInTheDocument();
    }
    expect(removeProofs).not.toHaveBeenCalled();
    expect(cashuMocks.removePortfolioPosition).not.toHaveBeenCalled();
  });
});
