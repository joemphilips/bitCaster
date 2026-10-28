import {
  deriveEncryptedWalletBackupV2AssetLocator,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2KeyHandle,
} from "@bitcaster/client-sdk";
import type { EncryptedWalletBackupOwnerCandidate } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDiscovery";
import type {
  EncryptedWalletBackupOwnerCollectedHeadEvidence,
  EncryptedWalletBackupOwnerContext,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import type { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ProofState, Wallet as CashuWallet } from "@cashu/cashu-ts";
import Dexie from "dexie";
import {
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
} from "../stores/browser-proof-backup-authority";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../stores/encrypted-wallet-backup-owner-db";
import { pageActiveCtfRangePreparations } from "../stores/ctf-range-order-db";
import { storedProofFromCustodyRow, type BitcasterDB } from "../stores/proof-db";
import { encryptedWalletBackupV2LocalAssetKey } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { hashToCurve } from "@cashu/cashu-ts";
import { EncryptedWalletBackupOwnerHttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHttpAdapter";
import { decodeDurableBolt11MintQuote } from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { discoverAndVerifyBrowserEncryptedWalletBackupOwnerDescriptor } from "./browserEncryptedWalletBackupV2Restore";
import { admitBrowserEncryptedWalletBackupOwnerAsset } from "./browserEncryptedWalletBackupOwnerAdmission";
import { withWalletProfileLock } from "./walletProfileLock";

const TEXT_MIN = "";
const TEXT_MAX = "\uffff";
const NUT07_BATCH = 256;
const SNAPSHOT_PROOF_MAX =
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX * ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX;

export type BrowserEncryptedWalletBackupOwnerConflictIncompleteReason =
  | "remote-unavailable"
  | "remote-head-changed"
  | "local-predecessor-unspent"
  | "local-predecessor-unknown"
  | "submitted-work-unresolved"
  | "local-state-changed";

export type BrowserEncryptedWalletBackupOwnerConflictResult =
  | { readonly kind: "completed"; readonly headVersion: number; readonly recoveryVersion: number }
  | {
      readonly kind: "incomplete";
      readonly reason: BrowserEncryptedWalletBackupOwnerConflictIncompleteReason;
    };

export interface BrowserEncryptedWalletBackupOwnerConflictInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly owner: EncryptedWalletBackupOwnerCandidate;
  readonly ownerContext: EncryptedWalletBackupOwnerContext;
  readonly ownerClient: Pick<EncryptedWalletBackupOwnerClient, "readCurrentHead" | "readObject">;
  readonly ownerStore: EncryptedWalletBackupOwnerDexieAuthorityStore;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly loadWallet: (mintUrl: string) => Promise<CashuWallet>;
  readonly lockManager?: Pick<LockManager, "request">;
}

interface Snapshot {
  readonly digest: string;
  readonly activeProofCount: number;
}

/** Reconciles one selected owner's competing head without creating V2 head authority. */
export async function recoverBrowserEncryptedWalletBackupOwnerConflict(
  input: BrowserEncryptedWalletBackupOwnerConflictInput,
): Promise<BrowserEncryptedWalletBackupOwnerConflictResult> {
  requireCurrent(input);
  const status = await input.ownerStore.readLocalRecoveryStatus();
  if (status?.localRecoveryStatus !== "recovery-required")
    throw new Error("encrypted backup owner conflict recovery is not required");
  if (await input.ownerStore.readPreparedMutation()) return incomplete("submitted-work-unresolved");
  const currentHead = await input.ownerStore.readCurrentHead();
  if (currentHead === null) return incomplete("local-state-changed");

  const firstHead = await tryReadHead(input);
  if (firstHead === null) return incomplete("remote-unavailable");
  if (await hasUnresolvedSubmittedWork(input.database, input.scopeId))
    return incomplete("submitted-work-unresolved");
  const staged = await input.ownerStore.stageRecoveryHead({
    expectedHeadVersion: currentHead.head.headVersion,
    expectedRecoveryVersion: status.localRecoveryVersion,
    evidence: firstHead,
  });
  if (staged !== "staged") return incomplete("local-state-changed");

  const desiredRows = await readDesiredRows(input);
  const desiredByLocator = new Map<
    string,
    ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>
  >();
  for (const desired of desiredRows) {
    requireCurrent(input);
    const locator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    });
    if (desiredByLocator.has(locator)) throw new Error("owner conflict local asset is duplicated");
    desiredByLocator.set(locator, desired);
  }

  const remoteLocators = new Set(firstHead.bundles.map(({ assetLocator }) => assetLocator));
  for (const [locator, desired] of desiredByLocator) {
    if (remoteLocators.has(locator)) continue;
    if (desired.removalIntent !== null) return incomplete("submitted-work-unresolved");
    const retired = await retireSpentLocalProofs(input, desired, []);
    if (retired === "unspent") return incomplete("local-predecessor-unspent");
    if (retired === "unknown") return incomplete("local-predecessor-unknown");
    const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
      input.scopeId,
      desired.localAssetKey,
    ]);
    requireCurrent(input);
    if (raw === undefined) return incomplete("local-state-changed");
    const current = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    if (current.activeProofCount !== 0) return incomplete("local-state-changed");
    const preserved = await input.ownerStore.preserveLocalDesiredPending({
      localAssetKey: current.localAssetKey,
      assetLocator: locator,
      custodyRevision: current.custodyRevision,
      desiredAction: current.desiredAction,
      activeProofCount: current.activeProofCount,
    });
    if (preserved !== "preserved") return incomplete("local-state-changed");
  }

  for (const descriptor of firstHead.bundles) {
    requireCurrent(input);
    const restored = await discoverAndVerifyBrowserEncryptedWalletBackupOwnerDescriptor({
      seed: input.seed,
      keyHandle: input.keyHandle,
      ownerClient: input.ownerClient,
      owner: input.owner,
      ownerContext: input.ownerContext,
      collectedOwnerHeadEvidence: firstHead,
      descriptor,
      runtime: input.runtime,
      signal: input.signal,
      isCurrentProfile: input.isCurrentProfile,
      loadWallet: input.loadWallet,
    });
    const localAssetKey = encryptedWalletBackupV2LocalAssetKey(restored.asset);
    const desired = desiredByLocator.get(descriptor.assetLocator);
    if (desired?.removalIntent !== null && desired !== undefined)
      return incomplete("submitted-work-unresolved");
    if (desired !== undefined) {
      const retired = await retireSpentLocalProofs(
        input,
        desired,
        restored.verified.proofSet.proofs.map(({ proofId }) => proofId),
      );
      if (retired === "unspent") return incomplete("local-predecessor-unspent");
      if (retired === "unknown") return incomplete("local-predecessor-unknown");
      const currentRows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: input.database,
        scopeId: input.scopeId,
        asset: restored.asset,
      });
      const remoteIds = new Set(restored.verified.proofSet.proofs.map(({ proofId }) => proofId));
      if (
        currentRows.length > 0 &&
        currentRows.every(({ proofId }) => remoteIds.has(proofId)) &&
        currentRows.length === remoteIds.size
      ) {
        await withWalletProfileLock(
          input.scopeId,
          () =>
            input.database.transaction(
              "rw",
              [
                input.database.encryptedWalletBackupOwnerAcceptedHeads,
                input.database.encryptedWalletBackupOwnerActiveDescriptors,
                input.database.encryptedWalletBackupOwnerProofCoverage,
                input.database.encryptedWalletBackupOwnerDesiredAssets,
                input.database.encryptedWalletBackupV2DesiredAssets,
                input.database.custodyProofs,
                input.database.custodyProofBackupAuthorities,
              ],
              () =>
                input.ownerStore.assertCurrentRestoreAuthority({
                  database: input.database,
                  collectedHeadEvidence: firstHead,
                  verified: restored.verified,
                  proofIds: [...remoteIds],
                  localAssetKey,
                  requireExistingProofs: true,
                }),
            ),
          input.lockManager,
          input.signal,
        );
        continue;
      }
    }
    const live = restored.verified.proofSet.proofs.some(
      ({ selectionAuthority }) => selectionAuthority === "live-verified",
    );
    try {
      await admitBrowserEncryptedWalletBackupOwnerAsset({
        seed: input.seed,
        verified: restored.verified,
        collectedHeadEvidence: firstHead,
        ownerContext: input.ownerContext,
        ownerAuthorityStore: input.ownerStore,
        asset: restored.asset,
        database: input.database,
        ...(live ? { wallet: await input.loadWallet(restored.asset.mintUrl) } : {}),
        sourceOperationId: `owner-conflict:${firstHead.head.headVersion}:${descriptor.assetLocator}`,
        isCurrentProfile: input.isCurrentProfile,
        lockManager: input.lockManager,
      });
    } catch (error) {
      // A targeted restore can change this local row after the snapshot above.
      // A later pass reads the new row and repeats every check.
      const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
        input.scopeId,
        localAssetKey,
      ]);
      const current = raw === undefined ? undefined : decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
      if (!sameDesiredRow(desired, current)) return incomplete("local-state-changed");
      throw error;
    }
  }

  if (await hasUnresolvedSubmittedWork(input.database, input.scopeId))
    return incomplete("submitted-work-unresolved");
  const captured = await withWalletProfileLock(
    input.scopeId,
    () => readSnapshot(input),
    input.lockManager,
    input.signal,
  );
  const secondHead = await tryReadHead(input);
  if (secondHead === null) return incomplete("remote-unavailable");
  if (!sameOwnerHead(firstHead, secondHead)) return incomplete("remote-head-changed");
  try {
    const accepted = await withWalletProfileLock(
      input.scopeId,
      () =>
        input.ownerStore.acceptRecoveredHead({
          expectedHeadVersion: firstHead.head.headVersion,
          expectedRecoveryVersion: status.localRecoveryVersion,
          evidence: secondHead,
          recheckLocalState: async () => {
            requireCurrent(input);
            if (await hasUnresolvedSubmittedWork(input.database, input.scopeId)) return false;
            const latest = await readSnapshot(input);
            requireCurrent(input);
            return (
              latest.digest === captured.digest &&
              latest.activeProofCount === captured.activeProofCount
            );
          },
        }),
      input.lockManager,
      input.signal,
    );
    if (accepted !== "accepted") return incomplete("local-state-changed");
    return {
      kind: "completed",
      headVersion: secondHead.head.headVersion,
      recoveryVersion: status.localRecoveryVersion + 1,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("local state changed"))
      return incomplete("local-state-changed");
    throw error;
  }
}

async function retireSpentLocalProofs(
  input: BrowserEncryptedWalletBackupOwnerConflictInput,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  remoteProofIds: readonly string[],
): Promise<"retired" | "unspent" | "unknown"> {
  requireCurrent(input);
  if (desired.activeProofCount === 0) return "retired";
  const asset = {
    mintUrl: desired.mintUrl,
    unit: desired.unit,
    assetIdentity: desired.assetIdentity,
  };
  const local = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset,
  });
  if (local.length !== desired.activeProofCount) return "unknown";
  const remote = new Set(remoteProofIds);
  const predecessors = local.filter(({ proofId }) => !remote.has(proofId));
  if (predecessors.length === 0) return "retired";
  const wallet = await input.loadWallet(desired.mintUrl);
  requireCurrent(input);
  for (let offset = 0; offset < predecessors.length; offset += NUT07_BATCH) {
    const batch = predecessors.slice(offset, offset + NUT07_BATCH);
    let states: readonly ProofState[];
    try {
      states = await wallet.checkProofsStates(
        batch.map((proof) => {
          const stored = storedProofFromCustodyRow(proof);
          return { id: stored.id, secret: stored.secret };
        }),
      );
    } catch {
      return "unknown";
    }
    requireCurrent(input);
    const byY = new Map(
      batch.map((proof) => {
        const stored = storedProofFromCustodyRow(proof);
        return [hashToCurve(new TextEncoder().encode(stored.secret)).toHex(true), proof] as const;
      }),
    );
    if (states.length !== batch.length) return "unknown";
    for (const state of states) {
      if (!byY.has(state.Y)) return "unknown";
      byY.delete(state.Y);
      if (state.state === "UNSPENT") return "unspent";
      if (state.state !== "SPENT") return "unknown";
    }
    if (byY.size !== 0) return "unknown";
  }
  const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
    predecessors.map(({ proofId }) => [input.scopeId, proofId]),
  );
  const candidates = predecessors.map((proof, index) => ({
    proof,
    authority: requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(authorities[index], [
        input.scopeId,
        proof.proofId,
      ]),
      proof,
    ),
  }));
  await withWalletProfileLock(
    input.scopeId,
    () =>
      new BrowserDurableCustodyAdapter(input.database).retireExactMintSpentProofs({
        scopeId: input.scopeId,
        candidates,
        expectedDesiredAsset: desired,
        observedAtMs: Date.now(),
      }),
    input.lockManager,
    input.signal,
  );
  requireCurrent(input);
  return "retired";
}

type DesiredRow = ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>;

function sameDesiredRow(left: DesiredRow | undefined, right: DesiredRow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.custodyRevision === right.custodyRevision &&
    left.syncState === right.syncState &&
    left.activeProofCount === right.activeProofCount &&
    left.desiredAction === right.desiredAction
  );
}

async function readDesiredRows(input: BrowserEncryptedWalletBackupOwnerConflictInput) {
  const rows = await input.database.encryptedWalletBackupV2DesiredAssets
    .where("[scopeId+localAssetKey]")
    .between([input.scopeId, TEXT_MIN], [input.scopeId, TEXT_MAX])
    .limit(ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX + 1)
    .toArray();
  if (rows.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX)
    throw new Error("encrypted backup owner conflict desired asset limit exceeded");
  return rows.map(decodeEncryptedWalletBackupV2DesiredAssetRow);
}

async function readSnapshot(
  input: BrowserEncryptedWalletBackupOwnerConflictInput,
): Promise<Snapshot> {
  requireCurrent(input);
  const desiredRows = await readDesiredRows(input);
  const entries: unknown[] = [];
  let activeProofCount = 0;
  for (const desired of desiredRows) {
    const asset = {
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    };
    const proofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
      database: input.database,
      scopeId: input.scopeId,
      asset,
    });
    activeProofCount += proofs.length;
    if (proofs.length !== desired.activeProofCount)
      throw new Error("owner recovery local proof count changed");
    const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
      proofs.map(({ proofId }) => [input.scopeId, proofId]),
    );
    const fingerprints = proofs.map((proof) =>
      deriveDurableCustodyArtifactFingerprint(
        serializeDurableCustodyProofArtifact(storedProofFromCustodyRow(proof)),
      ),
    );
    // Include the complete custody row state, not only immutable proof material.
    // Selectability, reservation, asset binding, and revision can change while
    // proof bytes and the total active count stay constant.
    entries.push([desired, proofs, fingerprints, authorities]);
    requireCurrent(input);
  }
  if (activeProofCount > SNAPSHOT_PROOF_MAX)
    throw new Error("owner recovery local snapshot exceeds bound");
  const allActiveStates = [
    "selectable",
    "locked",
    "verified-losing",
    "retained-unverified",
    "pending-removal",
  ] as const;
  const totalActive = await Promise.all(
    allActiveStates.map((state) =>
      input.database.custodyProofs
        .where("[scopeId+selectability]")
        .equals([input.scopeId, state])
        .count(),
    ),
  ).then((counts) => counts.reduce((sum, count) => sum + count, 0));
  if (totalActive !== activeProofCount)
    throw new Error("owner recovery found an unowned local proof");
  const ownerDesired = await input.database.encryptedWalletBackupOwnerDesiredAssets
    .where("[scopeId+ownerScopeId+localAssetKey]")
    .between(
      [input.scopeId, input.ownerContext.ownerScopeId, TEXT_MIN],
      [input.scopeId, input.ownerContext.ownerScopeId, TEXT_MAX],
    )
    .limit(ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX + 1)
    .toArray();
  if (ownerDesired.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX)
    throw new Error("owner recovery desired snapshot exceeds bound");
  entries.push(ownerDesired);
  const digest = bytesToHex(sha256(new TextEncoder().encode(stableJson(entries))));
  return { digest, activeProofCount };
}

async function hasUnresolvedSubmittedWork(
  database: BitcasterDB,
  scopeId: string,
): Promise<boolean> {
  const [activeWork, reservation, activeRange, outgoing, outgoingMintRecovery, prepared] =
    await Promise.all([
      database.custodyActiveWork
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_MIN], [scopeId, TEXT_MAX])
        .first(),
      database.custodyReservations
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_MIN], [scopeId, TEXT_MAX])
        .first(),
      pageActiveCtfRangePreparations({ scopeId, limit: 1 }, database),
      database.outgoingCashuTransfers
        .where("[scopeId+localAuthorityState+transferId]")
        .between([scopeId, "nonterminal", TEXT_MIN], [scopeId, "nonterminal", TEXT_MAX])
        .first(),
      database.outgoingCashuTransfers
        .where("[scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId]")
        .between([scopeId, "pending"], [scopeId, "pending", []], true, true)
        .first(),
      // proofOperations is stored in the per-wallet BitcasterDB, so its primary
      // key is already confined to this custody scope.
      database.proofOperations.where("state").equals("prepared").first(),
    ]);
  if (
    activeWork !== undefined ||
    reservation !== undefined ||
    activeRange.preparations.length > 0 ||
    outgoing !== undefined ||
    outgoingMintRecovery !== undefined ||
    prepared !== undefined
  )
    return true;
  const quotes = await database.mintQuotes
    .where("[scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]")
    .between(
      [scopeId, "bolt11", "pending", Dexie.minKey, Dexie.minKey],
      [scopeId, "bolt11", "pending", Number.MAX_SAFE_INTEGER, TEXT_MAX],
    )
    .limit(ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX + 1)
    .toArray();
  // Refuse on overflow: an unresolved quote may sort beyond the bounded page.
  if (quotes.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX) return true;
  return quotes.some((row) => {
    const quote = decodeDurableBolt11MintQuote(row.quote);
    return quote.observedState !== "UNPAID" || quote.walletMintOperationAuthority !== null;
  });
}

async function tryReadHead(
  input: BrowserEncryptedWalletBackupOwnerConflictInput,
): Promise<EncryptedWalletBackupOwnerCollectedHeadEvidence | null> {
  try {
    requireCurrent(input);
    const head = await input.ownerClient.readCurrentHead({
      owner: input.owner,
      enrollmentEpoch: input.ownerContext.enrollmentEpoch,
      signal: input.signal,
    });
    requireCurrent(input);
    return head;
  } catch (error) {
    if (input.signal.aborted || !input.isCurrentProfile()) throw error;
    if (
      error instanceof EncryptedWalletBackupOwnerHttpTransportError &&
      ["unavailable", "overloaded", "rate-limited"].includes(error.code)
    )
      return null;
    throw error;
  }
}

function sameOwnerHead(
  left: EncryptedWalletBackupOwnerCollectedHeadEvidence,
  right: EncryptedWalletBackupOwnerCollectedHeadEvidence,
): boolean {
  if (
    left.head.headVersion !== right.head.headVersion ||
    left.head.activeSetDigest !== right.head.activeSetDigest ||
    left.bundles.length !== right.bundles.length
  )
    return false;
  return left.bundles.every((bundle, index) => {
    const other = right.bundles[index];
    return (
      other !== undefined &&
      bundle.bundleId === other.bundleId &&
      bundle.assetLocator === other.assetLocator &&
      bundle.custodyRevision === other.custodyRevision &&
      bundle.payloadCommitment === other.payloadCommitment
    );
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function requireCurrent(input: BrowserEncryptedWalletBackupOwnerConflictInput): void {
  if (input.signal.aborted || !input.isCurrentProfile())
    throw new Error("encrypted backup owner conflict recovery was cancelled");
}

function incomplete(
  reason: BrowserEncryptedWalletBackupOwnerConflictIncompleteReason,
): BrowserEncryptedWalletBackupOwnerConflictResult {
  return { kind: "incomplete", reason };
}
