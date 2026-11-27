/** The localStorage name of the persisted wallet store (stores/wallet.ts). */
export const WALLET_STORAGE_KEY = "bitcaster-wallet";

/** The secret that lets a user open this browser's wallet in another browser or origin. */
export interface PersistedWalletSecrets {
  /** The BIP-39 recovery phrase of the wallet, or null when the browser has no wallet. */
  readonly seedWords: readonly string[] | null;
}

function persistedState(storage: Pick<Storage, "getItem">, key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (typeof value !== "object" || value === null) return {};
    const state: unknown = (value as { state?: unknown }).state;
    return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Reads the persisted recovery phrase only. It does not write or migrate the storage, and it
 * does not start the stores, so that a page that must not change the wallet can show it.
 */
export function readPersistedWalletSecrets(
  storage: Pick<Storage, "getItem">,
): PersistedWalletSecrets {
  const { mnemonic } = persistedState(storage, WALLET_STORAGE_KEY);
  const words = typeof mnemonic === "string" ? mnemonic.trim().split(/\s+/).filter(Boolean) : [];
  return { seedWords: words.length > 0 ? words : null };
}
