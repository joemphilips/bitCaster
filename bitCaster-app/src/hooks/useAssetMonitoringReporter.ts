import { useEffect, useSyncExternalStore } from "react";
import type { Transaction } from "dexie";
import {
  AssetMonitoringReporter,
  buildAssetMonitoringHoldings,
  fetchAssetMonitoringCatalogue,
} from "@/lib/assetMonitoringReporter";
import {
  activeBrowserWalletScopeId,
  browserWalletDatabaseName,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { createAuthenticatedBrowserEngineClient } from "@/lib/markets";
import { getNdk, getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import { hasSubmittedCtfRangeOrder } from "@/stores/ctf-range-order-db";
import {
  db,
  isCtfProof,
  storedProofFromRow,
  type BitcasterDB,
  type StoredProof,
  type StoredProofRow,
} from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

/** Mounts fail-open asset-monitoring reports for the active wallet profile. */
export function useAssetMonitoringReporter(nostrSignerReady: boolean): void {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const signerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision,
    getNostrSignerRevision,
    getNostrSignerRevision,
  );

  useEffect(() => {
    if (!nostrSignerReady || !mnemonic) return;
    const walletId = browserWalletIdFromMnemonic(mnemonic);
    const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
    if (walletId === null || scopeId === null || activeBrowserWalletScopeId() !== scopeId) return;

    const database = db;
    if (database.name !== browserWalletDatabaseName(scopeId)) return;
    const signer = getNdk().signer;
    if (!signer) return;

    const reporter = new AssetMonitoringReporter({
      walletId,
      remote: createAuthenticatedBrowserEngineClient(signer),
      buildHoldings: async () => {
        const proofs = (await database.proofs.toArray())
          .map(storedProofFromRow)
          .filter((proof) => proof.terminalOperationId === undefined);
        const conditionIds = conditionalProofConditionIds(proofs);
        if (conditionIds === null) return null;
        const catalogue = await fetchAssetMonitoringCatalogue(conditionIds, {
          engineBaseUrl: window.location.origin,
          fetchImpl: fetch,
        });
        return buildAssetMonitoringHoldings({ proofs, catalogue });
      },
      hasPendingSubmittedOrder: () => hasSubmittedCtfRangeOrder(scopeId, database),
      isCurrent: () => {
        const currentMnemonic = useWalletStore.getState().mnemonic;
        return (
          nostrSignerReady &&
          currentMnemonic === mnemonic &&
          browserWalletIdFromMnemonic(currentMnemonic) === walletId &&
          browserWalletScopeIdFromMnemonic(currentMnemonic) === scopeId &&
          activeBrowserWalletScopeId() === scopeId &&
          db === database &&
          database.name === browserWalletDatabaseName(scopeId) &&
          getNdk().signer === signer
        );
      },
    });
    const unsubscribe = subscribeToCommittedProofChanges(database, () => reporter.request());
    reporter.request();

    return () => {
      reporter.stop();
      unsubscribe();
    };
  }, [mnemonic, nostrSignerReady, signerRevision]);
}

/** Calls the callback once after each transaction that commits a proof write. */
export function subscribeToCommittedProofChanges(
  database: BitcasterDB,
  callback: () => void,
): () => void {
  const observedTransactions = new WeakSet<Transaction>();
  let active = true;
  const requestAfterCommit = (transaction: Transaction) => {
    if (observedTransactions.has(transaction)) return;
    observedTransactions.add(transaction);
    transaction.on("complete", () => {
      if (active) callback();
    });
  };
  const creating = (_key: unknown, _proof: StoredProofRow, transaction: Transaction) =>
    requestAfterCommit(transaction);
  const updating = (
    _changes: object,
    _key: unknown,
    _proof: StoredProofRow,
    transaction: Transaction,
  ) => requestAfterCommit(transaction);
  const deleting = (_key: unknown, _proof: StoredProofRow, transaction: Transaction) =>
    requestAfterCommit(transaction);

  database.proofs.hook("creating", creating);
  database.proofs.hook("updating", updating);
  database.proofs.hook("deleting", deleting);
  return () => {
    active = false;
    database.proofs.hook("creating").unsubscribe(creating);
    database.proofs.hook("updating").unsubscribe(updating);
    database.proofs.hook("deleting").unsubscribe(deleting);
  };
}

function conditionalProofConditionIds(proofs: readonly StoredProof[]): string[] | null {
  const conditionIds = new Set<string>();
  for (const proof of proofs) {
    if (!isCtfProof(proof)) continue;
    const candidate = proof as StoredProof & { condition_id?: unknown };
    if (
      candidate.conditionId !== undefined &&
      candidate.condition_id !== undefined &&
      candidate.conditionId !== candidate.condition_id
    ) {
      return null;
    }
    const conditionId = candidate.conditionId ?? candidate.condition_id;
    if (typeof conditionId !== "string") return null;
    conditionIds.add(conditionId);
  }
  return [...conditionIds];
}
