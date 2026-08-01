import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hydrationCallbacks: Array<() => void> = [];
  const walletState = {
    mnemonic: null as string | null,
    mints: [] as Array<{ url: string; info?: Record<string, unknown> }>,
  };
  const settingsState = {
    nostrSignerMode: "none" as "none" | "nip07" | "nsec",
    relays: [] as Array<{ url: string }>,
    nostrProfile: null as null | { displayName?: string; avatar?: string },
  };

  const walletPersist = {
    hydrated: false,
    hasHydrated: vi.fn(() => walletPersist.hydrated),
    onFinishHydration: vi.fn((cb: () => void) => {
      hydrationCallbacks.push(cb);
      return vi.fn();
    }),
    triggerHydration: () => {
      walletPersist.hydrated = true;
      for (const cb of [...hydrationCallbacks]) cb();
    },
  };

  return {
    settingsState,
    walletState,
    walletPersist,
    sweepElapsedPartialLockFailures: vi.fn().mockResolvedValue(undefined),
    rehydratePersistedNostrIdentity: vi.fn().mockResolvedValue(undefined),
    normalizeStoredMintUrls: vi.fn().mockResolvedValue(undefined),
    recoverKeysetCountersForMint: vi.fn().mockResolvedValue({ scannedKeysets: [], complete: true }),
    recoverPendingTokenReceives: vi.fn().mockResolvedValue({ pending: 0 }),
    recoverBrowserCtfRangeOrders: vi.fn().mockResolvedValue({ recovered: 0, pending: [] }),
    startNip17Listener: vi.fn().mockResolvedValue(undefined),
    userAddAndSelectMint: vi.fn().mockResolvedValue(undefined),
    reset: () => {
      hydrationCallbacks.length = 0;
      walletPersist.hydrated = false;
      walletState.mnemonic = null;
      walletState.mints = [];
      settingsState.nostrSignerMode = "none";
      settingsState.relays = [];
      settingsState.nostrProfile = null;
      mocks.recoverPendingTokenReceives.mockReset().mockResolvedValue({ pending: 0 });
      mocks.recoverKeysetCountersForMint
        .mockReset()
        .mockResolvedValue({ scannedKeysets: [], complete: true });
      mocks.recoverBrowserCtfRangeOrders
        .mockReset()
        .mockResolvedValue({ recovered: 0, pending: [] });
    },
  };
});

vi.mock("@/components/shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DurableWalletErrors: () => null,
}));

vi.mock("@/components/ui/Toast", () => ({
  ToastContainer: () => null,
}));

vi.mock("@/pages/MarketsPage", () => ({ MarketsPage: () => <div>Markets</div> }));
vi.mock("@/pages/MarketDetailPage", () => ({ MarketDetailPage: () => <div>Market</div> }));
vi.mock("@/pages/PortfolioPage", () => ({ PortfolioPage: () => <div>Portfolio</div> }));
vi.mock("@/pages/CreatorPage", () => ({ CreatorPage: () => <div>Creator</div> }));
vi.mock("@/pages/MarketCreationPage", () => ({ MarketCreationPage: () => <div>Create</div> }));
vi.mock("@/pages/SettingsPage", () => ({ SettingsPage: () => <div>Settings</div> }));
vi.mock("@/pages/MintDetailPage", () => ({ MintDetailPage: () => <div>Mint</div> }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => <div>User</div> }));

vi.mock("@/stores/useBookmarkSync", () => ({ useBookmarkSync: vi.fn() }));
vi.mock("@/stores/useCreatorSync", () => ({ useCreatorSync: vi.fn() }));
vi.mock("@/stores/useActivityLogSync", () => ({ useActivityLogSync: vi.fn() }));
vi.mock("@/lib/orderStatus", () => ({ usePendingTradesPoller: vi.fn() }));
vi.mock("@/hooks/useTradeSettlement", () => ({ useTradeSettlement: vi.fn() }));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector?: (state: typeof mocks.settingsState) => unknown) =>
      selector ? selector(mocks.settingsState) : mocks.settingsState,
    ),
    {
      getState: () => mocks.settingsState,
    },
  ),
}));

vi.mock("@/stores/wallet", () => ({
  DEFAULT_MINT_URL: "http://localhost:8086",
  useBalance: vi.fn(() => 0),
  useWalletStore: Object.assign(
    vi.fn((selector?: (state: typeof mocks.walletState) => unknown) =>
      selector ? selector(mocks.walletState) : mocks.walletState,
    ),
    {
      getState: () => mocks.walletState,
      persist: mocks.walletPersist,
    },
  ),
}));

vi.mock("@/stores/proof-db", () => ({
  normalizeStoredMintUrls: mocks.normalizeStoredMintUrls,
}));

vi.mock("@/lib/cashu", () => ({
  recoverKeysetCountersForMint: mocks.recoverKeysetCountersForMint,
  recoverPendingTokenReceives: mocks.recoverPendingTokenReceives,
}));

vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  recoverBrowserCtfRangeOrders: mocks.recoverBrowserCtfRangeOrders,
}));

vi.mock("@/lib/nip17-listener", () => ({
  startNip17Listener: mocks.startNip17Listener,
  getNip17ListenerDiagnostics: vi.fn(() => ({
    running: false,
    relays: [],
    subscribedPubkey: null,
  })),
}));

vi.mock("@/lib/walletOps", () => ({
  refreshMintInfoWithoutActivating: vi.fn().mockResolvedValue(undefined),
  userAddAndSelectMint: mocks.userAddAndSelectMint,
}));

vi.mock("@/lib/identityOps", () => ({
  rehydratePersistedNostrIdentity: mocks.rehydratePersistedNostrIdentity,
}));

vi.mock("@/lib/partialLockRecovery", () => ({
  sweepElapsedPartialLockFailures: mocks.sweepElapsedPartialLockFailures,
}));

describe("App partial-lock recovery sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    window.history.replaceState({}, "", "/markets");
  });

  it("waits for wallet-store hydration before sweeping elapsed partial locks", async () => {
    const { default: App } = await import("../App");

    render(<App />);

    expect(mocks.sweepElapsedPartialLockFailures).not.toHaveBeenCalled();
    expect(mocks.walletPersist.onFinishHydration).toHaveBeenCalled();

    await act(async () => {
      mocks.walletPersist.triggerHydration();
    });

    await waitFor(() => {
      expect(mocks.sweepElapsedPartialLockFailures).toHaveBeenCalledOnce();
    });
  });

  it("recovers durable range orders before generic keyset counters", async () => {
    mocks.walletState.mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    mocks.walletState.mints = [{ url: "https://mint.example" }];
    mocks.settingsState.nostrSignerMode = "nsec";
    const order: string[] = [];
    mocks.recoverPendingTokenReceives.mockImplementation(async () => {
      order.push("receives");
      return { pending: 0 };
    });
    mocks.recoverBrowserCtfRangeOrders.mockImplementation(async () => {
      order.push("orders");
      return { recovered: 1, pending: [] };
    });
    mocks.recoverKeysetCountersForMint.mockImplementation(async () => {
      order.push("counters");
      return { scannedKeysets: [], complete: true };
    });
    const { default: App } = await import("../App");

    render(<App />);
    await act(async () => {
      mocks.walletPersist.triggerHydration();
    });

    await waitFor(() => {
      expect(order).toEqual(["receives", "orders", "counters"]);
    });
    expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledWith({
      mnemonic: mocks.walletState.mnemonic,
      mintUrls: ["https://mint.example"],
    });
  });

  it("retries pending funds recovery when the browser comes online", async () => {
    mocks.walletState.mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    mocks.walletState.mints = [{ url: "https://mint.example" }];
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.recoverPendingTokenReceives.mockResolvedValue({ pending: 0 });
    mocks.recoverKeysetCountersForMint.mockResolvedValue({ scannedKeysets: [], complete: true });
    mocks.recoverBrowserCtfRangeOrders
      .mockResolvedValueOnce({
        recovered: 0,
        pending: [
          {
            operationId: "range-1",
            revision: 3,
            code: "mint-source-uncertain",
          },
        ],
      })
      .mockResolvedValue({ recovered: 1, pending: [] });
    const { default: App } = await import("../App");

    render(<App />);
    await waitFor(() => expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledOnce());

    await act(async () => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(mocks.recoverBrowserCtfRangeOrders).toHaveBeenCalledTimes(2));
    expect(mocks.recoverPendingTokenReceives).toHaveBeenCalledOnce();
    expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce();
  });

  it("runs mint recovery even when no Nostr signer is configured", async () => {
    mocks.walletState.mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    mocks.walletState.mints = [{ url: "https://mint.example" }];
    mocks.settingsState.nostrSignerMode = "none";
    mocks.recoverPendingTokenReceives.mockResolvedValue({ pending: 0 });
    mocks.recoverBrowserCtfRangeOrders.mockResolvedValue({ recovered: 0, pending: [] });
    mocks.recoverKeysetCountersForMint.mockResolvedValue({ scannedKeysets: [], complete: true });
    const { default: App } = await import("../App");

    render(<App />);

    await waitFor(() => expect(mocks.recoverKeysetCountersForMint).toHaveBeenCalledOnce());
    expect(mocks.recoverPendingTokenReceives).toHaveBeenCalledOnce();
  });

  it("does not expose the removed wallet setup wizard route", async () => {
    window.history.replaceState({}, "", "/setup");
    const { default: App } = await import("../App");

    render(<App />);

    expect(document.body).not.toHaveTextContent("Setup");
  });
});
