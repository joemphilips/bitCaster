import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const mocks = vi.hoisted(() => ({
  wallet: {
    mnemonic: "wallet-a",
    mints: [{ url: "https://mint.example", info: { nuts: { CTF: {} } } }],
  },
  settings: {
    nostrSignerMode: "none",
    nostrProfile: null,
    relays: [{ url: "wss://relay.example", connectionStatus: "disconnected" }],
  },
  startListener: vi.fn(),
  stopListener: vi.fn(),
  rehydrateIdentity: vi.fn(),
  recoverBolt11: vi.fn(),
  recoverMelts: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
  DurableWalletErrors: () => null,
  EncryptedWalletBackupRecoveryStatus: () => null,
}));
vi.mock("@/components/shell/SettlementProgress", () => ({ SettlementProgress: () => null }));
vi.mock("@/components/ui/Toast", () => ({ ToastContainer: () => null }));
vi.mock("@/pages/MarketsPage", () => ({ MarketsPage: () => null }));
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
    { getState: () => mocks.settings },
  ),
}));
vi.mock("@/stores/useBookmarkSync", () => ({ useBookmarkSync: vi.fn() }));
vi.mock("@/stores/useCreatorSync", () => ({ useCreatorSync: vi.fn() }));
vi.mock("@/stores/useActivityLogSync", () => ({ useActivityLogSync: vi.fn() }));
vi.mock("@/hooks/useOrderSettlementLifecycle", () => ({ useOrderSettlementLifecycle: vi.fn() }));
vi.mock("@/hooks/useLikedMarketCloseReconcile", () => ({ useLikedMarketCloseReconcile: vi.fn() }));
vi.mock("@/hooks/useEncryptedWalletBackupDriver", () => ({
  useEncryptedWalletBackupDriver: () => undefined,
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
vi.mock("@/lib/relayDefaults", () => ({
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
  mocks.settings.relays = [{ url: "wss://relay.example", connectionStatus: "disconnected" }];
  mocks.startListener.mockReset().mockResolvedValue(undefined);
  mocks.stopListener.mockReset();
  mocks.rehydrateIdentity.mockReset().mockResolvedValue(undefined);
  mocks.recoverBolt11.mockReset().mockResolvedValue({ hasMore: false });
  mocks.recoverMelts
    .mockReset()
    .mockResolvedValue({ pending: 0, nextCursor: null, hasMore: false });
});

describe("App NIP-17 listener lifecycle", () => {
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
});
