import { StrictMode } from "react";
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
  resumeBackupAfterRecovery: vi.fn(),
  activeScope: "wallet-scope-a" as string | null,
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

vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  resumeBrowserEncryptedWalletBackupV2AfterRecovery: mocks.resumeBackupAfterRecovery,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: (mnemonic: string) =>
    mnemonic === "wallet B mnemonic" ? "wallet-scope-b" : "wallet-scope-a",
  activeBrowserWalletScopeId: () => mocks.activeScope,
}));

describe("useBrowserCtfRangeOrderRecovery", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activeScope = "wallet-scope-a";
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
    expect(mocks.resumeBackupAfterRecovery).toHaveBeenCalledWith("wallet-scope-a");

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

  it("resumes deferred recovery immediately after a successful active attempt releases", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
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
    expect(mocks.resumeBackupAfterRecovery).toHaveBeenCalledWith("wallet-scope-a");

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: false,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(Date.now()).toBe(startedAt);
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
  });

  it("coalesces burst wakes into one single-flight follow-up and clears the fallback", async () => {
    vi.useFakeTimers();
    const blocked = deferred<{ recovered: number; pending: never[] }>();
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.recoverBrowserCtfRangeOrders
      .mockImplementationOnce(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const result = await blocked.promise;
        inFlight -= 1;
        return result;
      })
      .mockImplementation(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        inFlight -= 1;
        return { recovered: 1, pending: [] };
      });
    mountRecovery();
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    for (let index = 0; index < 20; index += 1) {
      publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
    }
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    blocked.resolve({ recovered: 0, pending: [] });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
  });

  it("keeps the fallback after a failed wake pass and cancels it on a successful wake", async () => {
    vi.useFakeTimers();
    const blocked = deferred<{ recovered: number; pending: { operationId: string }[] }>();
    mocks.recoverBrowserCtfRangeOrders
      .mockReturnValueOnce(blocked.promise)
      .mockRejectedValueOnce(new Error("mint unavailable"));
    mountRecovery();
    await flush();
    publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
    blocked.resolve({ recovered: 0, pending: [{ operationId: "pending" }] });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(3);
  });

  it("waits for the last of two successful attempts before recovering deferred work", async () => {
    vi.useFakeTimers();
    beginBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
    });
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-scope-a", operationId: "second" });
    mountRecovery();
    await flush();
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "second",
      retainedRecoveryWork: false,
    });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).not.toHaveBeenCalled();
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: false,
    });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
  });

  it("ignores a wake from another scope and success without deferred work", async () => {
    mountRecovery();
    await flush();
    beginBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
    });
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-scope-a",
      operationId: "app-recovery-attempt",
      retainedRecoveryWork: false,
    });
    publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-b" });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
  });

  it.each(["receive", "mint", "range", "outgoing", "counter"] as const)(
    "does not start subsequent wallet helpers after disposal during %s recovery",
    async (stage) => {
      const blocked = deferred<ReturnType<typeof recoveryResult>>();
      const helpers = [
        mocks.recoverPendingTokenReceives,
        mocks.recoverPendingWalletMints,
        mocks.recoverBrowserCtfRangeOrders,
        mocks.recoverBrowserDurableOutgoingCashuTransfersInPass,
        mocks.recoverKeysetCountersForMint,
      ];
      const index = ["receive", "mint", "range", "outgoing", "counter"].indexOf(stage);
      helpers[index]!.mockReturnValueOnce(blocked.promise);
      mountRecovery("https://mint.example\nhttps://second.example");
      await flush();
      expect(helpers[index]).toHaveBeenCalledOnce();
      publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
      unmount?.();
      unmount = undefined;
      blocked.resolve(recoveryResult(stage));
      await flush();
      for (const helper of helpers.slice(index + 1)) expect(helper).not.toHaveBeenCalled();
      if (stage === "counter") expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
      expect(mocks.resumeBackupAfterRecovery).not.toHaveBeenCalled();
    },
  );

  it.each(["range", "outgoing", "counter"] as const)(
    "does not resume active-wallet helpers after profile invalidation during %s recovery",
    async (stage) => {
      const blocked = deferred<ReturnType<typeof recoveryResult>>();
      const helper =
        stage === "range"
          ? mocks.recoverBrowserCtfRangeOrders
          : stage === "outgoing"
            ? mocks.recoverBrowserDurableOutgoingCashuTransfersInPass
            : mocks.recoverKeysetCountersForMint;
      helper.mockReturnValueOnce(blocked.promise);
      mountRecovery("https://mint.example\nhttps://second.example");
      await flush();
      expect(helper).toHaveBeenCalledOnce();
      mocks.activeScope = null;
      blocked.resolve(recoveryResult(stage));
      await flush();
      if (stage === "range")
        expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).not.toHaveBeenCalled();
      if (stage !== "counter") expect(mocks.recoverKeysetCountersForMint).not.toHaveBeenCalled();
      else expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
      expect(mocks.resumeBackupAfterRecovery).not.toHaveBeenCalled();
    },
  );

  it("drops queued old-wallet recovery on handoff while the new wallet completes", async () => {
    const blocked = deferred<{ recovered: number; pending: never[] }>();
    mocks.recoverBrowserCtfRangeOrders.mockReturnValueOnce(blocked.promise);
    const mounted = renderHook(
      ({ mnemonic }) =>
        useBrowserCtfRangeOrderRecovery({
          nostrSignerReady: true,
          walletMnemonic: mnemonic,
          walletMintUrls: "https://mint.example",
        }),
      { initialProps: { mnemonic: "wallet mnemonic" } },
    );
    unmount = mounted.unmount;
    await flush();
    publishBrowserCtfRangeRecoveryWake({ scopeId: "wallet-scope-a" });
    mocks.activeScope = "wallet-scope-b";
    mounted.rerender({ mnemonic: "wallet B mnemonic" });
    await flush();
    blocked.resolve({ recovered: 0, pending: [] });
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).toHaveBeenCalledOnce();
    expect(mocks.resumeBackupAfterRecovery).toHaveBeenCalledExactlyOnceWith("wallet-scope-b");
  });

  it("does not resume a cancelled StrictMode pass after its replacement completes", async () => {
    const blocked = deferred<{ pending: number; lastAttemptedOperationId: null }>();
    mocks.recoverPendingTokenReceives.mockReturnValueOnce(blocked.promise);
    unmount = renderHook(
      () =>
        useBrowserCtfRangeOrderRecovery({
          nostrSignerReady: true,
          walletMnemonic: "wallet mnemonic",
          walletMintUrls: "https://mint.example",
        }),
      { wrapper: StrictMode },
    ).unmount;
    await flush();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    blocked.resolve({ pending: 0, lastAttemptedOperationId: null });
    await flush();
    expect(mocks.recoverPendingWalletMints).toHaveBeenCalledOnce();
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce();
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).toHaveBeenCalledOnce();
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
  });

  function mountRecovery(walletMintUrls = "https://mint.example") {
    unmount = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: "wallet mnemonic",
        walletMintUrls,
      }),
    ).unmount;
  }

  async function flush() {
    await act(async () => {});
  }

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

function recoveryResult(stage: string) {
  return stage === "range"
    ? { recovered: 0, pending: [] }
    : { pending: 0, lastAttemptedOperationId: null, complete: true, hasMore: false };
}
