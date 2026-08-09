import { useEffect, useMemo } from "react";
import {
  activeBrowserWalletScopeId,
  browserWalletDatabaseName,
  browserWalletScopeIdFromSeed,
} from "@/lib/browserWalletProfile";
import { resolveEncryptedWalletBackupConfiguration } from "@/lib/encryptedWalletBackupConfig";
import {
  createBrowserEncryptedWalletBackupV2RuntimeDriver,
  registerBrowserEncryptedWalletBackupV2RuntimeDriver,
} from "@/lib/encryptedWalletBackupDriver";
import { toSeed } from "@/lib/bip39";
import { db } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

/** Mounts V2-only backup work after the signer and wallet mnemonic are ready. */
export function useEncryptedWalletBackupDriver(nostrSignerReady: boolean): void {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const configuration = useMemo(() => resolveEncryptedWalletBackupConfiguration(), []);

  useEffect(() => {
    if (!nostrSignerReady || !mnemonic || configuration === null) return;
    const words = mnemonic.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const seed = toSeed(words);
    const scopeId = browserWalletScopeIdFromSeed(seed);
    const database = db;
    if (database.name !== browserWalletDatabaseName(scopeId)) return;
    const controller = new AbortController();
    const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
      configuration,
      database,
      scopeId,
      seed,
      signal: controller.signal,
      isCurrentProfile: () =>
        useWalletStore.getState().mnemonic === mnemonic &&
        activeBrowserWalletScopeId() === scopeId &&
        db === database &&
        database.name === browserWalletDatabaseName(scopeId),
    });
    const unregister = registerBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId, driver);
    return () => {
      unregister();
      controller.abort();
      driver.stop();
    };
  }, [configuration, mnemonic, nostrSignerReady]);
}
