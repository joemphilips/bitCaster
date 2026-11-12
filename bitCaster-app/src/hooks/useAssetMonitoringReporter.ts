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
import { browserSeedPositionRestoreGate } from "@/lib/browserSeedPositionRestore";

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
    // The engine keeps only the latest report. A new profile reports nothing
    // until its first seed restore pass read the earlier report (ADR-039).
    const gate = browserSeedPositionRestoreGate(scopeId);
    let released = gate.released;
    let stopped = false;
    const request = () => {
      if (released) reporter.request();
    };
    const unsubscribe = subscribeToCommittedProofChanges(database, request);
    if (released) {
      reporter.request();
    } else {
      void gate.wait
        .catch(() => undefined)
        .then(() => {
          if (stopped) return;
          released = true;
          reporter.request();
        });
    }

    return () => {
      stopped = true;
      reporter.stop();
      unsubscribe();
    };
  }, [mnemonic, nostrSignerReady, signerRevision]);
}

/** Build a report from one current custody snapshot. */
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
  const catalogue = await fetchAssetMonitoringCatalogue(conditionIds, {
    engineBaseUrl: remote.engineBaseUrl,
    fetchImpl: remote.fetchImpl,
  });
  if (snapshot.isCurrent !== undefined && !snapshot.isCurrent()) return null;
  return buildAssetMonitoringHoldings({
    proofs,
    catalogue,
    ...(snapshot.custody === undefined ? {} : { custody: snapshot.custody }),
  });
}

interface AssetMonitoringDatabaseSnapshot {
  readonly isCurrent?: () => boolean;
  readonly custody?: {
    readonly scopeId: string;
    readonly proofs: readonly unknown[];
    readonly proofBackupAuthorities: readonly unknown[];
  };
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
  if (!hasCustodyAuthorityTables(database)) return {};
  const isCurrent = () =>
    database.name === browserWalletDatabaseName(scopeId) &&
    activeBrowserWalletScopeId() === scopeId;
  if (!isCurrent()) throw new Error("asset monitoring snapshot is stale");
  return database.transaction(
    "r",
    [database.custodyProofs, database.custodyProofBackupAuthorities],
    async () => {
      const [selectableProofs, lockedProofs, proofBackupAuthorities] = await Promise.all([
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
      ]);
      if (!isCurrent()) throw new Error("asset monitoring snapshot is stale");
      return {
        isCurrent,
        custody: {
          scopeId,
          proofs: [...selectableProofs, ...lockedProofs],
          proofBackupAuthorities,
        },
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
