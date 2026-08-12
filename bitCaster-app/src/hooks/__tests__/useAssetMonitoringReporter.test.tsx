import { act, renderHook } from "@testing-library/react";
import type { Transaction } from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HookEvent = "creating" | "updating" | "deleting";
type HookListener = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const listeners = new Map<HookEvent, Set<HookListener>>([
    ["creating", new Set()],
    ["updating", new Set()],
    ["deleting", new Set()],
  ]);
  const walletState = { mnemonic: "wallet-a" };
  const signerSubscribers = new Set<() => void>();
  const state = {
    activeScopeId: "scope-wallet-a" as string | null,
    signer: {} as object | undefined,
    signerRevision: 0,
    database: null as unknown,
    reporters: [] as MockReporter[],
  };

  class MockReporter {
    readonly request = vi.fn();
    readonly stop = vi.fn();
    constructor(
      readonly input: {
        isCurrent: () => boolean;
        buildHoldings: () => Promise<unknown>;
      },
    ) {
      state.reporters.push(this);
    }
  }

  const hook = vi.fn((event: HookEvent, listener?: HookListener) => {
    const subscribers = listeners.get(event)!;
    if (listener) {
      subscribers.add(listener);
      return undefined;
    }
    return { unsubscribe: (candidate: HookListener) => subscribers.delete(candidate) };
  });

  return {
    MockReporter,
    hook,
    listeners,
    state,
    walletState,
    fetchAssetMonitoringCatalogue: vi.fn(),
    buildAssetMonitoringHoldings: vi.fn(),
    createAuthenticatedBrowserEngineClient: vi.fn(),
    hasSubmittedCtfRangeOrder: vi.fn(),
    reset: () => {
      walletState.mnemonic = "wallet-a";
      state.activeScopeId = "scope-wallet-a";
      state.signer = {};
      state.signerRevision = 0;
      signerSubscribers.clear();
      state.reporters.length = 0;
      state.database = database("scope-wallet-a");
      for (const subscribers of listeners.values()) subscribers.clear();
      hook.mockClear();
      mocks.fetchAssetMonitoringCatalogue.mockReset();
      mocks.buildAssetMonitoringHoldings.mockReset();
      mocks.createAuthenticatedBrowserEngineClient.mockReset().mockReturnValue({});
      mocks.hasSubmittedCtfRangeOrder.mockReset().mockResolvedValue(false);
    },
    replaceSigner: () => {
      state.signer = {};
      state.signerRevision += 1;
      for (const listener of signerSubscribers) listener();
    },
    getNostrSignerRevision: () => state.signerRevision,
    subscribeToNostrSignerRevision: (listener: () => void) => {
      signerSubscribers.add(listener);
      return () => signerSubscribers.delete(listener);
    },
  };
});

vi.mock("@/lib/assetMonitoringReporter", () => ({
  AssetMonitoringReporter: mocks.MockReporter,
  buildAssetMonitoringHoldings: mocks.buildAssetMonitoringHoldings,
  fetchAssetMonitoringCatalogue: mocks.fetchAssetMonitoringCatalogue,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => mocks.state.activeScopeId,
  browserWalletDatabaseName: (scopeId: string) => `wallet-db-${scopeId}`,
  browserWalletIdFromMnemonic: (mnemonic: string) => (mnemonic ? `id-${mnemonic}` : null),
  browserWalletScopeIdFromMnemonic: (mnemonic: string) => (mnemonic ? `scope-${mnemonic}` : null),
}));

vi.mock("@/lib/markets", () => ({
  createAuthenticatedBrowserEngineClient: mocks.createAuthenticatedBrowserEngineClient,
}));

vi.mock("@/lib/nostr", () => ({
  getNdk: () => ({ signer: mocks.state.signer }),
  getNostrSignerRevision: mocks.getNostrSignerRevision,
  subscribeToNostrSignerRevision: mocks.subscribeToNostrSignerRevision,
}));

vi.mock("@/stores/ctf-range-order-db", () => ({
  hasSubmittedCtfRangeOrder: mocks.hasSubmittedCtfRangeOrder,
}));

vi.mock("@/stores/proof-db", () => ({
  get db() {
    return mocks.state.database;
  },
  isCtfProof: () => false,
  storedProofFromRow: (row: unknown) => row,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.walletState) => unknown) => selector(mocks.walletState)),
    { getState: () => mocks.walletState },
  ),
}));

const { subscribeToCommittedProofChanges, useAssetMonitoringReporter } =
  await import("../useAssetMonitoringReporter");

beforeEach(() => mocks.reset());
afterEach(() => vi.clearAllMocks());

describe("useAssetMonitoringReporter", () => {
  it("does not mount without a ready signer or mnemonic wallet profile", () => {
    const disabled = renderHook(() => useAssetMonitoringReporter(false));
    expect(mocks.state.reporters).toHaveLength(0);
    disabled.unmount();

    mocks.walletState.mnemonic = "";
    renderHook(() => useAssetMonitoringReporter(true));
    expect(mocks.state.reporters).toHaveLength(0);
    expect(mocks.hook).not.toHaveBeenCalled();
  });

  it("requests one startup report after it installs proof subscriptions", () => {
    renderHook(() => useAssetMonitoringReporter(true));

    expect(mocks.hook).toHaveBeenCalledTimes(3);
    expect(mocks.state.reporters).toHaveLength(1);
    expect(mocks.state.reporters[0]!.request).toHaveBeenCalledOnce();
  });

  it("builds each snapshot on demand from the current proof read", async () => {
    mocks.fetchAssetMonitoringCatalogue.mockResolvedValue([]);
    mocks.buildAssetMonitoringHoldings.mockReturnValue([]);
    renderHook(() => useAssetMonitoringReporter(true));

    await expect(mocks.state.reporters[0]!.input.buildHoldings()).resolves.toEqual([]);
    expect(proofs(mocks.state.database).toArray).toHaveBeenCalledOnce();
    expect(mocks.fetchAssetMonitoringCatalogue).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ engineBaseUrl: window.location.origin, fetchImpl: fetch }),
    );
  });

  it("requests once for each committed proof transaction and coalesces its writes", () => {
    renderHook(() => useAssetMonitoringReporter(true));
    const reporter = mocks.state.reporters[0]!;

    const create = transaction();
    trigger("creating", create);
    complete(create);
    const update = transaction();
    trigger("updating", update);
    complete(update);
    const remove = transaction();
    trigger("deleting", remove);
    complete(remove);
    const combined = transaction();
    trigger("creating", combined);
    trigger("updating", combined);
    trigger("deleting", combined);
    complete(combined);

    expect(reporter.request).toHaveBeenCalledTimes(5);
  });

  it("does not request for an aborted proof transaction", () => {
    renderHook(() => useAssetMonitoringReporter(true));
    const reporter = mocks.state.reporters[0]!;
    trigger("creating", transaction());

    expect(reporter.request).toHaveBeenCalledOnce();
  });

  it("stops, unsubscribes, and suppresses the old wallet profile", () => {
    const hook = renderHook(() => useAssetMonitoringReporter(true));
    const first = mocks.state.reporters[0]!;
    const pendingCommit = transaction();
    trigger("updating", pendingCommit);

    mocks.walletState.mnemonic = "wallet-b";
    mocks.state.activeScopeId = "scope-wallet-b";
    mocks.state.database = database("scope-wallet-b");
    expect(first.input.isCurrent()).toBe(false);
    hook.rerender();
    complete(pendingCommit);

    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.request).toHaveBeenCalledOnce();
    expect(mocks.state.reporters).toHaveLength(2);
    expect(mocks.state.reporters[1]!.request).toHaveBeenCalledOnce();
  });

  it("remounts when an active signer is replaced", () => {
    renderHook(() => useAssetMonitoringReporter(true));
    const first = mocks.state.reporters[0]!;

    act(() => mocks.replaceSigner());

    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.input.isCurrent()).toBe(false);
    expect(mocks.state.reporters).toHaveLength(2);
    expect(mocks.state.reporters[1]!.request).toHaveBeenCalledOnce();
  });

  it("keeps an A snapshot bound to A across an A-to-B-to-A profile race", async () => {
    const databaseA1 = database("scope-wallet-a", [{ marker: "A1" }]);
    mocks.state.database = databaseA1;
    mocks.fetchAssetMonitoringCatalogue.mockResolvedValue([]);
    mocks.buildAssetMonitoringHoldings.mockReturnValue([]);
    const mounted = renderHook(() => useAssetMonitoringReporter(true));
    const reporterA1 = mocks.state.reporters[0]!;

    mocks.walletState.mnemonic = "wallet-b";
    mocks.state.activeScopeId = "scope-wallet-b";
    mocks.state.database = database("scope-wallet-b", [{ marker: "B" }]);
    mounted.rerender();
    mocks.walletState.mnemonic = "wallet-a";
    mocks.state.activeScopeId = "scope-wallet-a";
    mocks.state.database = database("scope-wallet-a", [{ marker: "A2" }]);
    mounted.rerender();

    await reporterA1.input.buildHoldings();
    expect(proofs(databaseA1).toArray).toHaveBeenCalledOnce();
    expect(mocks.buildAssetMonitoringHoldings).toHaveBeenCalledWith({
      catalogue: [],
      proofs: [{ marker: "A1" }],
    });
  });
});

describe("subscribeToCommittedProofChanges", () => {
  it("waits for commit, coalesces writes, and removes all listeners", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToCommittedProofChanges(mocks.state.database as never, callback);
    const committed = transaction();
    trigger("creating", committed);
    trigger("updating", committed);
    trigger("deleting", committed);
    expect(callback).not.toHaveBeenCalled();
    complete(committed);
    expect(callback).toHaveBeenCalledOnce();

    const aborted = transaction();
    trigger("creating", aborted);
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
    expect([...mocks.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    complete(aborted);
    expect(callback).toHaveBeenCalledOnce();
  });
});

function transaction(): Transaction & { complete: () => void } {
  const completeListeners: Array<() => void> = [];
  return {
    on: ((event: string, listener: () => void) => {
      if (event === "complete") completeListeners.push(listener);
    }) as Transaction["on"],
    complete: () => {
      for (const listener of completeListeners) listener();
    },
  } as Transaction & { complete: () => void };
}

function trigger(event: HookEvent, currentTransaction: Transaction): void {
  for (const listener of mocks.listeners.get(event) ?? []) {
    if (event === "creating") listener("proof", {}, currentTransaction);
    if (event === "updating") listener({}, "proof", {}, currentTransaction);
    if (event === "deleting") listener("proof", {}, currentTransaction);
  }
}

function complete(currentTransaction: Transaction & { complete?: () => void }): void {
  currentTransaction.complete?.();
}

function database(scopeId: string, rows: unknown[] = []) {
  return {
    name: `wallet-db-${scopeId}`,
    proofs: {
      hook: mocks.hook,
      toArray: vi.fn().mockResolvedValue(rows),
    },
  };
}

function proofs(database: unknown): { toArray: ReturnType<typeof vi.fn> } {
  return (database as { proofs: { toArray: ReturnType<typeof vi.fn> } }).proofs;
}
