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
import { listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts } from "@/lib/browserEncryptedWalletBackupV2SeedHandoff";
import {
  activeBrowserEncryptedWalletBackupV2RuntimeDriver,
  subscribeToBrowserEncryptedBackupMonitoring,
} from "@/lib/encryptedWalletBackupDriver";
import { decodeBrowserCustodyProofRow } from "@/stores/durable-custody-types";
import {
  db,
  isCtfProof,
  storedProofFromCustodyRow,
  type BitcasterDB,
  type StoredProof,
  type StoredProofRow,
} from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { publishPortfolioInvalidation } from "@/lib/portfolioInvalidation";

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
    if (!hasCustodyAuthorityTables(database)) return;
    const signer = getNdk().signer;
    if (!signer) return;

    const isCurrent = () => {
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
    };
    const reporter = new AssetMonitoringReporter({
      walletId,
      remote: createAuthenticatedBrowserEngineClient(signer),
      buildHoldings: () =>
        buildBrowserAssetMonitoringHoldings(database, scopeId, {
          engineBaseUrl: window.location.origin,
          fetchImpl: fetch,
        }),
      hasPendingSubmittedOrder: () => hasSubmittedCtfRangeOrder(scopeId, database),
      isCurrent,
      onAccepted: () => {
        if (isCurrent()) publishPortfolioInvalidation({ walletId });
      },
    });
    const unsubscribe = subscribeToCommittedProofChanges(database, () => reporter.request());
    const unsubscribeOwner = subscribeToBrowserEncryptedBackupMonitoring(scopeId, () =>
      reporter.request(),
    );
    reporter.request();

    return () => {
      reporter.stop();
      unsubscribe();
      unsubscribeOwner();
    };
  }, [mnemonic, nostrSignerReady, signerRevision]);
}

/** Build a report from one current custody/owner snapshot. */
export async function buildBrowserAssetMonitoringHoldings(
  database: BitcasterDB,
  scopeId: string,
  remote: { engineBaseUrl: string; fetchImpl: typeof fetch },
) {
  const snapshot = await readAssetMonitoringSnapshot(database, scopeId);
  if (snapshot.custody === undefined) return null;
  const proofs = snapshot.custody.proofs
    .map((rawProof) => decodeCurrentCustodyProof(rawProof, scopeId))
    .filter((proof): proof is StoredProof => proof !== null);
  const conditionIds = conditionalProofConditionIds(proofs);
  if (conditionIds === null) return null;
  const monitoringConditionIds = [
    ...new Set([
      ...conditionIds,
      ...snapshot.evictedAssets.flatMap((asset) =>
        asset.kind === "conditional" ? [asset.conditionId] : [],
      ),
    ]),
  ];
  const catalogue = await fetchAssetMonitoringCatalogue(monitoringConditionIds, {
    engineBaseUrl: remote.engineBaseUrl,
    fetchImpl: remote.fetchImpl,
  });
  if (snapshot.isCurrent !== undefined && !snapshot.isCurrent()) return null;
  return buildAssetMonitoringHoldings({
    proofs,
    catalogue,
    ...(snapshot.custody === undefined ? {} : { custody: snapshot.custody }),
    ...(snapshot.evictedAssets.length === 0 ? {} : { evictedAssets: snapshot.evictedAssets }),
  });
}

interface AssetMonitoringDatabaseSnapshot {
  readonly isCurrent?: () => boolean;
  readonly custody?: {
    readonly scopeId: string;
    readonly proofs: readonly unknown[];
    readonly proofBackupAuthorities: readonly unknown[];
  };
  readonly evictedAssets: Awaited<
    ReturnType<typeof listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts>
  >;
}

function decodeCurrentCustodyProof(rawProof: unknown, scopeId: string): StoredProof | null {
  const proof = decodeBrowserCustodyProofRow(rawProof);
  if (proof.scopeId !== scopeId || proof.selectability === "spent") return null;
  return storedProofFromCustodyRow(proof);
}

export async function readAssetMonitoringSnapshot(
  database: BitcasterDB,
  scopeId: string,
): Promise<AssetMonitoringDatabaseSnapshot> {
  if (!hasCustodyAuthorityTables(database)) {
    return { evictedAssets: [] };
  }
  const driver = activeBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId);
  const owner = (await driver?.captureSelectedOwnerMonitoringAuthority?.()) ?? null;
  const isCurrent = () =>
    database.name === browserWalletDatabaseName(scopeId) &&
    activeBrowserWalletScopeId() === scopeId &&
    (owner === null ||
      (activeBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId) === driver && owner.isCurrent()));
  if (!isCurrent()) throw new Error("asset monitoring snapshot is stale");
  return database.transaction(
    "r",
    [
      database.custodyProofs,
      database.custodyProofBackupAuthorities,
      database.custodyConditionalKeysets,
      database.encryptedWalletBackupV2DesiredAssets,
      database.encryptedWalletBackupOwnerDesiredAssets,
      database.encryptedWalletBackupOwnerAssetReceipts,
      database.encryptedWalletBackupOwnerAcceptedHeads,
      database.encryptedWalletBackupOwnerActiveDescriptors,
    ],
    async () => {
      const [selectableProofs, lockedProofs, proofBackupAuthorities, evictedAssets] =
        await Promise.all([
          database.custodyProofs
            .where("[scopeId+selectability]")
            .equals([scopeId, "selectable"])
            .toArray(),
          database.custodyProofs
            .where("[scopeId+selectability]")
            .equals([scopeId, "locked"])
            .toArray(),
          database.custodyProofBackupAuthorities
            .where("[scopeId+proofState+proofId]")
            .between([scopeId, "", ""], [scopeId, "\uffff", "\uffff"], true, true)
            .toArray(),
          owner === null
            ? Promise.resolve([])
            : listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts({
                database,
                scopeId,
                isCurrentProfile: isCurrent,
                ownerAuthority: owner,
              }),
        ]);
      if (!isCurrent()) throw new Error("asset monitoring snapshot is stale");
      return {
        isCurrent,
        custody: {
          scopeId,
          proofs: [...selectableProofs, ...lockedProofs],
          proofBackupAuthorities,
        },
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
    metadataUnsubscribers.push(subscribeTableChanges(database.custodyProofs, requestAfterCommit));
    database.custodyProofBackupAuthorities.hook("creating", authorityCreating);
    database.custodyProofBackupAuthorities.hook("updating", authorityUpdating);
    database.custodyProofBackupAuthorities.hook("deleting", authorityDeleting);
  }
  if (observesBackupMetadata) {
    metadataUnsubscribers.push(
      subscribeTableChanges(database.encryptedWalletBackupV2DesiredAssets, requestAfterCommit),
      subscribeTableChanges(database.custodyConditionalKeysets, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupOwnerDesiredAssets, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupOwnerAssetReceipts, requestAfterCommit),
      subscribeTableChanges(database.encryptedWalletBackupOwnerAcceptedHeads, requestAfterCommit),
      subscribeTableChanges(
        database.encryptedWalletBackupOwnerActiveDescriptors,
        requestAfterCommit,
      ),
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
    metadataUnsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

function hasBackupMetadataTables(database: BitcasterDB): boolean {
  return (
    database.custodyConditionalKeysets !== undefined &&
    database.encryptedWalletBackupV2DesiredAssets !== undefined &&
    database.encryptedWalletBackupOwnerDesiredAssets !== undefined &&
    database.encryptedWalletBackupOwnerAssetReceipts !== undefined &&
    database.encryptedWalletBackupOwnerAcceptedHeads !== undefined &&
    database.encryptedWalletBackupOwnerActiveDescriptors !== undefined
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
