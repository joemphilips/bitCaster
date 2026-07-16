import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    requestGuiNativeProofOperationRecovery: vi.fn().mockResolvedValue("clear"),
    requestGuiBearerSpendRecovery: vi.fn().mockResolvedValue("clear"),
    reconcileGuiOutgoingPayments: vi.fn().mockResolvedValue({
      remaining: [],
      hasMore: false,
      nextCursor: null,
      nextAttemptAt: null,
      blocked: [],
    }),
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

vi.mock("@/pages/MarketsPage", () => ({
  MarketsPage: () => <div>Markets</div>,
}));
vi.mock("@/pages/MarketDetailPage", () => ({
  MarketDetailPage: () => <div>Market</div>,
}));
vi.mock("@/pages/PortfolioPage", () => ({
  PortfolioPage: () => <div>Portfolio</div>,
}));
vi.mock("@/pages/CreatorPage", () => ({
  CreatorPage: () => <div>Creator</div>,
}));
vi.mock("@/pages/MarketCreationPage", () => ({
  MarketCreationPage: () => <div>Create</div>,
}));
vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: () => <div>Settings</div>,
}));
vi.mock("@/pages/MintDetailPage", () => ({
  MintDetailPage: () => <div>Mint</div>,
}));
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
  resolveCreatorPubkey: vi.fn(() => "aa".repeat(32)),
}));

vi.mock("@/lib/guiOutgoingPaymentRecovery", () => ({
  reconcileGuiOutgoingPayments: mocks.reconcileGuiOutgoingPayments,
}));

vi.mock("@/lib/markets", () => ({
  getDepositStatus: vi.fn(),
  requestEcashDeposit: vi.fn(),
}));

vi.mock("@/lib/partialLockRecovery", () => ({
  sweepElapsedPartialLockFailures: mocks.sweepElapsedPartialLockFailures,
}));

vi.mock("@/stores/gui-native-proof-operation-recovery", () => ({
  requestGuiNativeProofOperationRecovery:
    mocks.requestGuiNativeProofOperationRecovery,
}));

vi.mock("@/stores/gui-bearer-spend-recovery", () => ({
  requestGuiBearerSpendRecovery: mocks.requestGuiBearerSpendRecovery,
}));

describe("App partial-lock recovery sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.reconcileGuiOutgoingPayments.mockReset().mockResolvedValue({
      remaining: [],
      hasMore: false,
      nextCursor: null,
      nextAttemptAt: null,
      blocked: [],
    });
    mocks.rehydratePersistedNostrIdentity
      .mockReset()
      .mockResolvedValue(undefined);
    window.history.replaceState({}, "", "/markets");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps elapsed partial locks when hydration supplies the wallet seed", async () => {
    const { default: App } = await import("../App");

    const rendered = render(<App />);

    expect(mocks.sweepElapsedPartialLockFailures).not.toHaveBeenCalled();
    expect(mocks.walletPersist.onFinishHydration).toHaveBeenCalled();

    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    mocks.walletPersist.triggerHydration();
    rendered.rerender(<App />);

    await waitFor(() => {
      expect(mocks.sweepElapsedPartialLockFailures).toHaveBeenCalledOnce();
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();
    });
  });

  it("requests bearer reconciliation at startup and on wallet activity", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    const { default: App } = await import("../App");
    const rendered = render(<App />);

    await waitFor(() => {
      expect(mocks.requestGuiBearerSpendRecovery).toHaveBeenCalledTimes(1);
    });
    act(() => {
      window.dispatchEvent(
        new Event("bitcaster:wallet-bearer-recovery-request"),
      );
    });
    await waitFor(() => {
      expect(mocks.requestGuiBearerSpendRecovery).toHaveBeenCalledTimes(2);
    });

    rendered.unmount();
  });

  it("shows a fixed fail-closed warning for blocked native recovery", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    mocks.requestGuiNativeProofOperationRecovery.mockResolvedValueOnce(
      "blocked",
    );
    const { default: App } = await import("../App");

    render(<App />);

    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Wallet recovery found an inconsistent or unsupported unfinished operation.",
      );
    });
  });

  it("shows a fixed fail-closed warning for blocked bearer recovery", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    mocks.requestGuiBearerSpendRecovery.mockResolvedValueOnce("blocked");
    const { default: App } = await import("../App");

    render(<App />);

    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Token-payment recovery found inconsistent local state.",
      );
    });
  });

  it("shows a fixed fail-closed warning for a blocked wallet deposit", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    mocks.reconcileGuiOutgoingPayments.mockResolvedValueOnce({
      remaining: [],
      hasMore: false,
      nextCursor: null,
      nextAttemptAt: null,
      blocked: [{ depositId: "deposit-a", error: "authority mismatch" }],
    });
    const { default: App } = await import("../App");

    render(<App />);

    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Wallet deposit recovery found inconsistent durable state.",
      );
    });
  });

  it("automatically drains bounded deposit pages and keeps their stable cursor", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    const cursor = {
      eligibleBefore: 100,
      nextAttemptAt: 1,
      createdAt: 1,
      depositId: "00000000-0000-4000-8000-000000000016",
    };
    mocks.reconcileGuiOutgoingPayments
      .mockResolvedValueOnce({
        remaining: [{}],
        hasMore: true,
        nextCursor: cursor,
        nextAttemptAt: 1_100,
        blocked: [],
      })
      .mockResolvedValueOnce({
        remaining: [],
        hasMore: false,
        nextCursor: null,
        nextAttemptAt: null,
        blocked: [],
      });
    const { default: App } = await import("../App");

    render(<App />);

    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(2);
    });
    expect(
      mocks.reconcileGuiOutgoingPayments.mock.calls[0]?.[0]?.cursor,
    ).toBeNull();
    expect(
      mocks.reconcileGuiOutgoingPayments.mock.calls[1]?.[0]?.cursor,
    ).toEqual(cursor);
  });

  it("restarts deposit recovery on online and visible events", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const { default: App } = await import("../App");

    render(<App />);
    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();
    });

    window.dispatchEvent(new Event("online"));
    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(2);
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(3);
    });
  });

  it("coalesces event triggers while one deposit page is in flight", async () => {
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    const page = deferred<{
      remaining: unknown[];
      hasMore: boolean;
      nextCursor: null;
      nextAttemptAt: null;
      blocked: unknown[];
    }>();
    mocks.reconcileGuiOutgoingPayments.mockReturnValueOnce(page.promise);
    const { default: App } = await import("../App");

    render(<App />);
    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();
    });
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();

    page.resolve({
      remaining: [],
      hasMore: false,
      nextCursor: null,
      nextAttemptAt: null,
      blocked: [],
    });
    await waitFor(() => {
      expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps online triggers inside bounded in-memory exponential backoff", async () => {
    vi.useFakeTimers();
    mocks.walletState.mnemonic = `${"abandon ".repeat(11)}about`;
    mocks.reconcileGuiOutgoingPayments.mockRejectedValue(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: App } = await import("../App");

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.reconcileGuiOutgoingPayments).toHaveBeenCalledTimes(3);
    warning.mockRestore();
  });

  it("does not expose the removed wallet setup wizard route", async () => {
    window.history.replaceState({}, "", "/setup");
    const { default: App } = await import("../App");

    render(<App />);

    expect(document.body).not.toHaveTextContent("Setup");
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
