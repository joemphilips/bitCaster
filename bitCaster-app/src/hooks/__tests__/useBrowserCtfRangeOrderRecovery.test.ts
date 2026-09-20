import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserCtfRangeOrderAttempt,
  endBrowserCtfRangeOrderAttempt,
  publishBrowserCtfRangeRecoveryWake,
} from "@/lib/browserCtfRangeOrderRecoveryWake";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

const mocks = vi.hoisted(() => ({
  recoverBrowserCtfRangeOrders: vi.fn(),
  recoverBrowserDurableOutgoingCashuTransfersInPass: vi.fn(),
  recoverKeysetCountersForMint: vi.fn(),
  recoverPendingTokenReceives: vi.fn(),
  recoverPendingWalletMints: vi.fn(),
}));

vi.mock("@/lib/cashu", () => ({
  recoverBrowserDurableOutgoingCashuTransfersInPass:
    mocks.recoverBrowserDurableOutgoingCashuTransfersInPass,
  recoverKeysetCountersForMint: mocks.recoverKeysetCountersForMint,
  recoverPendingTokenReceives: mocks.recoverPendingTokenReceives,
  recoverPendingWalletMints: mocks.recoverPendingWalletMints,
}));

vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  recoverBrowserCtfRangeOrders: mocks.recoverBrowserCtfRangeOrders,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => "wallet-scope-a",
}));

describe("useBrowserCtfRangeOrderRecovery", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverPendingTokenReceives.mockResolvedValue({
      pending: 0,
      lastAttemptedOperationId: null,
    });
    mocks.recoverPendingWalletMints.mockResolvedValue({ pending: 0 });
    mocks.recoverBrowserDurableOutgoingCashuTransfersInPass.mockResolvedValue({
      pending: 0,
      hasMore: false,
    });
    mocks.recoverKeysetCountersForMint.mockResolvedValue({ complete: true });
    mocks.recoverBrowserCtfRangeOrders.mockResolvedValue({ recovered: 0, pending: [] });
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.useRealTimers();
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: false,
    });
  });

  it("defers active recovery and wakes the existing scheduler once after failure settles", async () => {
    beginBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
    });
    const mounted = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: "wallet mnemonic",
        walletMintUrls: "https://mint.example",
      }),
    );
    unmount = mounted.unmount;

    await completeInitialPass();
    expect(mocks.recoverBrowserCtfRangeOrders).not.toHaveBeenCalled();

    const recoveryResolvers: Array<(value: { recovered: number; pending: never[] }) => void> = [];
    mocks.recoverBrowserCtfRangeOrders.mockImplementation(
      () =>
        new Promise((resolve) => {
          recoveryResolvers.push(resolve);
        }),
    );

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: true,
    });

    await waitFor(() => expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce());
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledWith({
      mnemonic: "wallet mnemonic",
      mintUrls: ["https://mint.example"],
    });
    publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
    publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    recoveryResolvers[0]!({ recovered: 0, pending: [] });
    await waitFor(() => expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2));
    recoveryResolvers[1]!({ recovered: 0, pending: [] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
  });

  it("resumes deferred recovery after a successful active attempt releases", async () => {
    vi.useFakeTimers();
    beginBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
    });
    const mounted = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: "wallet mnemonic",
        walletMintUrls: "https://mint.example",
      }),
    );
    unmount = mounted.unmount;
    await completeInitialPass();
    expect(mocks.recoverBrowserCtfRangeOrders).not.toHaveBeenCalled();

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
  });

  async function completeInitialPass(): Promise<void> {
    const countersDone = deferred<{ complete: true }>();
    mocks.recoverKeysetCountersForMint.mockReturnValueOnce(countersDone.promise);
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
    countersDone.resolve({ complete: true });
    await act(async () => {
      await countersDone.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
