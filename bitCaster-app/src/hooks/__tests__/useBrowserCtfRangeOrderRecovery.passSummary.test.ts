import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeBrowserWalletActivation,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { getWalletRecoveryPassSummary, walletRecoveryTag } from "@/lib/walletRecoveryPassSummary";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

// The coordinator writes the display-only pass summary. The wallet profile
// and the summary are real; the recovery stages are mocks.
const mocks = vi.hoisted(() => ({
  recoverBrowserCtfRangeOrders: vi.fn(),
  recoverBrowserDurableOutgoingCashuTransfersInPass: vi.fn(),
  recoverKeysetCountersForMint: vi.fn(),
  recoverPendingTokenReceives: vi.fn(),
  recoverPendingWalletMints: vi.fn(),
  resumeBackupAfterRecovery: vi.fn(),
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

vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  resumeBrowserEncryptedWalletBackupV2AfterRecovery: mocks.resumeBackupAfterRecovery,
}));

const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SCOPE_A = browserWalletScopeIdFromMnemonic(MNEMONIC_A)!;
const MINT_1 = "https://mint-1.example";
const MINT_2 = "https://mint-2.example";

describe("useBrowserCtfRangeOrderRecovery pass summary", () => {
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
    mocks.recoverKeysetCountersForMint.mockResolvedValue({ scannedKeysets: [], complete: true });
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

  it("writes each stage result before the pass ends, and counts the pass after its last stage", async () => {
    const range = blockedRange();
    const passEnded = nextPassEnd();
    mountRecovery(`${MINT_1}/\n${MINT_2}`);
    await act(() => range.started);

    expect(getWalletRecoveryPassSummary()).toMatchObject({
      tag: currentTag([MINT_1, MINT_2]),
      passSeq: 0,
      wallet: {
        receives: { state: "completed" },
        mints: { state: "completed" },
        rangeOrders: null,
        outgoing: null,
      },
    });

    range.finish();
    await act(() => passEnded);

    const summary = getWalletRecoveryPassSummary()!;
    expect(summary.passSeq).toBe(1);
    expect(summary.wallet).toMatchObject({
      rangeOrders: { state: "completed" },
      outgoing: { state: "completed" },
    });
    expect([...summary.mints.keys()].sort()).toEqual([MINT_1, MINT_2]);
    for (const mint of [MINT_1, MINT_2]) {
      expect(summary.mints.get(mint)).toMatchObject({
        regularCounters: { observation: { state: "completed" } },
        resyncPass: { state: "completed" },
        seedRestorePass: { observation: { state: "completed" } },
      });
    }
  });

  it("drops every summary write of a pass that the activation stopped", async () => {
    const range = blockedRange();
    mountRecovery(MINT_1);
    await act(() => range.started);
    expect(getWalletRecoveryPassSummary()?.wallet.receives).not.toBeNull();

    await act(async () => {
      setActiveBrowserWalletProfile("");
      range.finish();
      await drainMicrotasks();
    });

    expect(mocks.recoverBrowserDurableOutgoingCashuTransfersInPass).not.toHaveBeenCalled();
    expect(getWalletRecoveryPassSummary()).toMatchObject({
      passSeq: 0,
      wallet: { receives: null, mints: null, rangeOrders: null },
    });
  });

  it("records a pending range stage when an attempt defers recovery, and a failed stage", async () => {
    mocks.recoverBrowserCtfRangeOrders.mockResolvedValue({ recovered: 0, pending: ["order"] });
    mocks.recoverBrowserDurableOutgoingCashuTransfersInPass.mockRejectedValue(new Error("offline"));
    const before = Date.now();
    const passEnded = nextPassEnd();
    mountRecovery(MINT_1);
    await act(() => passEnded);

    const { wallet } = getWalletRecoveryPassSummary()!;
    expect(wallet.rangeOrders).toMatchObject({ state: "pending", reason: "operation" });
    expect(wallet.outgoing).toMatchObject({ state: "failed", consecutiveFailures: 1 });
    // The coordinator retries a failed stage after its retry interval.
    expect(wallet.outgoing?.state === "failed" && wallet.outgoing.retryAtMs).toBeGreaterThanOrEqual(
      before + 15_000,
    );
  });

  it("reports a failed wallet stage with its error class name only", async () => {
    class MintTransportError extends Error {
      override name = "MintTransportError";
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mocks.recoverBrowserCtfRangeOrders.mockRejectedValue(
        new MintTransportError("cashuBsecret-token 1234 sat"),
      );
      mocks.recoverBrowserDurableOutgoingCashuTransfersInPass.mockRejectedValue(
        Object.assign(new Error("proof secret"), { name: "proof secret 1234" }),
      );
      const passEnded = nextPassEnd();
      mountRecovery(MINT_1);
      await act(() => passEnded);

      const labels = warn.mock.calls.map((call) => String(call[0]));
      expect(labels).toContain("wallet-recovery-stage-error=rangeOrders error=MintTransportError");
      expect(labels).toContain("wallet-recovery-stage-error=outgoing error=unknown");
      expect(labels.join("\n")).not.toMatch(/secret|cashuB|1234/);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the counter deferral: one counter run, and its keysets in the summary", async () => {
    mocks.recoverKeysetCountersForMint.mockResolvedValue({
      scannedKeysets: ["k1"],
      complete: false,
      failed: false,
      pendingKeysets: ["k1"],
    });
    const passEnded = nextPassEnd();
    mountRecovery(MINT_1);
    await act(() => passEnded);

    expect(getWalletRecoveryPassSummary()?.mints.get(MINT_1)?.regularCounters).toEqual({
      observation: {
        stage: `regularCounters ${MINT_1}`,
        state: "pending",
        reason: "proof-pending",
        retryAtMs: null,
      },
      pendingKeysets: ["k1"],
      postponedKeysets: [],
    });

    const secondPassEnded = nextPassEnd();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await secondPassEnded;
    });
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
    // The second pass did not run the counters, so their result stays.
    const summary = getWalletRecoveryPassSummary()!;
    expect(summary.passSeq).toBe(2);
    expect(summary.mints.get(MINT_1)?.regularCounters?.pendingKeysets).toEqual(["k1"]);
  });

  it("records the seed restore failure of the mint whose pass threw", async () => {
    mocks.runBrowserSeedPositionRestorePass
      .mockResolvedValueOnce({ status: "complete", retryAtMs: null, hintsSettled: true })
      .mockRejectedValueOnce(new Error("mint down"));
    const passEnded = nextPassEnd();
    mountRecovery(`${MINT_1}\n${MINT_2}`);
    await act(() => passEnded);

    const { mints, passSeq } = getWalletRecoveryPassSummary()!;
    expect(passSeq).toBe(1);
    expect(mints.get(MINT_1)?.seedRestorePass?.observation).toMatchObject({ state: "completed" });
    expect(mints.get(MINT_2)?.seedRestorePass?.observation).toMatchObject({
      state: "failed",
      consecutiveFailures: 1,
    });
  });

  function mountRecovery(walletMintUrls: string) {
    unmount = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: MNEMONIC_A,
        walletMintUrls,
      }),
    ).unmount;
  }
});

function currentTag(mintUrls: readonly string[]) {
  const { epoch } = activeBrowserWalletActivation();
  return walletRecoveryTag({ scopeId: SCOPE_A, epoch }, mintUrls);
}

/** The coordinator resumes the backup at the end of each current pass. */
function nextPassEnd(): Promise<void> {
  return new Promise((resolve) => {
    mocks.resumeBackupAfterRecovery.mockImplementationOnce(() => resolve());
  });
}

/** Lets a resolved stage result reach the next activation check of its pass. */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function blockedRange(): { started: Promise<void>; finish: () => void } {
  let signalStart!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  let finish!: () => void;
  const result = new Promise<{ recovered: number; pending: never[] }>((resolve) => {
    finish = () => resolve({ recovered: 0, pending: [] });
  });
  mocks.recoverBrowserCtfRangeOrders.mockImplementationOnce(() => {
    signalStart();
    return result;
  });
  return { started, finish };
}
