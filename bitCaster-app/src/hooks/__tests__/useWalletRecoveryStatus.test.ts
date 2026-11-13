import "fake-indexeddb/auto";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { Portfolio } from "@/components/portfolio/Portfolio";
import type { PortfolioStats } from "@/types/portfolio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletRecoveryStatus } from "@bitcaster/client-sdk/walletRecoveryStatus";
import {
  activeBrowserWalletActivation,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { getWalletRecoveryPassSummary, walletRecoveryTag } from "@/lib/walletRecoveryPassSummary";
import { activateBrowserWalletDatabase, db } from "@/stores/proof-db";
import {
  initialSeedRestoreResyncRow,
  initialSeedRestoreResyncSchedule,
  initialSeedRestoreState,
  seedRestoreDatabase,
  type SeedRestoreKeysetRow,
  type SeedRestoreResyncRow,
  type SeedRestoreStateRow,
} from "@/stores/seed-restore-db";
import { RECOVERY_INDEX_KEYSET_PROGRESS_START } from "@bitcaster/client-sdk/recoveryIndexRestore";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";
import {
  browserWalletRecoveryStatus,
  readWalletRecoveryDurableRows,
  useWalletRecoveryStatus,
} from "../useWalletRecoveryStatus";

// The status reads the real pass summary, written by the real coordinator,
// and the real durable rows in fake IndexedDB. Only the recovery stages and
// the wallet store are replaced.
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

const wallet = vi.hoisted(() => {
  let state = { mnemonic: "", mints: [] as { url: string }[] };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: { mnemonic: string; mints: { url: string }[] }) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: wallet.getState, subscribe: wallet.subscribe },
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
const SCOPE_A = browserWalletScopeIdFromMnemonic(MNEMONIC_A)!;
const MINT_1 = "https://mint-1.example";
const MINT_2 = "https://mint-2.example";
const LATER = Date.now() + 3_600_000;
const KEYSET_A = `01${"aa".repeat(32)}`;

describe("useWalletRecoveryStatus", () => {
  const unmounts: Array<() => void> = [];

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
  });

  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) unmount();
    setActiveBrowserWalletProfile("");
    wallet.set({ mnemonic: "", mints: [] });
    vi.restoreAllMocks();
    const seedRestore = seedRestoreDatabase(SCOPE_A);
    for (const table of seedRestore.tables) await table.clear();
    activateBrowserWalletDatabase(SCOPE_A);
    await db.walletCounterAssociations.clear();
  });

  it("is checking on the first render", async () => {
    await putState(MINT_1, completedState());
    useWallet(MNEMONIC_A, [MINT_1]);

    const status = mountStatus();

    expect(status.current).toEqual({ kind: "checking", tag: currentTag([MINT_1]) });
  });

  it("is unavailable when the durable rows cannot be read", async () => {
    useWallet(MNEMONIC_A, [MINT_1]);
    vi.spyOn(seedRestoreDatabase(SCOPE_A).origins, "get").mockRejectedValue(
      new Error("IndexedDB is closed"),
    );

    const status = mountStatus();

    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "unavailable",
        tag: currentTag([MINT_1]),
        reason: "read-failed",
        retryable: true,
      }),
    );
  });

  it("is unavailable when a durable row has an unknown wait reason", async () => {
    await putState(MINT_1, completedState());
    await putResync(MINT_1, "k1", {
      pendingFromCounter: 0,
      waitReason: "later" as SeedRestoreResyncRow["waitReason"],
    });
    useWallet(MNEMONIC_A, [MINT_1]);

    const status = mountStatus();

    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "unavailable", reason: "read-failed" }),
    );
  });

  it("is profile-unavailable when the wallet mnemonic is not the active profile", () => {
    setActiveBrowserWalletProfile(MNEMONIC_A);
    wallet.set({ mnemonic: "not a wallet seed", mints: [{ url: MINT_1 }] });

    const status = mountStatus();

    expect(status.current).toEqual({
      kind: "unavailable",
      tag: null,
      reason: "profile-unavailable",
      retryable: false,
    });
  });

  it("is checking while one wallet mint has no restore row, and completes with it", async () => {
    await putState(MINT_1, completedState());
    useWallet(MNEMONIC_A, [MINT_1, MINT_2]);
    const status = mountStatus();
    await runPass(`${MINT_1}\n${MINT_2}`);

    expect(status.current.kind).toBe("checking");
    await putState(MINT_2, completedState());
    await waitFor(() => expect(status.current).toMatchObject({ kind: "completed", passSeq: 1 }));
  });

  it("ignores a failed restore row of a removed mint", async () => {
    await putState(MINT_1, completedState());
    await putState(MINT_2, { ...completedState(), failures: 5 });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();

    await runPass(MINT_1);

    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "completed",
        tag: currentTag([MINT_1]),
        passSeq: 1,
        coverage: "full",
      }),
    );
  });

  it("matches a wallet mint URL with a trailing slash to its row", async () => {
    await putState(MINT_1, completedState());
    useWallet(MNEMONIC_A, [`${MINT_1}/`]);
    const status = mountStatus();

    await runPass(`${MINT_1}/`);

    await waitFor(() => expect(status.current).toMatchObject({ kind: "completed", passSeq: 1 }));
  });

  it("is pending for a pending receive of a generated seed", async () => {
    await seedRestoreDatabase(SCOPE_A).origins.put({
      scopeId: SCOPE_A,
      origin: "generated",
      recordedAtMs: 1,
    });
    mocks.recoverPendingTokenReceives.mockResolvedValue({
      pending: 1,
      lastAttemptedOperationId: "receive-1",
    });
    mocks.runBrowserSeedPositionRestorePass.mockResolvedValue({
      status: "skipped",
      retryAtMs: null,
      hintsSettled: true,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();

    await runPass(MINT_1);

    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "pending", reason: "operation" }),
    );
  });

  it("is pending for a pending-proof deferral after a completed conditional restore", async () => {
    await putState(MINT_1, completedState());
    await putResync(MINT_1, "k1", {
      pendingFromCounter: 4,
      waitReason: "pending-proof",
      failures: 1,
      nextAttemptAtMs: LATER,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();

    await runPass(MINT_1);

    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "pending",
        tag: currentTag([MINT_1]),
        reason: "proof-pending",
        retryAtMs: LATER,
      }),
    );
  });

  it("keeps an incomplete counter result pending until its keyset completes", async () => {
    mocks.recoverKeysetCountersForMint.mockResolvedValue({
      scannedKeysets: ["k1"],
      complete: false,
      failed: false,
      pendingKeysets: ["k1"],
    });
    await putState(MINT_1, completedState());
    await putAssociation(MINT_1, "k1", false);
    await putResync(MINT_1, "k1", {
      pendingFromCounter: 2,
      waitReason: "pending-proof",
      failures: 1,
      nextAttemptAtMs: LATER,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({
        kind: "pending",
        reason: "proof-pending",
        retryAtMs: LATER,
      }),
    );

    // The re-sync cleared the marker, but the association is not complete yet.
    await putResync(MINT_1, "k1", {});
    await waitFor(() =>
      expect(status.current).toMatchObject({
        kind: "pending",
        reason: "proof-pending",
        retryAtMs: null,
      }),
    );

    await putAssociation(MINT_1, "k1", true);
    await waitFor(() => expect(status.current).toMatchObject({ kind: "completed", passSeq: 1 }));
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
  });

  it("is pending with its resume time when the start limit denies a restore", async () => {
    mocks.runBrowserSeedPositionRestorePass.mockResolvedValue({
      status: "waiting",
      retryAtMs: LATER,
      hintsSettled: false,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();

    await runPass(MINT_1);

    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "pending",
        tag: currentTag([MINT_1]),
        reason: "start-limit",
        retryAtMs: LATER,
      }),
    );
  });

  it("is unavailable after three receive failures, and completes after a success", async () => {
    mocks.recoverPendingTokenReceives
      .mockRejectedValueOnce(new Error("mint down"))
      .mockRejectedValueOnce(new Error("mint down"))
      .mockRejectedValueOnce(new Error("mint down"));
    await putState(MINT_1, completedState());
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();

    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "pending", reason: "backoff" }),
    );
    await wakePass();
    expect(status.current).toMatchObject({ kind: "pending", reason: "backoff" });
    await wakePass();
    expect(status.current).toEqual({
      kind: "unavailable",
      tag: currentTag([MINT_1]),
      reason: "recovery-failed",
      retryable: true,
    });

    await wakePass();
    expect(status.current).toMatchObject({ kind: "completed", passSeq: 4 });
  });

  it("ignores the summary and the durable snapshot of an earlier activation (A -> B -> A)", async () => {
    await putState(MINT_1, completedState());
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    const coordinator = await runPass(MINT_1);
    await waitFor(() => expect(status.current).toMatchObject({ kind: "completed" }));
    const firstTag = currentTag([MINT_1]);
    const firstSummary = getWalletRecoveryPassSummary();
    coordinator();

    act(() => {
      useWallet(MNEMONIC_B, [MINT_1]);
      useWallet(MNEMONIC_A, [MINT_1]);
    });

    // The summary and the durable read still describe the first activation.
    expect(getWalletRecoveryPassSummary()).toBe(firstSummary);
    expect(status.current).toEqual({ kind: "checking", tag: currentTag([MINT_1]) });

    await runPass(MINT_1);
    const fresh = currentTag([MINT_1]);
    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "completed",
        tag: fresh,
        passSeq: 1,
        coverage: "full",
      }),
    );
    // A kept durable read of the first activation does not complete the new one.
    expect(
      browserWalletRecoveryStatus({
        current: fresh,
        mintUrls: [MINT_1],
        summary: getWalletRecoveryPassSummary(),
        durable: await readWalletRecoveryDurableRows(firstTag, [MINT_1]),
      }),
    ).toEqual({ kind: "checking", tag: fresh });
  });

  it("starts a reload with complete durable rows at checking, and completes after this page's pass", async () => {
    await putState(MINT_1, completedState());
    // A reload starts a new activation with no pass in page memory.
    useWallet(MNEMONIC_A, [MINT_1]);
    const tag = currentTag([MINT_1]);
    const durable = await readWalletRecoveryDurableRows(tag, [MINT_1]);
    expect(
      browserWalletRecoveryStatus({ current: tag, mintUrls: [MINT_1], summary: null, durable }),
    ).toEqual({ kind: "checking", tag });

    const status = mountStatus();
    expect(status.current).toEqual({ kind: "checking", tag });

    await runPass(MINT_1);
    await waitFor(() => expect(status.current).toMatchObject({ kind: "completed", passSeq: 1 }));
  });

  it("completes a wallet with no mints", async () => {
    useWallet(MNEMONIC_A, []);
    const status = mountStatus();

    await runPass("");

    await waitFor(() =>
      expect(status.current).toEqual({
        kind: "completed",
        tag: currentTag([]),
        passSeq: 1,
        coverage: "full",
      }),
    );
  });

  it("maps a scan-budget deferral to pending, and to a failure at its continuation cap", async () => {
    await putState(MINT_1, completedState());
    await putResync(MINT_1, "k1", {
      pendingFromCounter: 3_000,
      waitReason: "scan-budget",
      scanContinuations: 1,
      nextAttemptAtMs: LATER,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "pending", reason: "scan-continues" }),
    );

    await putResync(MINT_1, "k1", {
      pendingFromCounter: 3_000,
      waitReason: "scan-budget",
      scanContinuations: 101,
      failures: 0,
      nextAttemptAtMs: LATER,
    });
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "unavailable", reason: "recovery-failed" }),
    );
  });

  it("maps a due probe to pending, and three probe failures to a failure", async () => {
    await putState(MINT_1, completedState());
    await seedRestoreDatabase(SCOPE_A).resyncSchedules.put({
      ...initialSeedRestoreResyncSchedule(SCOPE_A, MINT_1),
      evidence: 1,
      nextProbeAtMs: LATER,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({
        kind: "pending",
        reason: "probe-due",
        retryAtMs: LATER,
      }),
    );

    await seedRestoreDatabase(SCOPE_A).resyncSchedules.put({
      ...initialSeedRestoreResyncSchedule(SCOPE_A, MINT_1),
      probeFailures: 3,
      nextProbeAtMs: LATER,
    });
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "unavailable", reason: "recovery-failed" }),
    );
  });

  it("maps an admission failure to backoff, and three to a failure", async () => {
    await putState(MINT_1, completedState());
    await putResync(MINT_1, "k1", {
      pendingFromCounter: 0,
      waitReason: "admission-failed",
      failures: 1,
      nextAttemptAtMs: LATER,
    });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({
        kind: "pending",
        reason: "backoff",
        retryAtMs: LATER,
      }),
    );

    await putResync(MINT_1, "k1", {
      pendingFromCounter: 0,
      waitReason: "admission-failed",
      failures: 3,
      nextAttemptAtMs: LATER,
    });
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "unavailable", reason: "recovery-failed" }),
    );
  });

  it("maps a restore that has not finished its first walk to pending, and repeated failures to a failure", async () => {
    await putState(MINT_1, { ...initialSeedRestoreState(SCOPE_A, MINT_1), nextAttemptAtMs: LATER });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({
        kind: "pending",
        reason: "scan-continues",
        retryAtMs: LATER,
      }),
    );

    await putState(MINT_1, { ...completedState(), itemFailures: 3 });
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "unavailable", reason: "recovery-failed" }),
    );
  });

  it.each([
    ["no index", { index: "absent" as const }],
    ["an unavailable index", { index: "unavailable" as const }],
    ["a stop at the counter budget", { budgetStopped: true, initialCompletedAtMs: null }],
  ])("completes a restore with %s with limited coverage", async (_label, fields) => {
    await putState(MINT_1, { ...completedState(), ...fields });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);

    // Empty holdings are not final (ADR-039 "Restore order").
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "completed", coverage: "limited" }),
    );
  });

  it("shows a restore stopped at its budget as a partial result with Retry, not as recovering", async () => {
    await putState(MINT_1, {
      ...completedState(),
      budgetStopped: true,
      initialCompletedAtMs: null,
    });
    // The plan still holds keysets that the budget did not reach.
    await putRestoreKeyset(MINT_1, KEYSET_A, { state: "queued" });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);

    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "completed", coverage: "limited" }),
    );
    const tag = currentTag([MINT_1]);
    const read = { kind: "ok", tag, afterPassSeq: 1, value: [] } as const;
    render(
      createElement(Portfolio, {
        walletState: "ready",
        baseCurrency: "BTC",
        selectedTimeRange: "ALL",
        profile: { displayName: "Anonymous", avatarUrl: null, bio: "" },
        plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
        stats: {
          totalValueSats: 0,
          totalValueKnown: true,
          positionsValueSats: 0,
          positionsValueKnown: true,
          predictionsCount: 0,
        } as PortfolioStats,
        positions: [],
        activity: [],
        funds: [],
        holdings: { funds: read, positions: read },
        createdMarkets: [],
        positionsTab: "active",
      }),
    );

    const result = await screen.findByTestId("seed-restore-result");
    expect(result).toHaveAttribute("data-partial", "true");
    expect(
      within(result).getByText(
        "Some positions may be missing. Use bitcaster wallet recover-seed --all-conditions.",
      ),
    ).toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByTestId("wallet-recovery-status")).toHaveAttribute("data-state", "complete");
  });

  it("keeps a keyset scan pending, and a refused keyset limits the coverage", async () => {
    await putState(MINT_1, completedState());
    await putRestoreKeyset(MINT_1, KEYSET_A, { state: "queued", nextAttemptAtMs: LATER });
    useWallet(MNEMONIC_A, [MINT_1]);
    const status = mountStatus();
    await runPass(MINT_1);
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "pending", reason: "scan-continues" }),
    );

    await putRestoreKeyset(MINT_1, KEYSET_A, { state: "unverifiable" });
    await waitFor(() =>
      expect(status.current).toMatchObject({ kind: "completed", coverage: "limited" }),
    );
  });

  function mountStatus(): { readonly current: WalletRecoveryStatus } {
    const rendered = renderHook(() => useWalletRecoveryStatus());
    unmounts.push(rendered.unmount);
    return rendered.result;
  }

  /** Mounts the coordinator and waits for the end of its first pass. Returns its unmount. */
  async function runPass(walletMintUrls: string): Promise<() => void> {
    const passEnded = nextPassEnd();
    const rendered = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: wallet.getState().mnemonic,
        walletMintUrls,
      }),
    );
    let mounted = true;
    const unmount = () => {
      if (mounted) rendered.unmount();
      mounted = false;
    };
    unmounts.push(unmount);
    await act(() => passEnded);
    return unmount;
  }
});

function useWallet(mnemonic: string, mintUrls: readonly string[]): void {
  setActiveBrowserWalletProfile(mnemonic);
  activateBrowserWalletDatabase(browserWalletScopeIdFromMnemonic(mnemonic)!);
  wallet.set({ mnemonic, mints: mintUrls.map((url) => ({ url })) });
}

function currentTag(mintUrls: readonly string[]) {
  const { scopeId, epoch } = activeBrowserWalletActivation();
  return walletRecoveryTag({ scopeId: scopeId!, epoch }, mintUrls);
}

/** The coordinator resumes the backup at the end of each current pass. */
function nextPassEnd(): Promise<void> {
  return new Promise((resolve) => {
    mocks.uploadIndexAfterRecovery.mockImplementationOnce(() => resolve());
  });
}

async function wakePass(): Promise<void> {
  const passEnded = nextPassEnd();
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await passEnded;
  });
}

function completedState(): SeedRestoreStateRow {
  return {
    ...initialSeedRestoreState(SCOPE_A, MINT_1),
    initialCompletedAtMs: 1,
    hintsDone: true,
    index: "listed",
    planned: true,
  };
}

async function putState(mintUrl: string, state: SeedRestoreStateRow): Promise<void> {
  await seedRestoreDatabase(SCOPE_A).states.put({ ...state, scopeId: SCOPE_A, mintUrl });
}

async function putResync(
  mintUrl: string,
  keysetId: string,
  fields: Partial<SeedRestoreResyncRow>,
): Promise<void> {
  await seedRestoreDatabase(SCOPE_A).resync.put({
    ...initialSeedRestoreResyncRow(SCOPE_A, mintUrl, keysetId),
    ...fields,
  });
}

async function putRestoreKeyset(
  mintUrl: string,
  keysetId: string,
  fields: Partial<SeedRestoreKeysetRow>,
): Promise<void> {
  await seedRestoreDatabase(SCOPE_A).keysets.put({
    scopeId: SCOPE_A,
    mintUrl,
    keysetId,
    schemaVersion: 3,
    source: "listed",
    conditional: null,
    outcomeCollection: null,
    order: 0,
    state: "queued",
    refusal: null,
    progress: RECOVERY_INDEX_KEYSET_PROGRESS_START,
    failures: 0,
    nextAttemptAtMs: 0,
    ...fields,
  });
}

async function putAssociation(mintUrl: string, keysetId: string, complete: boolean) {
  await db.walletCounterAssociations.put({
    scopeId: SCOPE_A,
    normalizedMint: mintUrl,
    unit: "msat",
    keysetId,
    recoveryComplete: complete,
  });
}
