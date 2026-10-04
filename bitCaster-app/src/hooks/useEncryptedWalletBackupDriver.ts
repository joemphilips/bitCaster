import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeBrowserWalletScopeId,
  browserWalletDatabaseName,
  browserWalletScopeIdFromSeed,
} from "@/lib/browserWalletProfile";
import { resolveEncryptedWalletBackupConfiguration } from "@/lib/encryptedWalletBackupConfig";
import {
  BrowserWalletRecoveryRequiredError,
  requireBrowserWalletNewWritePermission,
} from "@/lib/browserWalletNewWritePermission";
import { assertNever } from "@/lib/enumDiscipline";
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
    useState<BrowserEncryptedWalletBackupV2RecoveryStatus>(() =>
      nostrSignerReady && mnemonic && configuration !== null
        ? { kind: "preparing", reason: "authentication" }
        : READY_STATUS,
    );
  const [restart, setRestart] = useState(0);
  const driverRef = useRef<BrowserEncryptedWalletBackupV2RuntimeDriver | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    driverRef.current = null;
    setRecoveryStatus(READY_STATUS);
    if (!mnemonic || configuration === null) return;
    const controller = new AbortController();
    let driver: BrowserEncryptedWalletBackupV2RuntimeDriver | undefined;
    let unregister: (() => void) | undefined;
    try {
      const words = mnemonic.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return;
      const seed = toSeed(words);
      const scopeId = browserWalletScopeIdFromSeed(seed);
      const database = db;
      if (database.name !== browserWalletDatabaseName(scopeId)) return;
      const isCurrentProfile = () =>
        useWalletStore.getState().mnemonic === mnemonic &&
        activeBrowserWalletScopeId() === scopeId &&
        db === database &&
        database.name === browserWalletDatabaseName(scopeId);
      const onRecoveryStatusChange = (status: BrowserEncryptedWalletBackupV2RecoveryStatus) => {
        if (
          controller.signal.aborted ||
          generationRef.current !== generation ||
          !isCurrentProfile()
        )
          return;
        setRecoveryStatus((previous) => {
          if (previous.kind !== status.kind) return status;
          switch (status.kind) {
            case "ready":
            case "failed":
              return previous;
            case "preparing":
            case "recovering":
              return "reason" in previous && previous.reason === status.reason ? previous : status;
            default:
              return assertNever(status);
          }
        });
      };
      if (!nostrSignerReady) {
        // Missing signers do not block an unenrolled wallet. Project the existing read-only guard.
        void readNoDriverStatus(database, scopeId).then(onRecoveryStatusChange);
        return () => controller.abort();
      }
      onRecoveryStatusChange({ kind: "preparing", reason: "authentication" });
      driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
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
      unregister = registerBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId, driver);
    } catch {
      setRecoveryStatus({ kind: "failed" });
    }
    return () => {
      if (generationRef.current === generation) driverRef.current = null;
      unregister?.();
      controller.abort();
      driver?.stop();
    };
  }, [configuration, mnemonic, nostrSignerReady, restart]);

  const retryRecovery = useCallback(() => {
    switch (recoveryStatus.kind) {
      case "recovering":
        if (driverRef.current !== null) driverRef.current.resumeAfterRecovery();
        else setRestart((value) => value + 1);
        break;
      case "failed":
        setRestart((value) => value + 1);
        break;
      case "ready":
      case "preparing":
        break;
      default:
        assertNever(recoveryStatus);
    }
  }, [recoveryStatus]);

  return { recoveryStatus, retryRecovery };
}

async function readNoDriverStatus(
  database: typeof db,
  scopeId: string,
): Promise<BrowserEncryptedWalletBackupV2RecoveryStatus> {
  try {
    await requireBrowserWalletNewWritePermission({ database, scopeId });
    return READY_STATUS;
  } catch (error) {
    if (!(error instanceof BrowserWalletRecoveryRequiredError)) return { kind: "failed" };
    switch (error.reason) {
      case "startup-authentication-pending":
        return { kind: "preparing", reason: "driver-unavailable" };
      case "genuine-conflict":
        return { kind: "recovering", reason: null };
      default:
        return assertNever(error.reason);
    }
  }
}
