import { useEffect, useSyncExternalStore } from "react";
import {
  recoverKeysetCountersForMint,
  recoverBrowserDurableOutgoingCashuTransfersInPass,
  recoverPendingTokenReceives,
  recoverPendingWalletMints,
} from "@/lib/cashu";
import { recoverBrowserCtfRangeOrders } from "@/lib/browserCtfRangeOrderSubmission";
import {
  activeBrowserWalletActivation,
  browserWalletScopeIdFromMnemonic,
  subscribeBrowserWalletActivation,
} from "@/lib/browserWalletProfile";
import {
  deferBrowserCtfRangeOrderRecovery,
  listenForBrowserCtfRangeRecoveryWake,
} from "@/lib/browserCtfRangeOrderRecoveryWake";
import {
  releaseBrowserSeedPositionRestoreGate,
  resyncBrowserKeysetsInUse,
  runBrowserSeedPositionRestorePass,
} from "@/lib/browserSeedPositionRestore";
import {
  beginWalletRecoveryPass,
  walletRecoveryTag,
  type WalletRecoveryPassWriter,
  type WalletRecoveryStageOutcome,
  type WalletRecoveryWalletStage,
} from "@/lib/walletRecoveryPassSummary";
import { uploadBrowserRecoveryIndexAfterRecovery } from "@/lib/browserRecoveryIndex";
import { reportBrowserWalletUsedElsewhere } from "@/lib/browserWalletUsedElsewhere";

const RANGE_RECOVERY_RETRY_MS = 15_000;
/** A seed restore pass that ran out of budget continues soon. */
const SEED_RESTORE_CONTINUE_MS = 1_000;

function earliest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const STAGE_COMPLETED: WalletRecoveryStageOutcome = { state: "completed" };
/** A stage that waits is retried with the pass. */
const stageWaits = (reason: "operation" | "scan-continues"): WalletRecoveryStageOutcome => ({
  state: "pending",
  reason,
  retryAtMs: Date.now() + RANGE_RECOVERY_RETRY_MS,
});
const stageFailed = (): WalletRecoveryStageOutcome => ({
  state: "failed",
  retryAtMs: Date.now() + RANGE_RECOVERY_RETRY_MS,
});

/** An error class name. A name of another form is not reported. */
const SAFE_ERROR_NAME = /^(?:[A-Z][A-Za-z0-9]{0,62})?(?:Error|Exception)$/;

/**
 * The label of a failed wallet stage. It holds only the stage and the error
 * class name, never the error message, so it cannot expose a proof, a secret,
 * or an amount.
 */
function walletRecoveryStageErrorLabel(stage: WalletRecoveryWalletStage, error: unknown): string {
  let name = "unknown";
  try {
    const candidate =
      typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
    if (typeof candidate === "string" && SAFE_ERROR_NAME.test(candidate)) name = candidate;
  } catch {
    // A diagnostic must not invoke an untrusted error getter again.
  }
  return `wallet-recovery-stage-error=${stage} error=${name}`;
}

function stageFailedWith(
  stage: WalletRecoveryWalletStage,
  error: unknown,
): WalletRecoveryStageOutcome {
  console.warn(walletRecoveryStageErrorLabel(stage, error));
  return stageFailed();
}

const activationEpoch = () => activeBrowserWalletActivation().epoch;

export function useBrowserCtfRangeOrderRecovery(input: {
  readonly nostrSignerReady: boolean;
  readonly walletMnemonic: string;
  readonly walletMintUrls: string;
}): void {
  const { nostrSignerReady, walletMnemonic, walletMintUrls } = input;
  // Each activation restarts the coordinator, also an activation of the same
  // wallet after the failed handoff of a replacement (A -> "" -> A).
  const epoch = useSyncExternalStore(
    subscribeBrowserWalletActivation,
    activationEpoch,
    activationEpoch,
  );

  // Another device can advance the shared seed's cursor. Recover default msat
  // keysets before reuse, re-sync the keysets in use (ADR-033), and run the
  // budgeted seed restore of conditional keysets (ADR-039).
  useEffect(() => {
    if (!walletMnemonic || !nostrSignerReady) return;
    const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
    if (scopeId === null) return;
    const mintUrls = walletMintUrls.split("\n").filter(Boolean);
    // The display-only pass summary of the recovery status (issue #161).
    const summaryTag = walletRecoveryTag({ scopeId, epoch }, mintUrls);
    let summary: WalletRecoveryPassWriter | null = null;
    let cancelled = false;
    let running = false;
    let rerunRequested = false;
    let receivesRecovered = false;
    let receiveCacheRepaired = false;
    let receiveRecoveryAfterOperationId: string | null = null;
    let mintsRecovered = false;
    let countersRecovered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // A late result of an earlier activation of this wallet (A -> B -> A) is
    // not current, also before React renders the new activation.
    const isCurrent = () => {
      const activation = activeBrowserWalletActivation();
      return !cancelled && activation.scopeId === scopeId && activation.epoch === epoch;
    };
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
      const pass = beginWalletRecoveryPass(summaryTag, isCurrent);
      summary = pass;
      let passRan = false;
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
            pass.walletStage(
              "receives",
              receivesRecovered ? STAGE_COMPLETED : stageWaits("operation"),
            );
          } catch (error) {
            retryRequired = true;
            pass.walletStage("receives", stageFailedWith("receives", error));
          }
        }
        if (!isCurrent()) return;
        if (!mintsRecovered) {
          try {
            const result = await recoverPendingWalletMints();
            mintsRecovered = result.pending === 0;
            retryRequired ||= !mintsRecovered;
            pass.walletStage("mints", mintsRecovered ? STAGE_COMPLETED : stageWaits("operation"));
          } catch (error) {
            retryRequired = true;
            pass.walletStage("mints", stageFailedWith("mints", error));
          }
        }
        if (!isCurrent()) return;
        if (deferBrowserCtfRangeOrderRecovery(scopeId)) {
          retryRequired = true;
          pass.walletStage("rangeOrders", stageWaits("operation"));
        } else {
          try {
            const result = await recoverBrowserCtfRangeOrders({
              mnemonic: walletMnemonic,
              mintUrls,
            });
            retryRequired ||= result.pending.length > 0;
            pass.walletStage(
              "rangeOrders",
              result.pending.length > 0 ? stageWaits("operation") : STAGE_COMPLETED,
            );
          } catch (error) {
            retryRequired = true;
            pass.walletStage("rangeOrders", stageFailedWith("rangeOrders", error));
          }
        }
        if (!isCurrent()) return;
        try {
          const result = await recoverBrowserDurableOutgoingCashuTransfersInPass({
            mintUrls,
            passCutoffMs: Date.now(),
          });
          retryRequired ||= result.pending > 0 || result.hasMore;
          pass.walletStage(
            "outgoing",
            result.pending > 0
              ? stageWaits("operation")
              : result.hasMore
                ? stageWaits("scan-continues")
                : STAGE_COMPLETED,
          );
        } catch (error) {
          retryRequired = true;
          pass.walletStage("outgoing", stageFailedWith("outgoing", error));
        }
        if (!isCurrent()) return;
        if (!countersRecovered) {
          let counterMintUrl: string | null = null;
          try {
            let complete = true;
            for (const mintUrl of mintUrls) {
              counterMintUrl = mintUrl;
              const result = await recoverKeysetCountersForMint(mintUrl, { baseAsset: "sat" });
              if (!isCurrent()) return;
              pass.regularCounters(mintUrl, result, Date.now() + RANGE_RECOVERY_RETRY_MS);
              // A PENDING proof waits in its deferral marker, which the
              // re-sync retries with a backoff. Only a failure retries here.
              complete &&= result.complete || result.failed === false;
            }
            countersRecovered = complete;
            retryRequired ||= !complete;
          } catch {
            retryRequired = true;
            if (counterMintUrl !== null) {
              pass.regularCounters(counterMintUrl, "error", Date.now() + RANGE_RECOVERY_RETRY_MS);
            }
          }
        }
        if (!isCurrent()) return;
        // Another client with this seed can sign outputs above the local
        // cursors. The re-sync probes only after evidence of another client,
        // and admits deferred outputs when their backoff ends (ADR-033).
        let resyncMintUrl: string | null = null;
        try {
          for (const mintUrl of mintUrls) {
            resyncMintUrl = mintUrl;
            const result = await resyncBrowserKeysetsInUse({
              scopeId,
              mnemonic: walletMnemonic,
              mintUrl,
              yieldControl: yieldToBrowser,
            });
            if (!isCurrent()) return;
            // The re-sync rows show its deferrals and probes.
            pass.resyncPass(mintUrl, STAGE_COMPLETED);
            retryAtMs = earliest(retryAtMs, result.retryAtMs);
            if (result.usedElsewhere) reportBrowserWalletUsedElsewhere(scopeId);
          }
        } catch {
          retryRequired = true;
          if (resyncMintUrl !== null) pass.resyncPass(resyncMintUrl, stageFailed());
        }
        if (!isCurrent()) return;
        // The automatic seed restore event (ADR-039, amendment 2026-11-04).
        let hintsSettled = true;
        let restoreMintUrl: string | null = null;
        try {
          for (const mintUrl of mintUrls) {
            restoreMintUrl = mintUrl;
            const result = await runBrowserSeedPositionRestorePass({
              scopeId,
              mnemonic: walletMnemonic,
              mintUrl,
              yieldControl: yieldToBrowser,
            });
            if (!isCurrent()) return;
            pass.seedRestorePass(mintUrl, result, Date.now() + SEED_RESTORE_CONTINUE_MS);
            restoreMore ||= result.status === "more";
            retryAtMs = earliest(retryAtMs, result.retryAtMs);
            hintsSettled &&= result.hintsSettled;
          }
        } catch {
          hintsSettled = false;
          retryRequired = true;
          if (restoreMintUrl !== null) {
            pass.seedRestorePass(restoreMintUrl, "error", Date.now() + RANGE_RECOVERY_RETRY_MS);
          }
        }
        passRan = true;
        // The first asset-monitoring report waits for the earlier report's hints.
        if (hintsSettled) releaseBrowserSeedPositionRestoreGate(scopeId);
      } finally {
        running = false;
        // A pass that stopped early is dropped with every summary write.
        if (passRan) pass.complete();
        else pass.discard();
        if (summary === pass) summary = null;
        if (!isCurrent()) return;
        uploadBrowserRecoveryIndexAfterRecovery(scopeId);
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
      summary?.discard();
      clearRetry();
      window.removeEventListener("online", onOnline);
      stopRecoveryWake();
    };
  }, [epoch, nostrSignerReady, walletMnemonic, walletMintUrls]);
}
