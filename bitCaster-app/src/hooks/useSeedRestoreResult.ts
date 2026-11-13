import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { SeedRestoreResultDisplay } from "@/components/shared/SeedRestoreResult";
import {
  activeBrowserWalletActivation,
  browserWalletScopeIdFromMnemonic,
  subscribeBrowserWalletActivation,
} from "@/lib/browserWalletProfile";
import { walletRecoveryMintUrls } from "@/lib/walletRecoveryPassSummary";
import {
  seedRestoreDatabase,
  seedRestoreResultIsPartial,
  seedRestoreResultIsRetryable,
} from "@/stores/seed-restore-db";
import { useWalletStore } from "@/stores/wallet";

/**
 * The restore result of the active wallet, from the durable restore rows. A
 * restore has a result when its plan is complete or it stopped at its counter
 * budget. A closed result and a seed that this browser generated show none.
 */
export function useSeedRestoreResult(): SeedRestoreResultDisplay | null {
  const walletKey = useSyncExternalStore(subscribeToWallet, readWalletKey, readWalletKey);
  const activation = useSyncExternalStore(
    subscribeBrowserWalletActivation,
    activeBrowserWalletActivation,
    activeBrowserWalletActivation,
  );
  const [mnemonic = "", mintKey = ""] = walletKey.split("\u0000");
  const scopeId = activeScopeId(mnemonic, activation.scopeId);
  return (
    useLiveQuery(
      async () => (scopeId === null ? null : readResult(scopeId, mintKey.split("\n"))),
      [scopeId, mintKey],
    ) ?? null
  );
}

async function readResult(
  scopeId: string,
  mintUrls: readonly string[],
): Promise<SeedRestoreResultDisplay | null> {
  const database = seedRestoreDatabase(scopeId);
  if ((await database.origins.get(scopeId)) !== undefined) return null;
  let shown = false;
  let partial = false;
  let retryable = false;
  for (const mintUrl of walletRecoveryMintUrls(mintUrls)) {
    const state = await database.states.get([scopeId, mintUrl]);
    if (state === undefined || state.resultDismissedAtMs !== null) continue;
    if (state.initialCompletedAtMs === null && !state.budgetStopped) continue;
    const keysets = await database.keysets
      .where("[scopeId+mintUrl]")
      .equals([scopeId, mintUrl])
      .toArray();
    shown = true;
    partial ||= seedRestoreResultIsPartial(state, keysets);
    retryable ||= seedRestoreResultIsRetryable(state, keysets);
  }
  return shown ? { scopeId, partial, retryable } : null;
}

function activeScopeId(mnemonic: string, activeScope: string | null): string | null {
  if (mnemonic === "" || activeScope === null) return null;
  try {
    return browserWalletScopeIdFromMnemonic(mnemonic) === activeScope ? activeScope : null;
  } catch {
    return null;
  }
}

// Many component tests replace the wallet store with a plain object that has
// only `getState`, so read it through its external-store interface.
type WalletStoreLike = {
  getState?: () => { mnemonic?: string; mints?: readonly { url: string }[] } | undefined;
  subscribe?: (listener: () => void) => () => void;
};

function subscribeToWallet(listener: () => void): () => void {
  return (useWalletStore as unknown as WalletStoreLike).subscribe?.(listener) ?? (() => {});
}

function readWalletKey(): string {
  const state = (useWalletStore as unknown as WalletStoreLike).getState?.();
  const mints = (state?.mints ?? []).map(({ url }) => url).join("\n");
  return `${state?.mnemonic ?? ""}\u0000${mints}`;
}
