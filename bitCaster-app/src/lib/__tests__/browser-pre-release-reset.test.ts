import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  PRE_RELEASE_BROWSER_RESET_EPOCH_KEY,
  PRE_RELEASE_BROWSER_RESET_ENABLED,
  resetPreReleaseBrowserState,
  shouldRunPreReleaseBrowserReset,
  type BrowserPreReleaseResetDependencies,
} from "../browserPreReleaseReset";
import { reconcileAcceptedLocalWalletPayments } from "../pendingLocalWalletPayments";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { activateBrowserWalletDatabase, db } from "../../stores/proof-db";

const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: "11".repeat(32),
});
const databaseName = browserWalletDatabaseName(scopeId);

afterEach(async () => {
  db.close();
  localStorage.clear();
  await Promise.all([Dexie.delete(databaseName), Dexie.delete("kormir")]);
});

describe("pre-release browser reset", () => {
  it("runs only for the compile-time development build before the reset epoch", () => {
    expect(shouldRunPreReleaseBrowserReset()).toBe(PRE_RELEASE_BROWSER_RESET_ENABLED);
    const productionStorage = {
      length: 0,
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    expect(shouldRunPreReleaseBrowserReset(false, productionStorage)).toBe(false);
    expect(productionStorage.getItem).not.toHaveBeenCalled();
    localStorage.setItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY, "phase-9e-5a");
    expect(shouldRunPreReleaseBrowserReset()).toBe(false);
  });

  it("clears v16 Dexie, the accepted payment journal, Kormir, and persisted seed and Nostr authority before reconciliation", async () => {
    const legacy = new Dexie(databaseName);
    legacy.version(16).stores({ proofs: "&secret" });
    await legacy.open();
    await legacy.table("proofs").put({ secret: "legacy-proof" });
    legacy.close();

    const kormir = new Dexie("kormir");
    kormir.version(1).stores({ oracle: "&key" });
    await kormir.open();
    await kormir.table("oracle").bulkPut([
      { key: "nsec", value: "legacy-nsec" },
      { key: "oracle_data/legacy-event", value: "legacy-event" },
    ]);
    kormir.close();

    localStorage.setItem("bitcaster-wallet", JSON.stringify({ state: { mnemonic: "legacy seed" } }));
    localStorage.setItem("bitcaster-settings", JSON.stringify({ state: { nsecSecret: "legacy-nsec" } }));
    localStorage.setItem(
      "bitcaster.pendingLocalWalletPayments.v1",
      JSON.stringify([
        {
          id: "accepted-incomplete",
          status: "accepted-but-not-completed",
          sendProofs: [],
          keepProofs: [{ id: "keyset", amount: 1, secret: "journal-proof", C: "point" }],
          spentSecrets: ["spent-proof"],
          target: {
            mintUrl: "https://mint.example",
            amountSubunits: 1,
            baseAsset: "sat",
            unit: "msat",
            reservationPurpose: "test",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );

    expect(await resetPreReleaseBrowserState()).toBe(true);

    expect(localStorage.getItem("bitcaster-wallet")).toBeNull();
    expect(localStorage.getItem("bitcaster-settings")).toBeNull();
    expect(localStorage.getItem("bitcaster.pendingLocalWalletPayments.v1")).toBeNull();
    expect(localStorage.getItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY)).not.toBeNull();
    expect(await Dexie.getDatabaseNames()).not.toContain(databaseName);
    expect(await Dexie.getDatabaseNames()).not.toContain("kormir");

    activateBrowserWalletDatabase(scopeId);
    await db.open();
    await reconcileAcceptedLocalWalletPayments();
    expect(await db.proofs.count()).toBe(0);
  });

  it("preserves current state after the reset epoch is recorded", async () => {
    expect(await resetPreReleaseBrowserState()).toBe(true);

    activateBrowserWalletDatabase(scopeId);
    await db.open();
    await db.proofs.put({
      secret: "current-proof",
      id: "keyset",
      C: "point",
      amount: 1,
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "msat",
    });
    localStorage.setItem("bitcaster-wallet", JSON.stringify({ state: { mnemonic: "current seed" } }));

    expect(await resetPreReleaseBrowserState()).toBe(false);
    expect(await db.proofs.get("current-proof")).toMatchObject({ secret: "current-proof" });
    expect(localStorage.getItem("bitcaster-wallet")).toBe(
      JSON.stringify({ state: { mnemonic: "current seed" } }),
    );
  });

  it("keeps the epoch absent after a failed delete and retries before recovery can mount", async () => {
    localStorage.setItem("bitcaster-wallet", JSON.stringify({ state: { mnemonic: "legacy seed" } }));
    let failDelete = true;
    const deleteDatabase = vi.fn(async (databaseName: string) => {
      if (failDelete && databaseName === "kormir") throw new Error("injected delete failure");
    });
    const dependencies: BrowserPreReleaseResetDependencies = {
      storage: localStorage,
      closeWalletDatabase: vi.fn(),
      resetKormirAuthority: vi.fn(),
      clearPendingKormirNsec: vi.fn(),
      getDatabaseNames: vi.fn(async () => ["bitcaster-wallet-old", "kormir"]),
      deleteDatabase,
    };

    await expect(resetPreReleaseBrowserState(dependencies)).rejects.toThrow("injected delete failure");
    expect(localStorage.getItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY)).toBeNull();
    expect(localStorage.getItem("bitcaster-wallet")).not.toBeNull();

    failDelete = false;
    await expect(resetPreReleaseBrowserState(dependencies)).resolves.toBe(true);
    expect(localStorage.getItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY)).not.toBeNull();
    expect(localStorage.getItem("bitcaster-wallet")).toBeNull();
    expect(deleteDatabase).toHaveBeenCalledTimes(4);
  });
});
