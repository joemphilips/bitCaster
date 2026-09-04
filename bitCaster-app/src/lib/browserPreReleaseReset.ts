import Dexie from "dexie";
import { db } from "@/stores/proof-db";
import { resetKormir, setPendingKormirNsec } from "./kormir";

export const PRE_RELEASE_BROWSER_RESET_EPOCH_KEY = "bitcaster.pre-release-reset-epoch";

const PRE_RELEASE_BROWSER_RESET_EPOCH = "phase-9e-5a";

/** This compile-time gate makes the destructive reset impossible in production builds. */
export const PRE_RELEASE_BROWSER_RESET_ENABLED = import.meta.env.DEV;

type BrowserResetStorage = Pick<
  Storage,
  "getItem" | "key" | "length" | "removeItem" | "setItem"
>;

export interface BrowserPreReleaseResetDependencies {
  readonly storage: BrowserResetStorage;
  readonly closeWalletDatabase: () => void;
  readonly resetKormirAuthority: () => void;
  readonly clearPendingKormirNsec: () => void;
  readonly getDatabaseNames: () => Promise<string[]>;
  readonly deleteDatabase: (databaseName: string) => Promise<void>;
}

function isBitcasterBrowserDatabase(name: string): boolean {
  return name === "bitcaster" || name === "kormir" || name.startsWith("bitcaster-wallet-");
}

function isBitcasterBrowserStorageKey(key: string): boolean {
  return key.startsWith("bitcaster-") || key.startsWith("bitcaster.");
}

/** Returns true only for the never-deployed development profile that needs this reset. */
export function shouldRunPreReleaseBrowserReset(
  developmentBuild = PRE_RELEASE_BROWSER_RESET_ENABLED,
  storage: BrowserResetStorage | null =
    developmentBuild && typeof window !== "undefined" ? window.localStorage : null,
): boolean {
  return (
    developmentBuild &&
    storage !== null &&
    storage.getItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY) !== PRE_RELEASE_BROWSER_RESET_EPOCH
  );
}

function browserPreReleaseResetDependencies(): BrowserPreReleaseResetDependencies {
  return {
    storage: window.localStorage,
    closeWalletDatabase: () => db.close(),
    resetKormirAuthority: resetKormir,
    clearPendingKormirNsec: () => setPendingKormirNsec(null),
    getDatabaseNames: () => Dexie.getDatabaseNames(),
    deleteDatabase: (databaseName) => Dexie.delete(databaseName),
  };
}

function clearBitcasterBrowserStorage(storage: BrowserResetStorage): void {
  for (const key of Array.from({ length: storage.length }, (_, index) => storage.key(index))) {
    if (key !== null && isBitcasterBrowserStorageKey(key)) storage.removeItem(key);
  }
}

/**
 * Delete every approved pre-release browser authority before the application
 * starts recovery. This reset is valid only before the first deployment.
 */
export async function resetPreReleaseBrowserState(
  dependencies?: BrowserPreReleaseResetDependencies,
): Promise<boolean> {
  if (!shouldRunPreReleaseBrowserReset()) return false;
  const activeDependencies = dependencies ?? browserPreReleaseResetDependencies();

  // The wallet mnemonic and the Nostr nsec are in namespaced localStorage.
  // Kormir keeps its nsec and oracle event data in the separate `kormir` DB.
  activeDependencies.closeWalletDatabase();
  activeDependencies.resetKormirAuthority();
  activeDependencies.clearPendingKormirNsec();

  const databaseNames = await activeDependencies.getDatabaseNames();
  await Promise.all(
    databaseNames
      .filter(isBitcasterBrowserDatabase)
      .map((databaseName) => activeDependencies.deleteDatabase(databaseName)),
  );

  clearBitcasterBrowserStorage(activeDependencies.storage);
  activeDependencies.storage.setItem(PRE_RELEASE_BROWSER_RESET_EPOCH_KEY, PRE_RELEASE_BROWSER_RESET_EPOCH);
  return true;
}
