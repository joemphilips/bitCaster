import Dexie from "dexie";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  classifyDurableCustodyActiveWork,
  decodeDurableCustodyRecord,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyArtifactFingerprint,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  deriveEncryptedWalletBackupV2AssetLocator,
  digestEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2UploadGroup,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2ProofSetProof,
  type EncryptedWalletBackupV2KeyHandle,
} from "@bitcaster/client-sdk";
import {
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeInput,
} from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { readDurableCustodyAuthenticatedTerminalMintRejection } from "@bitcaster/client-sdk/durableCustodyMintResult";
import type {
  DurableCustodyExactArtifact,
  DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
  incrementEncryptedWalletBackupV2DesiredAssetRevision,
  requireBrowserV2KeysetFreeTerminalContextForProof,
  type EncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2RemovalIntent,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  advanceBrowserProofBackupAuthorityRowToPendingRemoval,
  createBrowserCompletedLocalProofRemovalMarkerRow,
  createBrowserCompletedProofRemovalMarkerRow,
  restoreBrowserProofBackupAuthorityRowFromPendingRemoval,
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  decodeBrowserProofBackupAuthorityTableRow,
  type BrowserProofBackupAuthorityRow,
} from "../stores/browser-proof-backup-authority";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import {
  storedProofFromCustodyRow,
  storedProofFromRow,
  type BitcasterDB,
} from "../stores/proof-db";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../stores/browser-encrypted-wallet-backup-v2-terminal-seal-store";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../stores/encrypted-wallet-backup-v2-db";
import type { EncryptedWalletBackupV2PreparedMutationMatch } from "../stores/encrypted-wallet-backup-v2-db";
import { requireBrowserWalletNewWritePermission } from "./browserWalletNewWritePermission";
import { withWalletProfileLock } from "./walletProfileLock";
import {
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";

const MAX_PROOFS = 512;

export interface BrowserCtfRemoveTarget {
  readonly proofId: string;
  readonly proofFingerprint: string;
  readonly proofRevision: number;
}

export interface BrowserCtfRemoveInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  /** Backup identity is required only when the managed-backup path is used. */
  readonly keyHandle?: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch?: number;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly assetLocator?: string;
  readonly targets: readonly BrowserCtfRemoveTarget[];
  readonly observedAtMs?: number;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly isCurrentProfile?: () => boolean;
  readonly fault?: "before-commit";
}

export type BrowserCtfRemoveResult =
  | { readonly kind: "started" | "resumed"; readonly intentId: string }
  | { readonly kind: "completed"; readonly intentId: string }
  | { readonly kind: "pending"; readonly reason: "backup-not-ready" };

export interface BrowserCtfRejectedRemoveCancellationInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly localAssetKey: string;
  readonly assetLocator: string;
  readonly rejectedPreparedMutation: EncryptedWalletBackupV2PreparedMutationMatch;
  readonly observedAtMs?: number;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly isCurrentProfile?: () => boolean;
  readonly fault?: "before-commit";
}

/** Restores local losing custody only after the exact backup candidate was rejected. */
export async function cancelDefinitivelyRejectedBrowserCtfRemove(
  input: BrowserCtfRejectedRemoveCancellationInput,
): Promise<{ readonly kind: "cancelled"; readonly intentId: string }> {
  requireFinalizeAssetLocator(input);
  const observedAtMs = input.observedAtMs ?? Date.now();
  const desiredBefore = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    input.localAssetKey,
  ]);
  if (desiredBefore === undefined) {
    throw new Error("browser CTF rejected removal desired asset is missing");
  }
  await requireDesiredLocator(
    decodeEncryptedWalletBackupV2DesiredAssetRow(desiredBefore),
    input.assetLocator,
    input.keyHandle,
  );
  return withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      const store = authorityStore(input);
      return input.database.transaction("rw", removalTables(input.database), async () => {
        const prepared = await store.readPreparedMutation();
        if (
          prepared === null ||
          prepared.mutationId !== input.rejectedPreparedMutation.mutationId ||
          prepared.requestDigest !== input.rejectedPreparedMutation.requestDigest
        ) {
          throw new Error("browser CTF rejected removal prepared candidate is stale");
        }
        const group = decodeEncryptedWalletBackupV2UploadGroup({
          bytes: prepared.canonicalUploadGroup,
          expectedRequestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
          expectedContext: {
            realm: input.keyHandle.realm,
            walletId: input.keyHandle.walletId,
            enrollmentEpoch: input.enrollmentEpoch,
          },
        });
        const mutation = group.mutationEvidence.envelope.mutation;
        if (
          mutation.mutationId !== prepared.mutationId ||
          group.mutationEvidence.envelope.requestDigest !== prepared.requestDigest ||
          prepared.localAssetKey !== input.localAssetKey ||
          prepared.assetLocator !== input.assetLocator
        ) {
          throw new Error("browser CTF rejected removal prepared candidate is foreign");
        }
        const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
          input.scopeId,
          input.localAssetKey,
        ]);
        if (rawDesired === undefined) {
          throw new Error("browser CTF rejected removal desired asset is missing");
        }
        const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        const intent = desired.removalIntent;
        if (
          intent === null ||
          intent.state !== "pending" ||
          intent.acknowledgedExclusionEvidence !== null ||
          desired.syncState !== "pending" ||
          desired.custodyRevision !== intent.targetCustodyRevision ||
          prepared.custodyRevision !== desired.custodyRevision ||
          prepared.desiredAction !== desired.desiredAction ||
          prepared.activeProofCount !== desired.activeProofCount
        ) {
          throw new Error("browser CTF rejected removal intent is stale");
        }
        requireRemovalIntentProfile(intent, input);
        const accepted = await store.readAcceptedHead();
        if (
          accepted === null ||
          accepted.headVersion !== intent.expectedHeadVersion ||
          accepted.activeSetDigest !== intent.expectedActiveSetDigest ||
          mutation.expectedHeadVersion !== intent.expectedHeadVersion ||
          mutation.expectedActiveSetDigest !== intent.expectedActiveSetDigest
        ) {
          throw new Error("browser CTF rejected removal predecessor head is stale");
        }
        const descriptors = await store.listActiveDescriptors();
        const predecessor = descriptors.filter(
          ({ assetLocator }) => assetLocator === input.assetLocator,
        );
        const predecessorRevision = predecessorCustodyRevision(intent.targetCustodyRevision);
        if (
          predecessor.length !== 1 ||
          predecessor[0]!.custodyRevision !== predecessorRevision ||
          mutation.supersededBundleIds.length !== 1 ||
          mutation.supersededBundleIds[0] !== predecessor[0]!.bundleId
        ) {
          throw new Error("browser CTF rejected removal predecessor descriptor is stale");
        }
        if (
          (desired.desiredAction === "remove" &&
            (desired.activeProofCount !== 0 || mutation.addedBundle !== null)) ||
          (desired.desiredAction === "replace" &&
            (desired.activeProofCount === 0 ||
              mutation.addedBundle === null ||
              mutation.addedBundle.assetLocator !== input.assetLocator ||
              mutation.addedBundle.custodyRevision.toString() !== desired.custodyRevision))
        ) {
          throw new Error("browser CTF rejected removal successor is stale");
        }
        const rows = await exactAssetRows(input.database, desired);
        if (rows.length !== desired.activeProofCount + intent.proofs.length) {
          throw new Error("browser CTF rejected removal proof set is stale");
        }
        const tuples = new Map(intent.proofs.map((tuple) => [tuple.proofId, tuple]));
        const target = rows.filter(({ proofId }) => tuples.has(proofId));
        if (target.length !== intent.proofs.length) {
          throw new Error("browser CTF rejected removal proof set is incomplete");
        }
        const authorities = await requireRemovalAuthorities(input, rows);
        const restoredProofs: BrowserCustodyProofRow[] = [];
        const restoredAuthorities: BrowserProofBackupAuthorityRow[] = [];
        for (const proof of target) {
          const tuple = tuples.get(proof.proofId)!;
          const authority = authorities.get(proof.proofId)!;
          if (
            proof.selectability !== "pending-removal" ||
            proof.reservationOperationId !== null ||
            proof.revision !== tuple.proofRevision + 1 ||
            proof.proofFingerprint !== tuple.proofFingerprint
          ) {
            throw new Error("browser CTF rejected removal proof authority is stale");
          }
          const proofCommitment = await requireTerminalAuthority(input, desired, proof, authority);
          if (proofCommitment !== tuple.proofCommitment) {
            throw new Error("browser CTF rejected removal proof commitment is stale");
          }
          requirePendingRemovalAuthority(proof, authority, intent, proofCommitment);
          await requireProofReconciliationFence(input.database, proof, authority);
          const restored = decodeBrowserCustodyProofRow({
            ...proof,
            revision: nextProofRevision(proof.revision),
            selectability: "verified-losing",
            reservationOperationId: null,
          });
          restoredProofs.push(restored);
          restoredAuthorities.push(
            restoreBrowserProofBackupAuthorityRowFromPendingRemoval(
              authority,
              restored,
              observedAtMs,
            ),
          );
        }
        const restoredProofCount = desired.activeProofCount + intent.proofs.length;
        if (restoredProofCount < 1 || restoredProofCount > MAX_PROOFS) {
          throw new Error("browser CTF rejected removal predecessor proof count is invalid");
        }
        requireCurrent(input);
        await input.database.custodyProofs.bulkPut(restoredProofs);
        await input.database.custodyProofBackupAuthorities.bulkPut(restoredAuthorities);
        await input.database.encryptedWalletBackupV2DesiredAssets.put({
          ...desired,
          custodyRevision: predecessorRevision,
          activeProofCount: restoredProofCount,
          desiredAction: "replace",
          syncState: "acknowledged",
          removalIntent: null,
        });
        await input.database.encryptedWalletBackupV2PreparedMutations.delete([
          input.scopeId,
          input.keyHandle.realm,
          input.keyHandle.walletId,
          input.enrollmentEpoch,
        ]);
        if (input.fault === "before-commit") {
          throw new Error("browser CTF rejected removal cancellation fault");
        }
        requireCurrent(input);
        return { kind: "cancelled", intentId: intent.intentId } as const;
      });
    },
    input.lockManager,
  );
}

export async function startBrowserCtfRemove(
  input: BrowserCtfRemoveInput,
): Promise<BrowserCtfRemoveResult> {
  requireRemoveIdentity(input);
  const targets = sortedRemoveTargets(input.targets);
  const proofIds = targets.map(({ proofId }) => proofId);
  const observedAtMs = input.observedAtMs ?? Date.now();
  if (hasManagedRemoveContext(input)) await requireAssetLocator(input);
  const asset = input.asset;
  const localAssetKey = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset,
    custodyRevision: 0n,
    activeProofCount: 0,
  }).localAssetKey;
  return withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      return input.database.transaction("rw", removalTables(input.database), async () => {
        const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
          input.scopeId,
          localAssetKey,
        ]);
        if (
          await completedRemovalReplay(
            input.database,
            input.scopeId,
            localAssetKey,
            proofIds,
            input,
            targets,
          )
        ) {
          return { kind: "completed", intentId: "completed-removal" };
        }
        const localResult = await completeLocalOnlyRemoval(
          input,
          localAssetKey,
          targets,
          observedAtMs,
        );
        if (localResult !== null) return localResult;
        if (rawDesired === undefined) {
          throw new Error("browser CTF removal desired asset is missing");
        }
        requireManagedRemoveContext(input);
        const store = authorityStore(input);
        const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        requireDesiredAsset(desired, input.scopeId, asset);
        const existing = desired.removalIntent;
        if (existing !== null) {
          requireRemovalIntentProfile(existing, input);
          requireSameRemovalTargets(existing, targets);
          const rows = await requireRemovalRows(input, desired, proofIds, true, existing);
          const authorities = await requireRemovalAuthorities(input, rows);
          for (const proofId of proofIds) {
            const proof = rows.find((row) => row.proofId === proofId);
            const authority = authorities.get(proofId);
            if (proof === undefined || authority === undefined) {
              throw new Error("browser CTF removal pending proof is missing");
            }
            const proofCommitment = await requireTerminalAuthority(
              input,
              desired,
              proof,
              authority,
            );
            requirePendingRemovalAuthority(proof, authority, existing, proofCommitment);
          }
          return { kind: "resumed", intentId: existing.intentId };
        }
        const rows = await requireRemovalRows(input, desired, proofIds, false);
        const rowsById = new Map(rows.map((proof) => [proof.proofId, proof]));
        const target = targets.map((tuple) => rowsById.get(tuple.proofId)!);
        requireExactRemovalTargets(targets, target);
        if (desired.syncState !== "acknowledged") {
          return { kind: "pending", reason: "backup-not-ready" };
        }
        const prepared = await store.readPreparedMutation();
        if (prepared !== null) return { kind: "pending", reason: "backup-not-ready" };
        const accepted = await store.readAcceptedHead();
        if (accepted === null) throw new Error("browser CTF removal accepted head is missing");
        const descriptors = await store.listActiveDescriptors();
        const matchingDescriptors = descriptors.filter(
          ({ assetLocator }) => assetLocator === input.assetLocator,
        );
        if (
          matchingDescriptors.length !== 1 ||
          matchingDescriptors[0]!.custodyRevision !== desired.custodyRevision
        ) {
          throw new Error("browser CTF removal accepted head is stale");
        }
        const authorityRows = await requireRemovalAuthorities(input, rows);
        const proofCommitments = new Map<string, string>();
        for (const proof of target) {
          const authority = authorityRows.get(proof.proofId);
          if (authority === undefined) throw new Error("browser CTF removal authority is missing");
          proofCommitments.set(
            proof.proofId,
            await requireTerminalAuthority(input, desired, proof, authority),
          );
          await requireProofReconciliationFence(input.database, proof, authority);
        }
        await requireBrowserWalletNewWritePermission({
          database: input.database,
          scopeId: input.scopeId,
        });
        const intent = createEncryptedWalletBackupV2RemovalIntent({
          intentId: `ctf-remove:${input.keyHandle.walletId}:${observedAtMs}:${proofIds[0]}`,
          createdAtMs: observedAtMs,
          realm: input.keyHandle.realm,
          walletId: input.keyHandle.walletId,
          enrollmentEpoch: input.enrollmentEpoch,
          expectedHeadVersion: accepted.headVersion,
          expectedActiveSetDigest: accepted.activeSetDigest,
          targetCustodyRevision: incrementEncryptedWalletBackupV2DesiredAssetRevision(
            BigInt(desired.custodyRevision),
          ),
          proofs: target.map((proof) => ({
            proofId: proof.proofId,
            proofFingerprint: proof.proofFingerprint,
            proofRevision: proof.revision,
            proofCommitment: proofCommitments.get(proof.proofId)!,
          })),
        });
        const pendingRows = target.map((proof) =>
          decodeBrowserCustodyProofRow({
            ...proof,
            revision: nextProofRevision(proof.revision),
            selectability: "pending-removal",
            reservationOperationId: null,
          }),
        );
        const pendingAuthorities = pendingRows.map((proof) =>
          advanceBrowserProofBackupAuthorityRowToPendingRemoval(
            authorityRows.get(proof.proofId)!,
            proof,
            observedAtMs,
          ),
        );
        await removeLegacyCacheRows(input.database, target, authorityRows);
        await input.database.custodyProofs.bulkPut(pendingRows);
        await input.database.custodyProofBackupAuthorities.bulkPut(pendingAuthorities);
        await input.database.encryptedWalletBackupV2DesiredAssets.put(
          createEncryptedWalletBackupV2DesiredAssetRow({
            scopeId: input.scopeId,
            asset,
            custodyRevision: incrementEncryptedWalletBackupV2DesiredAssetRevision(
              BigInt(desired.custodyRevision),
            ),
            activeProofCount: desired.activeProofCount - target.length,
            terminalCtfContext: desired.terminalCtfContext,
            removalIntent: intent,
          }),
        );
        requireCurrent(input);
        if (input.fault === "before-commit") throw new Error("browser CTF removal commit fault");
        return { kind: "started", intentId: intent.intentId } as const;
      });
    },
    input.lockManager,
  );
}

export async function discoverBrowserCtfRemovals(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly isCurrentProfile?: () => boolean;
  readonly observedAtMs?: number;
}): Promise<number> {
  const rows = await input.database.encryptedWalletBackupV2DesiredAssets
    .where("[scopeId+localAssetKey]")
    .between([input.scopeId, Dexie.minKey], [input.scopeId, Dexie.maxKey])
    .limit(MAX_PROOFS + 1)
    .toArray();
  if (rows.length > MAX_PROOFS) throw new Error("browser CTF removal discovery exceeds the limit");
  let completed = 0;
  for (const raw of rows) {
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    if (desired.removalIntent?.state !== "exclusion-acknowledged") continue;
    const result = await finalizeBrowserCtfRemove({
      ...input,
      localAssetKey: desired.localAssetKey,
      assetLocator: await deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle: input.keyHandle,
        mintUrl: desired.mintUrl,
        unit: desired.unit,
        assetIdentity: desired.assetIdentity,
      }),
    });
    if (result.kind === "completed") completed += 1;
  }
  return completed;
}

export async function finalizeBrowserCtfRemove(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly localAssetKey: string;
  readonly assetLocator: string;
  readonly proofIds?: readonly string[];
  readonly lockManager?: Pick<LockManager, "request">;
  readonly isCurrentProfile?: () => boolean;
  readonly observedAtMs?: number;
  readonly fault?: "before-commit";
}): Promise<{ readonly kind: "completed" | "pending" }> {
  await requireFinalizeAssetLocator(input);
  const rawBefore = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    input.localAssetKey,
  ]);
  if (rawBefore !== undefined) {
    await requireDesiredLocator(
      decodeEncryptedWalletBackupV2DesiredAssetRow(rawBefore),
      input.assetLocator,
      input.keyHandle,
    );
  }
  return withWalletProfileLock(
    input.scopeId,
    async () =>
      input.database.transaction("rw", removalTables(input.database), async () => {
        requireCurrent(input);
        const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
          input.scopeId,
          input.localAssetKey,
        ]);
        if (raw === undefined) {
          if (
            input.proofIds !== undefined &&
            !(await completedRemovalReplay(
              input.database,
              input.scopeId,
              input.localAssetKey,
              sortedProofIds(input.proofIds),
              input,
            ))
          ) {
            throw new Error("browser CTF removal completed marker set is missing");
          }
          return { kind: "completed" };
        }
        const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
        const intent = desired.removalIntent;
        if (intent === null) {
          if (
            input.proofIds !== undefined &&
            !(await completedRemovalReplay(
              input.database,
              input.scopeId,
              input.localAssetKey,
              sortedProofIds(input.proofIds),
              input,
            ))
          ) {
            throw new Error("browser CTF removal completed marker set is missing");
          }
          return { kind: "completed" };
        }
        requireRemovalIntentProfile(intent, input);
        if (
          intent.state !== "exclusion-acknowledged" ||
          intent.acknowledgedExclusionEvidence === null
        ) {
          return { kind: "pending" };
        }
        const store = authorityStore(input);
        if ((await store.readPreparedMutation()) !== null) {
          throw new Error(
            "browser CTF removal finalization conflicts with prepared backup mutation",
          );
        }
        const accepted = await store.readAcceptedHead();
        const descriptors = await store.listActiveDescriptors();
        requireExclusionEvidence(input, desired, accepted, descriptors);
        const rows = await exactAssetRows(input.database, desired);
        if (rows.length !== desired.activeProofCount + intent.proofs.length) {
          throw new Error("browser CTF removal finalization proof set is stale");
        }
        const tuples = new Map(intent.proofs.map((proof) => [proof.proofId, proof]));
        const target = rows.filter((proof) => tuples.has(proof.proofId));
        if (target.length !== intent.proofs.length) {
          throw new Error("browser CTF removal finalization proof set is incomplete");
        }
        const authorities = await requireRemovalAuthorities(input, rows);
        const proofCommitments = new Map<string, string>();
        for (const proof of target) {
          const tuple = tuples.get(proof.proofId)!;
          if (
            proof.selectability !== "pending-removal" ||
            proof.reservationOperationId !== null ||
            proof.revision !== tuple.proofRevision + 1 ||
            proof.proofFingerprint !== tuple.proofFingerprint
          ) {
            throw new Error("browser CTF removal finalization proof authority is stale");
          }
          const authority = authorities.get(proof.proofId);
          if (authority === undefined || authority.proofState !== "pending-removal") {
            throw new Error("browser CTF removal finalization authority is stale");
          }
          const proofCommitment = await requireTerminalAuthority(input, desired, proof, authority);
          proofCommitments.set(proof.proofId, proofCommitment);
          if (tuple.proofCommitment !== proofCommitment) {
            throw new Error("browser CTF removal finalization proof commitment is stale");
          }
          requirePendingRemovalAuthority(proof, authority, intent, proofCommitment);
          await requireProofReconciliationFence(input.database, proof, authority);
        }
        requireCurrent(input);
        await removeLegacyCacheRows(input.database, target, authorities);
        if (input.fault === "before-commit")
          throw new Error("browser CTF removal finalization fault");
        const evidence = intent.acknowledgedExclusionEvidence;
        const markers = target.map((proof) =>
          createBrowserCompletedProofRemovalMarkerRow({
            scopeId: input.scopeId,
            proofId: proof.proofId,
            proofFingerprint: proof.proofFingerprint,
            proofRevision: proof.revision,
            proofCommitment: proofCommitments.get(proof.proofId)!,
            localAssetKey: desired.localAssetKey,
            removalIntentId: intent.intentId,
            proofSetCommitment: intent.proofSetCommitment,
            completionCustodyRevision: desired.custodyRevision,
            realm: intent.realm,
            walletId: intent.walletId,
            enrollmentEpoch: intent.enrollmentEpoch,
            acknowledgedHeadVersion: evidence.headVersion,
            acknowledgedActiveSetDigest: evidence.activeSetDigest,
            acknowledgementKind: evidence.kind,
            receiptDigest: evidence.kind === "receipt" ? evidence.receiptDigest : null,
            acknowledgedAtMs: evidence.acknowledgedAtMs,
            completedAtMs: input.observedAtMs ?? Date.now(),
          }),
        );
        await input.database.custodyProofs.bulkDelete(
          target.map((proof) => [input.scopeId, proof.proofId]),
        );
        await input.database.custodyProofBackupAuthorities.bulkPut(markers);
        const survivors = rows.filter((proof) => !tuples.has(proof.proofId));
        if (survivors.length === 0) {
          await input.database.encryptedWalletBackupV2DesiredAssets.delete([
            input.scopeId,
            desired.localAssetKey,
          ]);
        } else {
          await input.database.encryptedWalletBackupV2DesiredAssets.put({
            ...desired,
            activeProofCount: survivors.length,
            desiredAction: "replace",
            syncState: "acknowledged",
            removalIntent: null,
          });
        }
        requireCurrent(input);
        return { kind: "completed" };
      }),
    input.lockManager,
  );
}

async function completeLocalOnlyRemoval(
  input: BrowserCtfRemoveInput,
  localAssetKey: string,
  targets: readonly BrowserCtfRemoveTarget[],
  observedAtMs: number,
): Promise<{ readonly kind: "completed"; readonly intentId: string } | null> {
  const proofIds = targets.map(({ proofId }) => proofId);
  const keys = proofIds.map((proofId) => [input.scopeId, proofId] as [string, string]);
  const rawProofs = await input.database.custodyProofs.bulkGet(keys);
  if (rawProofs.every((proof) => proof === undefined)) return null;
  if (rawProofs.some((proof) => proof === undefined)) {
    throw new Error("browser CTF local removal proof set is incomplete");
  }
  const proofs = rawProofs.map((proof) => decodeBrowserCustodyProofRow(proof));
  const rawAuthorities = await input.database.custodyProofBackupAuthorities.bulkGet(keys);
  const authorities = new Map<string, BrowserProofBackupAuthorityRow>();
  let localAuthorityCount = 0;
  for (const [index, proof] of proofs.entries()) {
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(
      rawAuthorities[index],
      keys[index]!,
    );
    if (authority === undefined) {
      throw new Error("browser CTF local removal authority is missing");
    }
    if (authority.backupState === "local-only" && authority.derivationLocator === null) {
      localAuthorityCount += 1;
    }
    authorities.set(proof.proofId, authority);
  }
  if (localAuthorityCount === 0) return null;
  if (localAuthorityCount !== proofs.length) {
    throw new Error("browser CTF local removal authorities use mixed completion paths");
  }
  requireExactRemovalTargets(targets, proofs);

  const { conditionId, outcomeCollectionId } = localRemovalAsset(input.asset);
  for (const proof of proofs) {
    const authority = authorities.get(proof.proofId)!;
    if (
      proof.scopeId !== input.scopeId ||
      proof.normalizedMint !== input.asset.mintUrl ||
      proof.unit !== input.asset.unit ||
      proof.assetKind !== "conditional" ||
      proof.conditionId !== conditionId ||
      proof.outcomeCollection === null ||
      deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: proof.outcomeCollection,
      }) !== outcomeCollectionId ||
      proof.selectability !== "verified-losing" ||
      proof.reservationOperationId !== null
    ) {
      throw new Error("browser CTF local removal proof binding is foreign");
    }
    if (
      authority.backupState !== "local-only" ||
      authority.derivationLocator !== null ||
      authority.proofState !== "verified-losing" ||
      authority.terminalAuthority?.kind !== "local-operation" ||
      authority.terminalOperationId !== authority.terminalAuthority.operationId
    ) {
      throw new Error("browser CTF local removal authority is not eligible");
    }
    await requireProofReconciliationFence(input.database, proof, authority);
    await requireLocalTerminalAuthority(input, proof, authority);
  }

  await requireBrowserWalletNewWritePermission({
    database: input.database,
    scopeId: input.scopeId,
  });
  requireCurrent(input);
  await removeLegacyCacheRows(input.database, proofs, authorities);
  await input.database.custodyProofs.bulkDelete(keys);
  await input.database.custodyProofBackupAuthorities.bulkPut(
    proofs.map((proof) =>
      createBrowserCompletedLocalProofRemovalMarkerRow({
        scopeId: proof.scopeId,
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        proofRevision: proof.revision,
        localAssetKey,
        terminalOperationId: authorities.get(proof.proofId)!.terminalOperationId!,
        completedAtMs: observedAtMs,
      }),
    ),
  );
  if (input.fault === "before-commit") {
    throw new Error("browser CTF local removal commit fault");
  }
  requireCurrent(input);
  return { kind: "completed", intentId: "completed-local-removal" };
}

async function requireLocalTerminalAuthority(
  input: BrowserCtfRemoveInput,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): Promise<void> {
  const terminalOperationId = authority.terminalOperationId;
  if (terminalOperationId === null) {
    throw new Error("browser CTF local removal terminal operation is missing");
  }
  await new BrowserEncryptedWalletBackupV2TerminalSealStore({
    database: input.database,
    scopeId: input.scopeId,
  }).withCommittedTerminalRejection(terminalOperationId, ({ record, exactRejection }) =>
    validateLocalTerminalOperation(record, exactRejection, proof, terminalOperationId),
  );
}

function localRemovalAsset(asset: EncryptedWalletBackupV2AssetIdentity): {
  readonly conditionId: string;
  readonly outcomeCollectionId: string;
} {
  const parts = asset.assetIdentity.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "ctf" ||
    !/^[0-9a-f]{64}$/.test(parts[1]!) ||
    !/^[0-9a-f]{64}$/.test(parts[2]!)
  ) {
    throw new Error("browser CTF local removal asset is invalid");
  }
  return { conditionId: parts[1]!, outcomeCollectionId: parts[2]! };
}

function authorityStore(
  input: BrowserCtfBackupContext,
): EncryptedWalletBackupV2DexieAuthorityStore {
  return new EncryptedWalletBackupV2DexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
  });
}

function removalTables(database: BitcasterDB) {
  return [
    database.custodyProofs,
    database.custodyProofBackupAuthorities,
    database.custodyReservations,
    database.custodyOperations,
    database.custodyArtifacts,
    database.custodyActiveWork,
    database.encryptedWalletBackupEnrollmentResults,
    database.encryptedWalletBackupV2DesiredAssets,
    database.encryptedWalletBackupV2PreparedMutations,
    database.encryptedWalletBackupV2AcceptedHeads,
    database.encryptedWalletBackupV2ActiveDescriptors,
    database.proofs,
  ] as const;
}

async function exactAssetRows(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
): Promise<readonly BrowserCustodyProofRow[]> {
  const context = desired.terminalCtfContext;
  if (context === null) throw new Error("browser CTF removal context is missing");
  const raw = await database.custodyProofs
    .where("[scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]")
    .between(
      [
        desired.scopeId,
        desired.mintUrl,
        desired.unit,
        context.conditionId,
        context.outcomeLabel,
        "",
      ],
      [
        desired.scopeId,
        desired.mintUrl,
        desired.unit,
        context.conditionId,
        context.outcomeLabel,
        "\uffff",
      ],
      true,
      true,
    )
    .limit(MAX_PROOFS + 1)
    .toArray();
  if (raw.length > MAX_PROOFS) throw new Error("browser CTF removal proof count exceeds the limit");
  return raw.map(decodeBrowserCustodyProofRow);
}

async function requireRemovalRows(
  input: BrowserCtfRemoveInput,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  proofIds: readonly string[],
  resuming: boolean,
  intent?: EncryptedWalletBackupV2RemovalIntent,
): Promise<readonly BrowserCustodyProofRow[]> {
  const rows = await exactAssetRows(input.database, desired);
  if (!resuming && rows.length !== desired.activeProofCount) {
    throw new Error("browser CTF removal local proof count is stale");
  }
  if (
    resuming &&
    (intent === undefined || rows.length !== desired.activeProofCount + intent.proofs.length)
  ) {
    throw new Error("browser CTF removal pending proof set is stale");
  }
  const byId = new Map(rows.map((proof) => [proof.proofId, proof]));
  for (const proofId of proofIds) {
    const proof = byId.get(proofId);
    if (proof === undefined) throw new Error("browser CTF removal proof is missing");
    if (
      !resuming &&
      (proof.selectability !== "verified-losing" || proof.reservationOperationId !== null)
    ) {
      throw new Error("browser CTF removal requires exact verified-losing proofs");
    }
    if (resuming) {
      const tuple = intent!.proofs.find((candidate) => candidate.proofId === proofId);
      if (
        tuple === undefined ||
        proof.selectability !== "pending-removal" ||
        proof.reservationOperationId !== null ||
        proof.revision !== tuple.proofRevision + 1 ||
        proof.proofFingerprint !== tuple.proofFingerprint
      ) {
        throw new Error("browser CTF removal pending proof authority is stale");
      }
    }
  }
  return rows;
}

async function requireRemovalAuthorities(
  input: Pick<BrowserCtfRemoveInput, "database" | "scopeId">,
  rows: readonly BrowserCustodyProofRow[],
): Promise<ReadonlyMap<string, BrowserProofBackupAuthorityRow>> {
  const raw = await input.database.custodyProofBackupAuthorities.bulkGet(
    rows.map((proof) => [input.scopeId, proof.proofId]),
  );
  const authorities = new Map<string, BrowserProofBackupAuthorityRow>();
  for (const [index, proof] of rows.entries()) {
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(raw[index], [input.scopeId, proof.proofId]),
      proof,
    );
    authorities.set(proof.proofId, authority);
  }
  return authorities;
}

async function requireProofReconciliationFence(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): Promise<void> {
  if (proof.reservationOperationId !== null) {
    throw new Error("browser CTF removal proof is reserved");
  }
  if (await database.custodyReservations.get([proof.scopeId, proof.proofId])) {
    throw new Error("browser CTF removal proof reservation conflicts");
  }
  const operationId = authority.admissionOperationId;
  if (operationId === null) return;
  const [operationRow, activeWork] = await Promise.all([
    database.custodyOperations.get([proof.scopeId, operationId]),
    database.custodyActiveWork.get([proof.scopeId, operationId]),
  ]);
  if (activeWork !== undefined) throw new Error("browser CTF removal unfinished custody work");
  if (operationRow === undefined) return;
  const record = decodeDurableCustodyRecord(operationRow.record);
  if (
    record.scope.scopeId !== proof.scopeId ||
    record.operation.operationId !== operationId ||
    operationRow.scopeId !== proof.scopeId ||
    operationRow.operationId !== operationId ||
    operationRow.revision !== record.revision ||
    operationRow.operationState !== record.operation.state ||
    operationRow.nextAttemptAtMs !== record.operation.retry.nextAttemptAtMs ||
    !record.operation.proofStorage.lineage.successorProofIds.includes(proof.proofId) ||
    (record.operation.proofStorage.lineage.successorAdmission !== null &&
      !record.operation.proofStorage.lineage.successorAdmission.proofRows.some(
        ({ proofId }) => proofId === proof.proofId,
      ))
  ) {
    throw new Error("browser CTF removal creator operation is foreign");
  }
  if (classifyDurableCustodyActiveWork(record) !== "none") {
    throw new Error("browser CTF removal unfinished custody work");
  }
}

async function requireTerminalAuthority(
  input: Pick<BrowserCtfRemoveInput, "database" | "scopeId" | "keyHandle">,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): Promise<string> {
  if (
    (proof.selectability !== "verified-losing" && proof.selectability !== "pending-removal") ||
    authority.proofState !== proof.selectability ||
    authority.terminalAuthority === null
  ) {
    throw new Error("browser CTF removal terminal authority is missing");
  }
  const entry = terminalProofEntry(desired, proof, authority);
  const proofCommitment = digestEncryptedWalletBackupV2TerminalProofCommitment(entry);
  if (authority.terminalAuthority.kind === "remote-seal") {
    if (
      authority.backupState !== "remote-backed" ||
      authority.terminalOperationId !== null ||
      authority.backupRecordId !== proof.proofId ||
      authority.backupRecordCommitment !== proofCommitment
    ) {
      throw new Error("browser CTF removal remote terminal authority is foreign");
    }
    if (proof.selectability === "verified-losing") {
      await requireBrowserV2KeysetFreeTerminalContextForProof({
        database: input.database,
        proof,
        authority,
      });
    }
    return proofCommitment;
  }
  const operationId = authority.terminalAuthority.operationId;
  if (
    authority.backupState !== "local-only" ||
    authority.terminalOperationId !== operationId ||
    authority.admissionOperationId.length === 0
  ) {
    throw new Error("browser CTF removal local terminal authority is foreign");
  }
  const validate = ({
    record,
    exactRejection,
  }: {
    readonly record: DurableCustodyRecord;
    readonly exactRejection: DurableCustodyExactArtifact;
  }) => validateLocalTerminalOperation(record, exactRejection, proof, operationId);
  if (proof.selectability === "verified-losing") {
    await new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: input.database,
      scopeId: input.scopeId,
    }).withCommittedTerminalRejection(operationId, validate);
  } else {
    const decodedScope = decodeDurableCustodyScopeInput(input.scopeId);
    const scope = { ...decodedScope, scopeId: input.scopeId };
    const snapshot = await new BrowserDurableCustodyAdapter(input.database).readOperationSnapshot(
      scope,
      operationId,
    );
    if (snapshot === null) throw new Error("browser CTF removal terminal operation is missing");
    const rejectionReference = snapshot.record.operation.terminalMintRejection?.exactRejection;
    const exactRejection = snapshot.artifacts.find(
      ({ reference }) => reference.artifactId === rejectionReference?.artifactId,
    )?.artifact;
    if (exactRejection === undefined) {
      throw new Error("browser CTF removal terminal rejection artifact is missing");
    }
    validate({ record: snapshot.record, exactRejection });
  }
  return proofCommitment;
}

function terminalProofEntry(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): EncryptedWalletBackupV2ProofSetProof & { readonly proofId: string } {
  const context = desired.terminalCtfContext;
  if (
    context === null ||
    proof.assetKind !== "conditional" ||
    proof.conditionId !== context.conditionId ||
    proof.outcomeCollection !== context.outcomeLabel ||
    authority.derivationLocator === null
  ) {
    throw new Error("browser CTF removal terminal proof binding is invalid");
  }
  const proofMaterial = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(proof.proofBody)),
  );
  return {
    proofId: proof.proofId,
    mintUrl: proof.normalizedMint,
    unit: proof.unit,
    asset: {
      kind: "ctf",
      conditionId: context.conditionId,
      outcomeLabel: context.outcomeLabel,
      outcomeCollectionId: context.outcomeCollectionId,
      registeredAt: context.registeredAt,
      finalExpiry: context.finalExpiry,
    },
    proof: proofMaterial,
    locator: decodeDurableWalletProofDerivationLocator(authority.derivationLocator),
  };
}

function validateLocalTerminalOperation(
  record: DurableCustodyRecord,
  exactRejection: DurableCustodyExactArtifact,
  proof: BrowserCustodyProofRow,
  operationId: string,
): void {
  const operation = record.operation;
  const reservationInput = operation.reservation.inputs.find(
    ({ proofId }) => proofId === proof.proofId,
  );
  if (
    record.scope.scopeId !== proof.scopeId ||
    operation.operationId !== operationId ||
    operation.semanticKind !== "ctf-redeem" ||
    operation.state !== "aborted" ||
    operation.custodyContext.normalizedMint !== proof.normalizedMint ||
    operation.custodyContext.unit !== proof.unit ||
    operation.exactRequest.inputProofIds.filter((proofId) => proofId === proof.proofId).length !==
      1 ||
    reservationInput === undefined ||
    reservationInput.keysetId !== proof.keysetId ||
    reservationInput.curve !== proof.curve
  ) {
    throw new Error("browser CTF removal local terminal operation is foreign");
  }
  const rejection = readDurableCustodyAuthenticatedTerminalMintRejection({
    record,
    exactRejection,
  });
  if (
    rejection.operationId !== operationId ||
    rejection.normalizedMint !== proof.normalizedMint ||
    rejection.code !== 13015
  ) {
    throw new Error("browser CTF removal local terminal rejection is foreign");
  }
}

function requirePendingRemovalAuthority(
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
  intent: EncryptedWalletBackupV2RemovalIntent,
  proofCommitment: string,
): void {
  const tuple = intent.proofs.find((candidate) => candidate.proofId === proof.proofId);
  if (
    tuple === undefined ||
    authority.proofState !== "pending-removal" ||
    authority.proofRevision !== proof.revision ||
    authority.proofFingerprint !== proof.proofFingerprint ||
    tuple.proofRevision + 1 !== proof.revision ||
    tuple.proofFingerprint !== proof.proofFingerprint ||
    tuple.proofCommitment !== proofCommitment
  ) {
    throw new Error("browser CTF removal pending authority is stale");
  }
}

async function removeLegacyCacheRows(
  database: BitcasterDB,
  proofs: readonly BrowserCustodyProofRow[],
  authorities: ReadonlyMap<string, BrowserProofBackupAuthorityRow>,
): Promise<void> {
  const rows = await database.proofs.bulkGet(
    proofs.map((proof) => storedProofFromCustodyRow(proof).secret),
  );
  const secrets: string[] = [];
  for (const [index, raw] of rows.entries()) {
    if (raw === undefined) continue;
    const proof = proofs[index]!;
    const cached = storedProofFromRow(raw);
    const expected = storedProofFromCustodyRow(proof);
    if (
      cached.mintUrl !== expected.mintUrl ||
      cached.unit !== expected.unit ||
      cached.id !== expected.id ||
      cached.C !== expected.C ||
      Number(cached.amount) !== Number(expected.amount) ||
      cached.conditionId !== expected.conditionId ||
      cached.outcomeCollection !== expected.outcomeCollection ||
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(cached)) !==
        proof.proofFingerprint
    ) {
      throw new Error("browser CTF removal legacy cache conflicts");
    }
    if (cached.reservedBy !== undefined) throw new Error("browser CTF removal cache is reserved");
    const authority = authorities.get(proof.proofId);
    if (
      cached.terminalOperationId !== undefined &&
      authority?.terminalAuthority?.kind !== "local-operation"
    ) {
      throw new Error("browser CTF removal cache terminal authority conflicts");
    }
    secrets.push(raw.secret);
  }
  if (secrets.length > 0) await database.proofs.bulkDelete(secrets);
}

function requireExclusionEvidence(
  input: BrowserCtfAssetLocatorContext,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  accepted: Awaited<ReturnType<EncryptedWalletBackupV2DexieAuthorityStore["readAcceptedHead"]>>,
  descriptors: Awaited<
    ReturnType<EncryptedWalletBackupV2DexieAuthorityStore["listActiveDescriptors"]>
  >,
): void {
  const evidence = desired.removalIntent?.acknowledgedExclusionEvidence;
  if (evidence === null || evidence === undefined || accepted === null) {
    throw new Error("browser CTF removal accepted head evidence is missing");
  }
  if (
    accepted.headVersion !== evidence.headVersion ||
    accepted.activeSetDigest !== evidence.activeSetDigest
  ) {
    throw new Error("browser CTF removal accepted head evidence is stale");
  }
  const target = descriptors.filter(({ assetLocator }) => assetLocator === input.assetLocator);
  if (evidence.bundleId === null) {
    if (target.length !== 0 || evidence.bundleDescriptorDigest !== null) {
      throw new Error("browser CTF removal exclusion evidence is invalid");
    }
  } else if (
    target.length !== 1 ||
    target[0]!.bundleId !== evidence.bundleId ||
    target[0]!.custodyRevision !== desired.custodyRevision ||
    target[0]!.canonicalDescriptor.length === 0 ||
    digestEncryptedWalletBackupV2BundleDescriptor(
      decodeEncryptedWalletBackupV2BundleDescriptorWire(target[0]!.canonicalDescriptor, {
        realm: input.keyHandle.realm,
        walletId: input.keyHandle.walletId,
      }),
    ) !== evidence.bundleDescriptorDigest
  ) {
    throw new Error("browser CTF removal replacement evidence is invalid");
  }
}

function requireDesiredAsset(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  scopeId: string,
  asset: EncryptedWalletBackupV2AssetIdentity,
): void {
  if (
    desired.scopeId !== scopeId ||
    desired.mintUrl !== asset.mintUrl ||
    desired.unit !== asset.unit ||
    desired.assetIdentity !== asset.assetIdentity
  ) {
    throw new Error("browser CTF removal asset is foreign");
  }
  if (desired.terminalCtfContext === null) {
    throw new Error("browser CTF removal terminal context is missing");
  }
}

async function requireAssetLocator(input: BrowserCtfManagedRemoveInput): Promise<void> {
  const expected = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    mintUrl: input.asset.mintUrl,
    unit: input.asset.unit,
    assetIdentity: input.asset.assetIdentity,
  });
  if (expected !== input.assetLocator) {
    throw new Error("browser CTF removal asset locator is foreign");
  }
}

async function requireDesiredLocator(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  assetLocator: string,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
): Promise<void> {
  const expected = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: desired.mintUrl,
    unit: desired.unit,
    assetIdentity: desired.assetIdentity,
  });
  if (expected !== assetLocator) throw new Error("browser CTF removal asset locator is foreign");
}

function requireFinalizeAssetLocator(input: {
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly assetLocator: string;
}): void {
  const expectedScope = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: input.keyHandle.walletId,
  });
  if (
    expectedScope !== decodeDurableCustodyScopeId(input.scopeId) ||
    !/^[0-9a-f]{64}$/.test(input.assetLocator)
  ) {
    throw new Error("browser CTF removal finalization identity is foreign");
  }
}

function requireRemovalIntentProfile(
  intent: EncryptedWalletBackupV2RemovalIntent,
  input: BrowserCtfBackupContext,
): void {
  if (
    intent.realm !== input.keyHandle.realm ||
    intent.walletId !== input.keyHandle.walletId ||
    intent.enrollmentEpoch !== input.enrollmentEpoch
  ) {
    throw new Error("browser CTF removal intent is foreign");
  }
}

function nextProofRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("browser CTF removal proof revision exceeds the limit");
  }
  return revision + 1;
}

function predecessorCustodyRevision(revision: string): string {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(revision)) {
    throw new Error("browser CTF rejected removal custody revision is invalid");
  }
  const parsed = BigInt(revision);
  if (parsed < 1n) {
    throw new Error("browser CTF rejected removal custody revision is invalid");
  }
  return (parsed - 1n).toString();
}

async function completedRemovalReplay(
  database: BitcasterDB,
  scopeId: string,
  localAssetKey: string,
  proofIds: readonly string[],
  identity: Pick<BrowserCtfRemoveInput, "keyHandle" | "enrollmentEpoch">,
  targets?: readonly BrowserCtfRemoveTarget[],
): Promise<boolean> {
  const rows = await database.custodyProofBackupAuthorities.bulkGet(
    proofIds.map((proofId) => [scopeId, proofId]),
  );
  if (rows.some((row) => row === undefined)) return false;
  const markers = rows.map((row) => {
    try {
      const marker = decodeBrowserProofBackupAuthorityTableRow(row);
      return "recordKind" in marker ? marker : null;
    } catch {
      return null;
    }
  });
  if (markers.some((marker) => marker === null)) return false;
  const first = markers[0]!;
  if (first.recordKind === "completed-local-removal") {
    return markers.every(
      (marker, index) =>
        marker?.recordKind === "completed-local-removal" &&
        marker.scopeId === scopeId &&
        marker.proofId === proofIds[index] &&
        marker.localAssetKey === localAssetKey &&
        (targets === undefined ||
          (marker.proofFingerprint === targets[index]?.proofFingerprint &&
            marker.proofRevision === targets[index]?.proofRevision)),
    );
  }
  if (first.recordKind !== "completed-removal") return false;
  const keyHandle = identity.keyHandle;
  const enrollmentEpoch = identity.enrollmentEpoch;
  if (keyHandle === undefined || enrollmentEpoch === undefined) return false;
  return markers.every(
    (marker, index) =>
      marker?.recordKind === "completed-removal" &&
      marker.scopeId === scopeId &&
      marker.proofId === proofIds[index] &&
      (targets === undefined ||
        (marker.proofFingerprint === targets[index]?.proofFingerprint &&
          marker.proofRevision === nextProofRevision(targets[index]!.proofRevision))) &&
      marker.localAssetKey === localAssetKey &&
      marker.realm === keyHandle.realm &&
      marker.walletId === keyHandle.walletId &&
      marker.enrollmentEpoch === enrollmentEpoch &&
      marker.removalIntentId === first.removalIntentId &&
      marker.proofSetCommitment === first.proofSetCommitment &&
      marker.completionCustodyRevision === first.completionCustodyRevision &&
      marker.acknowledgedHeadVersion === first.acknowledgedHeadVersion &&
      marker.acknowledgedActiveSetDigest === first.acknowledgedActiveSetDigest &&
      marker.acknowledgementKind === first.acknowledgementKind &&
      marker.receiptDigest === first.receiptDigest,
  );
}

function requireSameRemovalTargets(
  intent: EncryptedWalletBackupV2RemovalIntent,
  targets: readonly BrowserCtfRemoveTarget[],
): void {
  const pendingById = new Map(intent.proofs.map((proof) => [proof.proofId, proof]));
  if (
    intent.proofs.length !== targets.length ||
    targets.some((target) => {
      const proof = pendingById.get(target.proofId);
      return (
        proof === undefined ||
        proof.proofFingerprint !== target.proofFingerprint ||
        proof.proofRevision !== target.proofRevision
      );
    })
  ) {
    throw new Error("browser CTF removal proof set conflicts with pending intent");
  }
}

function requireExactRemovalTargets(
  targets: readonly BrowserCtfRemoveTarget[],
  proofs: readonly BrowserCustodyProofRow[],
): void {
  const proofsById = new Map(proofs.map((proof) => [proof.proofId, proof]));
  if (
    targets.length !== proofs.length ||
    targets.some((target) => {
      const proof = proofsById.get(target.proofId);
      return (
        proof === undefined ||
        proof.proofFingerprint !== target.proofFingerprint ||
        proof.revision !== target.proofRevision
      );
    })
  ) {
    throw new Error("browser CTF removal caller proof tuples are stale");
  }
}

function sortedRemoveTargets(
  value: readonly BrowserCtfRemoveTarget[],
): readonly BrowserCtfRemoveTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROOFS) {
    throw new Error("browser CTF removal proof set is invalid");
  }
  const targets = Array.from(value, (target) => {
    if (
      target === null ||
      typeof target !== "object" ||
      typeof target.proofId !== "string" ||
      !/^[0-9a-f]{64}$/.test(target.proofId) ||
      typeof target.proofFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(target.proofFingerprint) ||
      !Number.isSafeInteger(target.proofRevision) ||
      target.proofRevision < 0
    ) {
      throw new Error("browser CTF removal proof tuple is invalid");
    }
    return {
      proofId: target.proofId,
      proofFingerprint: target.proofFingerprint,
      proofRevision: target.proofRevision,
    };
  });
  targets.sort((left, right) =>
    left.proofId < right.proofId ? -1 : left.proofId > right.proofId ? 1 : 0,
  );
  if (
    targets.some((target, index) => index > 0 && targets[index - 1]!.proofId === target.proofId)
  ) {
    throw new Error("browser CTF removal proof set is duplicated");
  }
  return targets;
}

function sortedProofIds(value: readonly string[]): readonly string[] {
  if (value.length < 1 || value.length > MAX_PROOFS) {
    throw new Error("browser CTF removal proof set is invalid");
  }
  const ids = [...value];
  if (ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error("browser CTF removal proof id is invalid");
  }
  ids.sort();
  if (ids.some((id, index) => index > 0 && ids[index - 1] === id)) {
    throw new Error("browser CTF removal proof set is duplicated");
  }
  return ids;
}

type BrowserCtfBackupContext = Pick<
  BrowserCtfRemoveInput,
  "database" | "scopeId" | "keyHandle" | "enrollmentEpoch"
> &
  Required<Pick<BrowserCtfRemoveInput, "keyHandle" | "enrollmentEpoch">>;

type BrowserCtfAssetLocatorContext = BrowserCtfBackupContext &
  Required<Pick<BrowserCtfRemoveInput, "assetLocator">>;

type BrowserCtfManagedRemoveInput = BrowserCtfRemoveInput &
  Required<Pick<BrowserCtfRemoveInput, "keyHandle" | "enrollmentEpoch" | "assetLocator">>;

function hasManagedRemoveContext(
  input: BrowserCtfRemoveInput,
): input is BrowserCtfManagedRemoveInput {
  return (
    input.keyHandle !== undefined &&
    input.enrollmentEpoch !== undefined &&
    input.assetLocator !== undefined
  );
}

function requireManagedRemoveContext(
  input: BrowserCtfRemoveInput,
): asserts input is BrowserCtfManagedRemoveInput {
  if (!hasManagedRemoveContext(input)) {
    throw new Error("browser CTF managed removal backup context is missing");
  }
}

function requireRemoveIdentity(input: BrowserCtfRemoveInput): void {
  const hasAnyBackupContext =
    input.keyHandle !== undefined ||
    input.enrollmentEpoch !== undefined ||
    input.assetLocator !== undefined;
  if (hasAnyBackupContext && !hasManagedRemoveContext(input)) {
    throw new Error("browser CTF removal backup context is incomplete");
  }
  if (input.keyHandle === undefined) {
    const scope = decodeDurableCustodyScopeInput(input.scopeId);
    if (scope.scopeKind !== "wallet") {
      throw new Error("browser CTF removal wallet scope is foreign");
    }
    if (!input.asset.assetIdentity.startsWith("ctf:") || input.asset.unit !== "msat") {
      throw new Error("browser CTF removal requires a CTF asset");
    }
    return;
  }
  requireManagedRemoveContext(input);
  const expectedScope = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: input.keyHandle.walletId,
  });
  if (expectedScope !== decodeDurableCustodyScopeId(input.scopeId)) {
    throw new Error("browser CTF removal wallet scope is foreign");
  }
  if (
    !input.asset.assetIdentity.startsWith("ctf:") ||
    input.asset.unit !== "msat" ||
    input.enrollmentEpoch < 1
  ) {
    throw new Error("browser CTF removal requires a CTF asset");
  }
}

function requireCurrent(input: { readonly isCurrentProfile?: () => boolean }): void {
  if (input.isCurrentProfile?.() === false) throw new Error("browser CTF removal profile is stale");
}
