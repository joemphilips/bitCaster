import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hydrationCallbacks: Array<() => void> = [];
  const walletState = {
    mnemonic: null as string | null,
    mints: [] as Array<{ url: string; info?: Record<string, unknown> }>,
  };
  const settingsState = {
    nostrSignerMode: "none" as const,
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
    recoverKeysetCountersForMint: vi.fn().mockResolvedValue(undefined),
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
    },
  };
});

vi.mock("@/components/shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

    mocks.walletPersist.triggerHydration();

    await waitFor(() => {
      expect(mocks.sweepElapsedPartialLockFailures).toHaveBeenCalledOnce();
    });
  });

  it("does not expose the removed wallet setup wizard route", async () => {
    window.history.replaceState({}, "", "/setup");
    const { default: App } = await import("../App");

    render(<App />);

    expect(document.body).not.toHaveTextContent("Setup");
  });
});
