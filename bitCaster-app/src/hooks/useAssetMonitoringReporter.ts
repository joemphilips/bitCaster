import { useEffect, useSyncExternalStore } from "react";
import Dexie, { type Transaction } from "dexie";
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
import { listBrowserEncryptedWalletBackupV2EvictedAssetMonitoringFacts } from "@/lib/browserEncryptedWalletBackupV2SeedHandoff";
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
        const snapshot = await readAssetMonitoringSnapshot(database, scopeId);
        const proofs = snapshot.proofRows
          .map(storedProofFromRow)
          .filter((proof) => proof.terminalOperationId === undefined);
        const conditionIds = conditionalProofConditionIds(proofs);
        if (conditionIds === null) return null;
        const catalogue = await fetchAssetMonitoringCatalogue(conditionIds, {
          engineBaseUrl: window.location.origin,
          fetchImpl: fetch,
        });
        return buildAssetMonitoringHoldings({
          proofs,
          catalogue,
          ...(snapshot.custody === undefined ? {} : { custody: snapshot.custody }),
          ...(snapshot.evictedAssets.length === 0 ? {} : { evictedAssets: snapshot.evictedAssets }),
        });
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

interface AssetMonitoringDatabaseSnapshot {
  readonly proofRows: readonly StoredProofRow[];
  readonly custody?: {
    readonly scopeId: string;
    readonly proofs: readonly unknown[];
    readonly proofBackupAuthorities: readonly unknown[];
  };
  readonly evictedAssets: Awaited<
    ReturnType<typeof listBrowserEncryptedWalletBackupV2EvictedAssetMonitoringFacts>
  >;
}

async function readAssetMonitoringSnapshot(
  database: BitcasterDB,
  scopeId: string,
): Promise<AssetMonitoringDatabaseSnapshot> {
  if (!hasCustodyAuthorityTables(database)) {
    return { proofRows: await database.proofs.toArray(), evictedAssets: [] };
  }
  return database.transaction(
    "r",
    [
      database.proofs,
      database.custodyProofs,
      database.custodyProofBackupAuthorities,
      database.custodyConditionalKeysets,
      database.encryptedWalletBackupV2DesiredAssets,
      database.encryptedWalletBackupV2AssetReceipts,
      database.encryptedWalletBackupV2AcceptedHeads,
      database.encryptedWalletBackupV2ActiveDescriptors,
    ],
    async () => {
      const [proofRows, custodyProofs, proofBackupAuthorities, evictedAssets] = await Promise.all([
        database.proofs.toArray(),
        database.custodyProofs
          .where("[scopeId+selectability+proofId]")
          .between([scopeId, Dexie.minKey, Dexie.minKey], [scopeId, Dexie.maxKey, Dexie.maxKey])
          .toArray(),
        database.custodyProofBackupAuthorities
          .where("[scopeId+proofState+proofId]")
          .between([scopeId, Dexie.minKey, Dexie.minKey], [scopeId, Dexie.maxKey, Dexie.maxKey])
          .toArray(),
        listBrowserEncryptedWalletBackupV2EvictedAssetMonitoringFacts({
          database,
          scopeId,
          isCurrentProfile: () =>
            database.name === browserWalletDatabaseName(scopeId) &&
            activeBrowserWalletScopeId() === scopeId,
        }),
      ]);
      return {
        proofRows,
        custody: { scopeId, proofs: custodyProofs, proofBackupAuthorities },
        evictedAssets,
      };
    },
  );
}

function hasCustodyAuthorityTables(database: BitcasterDB): boolean {
  return (
    database.custodyProofs !== undefined && database.custodyProofBackupAuthorities !== undefined
  );
}

/** Calls the callback once after each transaction that commits a monitoring source write. */
export function subscribeToCommittedProofChanges(
  database: BitcasterDB,
  callback: () => void,
): () => void {
  const observedTransactions = new WeakSet<Transaction>();
  let active = true;
  const observesAuthorities = hasCustodyAuthorityTables(database);
  const observesBackupMetadata = hasBackupMetadataTables(database);
  const metadataUnsubscribers: Array<() => void> = [];
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
  const authorityCreating = (_key: unknown, _authority: unknown, transaction: Transaction) =>
    requestAfterCommit(transaction);
  const authorityUpdating = (
    _changes: object,
    _key: unknown,
    _authority: unknown,
    transaction: Transaction,
  ) => requestAfterCommit(transaction);
  const authorityDeleting = (_key: unknown, _authority: unknown, transaction: Transaction) =>
    requestAfterCommit(transaction);

  database.proofs.hook("creating", creating);
  database.proofs.hook("updating", updating);
  database.proofs.hook("deleting", deleting);
  if (observesAuthorities) {
    database.custodyProofBackupAuthorities.hook("creating", authorityCreating);
    database.custodyProofBackupAuthorities.hook("updating", authorityUpdating);
    database.custodyProofBackupAuthorities.hook("deleting", authorityDeleting);
  }
  if (observesBackupMetadata) {
    metadataUnsubscribers.push(
      subscribeTableChanges(database.encryptedWalletBackupV2DesiredAssets, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupV2AssetReceipts, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupV2AcceptedHeads, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupV2ActiveDescriptors, requestAfterCommit),
      subscribeTableChanges(database.custodyConditionalKeysets, requestAfterCommit),
    );
  }
  return () => {
    active = false;
    database.proofs.hook("creating").unsubscribe(creating);
    database.proofs.hook("updating").unsubscribe(updating);
    database.proofs.hook("deleting").unsubscribe(deleting);
    if (observesAuthorities) {
      database.custodyProofBackupAuthorities.hook("creating").unsubscribe(authorityCreating);
      database.custodyProofBackupAuthorities.hook("updating").unsubscribe(authorityUpdating);
      database.custodyProofBackupAuthorities.hook("deleting").unsubscribe(authorityDeleting);
    }
    if (observesBackupMetadata) {
      metadataUnsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  };
}

function hasBackupMetadataTables(database: BitcasterDB): boolean {
  return (
    database.custodyConditionalKeysets !== undefined &&
    database.encryptedWalletBackupV2DesiredAssets !== undefined &&
    database.encryptedWalletBackupV2AssetReceipts !== undefined &&
    database.encryptedWalletBackupV2AcceptedHeads !== undefined &&
    database.encryptedWalletBackupV2ActiveDescriptors !== undefined
  );
}

function subscribeTableChanges(
  table: { hook(event: "creating" | "updating" | "deleting", listener?: never): unknown },
  requestAfterCommit: (transaction: Transaction) => void,
): () => void {
  const creating = (_key: unknown, _value: unknown, transaction: Transaction) =>
    requestAfterCommit(transaction);
  const updating = (_changes: object, _key: unknown, _value: unknown, transaction: Transaction) =>
    requestAfterCommit(transaction);
  const deleting = (_key: unknown, _value: unknown, transaction: Transaction) =>
    requestAfterCommit(transaction);
  table.hook("creating", creating as never);
  table.hook("updating", updating as never);
  table.hook("deleting", deleting as never);
  return () => {
    (table.hook("creating") as { unsubscribe(listener: unknown): void }).unsubscribe(creating);
    (table.hook("updating") as { unsubscribe(listener: unknown): void }).unsubscribe(updating);
    (table.hook("deleting") as { unsubscribe(listener: unknown): void }).unsubscribe(deleting);
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
