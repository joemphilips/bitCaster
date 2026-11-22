// The real Dexie live query starts only with an IndexedDB global.
import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  walletRecoveryEmptyIsTerminal,
  type WalletRecoveryStatus,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import { beginWalletRecoveryPass, walletRecoveryTag } from "@/lib/walletRecoveryPassSummary";

// The funds and positions reads of the Portfolio are typed holdings reads
// (issue #161). The real live query runs. Only the custody sources, the
// engine and the wallet profile are replaced.

const { SCOPE_ID, MINT_URL } = vi.hoisted(() => ({
  SCOPE_ID: "custody:wallet:" + "a".repeat(64),
  MINT_URL: "https://mint.example",
}));

const mocks = vi.hoisted(() => {
  let activation: Readonly<{ scopeId: string | null; epoch: number }> = Object.freeze({
    scopeId: null,
    epoch: 0,
  });
  const listeners = new Set<() => void>();
  return {
    readFunds: vi.fn(),
    readPositions: vi.fn(),
    activation: () => activation,
    activate(scopeId: string | null) {
      activation = Object.freeze({ scopeId, epoch: activation.epoch + 1 });
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("@/stores/proof-db", () => ({
  db: {},
  getCanonicalCurrentProofs: mocks.readFunds,
  isCtfProof: () => false,
}));
vi.mock("@/stores/portfolio-custody", () => ({
  readCanonicalPortfolioCustody: mocks.readPositions,
}));
vi.mock("@/stores/wallet", () => {
  const state = {
    setupComplete: true,
    mnemonic: "test mnemonic",
    mints: [{ url: MINT_URL }],
  };
  return { useWalletStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: object) => unknown) =>
    selector({ nostrProfile: null, signerConnectionStatus: "disconnected" }),
}));
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: object) => unknown) => selector({ items: [] }),
}));
vi.mock("@/hooks/useActivityCatalogue", () => ({
  useActivityCatalogue: (activity: unknown) => activity,
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: () => "a".repeat(64),
  browserWalletScopeIdFromMnemonic: () => SCOPE_ID,
  activeBrowserWalletScopeId: () => mocks.activation().scopeId,
  activeBrowserWalletActivation: mocks.activation,
  subscribeBrowserWalletActivation: mocks.subscribe,
}));
vi.mock("@/lib/nostr", () => ({
  getNostrSignerRevision: () => 0,
  subscribeToNostrSignerRevision: () => () => {},
}));
vi.mock("@/lib/markets", () => ({
  // The display-only projection stays unread, so only the local reads decide.
  createAuthenticatedBrowserEngineClient: () => ({
    getPortfolio: () => new Promise(() => {}),
    getAssetMonitoringAssets: () => new Promise(() => {}),
  }),
}));
vi.mock("@/lib/marketHub", () => ({
  observePortfolioValuations: () => ({
    replaceConditionIds: async () => {},
    dispose: () => {},
  }),
}));
vi.mock("@/lib/marketCatalogueBatches", () => ({
  loadMarketCatalogue: async () => new Map(),
}));

import { usePortfolioState } from "../usePortfolioState";

function currentTag() {
  return walletRecoveryTag(mocks.activation() as { scopeId: string; epoch: number }, [MINT_URL]);
}

function completedAfter(passSeq: number): WalletRecoveryStatus {
  return { kind: "completed", tag: currentTag(), passSeq, coverage: "full" };
}

function completePass(): void {
  const pass = beginWalletRecoveryPass(currentTag(), () => true);
  pass.complete();
}

beforeEach(() => {
  mocks.activate(SCOPE_ID);
  mocks.readFunds.mockResolvedValue([]);
  mocks.readPositions.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("usePortfolioState holdings reads", () => {
  it("is unhydrated, not empty, before the first read completes", () => {
    mocks.readFunds.mockReturnValue(new Promise(() => {}));
    mocks.readPositions.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => usePortfolioState());

    expect(result.current.holdings.funds).toEqual({ kind: "unhydrated" });
    expect(result.current.holdings.positions).toEqual({ kind: "unhydrated" });
  });

  it("gives a failed read, not an empty list, when custody is unavailable", async () => {
    mocks.readFunds.mockResolvedValue(null);
    mocks.readPositions.mockResolvedValue(null);

    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.holdings.funds).toEqual({ kind: "failed" }));
    await waitFor(() => expect(result.current.holdings.positions).toEqual({ kind: "failed" }));
    const status = completedAfter(0);
    expect(walletRecoveryEmptyIsTerminal(status, result.current.holdings.funds)).toBe(false);
    expect(walletRecoveryEmptyIsTerminal(status, result.current.holdings.positions)).toBe(false);
    // The shared status row reports a failed local read. The monitoring notice does not.
    expect(result.current.monitoring.error).toBeNull();
  });

  it("gives a failed read instead of a thrown error", async () => {
    mocks.readFunds.mockRejectedValue(new Error("IndexedDB is unavailable"));
    mocks.readPositions.mockRejectedValue(new Error("IndexedDB is unavailable"));

    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.holdings.funds).toEqual({ kind: "failed" }));
    await waitFor(() => expect(result.current.holdings.positions).toEqual({ kind: "failed" }));
    expect(walletRecoveryEmptyIsTerminal(completedAfter(0), result.current.holdings.funds)).toBe(
      false,
    );
  });

  it("reads again after each completed pass, so an empty read before the pass is not final", async () => {
    const { result } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.holdings.funds.kind).toBe("ok"));
    const before = result.current.holdings.funds;
    const readsBefore = mocks.readFunds.mock.calls.length;

    // The pass completes after this empty read began.
    act(() => completePass());
    const status = completedAfter(1);
    expect(walletRecoveryEmptyIsTerminal(status, before)).toBe(false);

    await waitFor(() =>
      expect(result.current.holdings.funds).toMatchObject({ kind: "ok", afterPassSeq: 1 }),
    );
    await waitFor(() =>
      expect(result.current.holdings.positions).toMatchObject({ kind: "ok", afterPassSeq: 1 }),
    );
    expect(mocks.readFunds.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(walletRecoveryEmptyIsTerminal(status, result.current.holdings.funds)).toBe(true);
    expect(walletRecoveryEmptyIsTerminal(status, result.current.holdings.positions)).toBe(true);
  });

  it("tags each read with its activation, so a read of an earlier activation is not final", async () => {
    const { result } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.holdings.funds.kind).toBe("ok"));
    const earlier = result.current.holdings.funds;

    act(() => mocks.activate(SCOPE_ID));

    expect(walletRecoveryEmptyIsTerminal(completedAfter(0), earlier)).toBe(false);
    await waitFor(() =>
      expect(result.current.holdings.funds).toMatchObject({ kind: "ok", tag: currentTag() }),
    );
    expect(walletRecoveryEmptyIsTerminal(completedAfter(0), result.current.holdings.funds)).toBe(
      true,
    );
  });
});
