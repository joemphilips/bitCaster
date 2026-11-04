import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useWalletBackupPresentation } from "@/hooks/WalletBackupPresentation";

const mocks = vi.hoisted(() => ({
  wallet: {
    mnemonic: "wallet-a",
    mints: [{ url: "https://mint.example", info: { nuts: { CTF: {} } } }],
  },
  settings: {
    nostrSignerMode: "none",
    signerConnectionStatus: "disconnected",
    nostrProfile: null,
    relays: [{ url: "wss://relay.example", connectionStatus: "disconnected" }],
  },
  startListener: vi.fn(),
  stopListener: vi.fn(),
  rehydrateIdentity: vi.fn(),
  recoverBolt11: vi.fn(),
  watchBolt11: vi.fn(),
  stopWatchingBolt11: vi.fn(),
  recoverMelts: vi.fn(),
  backup: { recoveryStatus: { kind: "failed" }, retryRecovery: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/shell", () => ({
  AppShell: ({ children, isLoggedIn }: { children: ReactNode; isLoggedIn: boolean }) => (
    <>
      <output data-testid="account-logged-in">{String(isLoggedIn)}</output>
      {children}
    </>
  ),
  DurableWalletErrors: () => null,
  EncryptedWalletBackupRecoveryStatus: () => null,
}));
vi.mock("@/components/shell/SettlementProgress", () => ({ SettlementProgress: () => null }));
vi.mock("@/components/ui/Toast", () => ({ ToastContainer: () => null }));
vi.mock("@/pages/MarketsPage", () => ({
  MarketsPage: () => {
    const backup = useWalletBackupPresentation();
    return (
      <button onClick={backup?.retryRecovery}>App backup: {backup?.recoveryStatus.kind}</button>
    );
  },
}));
vi.mock("@/pages/MarketDetailPage", () => ({ MarketDetailPage: () => null }));
vi.mock("@/pages/PortfolioPage", () => ({ PortfolioPage: () => null }));
vi.mock("@/pages/CreatorPage", () => ({ CreatorPage: () => null }));
vi.mock("@/pages/MarketCreationPage", () => ({ MarketCreationPage: () => null }));
vi.mock("@/pages/SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("@/pages/MintDetailPage", () => ({ MintDetailPage: () => null }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => null }));

vi.mock("@/stores/wallet", () => ({
  DEFAULT_MINT_URL: "https://mint.example",
  useBalance: () => 0,
  useWalletStore: Object.assign(
    (selector: (state: typeof mocks.wallet) => unknown) => selector(mocks.wallet),
    {
      getState: () => mocks.wallet,
      persist: {
        hasHydrated: () => true,
        onFinishHydration: vi.fn(() => () => {}),
      },
    },
  ),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof mocks.settings) => unknown) => selector(mocks.settings),
    { getState: () => mocks.settings, subscribe: () => () => {} },
  ),
}));
vi.mock("@/stores/useBookmarkSync", () => ({ useBookmarkSync: vi.fn() }));
vi.mock("@/stores/useCreatorSync", () => ({ useCreatorSync: vi.fn() }));
vi.mock("@/stores/useActivityLogSync", () => ({ useActivityLogSync: vi.fn() }));
vi.mock("@/hooks/useOrderSettlementLifecycle", () => ({ useOrderSettlementLifecycle: vi.fn() }));
vi.mock("@/hooks/useLikedMarketCloseReconcile", () => ({ useLikedMarketCloseReconcile: vi.fn() }));
vi.mock("@/hooks/useHeldPositionCloseNotifications", () => ({
  useHeldPositionCloseNotifications: vi.fn(),
}));
vi.mock("@/hooks/useEncryptedWalletBackupDriver", () => ({
  useEncryptedWalletBackupDriver: () => mocks.backup,
}));
vi.mock("@/hooks/useAssetMonitoringReporter", () => ({ useAssetMonitoringReporter: vi.fn() }));
vi.mock("@/hooks/useBrowserCtfRangeOrderRecovery", () => ({
  useBrowserCtfRangeOrderRecovery: vi.fn(),
}));
vi.mock("@/lib/BrowserPreReleaseResetGate", () => ({
  BrowserPreReleaseResetGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/identityOps", () => ({
  rehydratePersistedNostrIdentity: mocks.rehydrateIdentity,
}));
vi.mock("@/lib/nip17-listener", () => ({
  startNip17Listener: mocks.startListener,
  stopNip17Listener: mocks.stopListener,
}));
vi.mock("@/lib/relayDefaults", async () => ({
  ...(await vi.importActual<typeof import("@/lib/relayDefaults")>("@/lib/relayDefaults")),
  effectiveRelayUrls: (relays: { url: string }[]) => relays.map(({ url }) => url),
}));
vi.mock("@/lib/walletOps", () => ({
  refreshMintInfoWithoutActivating: vi.fn(),
  userAddAndSelectMint: vi.fn(),
}));
vi.mock("@/lib/cashu", () => ({ captureBrowserMintPersistenceContext: () => ({}) }));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: (mnemonic: string) => (mnemonic ? `scope:${mnemonic}` : null),
}));
vi.mock("@/lib/browserDurableBolt11MintQuote", () => ({
  recoverBrowserDurableBolt11MintQuotesInPass: mocks.recoverBolt11,
  watchPendingBrowserDurableBolt11MintQuotes: mocks.watchBolt11,
}));
vi.mock("@/lib/browserDurableWalletMelt", () => ({
  recoverBrowserDurableWalletMeltsInPass: mocks.recoverMelts,
}));
vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  resumeBrowserEncryptedWalletBackupV2AfterRecovery: vi.fn(),
}));

beforeEach(() => {
  mocks.wallet.mnemonic = "wallet-a";
  mocks.settings.nostrSignerMode = "none";
  mocks.settings.signerConnectionStatus = "disconnected";
  mocks.settings.relays = [{ url: "wss://relay.example", connectionStatus: "disconnected" }];
  mocks.startListener.mockReset().mockResolvedValue(undefined);
  mocks.stopListener.mockReset();
  mocks.rehydrateIdentity.mockReset().mockResolvedValue(undefined);
  mocks.recoverBolt11.mockReset().mockResolvedValue({ hasMore: false });
  mocks.stopWatchingBolt11.mockReset();
  mocks.watchBolt11.mockReset().mockReturnValue(mocks.stopWatchingBolt11);
  mocks.recoverMelts
    .mockReset()
    .mockResolvedValue({ pending: 0, nextCursor: null, hasMore: false });
});

describe("App NIP-17 listener lifecycle", () => {
  it("shares the single app-owned backup state and Retry with route content", () => {
    mocks.backup.retryRecovery.mockClear();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "App backup: failed" }));
    expect(mocks.backup.retryRecovery).toHaveBeenCalledOnce();
  });

  it("passes explicit opt-out to the listener and cleans up the old subscription", async () => {
    const view = render(<App />);
    await waitFor(() => expect(mocks.startListener).toHaveBeenCalledOnce());
    mocks.settings.relays = [];
    view.rerender(<App />);
    await waitFor(() => expect(mocks.startListener).toHaveBeenLastCalledWith("wallet-a", []));
    expect(mocks.stopListener).toHaveBeenCalledOnce();
  });

  it("restarts when two exact relay sets have the same delimiter-joined representation", async () => {
    mocks.settings.relays = [
      {
        url: "wss://custom.example/Path?Key=A|wss://other.example",
        connectionStatus: "disconnected",
      },
    ];
    const view = render(<App />);
    await waitFor(() => expect(mocks.startListener).toHaveBeenCalledOnce());
    mocks.settings.relays = [
      { url: "wss://custom.example/Path?Key=A", connectionStatus: "disconnected" },
      { url: "wss://other.example", connectionStatus: "disconnected" },
    ];
    view.rerender(<App />);
    await waitFor(() =>
      expect(mocks.startListener).toHaveBeenLastCalledWith("wallet-a", [
        "wss://custom.example/Path?Key=A",
        "wss://other.example",
      ]),
    );
    expect(mocks.startListener).toHaveBeenCalledTimes(2);
    expect(mocks.stopListener).toHaveBeenCalledOnce();
  });
  it("stops the listener when the wallet profile becomes empty", async () => {
    const view = render(<App />);
    await waitFor(() =>
      expect(mocks.startListener).toHaveBeenCalledWith("wallet-a", ["wss://relay.example"]),
    );

    mocks.wallet.mnemonic = "";
    view.rerender(<App />);

    expect(mocks.stopListener).toHaveBeenCalledOnce();
    expect(mocks.startListener).toHaveBeenCalledOnce();
  });

  it("restarts for a new profile and stops on effect cleanup", async () => {
    const view = render(<App />);
    await waitFor(() =>
      expect(mocks.startListener).toHaveBeenCalledWith("wallet-a", ["wss://relay.example"]),
    );

    mocks.wallet.mnemonic = "wallet-b";
    view.rerender(<App />);
    await waitFor(() =>
      expect(mocks.startListener).toHaveBeenCalledWith("wallet-b", ["wss://relay.example"]),
    );
    expect(mocks.stopListener).toHaveBeenCalledOnce();

    view.unmount();
    expect(mocks.stopListener).toHaveBeenCalledTimes(2);
  });

  it("watches pending mint quotes for the wallet profile independent of any deposit sheet", async () => {
    const view = render(<App />);
    await waitFor(() => expect(mocks.watchBolt11).toHaveBeenCalledOnce());

    mocks.wallet.mnemonic = "wallet-b";
    view.rerender(<App />);
    await waitFor(() => expect(mocks.watchBolt11).toHaveBeenCalledTimes(2));
    expect(mocks.stopWatchingBolt11).toHaveBeenCalledOnce();

    view.unmount();
    expect(mocks.stopWatchingBolt11).toHaveBeenCalledTimes(2);
  });
});

describe("App account item during the startup identity restore", () => {
  it("treats a stored identity as logged in until the restore signals completion", async () => {
    let finishRestore!: () => void;
    mocks.rehydrateIdentity.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestore = resolve;
      }),
    );
    mocks.settings.nostrSignerMode = "nsec";
    render(<App />);

    expect(screen.getByTestId("account-logged-in")).toHaveTextContent("true");

    // The restore failed, so the signer is still disconnected when it completes.
    await act(async () => finishRestore());
    expect(screen.getByTestId("account-logged-in")).toHaveTextContent("false");
  });

  it("does not treat a missing identity as logged in during the restore", async () => {
    let finishRestore!: () => void;
    mocks.rehydrateIdentity.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestore = resolve;
      }),
    );
    render(<App />);

    expect(screen.getByTestId("account-logged-in")).toHaveTextContent("false");
    await act(async () => finishRestore());
    expect(screen.getByTestId("account-logged-in")).toHaveTextContent("false");
  });
});
