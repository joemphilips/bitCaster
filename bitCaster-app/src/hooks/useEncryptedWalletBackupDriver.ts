import { useEffect, useMemo, useRef } from "react";
import {
  createEncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupKeyHandle,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import { browserWalletScopeIdFromSeed } from "@/lib/browserWalletProfile";
import { resolveEncryptedWalletBackupConfiguration } from "@/lib/encryptedWalletBackupConfig";
import { runEncryptedWalletBackupDriverCycle } from "@/lib/encryptedWalletBackupDriver";
import { toSeed } from "@/lib/bip39";
import { db } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

export const ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS = 120_000;

export function createEncryptedWalletBackupBackgroundCycleSignal(
  cleanupSignal: AbortSignal,
  timeoutMilliseconds = ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS,
): AbortSignal {
  return AbortSignal.any([cleanupSignal, AbortSignal.timeout(timeoutMilliseconds)]);
}

/** Starts the default-on bounded backup resumer for the one active wallet. */
export function useEncryptedWalletBackupDriver(nostrSignerReady: boolean): void {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const configuration = useMemo(() => resolveEncryptedWalletBackupConfiguration(), []);
  const ownerId = useRef(`gui-${crypto.randomUUID()}`);

  useEffect(() => {
    if (!nostrSignerReady || !mnemonic || configuration === null) return;
    const words = mnemonic.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const seed = toSeed(words);
    const scopeId = browserWalletScopeIdFromSeed(seed);
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keyHandle: EncryptedWalletBackupKeyHandle | undefined;
    let run: () => Promise<void>;
    run = async (): Promise<void> => {
      try {
        const result = await runEncryptedWalletBackupDriverCycle({
          configuration,
          database: db,
          scopeId,
          keyHandle: requireKeyHandle(keyHandle),
          signal: createEncryptedWalletBackupBackgroundCycleSignal(controller.signal),
          ownerId: ownerId.current,
        });
        if (controller.signal.aborted) return;
        switch (result.state) {
          case "idle-needs-snapshot":
            return;
          case "lease-pending":
            retry = setTimeout(
              () => void run(),
              Math.max(1, result.wakeAtUnixMilliseconds - Date.now()),
            );
            return;
          case "upload-pending":
            retry = setTimeout(() => void run(), 0);
            return;
          case "retry-pending":
            retry = setTimeout(
              () => void run(),
              Math.max(1, result.retryNotBeforeUnixMilliseconds - Date.now()),
            );
            return;
          case "cas-pending":
            if (result.retryNotBeforeUnixMilliseconds === null) return;
            retry = setTimeout(
              () => void run(),
              Math.max(1, result.retryNotBeforeUnixMilliseconds - Date.now()),
            );
            return;
          case "committed":
            return;
        }
      } catch {
        // Terminal and unknown errors require explicit user action or a later app restart.
      }
    };
    void initializeAndRun();
    async function initializeAndRun(): Promise<void> {
      if (configuration === null) return;
      keyHandle = await createEncryptedWalletBackupKeyHandle({
        seed,
        realm: configuration.realm,
      });
      if (!controller.signal.aborted) await run();
    }
    return () => {
      controller.abort();
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [configuration, mnemonic, nostrSignerReady]);
}

function requireKeyHandle(
  value: EncryptedWalletBackupKeyHandle | undefined,
): EncryptedWalletBackupKeyHandle {
  if (value === undefined) throw new Error("encrypted wallet backup key handle is unavailable");
  return value;
}
