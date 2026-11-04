import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { hasActiveCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { db, type BitcasterDB } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

/**
 * Order status reads and settlement need the Nostr signer. Read only local
 * state: the pending orders that the settlement lifecycle keeps until they
 * are terminal, and the active range orders in the wallet journal.
 */
export async function hasLocalOrdersInProgress(database: BitcasterDB = db): Promise<boolean> {
  // Include every wallet. A later restore of that wallet still needs this signer.
  if (Object.keys(usePendingTradesStore.getState().byOrderId).length > 0) return true;
  const scopeId = browserWalletScopeIdFromMnemonic(useWalletStore.getState().mnemonic);
  if (scopeId === null) return false;
  try {
    return await hasActiveCtfRangePreparation(scopeId, database);
  } catch {
    // An unreadable journal can hold active work. Keep the only copy of the key.
    return true;
  }
}
