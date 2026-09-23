import { useEffect } from "react";
import {
  recoverKeysetCountersForMint,
  recoverBrowserDurableOutgoingCashuTransfersInPass,
  recoverPendingTokenReceives,
  recoverPendingWalletMints,
} from "@/lib/cashu";
import { recoverBrowserCtfRangeOrders } from "@/lib/browserCtfRangeOrderSubmission";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import {
  hasActiveBrowserCtfRangeOrderAttempt,
  listenForBrowserCtfRangeRecoveryWake,
} from "@/lib/browserCtfRangeOrderRecoveryWake";
import { resumeBrowserEncryptedWalletBackupV2AfterRecovery } from "@/lib/encryptedWalletBackupDriver";

const RANGE_RECOVERY_RETRY_MS = 15_000;

export function useBrowserCtfRangeOrderRecovery(input: {
  readonly nostrSignerReady: boolean;
  readonly walletMnemonic: string;
  readonly walletMintUrls: string;
}): void {
  const { nostrSignerReady, walletMnemonic, walletMintUrls } = input;

  // Another device can advance the shared seed's cursor. Recover default msat
  // keysets before reuse; scanning every conditional keyset at startup is unbounded.
  useEffect(() => {
    if (!walletMnemonic || !nostrSignerReady) return;
    const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
    if (scopeId === null) return;
    const mintUrls = walletMintUrls.split("\n").filter(Boolean);
    let cancelled = false;
    let running = false;
    let rerunRequested = false;
    let receivesRecovered = false;
    let receiveCacheRepaired = false;
    let receiveRecoveryAfterOperationId: string | null = null;
    let mintsRecovered = false;
    let countersRecovered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void runRecovery();
      }, RANGE_RECOVERY_RETRY_MS);
    };
    const runRecovery = async () => {
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      let retryRequired = false;
      try {
        if (!receivesRecovered) {
          try {
            const result = await recoverPendingTokenReceives({
              repairCurrentInventory: !receiveCacheRepaired,
              afterOperationId: receiveRecoveryAfterOperationId,
            });
            receiveCacheRepaired = true;
            receiveRecoveryAfterOperationId = result.lastAttemptedOperationId;
            receivesRecovered = result.pending === 0;
            retryRequired ||= !receivesRecovered;
          } catch {
            retryRequired = true;
          }
        }
        if (!mintsRecovered) {
          try {
            const result = await recoverPendingWalletMints();
            mintsRecovered = result.pending === 0;
            retryRequired ||= !mintsRecovered;
          } catch {
            retryRequired = true;
          }
        }
        if (hasActiveBrowserCtfRangeOrderAttempt(scopeId)) {
          retryRequired = true;
        } else {
          try {
            const result = await recoverBrowserCtfRangeOrders({
              mnemonic: walletMnemonic,
              mintUrls,
            });
            retryRequired ||= result.pending.length > 0;
          } catch {
            retryRequired = true;
          }
        }
        try {
          const result = await recoverBrowserDurableOutgoingCashuTransfersInPass({
            mintUrls,
            passCutoffMs: Date.now(),
          });
          retryRequired ||= result.pending > 0 || result.hasMore;
        } catch {
          retryRequired = true;
        }
        if (!countersRecovered) {
          try {
            let complete = true;
            for (const mintUrl of mintUrls) {
              const result = await recoverKeysetCountersForMint(mintUrl, { baseAsset: "sat" });
              complete &&= result.complete;
            }
            countersRecovered = complete;
            retryRequired ||= !complete;
          } catch {
            retryRequired = true;
          }
        }
      } finally {
        running = false;
        resumeBrowserEncryptedWalletBackupV2AfterRecovery(scopeId);
        if (retryRequired) schedule();
        if (rerunRequested && !cancelled) {
          rerunRequested = false;
          void runRecovery();
        }
      }
    };
    const onOnline = () => void runRecovery();
    const stopRecoveryWake = listenForBrowserCtfRangeRecoveryWake(scopeId, () => {
      void runRecovery();
    });
    window.addEventListener("online", onOnline);
    void runRecovery();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      stopRecoveryWake();
    };
  }, [nostrSignerReady, walletMnemonic, walletMintUrls]);
}
