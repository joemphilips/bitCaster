import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMarketTradeRecovery,
  marketTradeRecoveryStage,
  submittedOrderRecoveryStage,
} from "../useMarketTradeRecovery";
import { usePendingTradesStore, type PendingTrade } from "@/stores/pendingTrades";
import {
  useOrderSettlementObservations,
  type OrderSettlementObservation,
} from "@/stores/orderSettlementObservations";
import type { BrowserTradeRecoveryObservation } from "@/lib/browserTradeRecoveryObservation";

const mocks = vi.hoisted(() => ({ read: vi.fn(), active: vi.fn(), activeScope: "scope-a" }));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: (mnemonic: string) =>
    mnemonic === "a" ? "a".repeat(64) : "b".repeat(64),
  browserWalletScopeIdFromMnemonic: (mnemonic: string) => `scope-${mnemonic}`,
  activeBrowserWalletScopeId: () => mocks.activeScope,
}));
vi.mock("@/stores/ctf-range-order-db", () => ({ hasActiveCtfRangePreparation: mocks.active }));
vi.mock("@/lib/browserTradeRecoveryObservation", () => ({
  readBrowserTradeRecoveryObservation: mocks.read,
}));

function trade(
  orderId = "order-a",
  marketId = "condition-with-dashes-Yes",
  wallet = "a",
): PendingTrade {
  return {
    orderId,
    clientOrderId: `client-${orderId}`,
    marketId,
    walletId: wallet.repeat(64),
    submittedAt: 1,
    baseAsset: "sat",
    divisibility: 1000,
  };
}
function observed(
  status: NonNullable<OrderSettlementObservation["group"]>["status"],
  orderId = "order-a",
): OrderSettlementObservation {
  return {
    walletId: "a".repeat(64),
    signerRevision: 1,
    marketId: "condition-with-dashes-Yes",
    orderId,
    status: "filled",
    group: { status } as OrderSettlementObservation["group"],
  };
}
const input: Parameters<typeof useMarketTradeRecovery>[0] = {
  mnemonic: "a",
  conditionId: "condition-with-dashes",
  signerRevision: 1,
  submittedOrder: null,
};
const submittedHere = {
  orderId: "order-a",
  walletId: "a".repeat(64),
  marketId: "condition-with-dashes-Yes",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.activeScope = "scope-a";
  mocks.active.mockResolvedValue(false);
  mocks.read.mockResolvedValue(null);
  usePendingTradesStore.setState({ byOrderId: {} });
  useOrderSettlementObservations.setState({ byOrderId: {} });
});

describe("market trade recovery presentation", () => {
  it.each([
    [null, null, "order-pending"],
    [null, "Reconciling", "settlement-pending"],
    ["none", "SubmissionPending", "settlement-pending"],
    ["none", "Confirmed", "wallet-recovery"],
    ["verified-staged", "Confirmed", "wallet-recovery"],
    ["applied", "Confirmed", "result-saved"],
    ["applied", "Reconciling", "result-saved"],
    [null, "Confirmed", "unavailable"],
  ] as const)(
    "maps canonical result %s and group %s to %s without inferring spendability",
    (resultState, groupStatus, stage) => {
      const local: BrowserTradeRecoveryObservation | null =
        resultState === null ? null : { lifecycleState: "order-submitted", resultState };
      expect(
        marketTradeRecoveryStage(local, groupStatus === null ? undefined : observed(groupStatus)),
      ).toBe(stage);
    },
  );

  it.each([
    [null, "Confirmed", null],
    ["none", null, null],
    ["none", "SubmissionPending", null],
    ["none", "Confirmed", "wallet-updating"],
    ["none", "DefinitivelyRejected", "wallet-updating"],
    ["verified-staged", "Confirmed", "wallet-updating"],
    ["applied", "Confirmed", "result-saved"],
    ["missing", "Confirmed", "unavailable"],
  ] as const)(
    "maps result %s and group %s of the order submitted here to %s",
    (resultState, groupStatus, stage) => {
      const local: BrowserTradeRecoveryObservation | null =
        resultState === null
          ? null
          : {
              lifecycleState: "order-submitted",
              resultState: resultState === "missing" ? null : resultState,
            };
      expect(
        submittedOrderRecoveryStage(
          local,
          groupStatus === null ? undefined : observed(groupStatus),
        ),
      ).toBe(stage);
    },
  );

  it("names the wallet update of the order submitted here and keeps an earlier recovery", async () => {
    usePendingTradesStore.setState({
      byOrderId: { "order-a": trade(), "order-b": trade("order-b") },
    });
    useOrderSettlementObservations.setState({
      byOrderId: { "order-a": observed("Confirmed"), "order-b": observed("Confirmed", "order-b") },
    });
    mocks.read.mockResolvedValue({
      lifecycleState: "order-submitted",
      resultState: "verified-staged",
    });
    const initialProps: typeof input = { ...input, submittedOrder: submittedHere };
    const { result, rerender } = renderHook((props) => useMarketTradeRecovery(props), {
      initialProps,
    });
    await waitFor(() =>
      expect(result.current.stages).toEqual(["wallet-updating", "wallet-recovery"]),
    );
    const key = result.current.invalidationKey;
    rerender(input);
    expect(result.current.stages).toEqual(["wallet-recovery"]);
    expect(result.current.invalidationKey).toBe(key);
  });

  it.each([
    ["wallet", { walletId: "b".repeat(64) }],
    ["market", { marketId: "condition-with-dashes-No" }],
    ["order", { orderId: "order-other" }],
  ] as const)("treats an order with another %s as an earlier trade", async (_, change) => {
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    useOrderSettlementObservations.setState({ byOrderId: { "order-a": observed("Confirmed") } });
    mocks.read.mockResolvedValue({
      lifecycleState: "order-submitted",
      resultState: "verified-staged",
    });
    const { result } = renderHook(() =>
      useMarketTradeRecovery({ ...input, submittedOrder: { ...submittedHere, ...change } }),
    );
    await waitFor(() => expect(result.current.stages).toEqual(["wallet-recovery"]));
  });

  it("does not call the order submitted here unavailable while its local facts load", async () => {
    let finish!: (value: BrowserTradeRecoveryObservation) => void;
    mocks.read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { result } = renderHook(() =>
      useMarketTradeRecovery({ ...input, submittedOrder: submittedHere }),
    );
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    expect(result.current.stages).toEqual([]);
    expect(result.current.suppressFundingHint).toBe(true);
    await act(async () => finish({ lifecycleState: "order-submitted", resultState: "applied" }));
    await waitFor(() => expect(result.current.stages).toEqual(["result-saved"]));
  });

  it("keeps a local read failure visible for the order submitted here", async () => {
    mocks.read.mockRejectedValue(new Error("local read failed"));
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { result } = renderHook(() =>
      useMarketTradeRecovery({ ...input, submittedOrder: submittedHere }),
    );
    await waitFor(() => expect(result.current.stages).toEqual(["unavailable"]));
  });

  it("reads only exact pending orders for the current wallet and parsed condition", async () => {
    const selected = trade();
    const foreign = trade("foreign", "other-Yes");
    const foreignWallet = trade("wallet-b", "condition-with-dashes-Yes", "b");
    usePendingTradesStore.setState({
      byOrderId: {
        [selected.orderId]: selected,
        [foreign.orderId]: foreign,
        [foreignWallet.orderId]: foreignWallet,
      },
    });
    mocks.read.mockResolvedValue({ lifecycleState: "order-submitted", resultState: "applied" });
    const { result } = renderHook(() => useMarketTradeRecovery(input));
    await waitFor(() => expect(result.current.stages).toEqual(["result-saved"]));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(
      { scopeKind: "wallet", walletId: "a".repeat(64), scopeId: "scope-a" },
      selected,
    );
    expect(result.current.suppressFundingHint).toBe(true);
  });

  it("does not attribute active pre-admission work to this market", async () => {
    mocks.active.mockResolvedValue(true);
    const { result } = renderHook(() => useMarketTradeRecovery(input));
    await waitFor(() => expect(mocks.active).toHaveBeenCalledWith("scope-a"));
    expect(result.current.stages).toEqual([]);
    expect(result.current.suppressFundingHint).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("ignores old signer observations and duplicate facts keep the same invalidation key", async () => {
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    useOrderSettlementObservations.setState({ byOrderId: { "order-a": observed("Reconciling") } });
    const { result, rerender } = renderHook((props) => useMarketTradeRecovery(props), {
      initialProps: input,
    });
    await waitFor(() => expect(result.current.stages).toEqual(["settlement-pending"]));
    const key = result.current.invalidationKey;
    act(() =>
      useOrderSettlementObservations.setState({
        byOrderId: { "order-a": { ...observed("Reconciling") } },
      }),
    );
    expect(result.current.invalidationKey).toBe(key);
    rerender({ ...input, signerRevision: 2 });
    await waitFor(() => expect(result.current.stages).toEqual(["order-pending"]));
  });

  it("discards an old wallet read after handoff and after disposal", async () => {
    let finish!: (value: BrowserTradeRecoveryObservation) => void;
    mocks.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { result, rerender, unmount } = renderHook((props) => useMarketTradeRecovery(props), {
      initialProps: input,
    });
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    mocks.activeScope = "scope-b";
    rerender({ ...input, mnemonic: "b" });
    await act(async () => finish({ lifecycleState: "order-submitted", resultState: "applied" }));
    expect(result.current.stages).toEqual([]);
    expect(result.current.invalidationKey).not.toContain("order-a");
    unmount();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not publish a deferred local result after in-flight disposal", async () => {
    let finish!: (value: BrowserTradeRecoveryObservation) => void;
    mocks.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const renders = vi.fn();
    const { unmount } = renderHook(() => {
      const display = useMarketTradeRecovery(input);
      renders(display);
      return display;
    });
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    unmount();
    const before = renders.mock.calls.length;
    await act(async () => finish({ lifecycleState: "order-submitted", resultState: "applied" }));
    expect(renders).toHaveBeenCalledTimes(before);
  });

  it("does not start exact order reads after disposal during the active-scope check", async () => {
    let finish!: (value: boolean) => void;
    mocks.active.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { unmount } = renderHook(() => useMarketTradeRecovery(input));
    await waitFor(() => expect(mocks.active).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => finish(true));
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("completion changes the estimate key and clears the hint suppression after the local query", async () => {
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { result } = renderHook(() => useMarketTradeRecovery(input));
    await waitFor(() => expect(result.current.stages).toEqual(["order-pending"]));
    const previous = result.current.invalidationKey;
    act(() => usePendingTradesStore.setState({ byOrderId: {} }));
    await waitFor(() => expect(result.current.suppressFundingHint).toBe(false));
    expect(result.current.invalidationKey).not.toBe(previous);
    expect(result.current.stages).toEqual([]);
  });

  it("local read refusal stays truthful and does not grant market funding advice", async () => {
    mocks.read.mockRejectedValue(new Error("local read failed"));
    usePendingTradesStore.setState({ byOrderId: { "order-a": trade() } });
    const { result } = renderHook(() => useMarketTradeRecovery(input));
    await waitFor(() => expect(result.current.invalidationKey).toContain("unavailable"));
    expect(result.current.stages).toEqual(["unavailable"]);
    expect(result.current.suppressFundingHint).toBe(true);
  });
});
