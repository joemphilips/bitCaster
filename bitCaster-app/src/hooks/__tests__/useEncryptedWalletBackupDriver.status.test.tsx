// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useEncryptedWalletBackupDriver } from "../useEncryptedWalletBackupDriver";
import { advanceNostrSignerRevision } from "@/lib/nostrSignerRevision";

const mocks = vi.hoisted(() => ({
  mnemonic: "alpha beta gamma",
  configurationEnabled: true,
  permission: vi.fn(),
  createError: false,
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
  resolveEncryptedWalletBackupConfiguration: () =>
    mocks.configurationEnabled
      ? {
          realm: "test",
          signedOrigin: "https://test",
        }
      : null,
}));
vi.mock("@/lib/browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.permission,
  BrowserWalletRecoveryRequiredError: class extends Error {
    constructor(readonly reason: string) {
      super("bounded wallet refusal");
    }
  },
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
    if (mocks.createError) throw new Error("private constructor details");
    mocks.input = input;
    mocks.callback = input.onRecoveryStatusChange as (status: unknown) => void;
    return mocks.driver;
  },
  registerBrowserEncryptedWalletBackupV2RuntimeDriver: () => mocks.unregister,
}));

beforeEach(() => {
  mocks.mnemonic = "alpha beta gamma";
  mocks.configurationEnabled = true;
  mocks.createError = false;
  mocks.permission.mockReset().mockResolvedValue(undefined);
  mocks.input = undefined;
  mocks.callback = undefined;
  mocks.driver.stop.mockClear();
  mocks.driver.resumeAfterRecovery.mockClear();
  mocks.unregister.mockClear();
});

it.each(["disabled", "missing-wallet"])("does not blanket-block %s wallets", async (mode) => {
  if (mode === "disabled") mocks.configurationEnabled = false;
  if (mode === "missing-wallet") mocks.mnemonic = "";
  const { result } = renderHook(() =>
    useEncryptedWalletBackupDriver(mode !== "unsigned-unenrolled"),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.recoveryStatus).toEqual({ kind: "ready" });
  expect(mocks.input).toBeUndefined();
  expect(mocks.permission).not.toHaveBeenCalled();
});

it("starts the account-bound driver and keeps configured backup writes paused before authentication", async () => {
  const { result } = renderHook(() => useEncryptedWalletBackupDriver(false));
  await waitFor(() => expect(mocks.input?.ownerSession).toBeDefined());
  expect(result.current.recoveryStatus).toEqual({
    kind: "preparing",
    reason: "driver-unavailable",
  });
  expect(mocks.permission).not.toHaveBeenCalled();
});

it("reports construction failure and permits a new driver without exposing private details", () => {
  mocks.createError = true;
  const { result } = renderHook(() => useEncryptedWalletBackupDriver(true));
  expect(result.current.recoveryStatus).toEqual({ kind: "failed" });
  mocks.createError = false;
  act(() => result.current.retryRecovery());
  expect(mocks.input).toBeDefined();
  expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
});

it("replaces configured owner discovery when the wallet profile changes", async () => {
  const { result, rerender } = renderHook(() => useEncryptedWalletBackupDriver(false));
  const previousInput = mocks.input!;
  const previousSignal = previousInput.signal as AbortSignal;
  mocks.mnemonic = "delta epsilon zeta";
  rerender();
  await waitFor(() => expect(mocks.input).not.toBe(previousInput));
  expect(previousSignal.aborted).toBe(true);
  expect(result.current.recoveryStatus).toEqual({
    kind: "preparing",
    reason: "driver-unavailable",
  });
});

it("exposes pending reason and retries the existing driver", () => {
  const { result } = renderHook(() => useEncryptedWalletBackupDriver(true));
  expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
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
  expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
});

it("recreates a terminal driver on Retry and ignores callbacks from the stopped owner", () => {
  const { result, unmount } = renderHook(() => useEncryptedWalletBackupDriver(true));
  const staleCallback = mocks.callback;
  const previousSignal = mocks.input?.signal as AbortSignal;
  act(() => mocks.callback?.({ kind: "failed" }));
  expect(result.current.recoveryStatus).toEqual({ kind: "failed" });
  act(() => result.current.retryRecovery());
  expect(mocks.driver.stop).toHaveBeenCalledOnce();
  expect(mocks.unregister).toHaveBeenCalledOnce();
  expect(previousSignal.aborted).toBe(true);
  expect(mocks.callback).not.toBe(staleCallback);
  expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
  act(() => staleCallback?.({ kind: "ready" }));
  expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
  act(() => mocks.callback?.({ kind: "ready" }));
  expect(result.current.recoveryStatus).toEqual({ kind: "ready" });
  expect(mocks.driver.resumeAfterRecovery).not.toHaveBeenCalled();
  unmount();
});

it("aborts and replaces the driver when the authenticated signer session changes", async () => {
  const { rerender } = renderHook(() => useEncryptedWalletBackupDriver(true));
  const previousInput = mocks.input!;
  const previousSignal = previousInput.signal as AbortSignal;

  act(() => advanceNostrSignerRevision());
  rerender();

  await waitFor(() => expect(previousSignal.aborted).toBe(true));
  expect(mocks.driver.stop).toHaveBeenCalled();
  expect(mocks.input).not.toBe(previousInput);
});

it.each(["wrong-account", "inactive", "incompatible-discovery"] as const)(
  "preserves blocked %s status and restarts explicitly",
  (reason) => {
    const { result } = renderHook(() => useEncryptedWalletBackupDriver(true));
    const before = mocks.input;
    act(() => mocks.callback!({ kind: "blocked", reason }));
    expect(result.current.recoveryStatus).toEqual({ kind: "blocked", reason });
    expect(mocks.driver.resumeAfterRecovery).not.toHaveBeenCalled();
    act(() => result.current.retryRecovery());
    expect(mocks.input).not.toBe(before);
    expect(mocks.driver.stop).toHaveBeenCalled();
    expect(result.current.recoveryStatus).toEqual({ kind: "preparing", reason: "authentication" });
  },
);
