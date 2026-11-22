import { useMemo, useSyncExternalStore } from "react";
import {
  sameWalletRecoveryTag,
  type WalletRecoveryTag,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import {
  activeBrowserWalletActivation,
  subscribeBrowserWalletActivation,
} from "@/lib/browserWalletProfile";
import {
  getWalletRecoveryPassSummary,
  subscribeWalletRecoveryPassSummary,
  walletRecoveryTag,
} from "@/lib/walletRecoveryPassSummary";

/** Where a holdings read starts: the current tag and the latest completed pass. */
export interface WalletRecoveryReadPosition {
  /** Null when the wallet is not the active profile. */
  readonly tag: WalletRecoveryTag | null;
  /** The passes of this tag that ran every stage in this page. */
  readonly passSeq: number;
}

/**
 * The tag and the pass count that a holdings read of the wallet records
 * (issue #161). A holdings query takes both as dependencies, so a new
 * activation and each completed pass start a new read.
 */
export function useWalletRecoveryReadPosition(
  scopeId: string | null,
  mintUrls: readonly string[],
): WalletRecoveryReadPosition {
  const activation = useSyncExternalStore(
    subscribeBrowserWalletActivation,
    activeBrowserWalletActivation,
    activeBrowserWalletActivation,
  );
  const summary = useSyncExternalStore(
    subscribeWalletRecoveryPassSummary,
    getWalletRecoveryPassSummary,
    getWalletRecoveryPassSummary,
  );
  const mintKey = mintUrls.join("\n");
  const tag = useMemo(
    () =>
      scopeId === null || activation.scopeId !== scopeId
        ? null
        : walletRecoveryTag({ scopeId, epoch: activation.epoch }, mintKey.split("\n")),
    [scopeId, activation, mintKey],
  );
  // An open pass keeps the count of its base, so only a completed pass changes it.
  const passSeq =
    tag !== null && summary !== null && sameWalletRecoveryTag(summary.tag, tag)
      ? summary.passSeq
      : 0;
  return useMemo(() => ({ tag, passSeq }), [tag, passSeq]);
}
