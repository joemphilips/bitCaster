import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeBrowserWalletActivation,
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
  subscribeBrowserWalletActivation,
} from "../browserWalletProfile";

const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

describe("browser wallet activation", () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  it("starts each activation with a new epoch, including the invalidation and the same wallet", () => {
    const scopeA = browserWalletScopeIdFromMnemonic(MNEMONIC_A);
    const scopeB = browserWalletScopeIdFromMnemonic(MNEMONIC_B);
    const start = activeBrowserWalletActivation().epoch;

    setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(activeBrowserWalletActivation()).toEqual({ scopeId: scopeA, epoch: start + 1 });
    setActiveBrowserWalletProfile("");
    expect(activeBrowserWalletActivation()).toEqual({ scopeId: null, epoch: start + 2 });
    setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(activeBrowserWalletActivation()).toEqual({ scopeId: scopeA, epoch: start + 3 });
    setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(activeBrowserWalletActivation()).toEqual({ scopeId: scopeA, epoch: start + 4 });
    setActiveBrowserWalletProfile(MNEMONIC_B);
    expect(activeBrowserWalletActivation()).toEqual({ scopeId: scopeB, epoch: start + 5 });
    expect(activeBrowserWalletScopeId()).toBe(scopeB);
  });

  it("keeps one snapshot between activations", () => {
    setActiveBrowserWalletProfile(MNEMONIC_A);
    const snapshot = activeBrowserWalletActivation();
    expect(activeBrowserWalletActivation()).toBe(snapshot);
    setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(activeBrowserWalletActivation()).not.toBe(snapshot);
  });

  it("notifies each subscriber once for each activation until it unsubscribes", () => {
    const seen: Array<{ scopeId: string | null; epoch: number }> = [];
    const unsubscribe = subscribeBrowserWalletActivation(() => {
      seen.push(activeBrowserWalletActivation());
    });
    unsubscribers.push(unsubscribe);
    const start = activeBrowserWalletActivation().epoch;

    setActiveBrowserWalletProfile(MNEMONIC_A);
    setActiveBrowserWalletProfile("");
    unsubscribe();
    setActiveBrowserWalletProfile(MNEMONIC_A);

    expect(seen).toEqual([
      { scopeId: browserWalletScopeIdFromMnemonic(MNEMONIC_A), epoch: start + 1 },
      { scopeId: null, epoch: start + 2 },
    ]);
  });

  it("starts a reloaded page with no active wallet and the first epoch", async () => {
    setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(activeBrowserWalletActivation().epoch).toBeGreaterThan(0);

    // A reload evaluates the module again. The epoch lives in page memory only.
    vi.resetModules();
    const reloaded = await import("../browserWalletProfile");

    expect(reloaded.activeBrowserWalletActivation()).toEqual({ scopeId: null, epoch: 0 });
    reloaded.setActiveBrowserWalletProfile(MNEMONIC_A);
    expect(reloaded.activeBrowserWalletActivation()).toEqual({
      scopeId: browserWalletScopeIdFromMnemonic(MNEMONIC_A),
      epoch: 1,
    });
  });
});
