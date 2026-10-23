import { decodeDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { decodeDurableCustodyRecord } from "@bitcaster/client-sdk/durableCustody";
import { decodeBrowserCustodyProofRow } from "../stores/durable-custody-types";
import { requireBrowserProofBackupAuthorityForProof } from "../stores/browser-proof-backup-authority";
import type { BitcasterDB } from "../stores/proof-db";
import { browserWalletDatabaseName } from "./browserWalletProfile";
import {
  listBrowserEncryptedWalletBackupOwnerCacheRemovalEligibleAssets,
  type BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
} from "./browserEncryptedWalletBackupV2SeedHandoff";
import { withWalletProfileLock } from "./walletProfileLock";
import { encryptedWalletBackupV2WalletLockName } from "./encryptedWalletBackupDriver";
import { requireBrowserEncryptedWalletBackupOwnerReachability } from "./browserEncryptedWalletBackupOwnerDeletion";
import type { BrowserEncryptedWalletBackupOwnerReachabilitySnapshot } from "./browserEncryptedWalletBackupOwnerDeletion";
import type { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../stores/encrypted-wallet-backup-owner-db";
import type { EncryptedWalletBackupV2PreparedDesiredBinding } from "../stores/encrypted-wallet-backup-v2-db";

export interface BrowserEncryptedWalletBackupV2QuotaWriteInput<T> {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  readonly protectedLocalAssetKeys?: readonly string[];
  /** Explicit owner selected by the backup adapter. Null keeps legacy v2 evidence non-authorizing. */
  readonly ownerScopeId?: string | null;
  /** Explicit selected-owner store. When present, only owner receipts can authorize eviction. */
  readonly ownerAuthorityStore?: EncryptedWalletBackupOwnerDexieAuthorityStore;
  /** Fetch fresh SDK-issued reachability evidence for one exact candidate under the profile lock. */
  readonly loadCurrentOwnerReachabilityEvidence?: (
    candidate: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
  ) => Promise<BrowserEncryptedWalletBackupOwnerReachabilitySnapshot>;
  readonly write: () => Promise<T>;
  readonly lockManager?: Pick<LockManager, "request">;
}

export interface BrowserEncryptedWalletBackupV2QuotaWriteResult<T> {
  readonly result: T;
  /** Opaque local asset identifier. This result never includes proof material. */
  readonly evictedLocalAssetKey: string | null;
}

/** Retry one quota-rejected local write after evicting one complete backed cache. */
export async function retryBrowserEncryptedWalletBackupV2QuotaWrite<T>(
  input: BrowserEncryptedWalletBackupV2QuotaWriteInput<T>,
): Promise<BrowserEncryptedWalletBackupV2QuotaWriteResult<T>> {
  try {
    return { result: await input.write(), evictedLocalAssetKey: null };
  } catch (error) {
    if (!isQuotaExceeded(error)) throw error;
    const evictedLocalAssetKey = await evictOneEligibleCache(input);
    if (evictedLocalAssetKey === null) throw error;
    return { result: await input.write(), evictedLocalAssetKey };
  }
}

async function evictOneEligibleCache<T>(
  input: BrowserEncryptedWalletBackupV2QuotaWriteInput<T>,
): Promise<string | null> {
  requireCurrent(input);
  return withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      if (
        input.ownerScopeId == null ||
        input.ownerAuthorityStore === undefined ||
        input.loadCurrentOwnerReachabilityEvidence === undefined
      )
        return null;
      const candidates = await listBrowserEncryptedWalletBackupOwnerCacheRemovalEligibleAssets({
        ...input,
        ownerAuthorityStore: input.ownerAuthorityStore,
      });
      const protectedLocalAssetKeys = new Set(input.protectedLocalAssetKeys);
      const ordered = [...candidates]
        .filter(({ desired }) => !protectedLocalAssetKeys.has(desired.localAssetKey))
        .sort((left, right) => {
          const difference = proofBytes(right) - proofBytes(left);
          return difference === 0
            ? left.desired.localAssetKey.localeCompare(right.desired.localAssetKey)
            : difference;
        });
      for (const candidate of ordered) {
        const localAssetKey = await evictCandidateWithCurrentOwnerEvidence(input, candidate);
        if (localAssetKey !== null) return localAssetKey;
      }
      return null;
    },
    input.lockManager,
  );
}

async function evictCandidateWithCurrentOwnerEvidence<T>(
  input: BrowserEncryptedWalletBackupV2QuotaWriteInput<T>,
  candidate: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
): Promise<string | null> {
  if (
    input.ownerScopeId == null ||
    input.ownerAuthorityStore === undefined ||
    input.loadCurrentOwnerReachabilityEvidence === undefined
  )
    return null;
  const manager = input.lockManager ?? globalThis.navigator?.locks;
  if (manager === undefined) return null;
  return manager.request(
    encryptedWalletBackupV2WalletLockName({
      realm: candidate.receipt.realm,
      walletId: candidate.receipt.walletId,
    }),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null) return null;
      requireCurrent(input);
      let snapshot: BrowserEncryptedWalletBackupOwnerReachabilitySnapshot;
      try {
        snapshot = await input.loadCurrentOwnerReachabilityEvidence!(candidate);
        if (snapshot.backupReceiptSnapshot === undefined)
          throw new Error("selected-owner receipt snapshot is unavailable");
        requireBrowserEncryptedWalletBackupOwnerReachability({
          ownerScopeId: input.ownerScopeId!,
          evidence: snapshot.evidence,
          collectedHeadEvidence: snapshot.collectedHeadEvidence,
          context: {
            realm: candidate.receipt.realm,
            walletId: candidate.receipt.walletId,
            enrollmentEpoch: candidate.receipt.enrollmentEpoch,
          },
          expectedBundleId: candidate.receipt.bundleId,
          expectedAssetLocator: candidate.receipt.assetLocator,
          expectedCustodyRevision: candidate.receipt.custodyRevision,
          expectedBundleDescriptor: candidate.descriptor,
        });
      } catch {
        return null;
      }
      requireCurrent(input);
      return input.database.transaction(
        "rw",
        [
          input.database.proofs,
          input.database.custodyProofs,
          input.database.custodyProofBackupAuthorities,
          input.database.custodyOperations,
          input.database.custodyArtifacts,
          input.database.custodyReservations,
          input.database.custodyActiveWork,
          input.database.custodyConditionalKeysets,
          input.database.encryptedWalletBackupV2DesiredAssets,
          input.database.encryptedWalletBackupV2AssetReceipts,
          input.database.encryptedWalletBackupV2ActiveDescriptors,
          input.database.encryptedWalletBackupV2AcceptedHeads,
          input.database.encryptedWalletBackupOwnerDesiredAssets,
          input.database.encryptedWalletBackupOwnerAssetReceipts,
          input.database.encryptedWalletBackupOwnerAcceptedHeads,
          input.database.encryptedWalletBackupOwnerActiveDescriptors,
        ],
        async () => {
          requireCurrent(input);
          const desiredBinding: EncryptedWalletBackupV2PreparedDesiredBinding = {
            localAssetKey: candidate.desired.localAssetKey,
            assetLocator: snapshot.backupReceiptSnapshot!.ownerDesired.assetLocator,
            custodyRevision: candidate.desired.custodyRevision,
            desiredAction: candidate.desired.desiredAction,
            activeProofCount: candidate.desired.activeProofCount,
          };
          await input.ownerAuthorityStore!.assertCurrentBackupReceiptInTransaction({
            snapshot: snapshot.backupReceiptSnapshot!,
            reachabilityEvidence: snapshot.evidence,
            desired: desiredBinding,
          });
          const proofs = await exactCurrentProofs(input.database, candidate);
          const authorities = await exactCurrentProofAuthorities(input.database, proofs);
          const secrets = proofs.map(proofSecret);
          const terminalReimports = await releasableTerminalReimports(
            input.database,
            input.scopeId,
            proofs,
            authorities,
          );
          await input.database.custodyProofs.bulkDelete(
            proofs.map((proof) => [input.scopeId, proof.proofId]),
          );
          await input.database.custodyProofBackupAuthorities.bulkDelete(
            proofs.map((proof) => [input.scopeId, proof.proofId]),
          );
          await input.database.proofs.bulkDelete(secrets);
          await deleteTerminalReimportMaterial(input.database, input.scopeId, terminalReimports);
          requireCurrent(input);
          return candidate.desired.localAssetKey;
        },
      );
    },
  );
}

async function releasableTerminalReimports(
  database: BitcasterDB,
  scopeId: string,
  removedProofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  removedAuthorities: readonly ReturnType<typeof requireBrowserProofBackupAuthorityForProof>[],
): Promise<readonly string[]> {
  const candidateProofIds = new Set(removedProofs.map(({ proofId }) => proofId));
  const referencedOperationIds = [
    ...new Set(
      removedAuthorities.flatMap(({ admissionOperationId }) =>
        admissionOperationId === null ? [] : [admissionOperationId],
      ),
    ),
  ];
  const rows = await database.custodyOperations.bulkGet(
    referencedOperationIds.map((operationId) => [scopeId, operationId]),
  );
  const operationIds: string[] = [];
  for (const row of rows) {
    if (row === undefined || row.scopeId !== scopeId) continue;
    const record = decodeDurableCustodyRecord(row.record);
    const successors = record.operation.proofStorage.lineage.successorProofIds;
    if (
      record.scope.scopeId !== scopeId ||
      record.operation.operationId !== row.operationId ||
      record.operation.state !== "reconciled" ||
      !isTerminalReimport(record) ||
      successors.length === 0 ||
      successors.some((proofId) => !candidateProofIds.has(proofId))
    ) {
      continue;
    }
    if (
      !(await hasNoRetainedOperationReferences(
        database,
        scopeId,
        row.operationId,
        candidateProofIds,
      ))
    ) {
      continue;
    }
    operationIds.push(row.operationId);
  }
  return operationIds;
}

async function hasNoRetainedOperationReferences(
  database: BitcasterDB,
  scopeId: string,
  operationId: string,
  removedProofIds: ReadonlySet<string>,
): Promise<boolean> {
  const [activeWork, reservations, authorities] = await Promise.all([
    database.custodyActiveWork.get([scopeId, operationId]),
    database.custodyReservations
      .where("[scopeId+operationId]")
      .equals([scopeId, operationId])
      .limit(1)
      .first(),
    database.custodyProofBackupAuthorities
      .where("[scopeId+admissionOperationId]")
      .equals([scopeId, operationId])
      .limit(removedProofIds.size + 1)
      .toArray(),
  ]);
  return (
    activeWork === undefined &&
    reservations === undefined &&
    authorities.length <= removedProofIds.size &&
    authorities.every((authority) => removedProofIds.has(authority.proofId))
  );
}

async function deleteTerminalReimportMaterial(
  database: BitcasterDB,
  scopeId: string,
  operationIds: readonly string[],
): Promise<void> {
  for (const operationId of operationIds) {
    const artifacts = await database.custodyArtifacts
      .where("[scopeId+operationId]")
      .equals([scopeId, operationId])
      .toArray();
    await database.custodyArtifacts.bulkDelete(
      artifacts.map(({ artifactId }) => [scopeId, operationId, artifactId]),
    );
  }
  await database.custodyOperations.bulkDelete(
    operationIds.map((operationId) => [scopeId, operationId]),
  );
}

function isTerminalReimport(record: ReturnType<typeof decodeDurableCustodyRecord>): boolean {
  return (
    record.operation.semanticKind === "generic-receive" &&
    record.operation.binding.stage === "receive" &&
    /:reimport:[A-Za-z0-9-]{1,64}$/.test(record.operation.binding.activityId)
  );
}

async function exactCurrentProofs(
  database: BitcasterDB,
  candidate: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
) {
  const expected = new Map(candidate.proofs.map((proof) => [proof.proofId, proof]));
  if (expected.size !== candidate.proofs.length)
    throw new Error("browser V2 quota cache is invalid");
  const current = await database.custodyProofs.bulkGet(
    candidate.proofs.map((proof) => [proof.scopeId, proof.proofId]),
  );
  if (current.some((proof) => proof === undefined))
    throw new Error("browser V2 quota cache changed");
  return current.map((raw, index) => {
    const proof = decodeBrowserCustodyProofRow(raw!);
    const expectedProof = candidate.proofs[index]!;
    if (
      proof.scopeId !== expectedProof.scopeId ||
      proof.proofId !== expectedProof.proofId ||
      proof.proofFingerprint !== expectedProof.proofFingerprint ||
      proof.selectability !== "selectable" ||
      proof.reservationOperationId !== null
    ) {
      throw new Error("browser V2 quota cache changed");
    }
    return proof;
  });
}

async function exactCurrentProofAuthorities(
  database: BitcasterDB,
  proofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
) {
  const rows = await database.custodyProofBackupAuthorities.bulkGet(
    proofs.map(({ scopeId, proofId }) => [scopeId, proofId]),
  );
  if (rows.some((row) => row === undefined)) throw new Error("browser V2 quota cache changed");
  return rows.map((row, index) => requireBrowserProofBackupAuthorityForProof(row!, proofs[index]!));
}

function proofBytes(candidate: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset): number {
  return candidate.proofs.reduce((total, proof) => total + proof.proofBody.byteLength, 0);
}

function proofSecret(
  proof: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset["proofs"][number],
) {
  return decodeDurableCustodyProofMaterialRecord(proof).proof.secret;
}

function isQuotaExceeded(error: unknown): error is Error {
  return error instanceof Error && error.name === "QuotaExceededError";
}

function requireCurrent<T>(input: BrowserEncryptedWalletBackupV2QuotaWriteInput<T>): void {
  if (
    !input.isCurrentProfile() ||
    input.database.name !== browserWalletDatabaseName(input.scopeId)
  ) {
    throw new Error("browser V2 quota cleanup profile is stale");
  }
}
