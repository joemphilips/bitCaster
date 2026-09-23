import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeBrowserWalletScopeId,
  browserWalletDatabaseName,
  browserWalletScopeIdFromSeed,
} from "@/lib/browserWalletProfile";
import { resolveEncryptedWalletBackupConfiguration } from "@/lib/encryptedWalletBackupConfig";
import {
  createBrowserEncryptedWalletBackupV2RuntimeDriver,
  registerBrowserEncryptedWalletBackupV2RuntimeDriver,
  type BrowserEncryptedWalletBackupV2RecoveryStatus,
  type BrowserEncryptedWalletBackupV2RuntimeDriver,
} from "@/lib/encryptedWalletBackupDriver";
import { toSeed } from "@/lib/bip39";
import { db } from "@/stores/proof-db";
import { getWalletForMnemonicUnit, useWalletStore } from "@/stores/wallet";

export interface EncryptedWalletBackupDriverState {
  readonly recoveryStatus: BrowserEncryptedWalletBackupV2RecoveryStatus;
  readonly retryRecovery: () => void;
}

const READY_STATUS: BrowserEncryptedWalletBackupV2RecoveryStatus = { kind: "ready" };

/** Mounts V2-only backup work after the signer and wallet mnemonic are ready. */
export function useEncryptedWalletBackupDriver(
  nostrSignerReady: boolean,
): EncryptedWalletBackupDriverState {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const configuration = useMemo(() => resolveEncryptedWalletBackupConfiguration(), []);
  const [recoveryStatus, setRecoveryStatus] =
    useState<BrowserEncryptedWalletBackupV2RecoveryStatus>(READY_STATUS);
  const driverRef = useRef<BrowserEncryptedWalletBackupV2RuntimeDriver | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    driverRef.current = null;
    setRecoveryStatus(READY_STATUS);
    if (!nostrSignerReady || !mnemonic || configuration === null) return;
    const words = mnemonic.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const seed = toSeed(words);
    const scopeId = browserWalletScopeIdFromSeed(seed);
    const database = db;
    if (database.name !== browserWalletDatabaseName(scopeId)) return;
    const controller = new AbortController();
    const isCurrentProfile = () =>
      useWalletStore.getState().mnemonic === mnemonic &&
      activeBrowserWalletScopeId() === scopeId &&
      db === database &&
      database.name === browserWalletDatabaseName(scopeId);
    const onRecoveryStatusChange = (status: BrowserEncryptedWalletBackupV2RecoveryStatus) => {
      if (controller.signal.aborted || generationRef.current !== generation || !isCurrentProfile())
        return;
      setRecoveryStatus((previous) => {
        if (previous.kind !== status.kind) return status;
        if (status.kind === "ready") return previous;
        if (previous.kind === "ready") return status;
        return previous.reason === status.reason ? previous : status;
      });
    };
    const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
      configuration,
      database,
      scopeId,
      seed,
      signal: controller.signal,
      isCurrentProfile,
      onRecoveryStatusChange,
      loadWallet: (mintUrl) => getWalletForMnemonicUnit(mintUrl, "msat", mnemonic),
    });
    driverRef.current = driver;
    const unregister = registerBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId, driver);
    return () => {
      if (generationRef.current === generation) driverRef.current = null;
      unregister();
      controller.abort();
      driver.stop();
    };
  }, [configuration, mnemonic, nostrSignerReady]);

  const retryRecovery = useCallback(() => {
    driverRef.current?.resumeAfterRecovery();
  }, []);

  return { recoveryStatus, retryRecovery };
}
