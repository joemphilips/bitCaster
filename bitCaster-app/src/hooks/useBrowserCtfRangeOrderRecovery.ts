import { useEffect } from "react";
import {
  recoverKeysetCountersForMint,
  recoverBrowserDurableOutgoingCashuTransfersInPass,
  recoverPendingTokenReceives,
  recoverPendingWalletMints,
} from "@/lib/cashu";
import { recoverBrowserCtfRangeOrders } from "@/lib/browserCtfRangeOrderSubmission";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  deferBrowserCtfRangeOrderRecovery,
  listenForBrowserCtfRangeRecoveryWake,
} from "@/lib/browserCtfRangeOrderRecoveryWake";
import { resumeBrowserEncryptedWalletBackupV2AfterRecovery } from "@/lib/encryptedWalletBackupDriver";
import {
  releaseBrowserSeedPositionRestoreGate,
  resyncBrowserKeysetsInUse,
  runBrowserSeedPositionRestorePass,
} from "@/lib/browserSeedPositionRestore";
import { useToastStore } from "@/stores/toast";
import i18n from "@/i18n";

const RANGE_RECOVERY_RETRY_MS = 15_000;
/** A seed restore pass that ran out of budget continues soon. */
const SEED_RESTORE_CONTINUE_MS = 1_000;

function earliest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function useBrowserCtfRangeOrderRecovery(input: {
  readonly nostrSignerReady: boolean;
  readonly walletMnemonic: string;
  readonly walletMintUrls: string;
}): void {
  const { nostrSignerReady, walletMnemonic, walletMintUrls } = input;

  // Another device can advance the shared seed's cursor. Recover default msat
  // keysets before reuse, re-sync the keysets in use (ADR-033), and run the
  // budgeted seed restore of conditional keysets (ADR-039).
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
    let usedElsewhereShown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isCurrent = () => !cancelled && activeBrowserWalletScopeId() === scopeId;
    const clearRetry = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delayMs = RANGE_RECOVERY_RETRY_MS) => {
      if (!isCurrent() || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void runRecovery();
      }, delayMs);
    };
    const runRecovery = async () => {
      if (!isCurrent()) return;
      clearRetry();
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      let retryRequired = false;
      let restoreMore = false;
      // The re-sync and the restore keep their own durable backoffs.
      let retryAtMs: number | null = null;
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
        if (!isCurrent()) return;
        if (!mintsRecovered) {
          try {
            const result = await recoverPendingWalletMints();
            mintsRecovered = result.pending === 0;
            retryRequired ||= !mintsRecovered;
          } catch {
            retryRequired = true;
          }
        }
        if (!isCurrent()) return;
        if (deferBrowserCtfRangeOrderRecovery(scopeId)) {
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
        if (!isCurrent()) return;
        try {
          const result = await recoverBrowserDurableOutgoingCashuTransfersInPass({
            mintUrls,
            passCutoffMs: Date.now(),
          });
          retryRequired ||= result.pending > 0 || result.hasMore;
        } catch {
          retryRequired = true;
        }
        if (!isCurrent()) return;
        if (!countersRecovered) {
          try {
            let complete = true;
            for (const mintUrl of mintUrls) {
              const result = await recoverKeysetCountersForMint(mintUrl, { baseAsset: "sat" });
              if (!isCurrent()) return;
              // A PENDING proof waits in its deferral marker, which the
              // re-sync retries with a backoff. Only a failure retries here.
              complete &&= result.complete || result.failed === false;
            }
            countersRecovered = complete;
            retryRequired ||= !complete;
          } catch {
            retryRequired = true;
          }
        }
        if (!isCurrent()) return;
        // Another client with this seed can sign outputs above the local
        // cursors. The re-sync probes at most daily, at once after evidence,
        // and admits deferred outputs when their backoff ends (ADR-033).
        try {
          for (const mintUrl of mintUrls) {
            const result = await resyncBrowserKeysetsInUse({
              scopeId,
              mnemonic: walletMnemonic,
              mintUrl,
              yieldControl: yieldToBrowser,
            });
            if (!isCurrent()) return;
            retryAtMs = earliest(retryAtMs, result.retryAtMs);
            if (result.usedElsewhere && !usedElsewhereShown) {
              usedElsewhereShown = true;
              useToastStore.getState().addToast({
                type: "info",
                message: i18n.t("wallet.usedInAnotherBrowser"),
              });
            }
          }
        } catch {
          retryRequired = true;
        }
        if (!isCurrent()) return;
        // The automatic seed restore event (ADR-039, amendment 2026-11-04).
        let hintsSettled = true;
        try {
          for (const mintUrl of mintUrls) {
            const result = await runBrowserSeedPositionRestorePass({
              scopeId,
              mnemonic: walletMnemonic,
              mintUrl,
              yieldControl: yieldToBrowser,
            });
            if (!isCurrent()) return;
            restoreMore ||= result.status === "more";
            retryAtMs = earliest(retryAtMs, result.retryAtMs);
            hintsSettled &&= result.hintsSettled;
          }
        } catch {
          hintsSettled = false;
          retryRequired = true;
        }
        // The first asset-monitoring report waits for the earlier report's hints.
        if (hintsSettled) releaseBrowserSeedPositionRestoreGate(scopeId);
      } finally {
        running = false;
        if (!isCurrent()) return;
        resumeBrowserEncryptedWalletBackupV2AfterRecovery(scopeId);
        if (rerunRequested) {
          rerunRequested = false;
          void runRecovery();
        } else if (restoreMore) {
          schedule(SEED_RESTORE_CONTINUE_MS);
        } else if (retryRequired) {
          schedule();
        } else if (retryAtMs !== null) {
          schedule(Math.max(SEED_RESTORE_CONTINUE_MS, retryAtMs - Date.now()));
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
      rerunRequested = false;
      clearRetry();
      window.removeEventListener("online", onOnline);
      stopRecoveryWake();
    };
  }, [nostrSignerReady, walletMnemonic, walletMintUrls]);
}
