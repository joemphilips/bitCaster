// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useEncryptedWalletBackupDriver } from "../useEncryptedWalletBackupDriver";

const mocks = vi.hoisted(() => ({
  mnemonic: "alpha beta gamma",
  input: undefined as Record<string, unknown> | undefined,
  callback: undefined as ((status: unknown) => void) | undefined,
  driver: {
    stop: vi.fn(),
    resumeAfterRecovery: vi.fn(),
    recoverTargetedAsset: vi.fn(),
  },
  unregister: vi.fn(),
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "scope-a",
  browserWalletDatabaseName: () => "wallet-db",
  browserWalletScopeIdFromSeed: () => "scope-a",
}));
vi.mock("@/lib/encryptedWalletBackupConfig", () => ({
  resolveEncryptedWalletBackupConfiguration: () => ({
    realm: "test",
    signedOrigin: "https://test",
  }),
}));
vi.mock("@/lib/bip39", () => ({ toSeed: () => new Uint8Array([1, 2, 3]) }));
vi.mock("@/stores/proof-db", () => ({ db: { name: "wallet-db" } }));
vi.mock("@/stores/wallet", () => {
  const useWalletStore = (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: mocks.mnemonic });
  useWalletStore.getState = () => ({ mnemonic: mocks.mnemonic });
  return { getWalletForMnemonicUnit: vi.fn(), useWalletStore };
});
vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  createBrowserEncryptedWalletBackupV2RuntimeDriver: (input: Record<string, unknown>) => {
    mocks.input = input;
    mocks.callback = input.onRecoveryStatusChange as (status: unknown) => void;
    return mocks.driver;
  },
  registerBrowserEncryptedWalletBackupV2RuntimeDriver: () => mocks.unregister,
}));

beforeEach(() => {
  mocks.mnemonic = "alpha beta gamma";
  mocks.input = undefined;
  mocks.callback = undefined;
  mocks.driver.stop.mockClear();
  mocks.driver.resumeAfterRecovery.mockClear();
  mocks.unregister.mockClear();
});

it("exposes pending reason and retries the existing driver", () => {
  const { result } = renderHook(() => useEncryptedWalletBackupDriver(true));
  expect(result.current.recoveryStatus).toEqual({ kind: "ready" });
  expect(mocks.callback).toBeDefined();

  act(() => mocks.callback?.({ kind: "recovering", reason: "remote-unavailable" }));
  expect(result.current.recoveryStatus).toEqual({
    kind: "recovering",
    reason: "remote-unavailable",
  });

  act(() => result.current.retryRecovery());
  expect(mocks.driver.resumeAfterRecovery).toHaveBeenCalledOnce();
});

it("drops callbacks from the previous wallet profile", () => {
  const { result, rerender } = renderHook(() => useEncryptedWalletBackupDriver(true));
  const staleCallback = mocks.callback;
  mocks.mnemonic = "delta epsilon zeta";
  rerender();
  act(() => staleCallback?.({ kind: "recovering", reason: "submitted-work-unresolved" }));
  expect(result.current.recoveryStatus).toEqual({ kind: "ready" });
});
