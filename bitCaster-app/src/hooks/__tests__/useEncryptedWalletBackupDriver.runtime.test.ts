import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEncryptedWalletBackupDriver } from "../useEncryptedWalletBackupDriver";

const mocks = vi.hoisted(() => {
  const walletState = { mnemonic: "test wallet mnemonic" };
  return {
    createDriver: vi.fn(),
    registerDriver: vi.fn(),
    getWalletForMnemonicUnit: vi.fn(),
    walletState,
  };
});

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "wallet-scope-a",
  browserWalletDatabaseName: () => "wallet-database-a",
  browserWalletScopeIdFromSeed: () => "wallet-scope-a",
}));

vi.mock("@/lib/encryptedWalletBackupConfig", () => ({
  resolveEncryptedWalletBackupConfiguration: () => ({ realm: "backup.example" }),
}));

vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  createBrowserEncryptedWalletBackupV2RuntimeDriver: mocks.createDriver,
  registerBrowserEncryptedWalletBackupV2RuntimeDriver: mocks.registerDriver,
}));

vi.mock("@/lib/bip39", () => ({ toSeed: () => new Uint8Array(64) }));

vi.mock("@/stores/proof-db", () => ({ db: { name: "wallet-database-a" } }));

vi.mock("@/stores/wallet", () => ({
  getWalletForMnemonicUnit: mocks.getWalletForMnemonicUnit,
  useWalletStore: Object.assign(
    (selector: (state: typeof mocks.walletState) => unknown) => selector(mocks.walletState),
    { getState: () => mocks.walletState },
  ),
}));

afterEach(() => vi.clearAllMocks());

it("loads the deterministic msat wallet for conflict recovery", async () => {
  const driver = {
    stop: vi.fn(),
    resumeAfterRecovery: vi.fn(),
    recoverTargetedAsset: vi.fn(),
  };
  const unregister = vi.fn();
  mocks.createDriver.mockReturnValue(driver);
  mocks.registerDriver.mockReturnValue(unregister);
  const mounted = renderHook(() => useEncryptedWalletBackupDriver(true));
  const input = mocks.createDriver.mock.calls[0]![0];

  await input.loadWallet("https://mint.example");

  expect(mocks.getWalletForMnemonicUnit).toHaveBeenCalledWith(
    "https://mint.example",
    "msat",
    "test wallet mnemonic",
  );
  mounted.unmount();
  expect(unregister).toHaveBeenCalledOnce();
  expect(driver.stop).toHaveBeenCalledOnce();
});
