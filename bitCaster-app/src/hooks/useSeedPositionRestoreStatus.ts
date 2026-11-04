import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { SEED_RESTORE_PERSISTENT_FAILURES } from "@/lib/browserSeedPositionRestore";
import { seedRestoreDatabase } from "@/stores/seed-restore-db";
import { useWalletStore } from "@/stores/wallet";

export type SeedPositionRestoreStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "restoring"; readonly scopeId: string }
  | { readonly kind: "failed"; readonly scopeId: string };

/** The state of the automatic seed restore for the active wallet (ADR-039). */
export function useSeedPositionRestoreStatus(): SeedPositionRestoreStatus {
  // Read the store through its external-store interface. Many component tests
  // replace the wallet store with a plain object that has only `getState`.
  const walletKey = useSyncExternalStore(subscribeToWallet, readWalletKey, readWalletKey);
  const [mnemonic = "", mintKey = ""] = walletKey.split("\u0000");
  const scopeId = mnemonic ? walletScopeId(mnemonic) : null;
  const status = useLiveQuery(async (): Promise<SeedPositionRestoreStatus> => {
    if (scopeId === null || mintKey === "") return { kind: "idle" };
    try {
      return await readSeedPositionRestoreStatus(scopeId);
    } catch {
      // A display read failure must not hide the page. The restore still runs.
      return { kind: "idle" };
    }
  }, [scopeId, mintKey]);
  return status ?? { kind: "idle" };
}

/**
 * Reads the restore state of one wallet scope. A failed restore pass, a
 * condition listing or keyset scan that keeps failing, or a deferral that
 * cannot be admitted shows the persistent error. A deferral can hold funds or
 * positions of a seed that this profile generated too.
 */
export async function readSeedPositionRestoreStatus(
  scopeId: string,
): Promise<SeedPositionRestoreStatus> {
  const database = seedRestoreDatabase(scopeId);
  const ofScope = [
    [scopeId, ""],
    [scopeId, "\uffff"],
  ] as const;
  const deferrals = await database.resync
    .where("[scopeId+mintUrl]")
    .between(...ofScope, true, true)
    .toArray();
  if (
    deferrals.some(
      (row) =>
        row.pendingFromCounter !== null &&
        row.waitReason === "admission-failed" &&
        row.failures >= SEED_RESTORE_PERSISTENT_FAILURES,
    )
  ) {
    return { kind: "failed", scopeId };
  }
  if ((await database.origins.get(scopeId))?.origin === "generated") return { kind: "idle" };
  const states = await database.states
    .where("[scopeId+mintUrl]")
    .between(...ofScope, true, true)
    .toArray();
  if (
    states.some(
      (state) =>
        state.failures >= SEED_RESTORE_PERSISTENT_FAILURES ||
        state.itemFailures >= SEED_RESTORE_PERSISTENT_FAILURES,
    )
  ) {
    return { kind: "failed", scopeId };
  }
  // Before the first pass writes its state, the restore has not finished.
  if (states.length === 0 || states.some((state) => state.initialCompletedAtMs === null)) {
    return { kind: "restoring", scopeId };
  }
  return { kind: "idle" };
}

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

function walletScopeId(mnemonic: string): string | null {
  try {
    return browserWalletScopeIdFromMnemonic(mnemonic);
  } catch {
    // The notice is display only. An unreadable profile shows nothing.
    return null;
  }
}
