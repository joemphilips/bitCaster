import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

// The wallet profile module is real here: these tests change the activation
// and observe how the coordinator follows it.
const mocks = vi.hoisted(() => ({
  recoverBrowserCtfRangeOrders: vi.fn(),
  recoverBrowserDurableOutgoingCashuTransfersInPass: vi.fn(),
  recoverKeysetCountersForMint: vi.fn(),
  recoverPendingTokenReceives: vi.fn(),
  recoverPendingWalletMints: vi.fn(),
  uploadIndexAfterRecovery: vi.fn(),
  resyncBrowserKeysetsInUse: vi.fn(),
  runBrowserSeedPositionRestorePass: vi.fn(),
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

vi.mock("@/lib/browserSeedPositionRestore", () => ({
  releaseBrowserSeedPositionRestoreGate: vi.fn(),
  resyncBrowserKeysetsInUse: mocks.resyncBrowserKeysetsInUse,
  runBrowserSeedPositionRestorePass: mocks.runBrowserSeedPositionRestorePass,
}));

vi.mock("@/lib/browserRecoveryIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browserRecoveryIndex")>()),
  uploadBrowserRecoveryIndexAfterRecovery: mocks.uploadIndexAfterRecovery,
}));

const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const SCOPE_A = browserWalletScopeIdFromMnemonic(MNEMONIC_A);

type RangeResult = { recovered: number; pending: never[] };

describe("useBrowserCtfRangeOrderRecovery wallet activation", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
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
    mocks.resyncBrowserKeysetsInUse.mockResolvedValue({ usedElsewhere: false, retryAtMs: null });
    mocks.runBrowserSeedPositionRestorePass.mockResolvedValue({
      status: "complete",
      retryAtMs: null,
      hintsSettled: true,
    });
    setActiveBrowserWalletProfile(MNEMONIC_A);
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    setActiveBrowserWalletProfile("");
  });

  it("ignores a late result of an earlier activation of the same wallet (A -> B -> A)", async () => {
    const firstRange = blockedRange();
    const secondRange = blockedRange();
    const passEnded = deferred<void>();
    mocks.uploadIndexAfterRecovery.mockImplementation(() => passEnded.resolve());
    mountRecovery();
    await act(() => firstRange.started);

    await act(async () => {
      setActiveBrowserWalletProfile(MNEMONIC_B);
      setActiveBrowserWalletProfile(MNEMONIC_A);
      // The late result arrives before React renders the new activation.
      firstRange.finish();
      await drainMicrotasks();
      expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).not.toHaveBeenCalled();
    });

    // The new activation starts its own pass.
    await act(() => secondRange.started);
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).not.toHaveBeenCalled();
    secondRange.finish();
    await act(() => passEnded.promise);
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).toHaveBeenCalledOnce();
    expect(mocks.uploadIndexAfterRecovery).toHaveBeenCalledExactlyOnceWith(SCOPE_A);
  });

  it("restarts recovery when a failed handoff activates the same wallet again (A -> '' -> A)", async () => {
    const firstRange = blockedRange();
    const passEnded = deferred<void>();
    mocks.uploadIndexAfterRecovery.mockImplementation(() => passEnded.resolve());
    mountRecovery();
    await act(() => firstRange.started);

    // The handoff invalidates the old profile, and the pass stops.
    await act(async () => {
      setActiveBrowserWalletProfile("");
      firstRange.finish();
      await drainMicrotasks();
    });
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).not.toHaveBeenCalled();
    expect(mocks.uploadIndexAfterRecovery).not.toHaveBeenCalled();

    // The handoff fails and restores the same wallet. The props do not change.
    await act(async () => {
      setActiveBrowserWalletProfile(MNEMONIC_A);
    });
    await act(() => passEnded.promise);

    expect(mocks.recoverPendingTokenReceives).toHaveBeenCalledTimes(2);
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2);
    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).toHaveBeenCalledOnce();
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
    expect(mocks.runBrowserSeedPositionRestorePass).toHaveBeenCalledOnce();
    expect(mocks.uploadIndexAfterRecovery).toHaveBeenCalledExactlyOnceWith(SCOPE_A);
  });

  function mountRecovery() {
    unmount = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: MNEMONIC_A,
        walletMintUrls: "https://mint.example",
      }),
    ).unmount;
  }
});

/**
 * Lets a resolved range result reach the next activation check of its pass.
 * The positive assertions after it wait for the pass-end signal instead.
 */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** The next range recovery call blocks until `finish`, and signals its start. */
function blockedRange(): { started: Promise<void>; finish: () => void } {
  const started = deferred<void>();
  const result = deferred<RangeResult>();
  mocks.recoverBrowserCtfRangeOrders.mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, finish: () => result.resolve({ recovered: 0, pending: [] }) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
