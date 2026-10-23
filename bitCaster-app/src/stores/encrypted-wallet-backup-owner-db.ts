import Dexie from "dexie";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  encodeEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerContext,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { requireEncryptedWalletBackupOwnerBackupReachabilityEvidence } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDeletionAuthority";
import { requireEncryptedWalletBackupOwnerVerifiedProofSet } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { applyEncryptedWalletBackupOwnerVerifiedReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerSync";
import {
  decodeEncryptedWalletBackupOwnerCurrentHeadWire,
  encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  encodeEncryptedWalletBackupOwnerDescriptorPage,
  encodeEncryptedWalletBackupOwnerSignedMutation,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerServiceCodec";
import {
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  digestEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleDescriptor,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import type {
  BitcasterDB,
  EncryptedWalletBackupOwnerAcceptedHeadRow,
  EncryptedWalletBackupOwnerActiveDescriptorRow,
  EncryptedWalletBackupOwnerAssetReceiptRow,
  EncryptedWalletBackupOwnerEnrollmentResultRow,
  EncryptedWalletBackupOwnerProofCoverageRow,
  EncryptedWalletBackupOwnerPreparedMutationRow,
  EncryptedWalletBackupOwnerRetrySchedulerRow,
  EncryptedWalletBackupOwnerDesiredAssetRow,
  EncryptedWalletBackupV2PreparedMutationRow,
} from "./proof-db";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { EncryptedWalletBackupAccountOperationResultRecord } from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import {
  ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  planEncryptedWalletBackupRetry,
} from "@bitcaster/client-sdk/encryptedWalletBackupRetrySchedule";
import {
  assertEncryptedWalletBackupEnrollmentResultReplacement,
  decodeEncryptedWalletBackupEnrollmentResultRecord,
} from "./encrypted-wallet-backup-enrollment-db";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import {
  digestEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import type { EncryptedWalletBackupV2PreparedDesiredBinding } from "./encrypted-wallet-backup-v2-db";
import {
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  sameBrowserProofDerivationLocator,
} from "./browser-proof-backup-authority";
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import type {
  EncryptedWalletBackupV2LocalRecoveryStatus,
  EncryptedWalletBackupV2NewWritePermission,
} from "./encrypted-wallet-backup-v2-db";
import {
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2DesiredAssetRow,
} from "./browser-encrypted-wallet-backup-v2-desired-asset";

export interface EncryptedWalletBackupOwnerAuthorityProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly ownerScopeId: string;
  readonly realm: string;
  readonly walletId: string;
  readonly requestAuthPublicKey: string;
  readonly enrollmentEpoch: number;
  readonly isCurrent: () => boolean;
}

export interface EncryptedWalletBackupOwnerBackupReceiptSnapshot {
  readonly desired: EncryptedWalletBackupV2DesiredAssetRow;
  readonly ownerDesired: EncryptedWalletBackupOwnerDesiredAssetRow;
  readonly receipt: EncryptedWalletBackupOwnerAssetReceiptRow;
  readonly collectedHeadEvidence: EncryptedWalletBackupOwnerCollectedHeadEvidence;
}

/** Refuse head-only restore provenance wherever a signed mutation receipt is required. */
export function requireOwnerMutationReceiptProofCoverage(
  value: unknown,
): EncryptedWalletBackupOwnerProofCoverageRow {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as EncryptedWalletBackupOwnerProofCoverageRow).sourceKind !== "mutation-receipt" ||
    typeof (value as EncryptedWalletBackupOwnerProofCoverageRow).receiptDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as EncryptedWalletBackupOwnerProofCoverageRow).receiptDigest!)
  ) {
    throw new Error("encrypted backup owner mutation receipt coverage is required");
  }
  return value as EncryptedWalletBackupOwnerProofCoverageRow;
}

/** Persists only SDK-collected owner evidence. It never reads v20 ownerless tables. */
export class EncryptedWalletBackupOwnerDexieAuthorityStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #context: EncryptedWalletBackupOwnerContext;
  readonly #requestAuthPublicKey: string;
  readonly #isCurrent: () => boolean;

  constructor(profile: EncryptedWalletBackupOwnerAuthorityProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#scopeId = profile.scopeId;
    this.#requestAuthPublicKey = profile.requestAuthPublicKey;
    this.#isCurrent = profile.isCurrent;
    this.#context = Object.freeze({
      ownerScopeId: profile.ownerScopeId,
      realm: profile.realm,
      walletId: profile.walletId,
      enrollmentEpoch: profile.enrollmentEpoch,
    });
  }

  async readCurrentHead(): Promise<EncryptedWalletBackupOwnerCollectedHeadEvidence | null> {
    this.#requireDatabaseBinding();
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      () => this.#readCurrentHeadInTransaction(),
    );
  }

  /** Capture one selected-owner receipt and exact current desired/head bindings. */
  async captureBackupReceipt(input: {
    readonly desired: EncryptedWalletBackupV2PreparedDesiredBinding;
  }): Promise<EncryptedWalletBackupOwnerBackupReceiptSnapshot | null> {
    this.#requireDatabaseBinding();
    const desiredBinding = requireDesiredBinding(input.desired);
    if (desiredBinding.desiredAction !== "replace") return null;
    return this.#database.transaction(
      "r",
      [
        this.#database.encryptedWalletBackupV2DesiredAssets,
        this.#database.encryptedWalletBackupOwnerDesiredAssets,
        this.#database.encryptedWalletBackupOwnerAssetReceipts,
        this.#database.encryptedWalletBackupOwnerAcceptedHeads,
        this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      ],
      async () => {
        this.#requireSessionCurrent();
        const canonicalRaw = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desiredBinding.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (canonicalRaw === undefined) return null;
        const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(canonicalRaw);
        if (desired.scopeId !== this.#scopeId || !matchesDesiredBinding(desired, desiredBinding))
          return null;
        const ownerDesiredRaw = await this.#database.encryptedWalletBackupOwnerDesiredAssets.get([
          this.#scopeId,
          this.#context.ownerScopeId,
          desiredBinding.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (ownerDesiredRaw === undefined) return null;
        const ownerDesired = this.#decodeOwnerDesiredRow(ownerDesiredRaw);
        if (
          ownerDesired.syncState !== "acknowledged" ||
          !sameOwnerDesiredBinding(ownerDesired, desiredBinding) ||
          desired.activeProofCount < 1
        )
          return null;
        const receiptRaw = await this.#database.encryptedWalletBackupOwnerAssetReceipts.get([
          this.#scopeId,
          this.#context.ownerScopeId,
          this.#context.realm,
          this.#context.walletId,
          this.#context.enrollmentEpoch,
          desiredBinding.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (receiptRaw === undefined) return null;
        const receipt = decodeOwnerReceiptRow(receiptRaw, this.#scopeId, this.#context);
        const head = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        if (head === null || !ownerHeadMatchesReceipt(head, receipt, desiredBinding)) return null;
        return freezeBackupReceiptSnapshot({
          desired,
          ownerDesired,
          receipt,
          collectedHeadEvidence: head,
        });
      },
    );
  }

  /** Capture the selected owner's current receipt for one local intent key. */
  async captureBackupReceiptForLocalAsset(
    localAssetKey: string,
  ): Promise<EncryptedWalletBackupOwnerBackupReceiptSnapshot | null> {
    this.#requireDatabaseBinding();
    if (typeof localAssetKey !== "string" || localAssetKey.length < 1)
      throw new Error("encrypted backup owner asset key is invalid");
    const ownerDesiredRaw = await this.#database.encryptedWalletBackupOwnerDesiredAssets.get([
      this.#scopeId,
      this.#context.ownerScopeId,
      localAssetKey,
    ]);
    this.#requireSessionCurrent();
    if (ownerDesiredRaw === undefined) return null;
    const ownerDesired = this.#decodeOwnerDesiredRow(ownerDesiredRaw);
    return this.captureBackupReceipt({
      desired: {
        localAssetKey: ownerDesired.localAssetKey,
        assetLocator: ownerDesired.assetLocator,
        custodyRevision: ownerDesired.custodyRevision,
        desiredAction: ownerDesired.desiredAction,
        activeProofCount: ownerDesired.activeProofCount,
      },
    });
  }

  /** Recheck captured receipt/head authority in the custody deletion transaction. */
  async assertCurrentBackupReceiptInTransaction(input: {
    readonly snapshot: EncryptedWalletBackupOwnerBackupReceiptSnapshot;
    readonly reachabilityEvidence: unknown;
    readonly desired: EncryptedWalletBackupV2PreparedDesiredBinding;
  }): Promise<void> {
    this.#requireDatabaseBinding();
    const transaction = Dexie.currentTransaction;
    if (
      transaction === undefined ||
      transaction.db !== this.#database ||
      transaction.mode !== "readwrite" ||
      !transaction.active
    )
      throw new Error("encrypted backup owner deletion is outside its custody transaction");
    for (const table of [
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      this.#database.encryptedWalletBackupOwnerAssetReceipts,
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
    ]) {
      if (!transaction.storeNames.includes(table.name))
        throw new Error("encrypted backup owner deletion transaction lacks owner evidence tables");
    }
    this.#requireSessionCurrent();
    const binding = requireDesiredBinding(input.desired);
    const snapshot = input.snapshot;
    const reachability = requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(
      input.reachabilityEvidence,
      this.#context,
    );
    if (
      snapshot.receipt.scopeId !== this.#scopeId ||
      snapshot.receipt.ownerScopeId !== this.#context.ownerScopeId ||
      snapshot.receipt.realm !== this.#context.realm ||
      snapshot.receipt.walletId !== this.#context.walletId ||
      snapshot.receipt.enrollmentEpoch !== this.#context.enrollmentEpoch ||
      !matchesDesiredBinding(snapshot.desired, binding) ||
      snapshot.desired.scopeId !== this.#scopeId ||
      !sameOwnerDesiredBinding(snapshot.ownerDesired, binding) ||
      snapshot.ownerDesired.syncState !== "acknowledged" ||
      reachability.bundle.bundleId !== snapshot.receipt.bundleId ||
      reachability.bundle.assetLocator !== binding.assetLocator ||
      reachability.bundle.custodyRevision.toString() !== binding.custodyRevision
    )
      throw new Error("encrypted backup owner deletion evidence is foreign");
    const [canonicalRaw, ownerDesiredRaw, receiptRaw, currentHead] = await Promise.all([
      this.#database.encryptedWalletBackupV2DesiredAssets.get([
        this.#scopeId,
        binding.localAssetKey,
      ]),
      this.#database.encryptedWalletBackupOwnerDesiredAssets.get([
        this.#scopeId,
        this.#context.ownerScopeId,
        binding.localAssetKey,
      ]),
      this.#database.encryptedWalletBackupOwnerAssetReceipts.get([
        this.#scopeId,
        this.#context.ownerScopeId,
        this.#context.realm,
        this.#context.walletId,
        this.#context.enrollmentEpoch,
        binding.localAssetKey,
      ]),
      this.#readCurrentHeadInTransaction(),
    ]);
    this.#requireSessionCurrent();
    if (
      canonicalRaw === undefined ||
      ownerDesiredRaw === undefined ||
      receiptRaw === undefined ||
      currentHead === null
    )
      throw new Error("encrypted backup owner deletion authority is absent");
    const canonical = decodeEncryptedWalletBackupV2DesiredAssetRow(canonicalRaw);
    const currentOwnerDesired = this.#decodeOwnerDesiredRow(ownerDesiredRaw);
    const currentReceipt = decodeOwnerReceiptRow(receiptRaw, this.#scopeId, this.#context);
    if (
      canonical.scopeId !== this.#scopeId ||
      !matchesDesiredBinding(canonical, binding) ||
      !sameCanonicalDesiredRow(canonical, snapshot.desired) ||
      currentOwnerDesired.syncState !== "acknowledged" ||
      !sameOwnerDesiredBinding(currentOwnerDesired, binding) ||
      !sameOwnerDesiredRow(currentOwnerDesired, snapshot.ownerDesired) ||
      !sameOwnerReceiptRow(currentReceipt, snapshot.receipt) ||
      !sameBytes(
        encodeEncryptedWalletBackupOwnerCurrentHead(currentHead.head),
        encodeEncryptedWalletBackupOwnerCurrentHead(snapshot.collectedHeadEvidence.head),
      ) ||
      reachability.headVersion !== currentHead.head.headVersion ||
      reachability.activeSetDigest !== currentHead.head.activeSetDigest ||
      !ownerHeadMatchesReceipt(currentHead, currentReceipt, binding) ||
      digestEncryptedWalletBackupV2BundleDescriptor(reachability.bundle) !==
        digestEncryptedWalletBackupV2BundleDescriptor(
          currentHead.bundles.find((bundle) => bundle.bundleId === currentReceipt.bundleId) ??
            reachability.bundle,
        )
    )
      throw new Error("encrypted backup owner deletion authority changed");
  }

  /** Recheck restore provenance inside the custody import's encompassing transaction. */
  async assertCurrentRestoreAuthority(input: {
    readonly database: BitcasterDB;
    readonly collectedHeadEvidence: unknown;
    readonly verified: unknown;
    readonly proofIds?: readonly string[];
    readonly localAssetKey?: string;
    readonly requireExistingProofs?: boolean;
  }): Promise<void> {
    this.#requireDatabaseBinding();
    const transaction = Dexie.currentTransaction;
    if (input.database !== this.#database)
      throw new Error("encrypted backup owner restore database is foreign");
    if (transaction === undefined || transaction.db !== this.#database)
      throw new Error("encrypted backup owner restore is outside its custody transaction");
    if (transaction.mode !== "readwrite" || !transaction.active)
      throw new Error("encrypted backup owner restore transaction is not active readwrite");
    if (
      !transaction.storeNames.includes(
        this.#database.encryptedWalletBackupOwnerAcceptedHeads.name,
      ) ||
      !transaction.storeNames.includes(
        this.#database.encryptedWalletBackupOwnerActiveDescriptors.name,
      )
    )
      throw new Error("encrypted backup owner restore transaction lacks head tables");
    if (
      input.proofIds !== undefined &&
      !transaction.storeNames.includes(this.#database.encryptedWalletBackupOwnerProofCoverage.name)
    )
      throw new Error("encrypted backup owner restore transaction lacks proof coverage");
    if (
      input.proofIds !== undefined &&
      (!transaction.storeNames.includes(
        this.#database.encryptedWalletBackupOwnerDesiredAssets.name,
      ) ||
        !transaction.storeNames.includes(this.#database.encryptedWalletBackupV2DesiredAssets.name))
    )
      throw new Error("encrypted backup owner restore transaction lacks desired asset tables");
    if (
      input.requireExistingProofs === true &&
      (!transaction.storeNames.includes(this.#database.custodyProofs.name) ||
        !transaction.storeNames.includes(this.#database.custodyProofBackupAuthorities.name))
    )
      throw new Error("encrypted backup owner restore transaction lacks custody proof tables");
    const expected = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
      input.collectedHeadEvidence,
      this.#context,
    );
    const verified = requireEncryptedWalletBackupOwnerVerifiedProofSet(
      input.verified,
      this.#context,
    );
    const source = verified.source;
    const descriptor = expected.bundles.find(
      (candidate) =>
        candidate.bundleId === source.bundleId &&
        candidate.assetLocator === source.assetLocator &&
        candidate.custodyRevision === source.custodyRevision &&
        digestEncryptedWalletBackupV2BundleDescriptor(candidate) === source.descriptorDigest,
    );
    if (
      descriptor === undefined ||
      source.headVersion !== expected.head.headVersion ||
      source.activeSetDigest !== expected.head.activeSetDigest
    ) {
      throw new Error("encrypted backup owner restore source is not in the expected head");
    }
    const coverageTable = this.#database.encryptedWalletBackupOwnerProofCoverage;
    const transactionTables = [
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      ...(input.proofIds === undefined
        ? []
        : [
            coverageTable,
            this.#database.encryptedWalletBackupOwnerDesiredAssets,
            this.#database.encryptedWalletBackupV2DesiredAssets,
            ...(input.requireExistingProofs === true
              ? [this.#database.custodyProofs, this.#database.custodyProofBackupAuthorities]
              : []),
          ]),
    ];
    await this.#database.transaction(
      input.proofIds === undefined ? "r" : "rw",
      transactionTables,
      async () => {
        this.#requireSessionCurrent();
        const current = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(
          this.#authorityKey(),
        );
        this.#requireSessionCurrent();
        if (current === undefined)
          throw new Error("encrypted backup owner accepted head is absent");
        requireOwnerRow(current, this.#scopeId, this.#context);
        const currentEvidence = await this.#readCurrentHeadInTransaction(current);
        this.#requireSessionCurrent();
        if (
          currentEvidence === null ||
          currentEvidence.head.headVersion !== expected.head.headVersion ||
          currentEvidence.head.activeSetDigest !== expected.head.activeSetDigest ||
          !sameDescriptorRows(
            await this.#descriptorRowsInTransaction(),
            expected.bundles.map((bundle) => ({
              ...this.#identity(),
              bundleId: bundle.bundleId,
              assetLocator: bundle.assetLocator,
              declaredAmount: bundle.declaredAmount.toString(),
              custodyRevision: bundle.custodyRevision.toString(),
              payloadCommitment: bundle.payloadCommitment,
              objectCount: bundle.objects.length,
              canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
            })),
          )
        ) {
          throw new Error("encrypted backup owner restore head changed before admission");
        }
        if (input.proofIds !== undefined) {
          if (
            input.localAssetKey === undefined ||
            input.proofIds.length === 0 ||
            input.proofIds.some((proofId) => !/^[0-9a-f]{64}$/.test(proofId)) ||
            new Set(input.proofIds).size !== input.proofIds.length
          ) {
            throw new Error("encrypted backup owner restore proof coverage is invalid");
          }
          for (const proofId of input.proofIds) {
            if (input.requireExistingProofs === true) {
              const localRaw = await this.#database.custodyProofs.get([this.#scopeId, proofId]);
              this.#requireSessionCurrent();
              const remoteProof = verified.proofSet.proofs.find(
                (entry) => entry.proofId === proofId,
              );
              if (localRaw === undefined || remoteProof === undefined)
                throw new Error("encrypted backup owner existing proof is absent");
              const localProof = decodeBrowserCustodyProofRow(localRaw);
              if (
                localProof.proofFingerprint !==
                deriveDurableCustodyArtifactFingerprint(
                  serializeDurableCustodyProofArtifact(remoteProof.proof),
                )
              )
                throw new Error("encrypted backup owner existing proof material conflicts");
              const authority = requireBrowserProofBackupAuthorityForProof(
                requireBrowserLiveProofBackupAuthorityTableRow(
                  await this.#database.custodyProofBackupAuthorities.get([this.#scopeId, proofId]),
                  [this.#scopeId, proofId],
                ),
                localProof,
              );
              this.#requireSessionCurrent();
              if (
                !sameBrowserProofDerivationLocator(authority.derivationLocator, remoteProof.locator)
              )
                throw new Error("encrypted backup owner existing proof derivation conflicts");
            }
            await coverageTable.put({
              ...this.#identity(),
              proofId,
              localAssetKey: input.localAssetKey,
              assetLocator: source.assetLocator,
              custodyRevision: source.custodyRevision.toString(),
              bundleId: source.bundleId,
              bundleDescriptorDigest: source.descriptorDigest,
              headVersion: source.headVersion,
              sourceKind: "head-restore",
              receiptDigest: null,
            });
            this.#requireSessionCurrent();
          }
          const legacyDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
            this.#scopeId,
            input.localAssetKey,
          ]);
          this.#requireSessionCurrent();
          if (legacyDesired === undefined)
            throw new Error("encrypted backup owner restore desired state is absent");
          const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(legacyDesired);
          const ownerDesiredKey = [
            this.#scopeId,
            this.#context.ownerScopeId,
            input.localAssetKey,
          ] as const;
          const existingOwnerDesired =
            await this.#database.encryptedWalletBackupOwnerDesiredAssets.get(ownerDesiredKey);
          this.#requireSessionCurrent();
          const currentOwnerDesired =
            existingOwnerDesired === undefined
              ? null
              : this.#decodeOwnerDesiredRow(existingOwnerDesired);
          const bindingMatches =
            desired.desiredAction === "replace" &&
            desired.custodyRevision === source.custodyRevision.toString() &&
            desired.activeProofCount === input.proofIds.length;
          const ownerDesired: EncryptedWalletBackupOwnerDesiredAssetRow = {
            ...this.#identity(),
            localAssetKey: input.localAssetKey,
            assetLocator: source.assetLocator,
            custodyRevision: desired.custodyRevision,
            desiredAction: desired.desiredAction,
            activeProofCount: desired.activeProofCount,
            syncState: bindingMatches ? "acknowledged" : "pending",
            lastObservedHeadVersion: source.headVersion,
            receiptDigest:
              currentOwnerDesired !== null &&
              sameOwnerDesiredBinding(currentOwnerDesired, {
                localAssetKey: input.localAssetKey,
                assetLocator: source.assetLocator,
                custodyRevision: desired.custodyRevision,
                desiredAction: desired.desiredAction,
                activeProofCount: desired.activeProofCount,
              })
                ? currentOwnerDesired.receiptDigest
                : null,
          };
          await this.#database.encryptedWalletBackupOwnerDesiredAssets.put(ownerDesired);
          this.#requireSessionCurrent();
        }
        this.#requireSessionCurrent();
      },
    );
  }

  async acceptCurrentHead(input: {
    readonly expectedHeadVersion: number | null;
    readonly evidence: unknown;
  }): Promise<"accepted" | "stale"> {
    this.#requireDatabaseBinding();
    const evidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
      input.evidence,
      this.#context,
    );
    if (
      input.expectedHeadVersion !== null &&
      (!Number.isSafeInteger(input.expectedHeadVersion) || input.expectedHeadVersion < 0)
    )
      throw new Error("encrypted backup owner expected head is invalid");
    const head = evidence.head;
    const canonicalCurrentHead = encodeEncryptedWalletBackupOwnerCurrentHead(head);
    const descriptorRows: EncryptedWalletBackupOwnerActiveDescriptorRow[] = evidence.bundles.map(
      (bundle) => ({
        ...this.#identity(),
        bundleId: bundle.bundleId,
        assetLocator: bundle.assetLocator,
        declaredAmount: bundle.declaredAmount.toString(),
        custodyRevision: bundle.custodyRevision.toString(),
        payloadCommitment: bundle.payloadCommitment,
        objectCount: bundle.objects.length,
        canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
      }),
    );
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      async () => {
        const key = this.#authorityKey();
        this.#requireSessionCurrent();
        const current = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        const currentEvidence = await this.#readCurrentHeadInTransaction(current);
        this.#requireSessionCurrent();
        const currentVersion = currentEvidence?.head.headVersion ?? null;
        if (currentVersion !== input.expectedHeadVersion) return "stale";
        if (current !== undefined) requireOwnerRow(current, this.#scopeId, this.#context);
        if (currentVersion === null && head.activeBundleCount > 0)
          throw new Error("nonempty encrypted backup owner head requires conflict recovery");
        if (currentVersion !== null && head.headVersion < currentVersion)
          throw new Error("encrypted backup owner head version regressed");
        if (currentVersion !== null && head.headVersion === currentVersion) {
          const currentDescriptors = await this.#descriptorRowsInTransaction();
          this.#requireSessionCurrent();
          if (
            current !== undefined &&
            sameBytes(current.canonicalCurrentHead, canonicalCurrentHead) &&
            sameDescriptorRows(currentDescriptors, descriptorRows)
          )
            return "accepted";
          throw new Error("encrypted backup owner head version conflicts");
        }
        const localStatus = current === undefined ? readyStatus(0) : readStatus(current);
        this.#requireSessionCurrent();
        const nextHead: EncryptedWalletBackupOwnerAcceptedHeadRow = {
          ...this.#identity(),
          headVersion: head.headVersion,
          activeBundleCount: head.activeBundleCount,
          activeObjectCount: head.activeObjectCount,
          activeSetDigest: head.activeSetDigest,
          canonicalCurrentHead,
          ...localStatus,
        };
        await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put(nextHead);
        this.#requireSessionCurrent();
        const descriptors = this.#database.encryptedWalletBackupOwnerActiveDescriptors;
        const existing = await descriptors
          .where("[scopeId+ownerScopeId+realm+walletId+enrollmentEpoch]")
          .equals(key)
          .primaryKeys();
        this.#requireSessionCurrent();
        await descriptors.bulkDelete(existing);
        this.#requireSessionCurrent();
        if (descriptorRows.length > 0) await descriptors.bulkPut(descriptorRows);
        this.#requireSessionCurrent();
        return "accepted";
      },
    );
  }

  async markCompetingHeadRecoveryRequired(input: {
    readonly evidence: unknown;
  }): Promise<EncryptedWalletBackupV2LocalRecoveryStatus> {
    this.#requireDatabaseBinding();
    const evidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
      input.evidence,
      this.#context,
    );
    const descriptorRows: EncryptedWalletBackupOwnerActiveDescriptorRow[] = evidence.bundles.map(
      (bundle) => ({
        ...this.#identity(),
        bundleId: bundle.bundleId,
        assetLocator: bundle.assetLocator,
        declaredAmount: bundle.declaredAmount.toString(),
        custodyRevision: bundle.custodyRevision.toString(),
        payloadCommitment: bundle.payloadCommitment,
        objectCount: bundle.objects.length,
        canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
      }),
    );
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      this.#database.encryptedWalletBackupOwnerPreparedMutations,
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      async () => {
        this.#requireSessionCurrent();
        const key = this.#authorityKey();
        const current = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        this.#requireSessionCurrent();
        await this.#readCurrentHeadInTransaction(current);
        this.#requireSessionCurrent();
        if (current !== undefined) requireOwnerRow(current, this.#scopeId, this.#context);
        const currentStatus = current === undefined ? readyStatus(0) : readStatus(current);
        const status = recoveryRequiredStatus(currentStatus);
        if (current === undefined) {
          await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put({
            ...this.#identity(),
            headVersion: evidence.head.headVersion,
            activeBundleCount: evidence.head.activeBundleCount,
            activeObjectCount: evidence.head.activeObjectCount,
            activeSetDigest: evidence.head.activeSetDigest,
            canonicalCurrentHead: encodeEncryptedWalletBackupOwnerCurrentHead(evidence.head),
            ...status,
          });
          this.#requireSessionCurrent();
          if (descriptorRows.length > 0)
            await this.#database.encryptedWalletBackupOwnerActiveDescriptors.bulkPut(
              descriptorRows,
            );
          this.#requireSessionCurrent();
        } else {
          await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put({
            ...current,
            ...status,
          });
          this.#requireSessionCurrent();
        }
        return status;
      },
    );
  }

  /** Stage one fresh remote snapshot while keeping new writes blocked. */
  async stageRecoveryHead(input: {
    readonly expectedHeadVersion: number;
    readonly expectedRecoveryVersion: number;
    readonly evidence: unknown;
  }): Promise<"staged" | "stale"> {
    this.#requireDatabaseBinding();
    if (
      !Number.isSafeInteger(input.expectedHeadVersion) ||
      input.expectedHeadVersion < 0 ||
      !Number.isSafeInteger(input.expectedRecoveryVersion) ||
      input.expectedRecoveryVersion < 0
    )
      throw new Error("encrypted backup owner recovery snapshot is invalid");
    const evidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
      input.evidence,
      this.#context,
    );
    const canonicalCurrentHead = encodeEncryptedWalletBackupOwnerCurrentHead(evidence.head);
    const descriptorRows = evidence.bundles.map((bundle) => ({
      ...this.#identity(),
      bundleId: bundle.bundleId,
      assetLocator: bundle.assetLocator,
      declaredAmount: bundle.declaredAmount.toString(),
      custodyRevision: bundle.custodyRevision.toString(),
      payloadCommitment: bundle.payloadCommitment,
      objectCount: bundle.objects.length,
      canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
    }));
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      this.#database.encryptedWalletBackupOwnerPreparedMutations,
      async () => {
        this.#requireSessionCurrent();
        const key = this.#authorityKey();
        const current = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        this.#requireSessionCurrent();
        if (current === undefined)
          throw new Error("encrypted backup owner recovery head is absent");
        requireOwnerRow(current, this.#scopeId, this.#context);
        const currentStatus = readStatus(current);
        const currentEvidence = await this.#readCurrentHeadInTransaction(current);
        this.#requireSessionCurrent();
        if (
          currentEvidence === null ||
          currentEvidence.head.headVersion !== input.expectedHeadVersion ||
          currentStatus.localRecoveryStatus !== "recovery-required" ||
          currentStatus.localRecoveryVersion !== input.expectedRecoveryVersion
        )
          return "stale";
        if (await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(key)) {
          throw new Error("encrypted backup owner recovery has submitted work");
        }
        this.#requireSessionCurrent();
        if (evidence.head.headVersion < input.expectedHeadVersion)
          throw new Error("encrypted backup owner recovery head regressed");
        if (evidence.head.headVersion === input.expectedHeadVersion) {
          const currentDescriptors = await this.#descriptorRowsInTransaction();
          this.#requireSessionCurrent();
          if (
            !sameBytes(current.canonicalCurrentHead, canonicalCurrentHead) ||
            !sameDescriptorRows(currentDescriptors, descriptorRows)
          )
            throw new Error("encrypted backup owner recovery head version conflicts");
        }
        const nextHead: EncryptedWalletBackupOwnerAcceptedHeadRow = {
          ...current,
          headVersion: evidence.head.headVersion,
          activeBundleCount: evidence.head.activeBundleCount,
          activeObjectCount: evidence.head.activeObjectCount,
          activeSetDigest: evidence.head.activeSetDigest,
          canonicalCurrentHead,
        };
        await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put(nextHead);
        this.#requireSessionCurrent();
        await this.#replaceOwnerDescriptorRows(descriptorRows);
        this.#requireSessionCurrent();
        return "staged";
      },
    );
  }

  /** Clear recovery only after exact local revalidation against a second stable head. */
  async acceptRecoveredHead(input: {
    readonly expectedHeadVersion: number;
    readonly expectedRecoveryVersion: number;
    readonly evidence: unknown;
    readonly recheckLocalState: () => Promise<boolean>;
  }): Promise<"accepted" | "stale"> {
    this.#requireDatabaseBinding();
    if (
      !Number.isSafeInteger(input.expectedHeadVersion) ||
      input.expectedHeadVersion < 0 ||
      !Number.isSafeInteger(input.expectedRecoveryVersion) ||
      input.expectedRecoveryVersion < 0
    )
      throw new Error("encrypted backup owner recovery acceptance is invalid");
    const evidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
      input.evidence,
      this.#context,
    );
    const canonicalCurrentHead = encodeEncryptedWalletBackupOwnerCurrentHead(evidence.head);
    const descriptorRows = evidence.bundles.map((bundle) => ({
      ...this.#identity(),
      bundleId: bundle.bundleId,
      assetLocator: bundle.assetLocator,
      declaredAmount: bundle.declaredAmount.toString(),
      custodyRevision: bundle.custodyRevision.toString(),
      payloadCommitment: bundle.payloadCommitment,
      objectCount: bundle.objects.length,
      canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
    }));
    return this.#database.transaction(
      "rw",
      [
        this.#database.encryptedWalletBackupOwnerAcceptedHeads,
        this.#database.encryptedWalletBackupOwnerActiveDescriptors,
        this.#database.encryptedWalletBackupOwnerPreparedMutations,
        this.#database.encryptedWalletBackupOwnerDesiredAssets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.walletCounterAssociations,
        this.#database.walletCounterCursors,
        this.#database.custodyOperations,
        this.#database.proofs,
        this.#database.custodyActiveWork,
        this.#database.custodyReservations,
        this.#database.ctfRangePreparations,
        this.#database.outgoingCashuTransfers,
        this.#database.proofOperations,
        this.#database.mintQuotes,
      ],
      async () => {
        this.#requireSessionCurrent();
        const key = this.#authorityKey();
        const current = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        this.#requireSessionCurrent();
        if (current === undefined) return "stale";
        requireOwnerRow(current, this.#scopeId, this.#context);
        const status = readStatus(current);
        const currentEvidence = await this.#readCurrentHeadInTransaction(current);
        this.#requireSessionCurrent();
        const currentDescriptors = await this.#descriptorRowsInTransaction();
        this.#requireSessionCurrent();
        if (
          status.localRecoveryStatus !== "recovery-required" ||
          status.localRecoveryVersion !== input.expectedRecoveryVersion ||
          currentEvidence === null ||
          currentEvidence.head.headVersion !== input.expectedHeadVersion ||
          evidence.head.headVersion !== input.expectedHeadVersion ||
          !sameBytes(current.canonicalCurrentHead, canonicalCurrentHead) ||
          !sameDescriptorRows(currentDescriptors, descriptorRows)
        )
          return "stale";
        if (await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(key))
          throw new Error("encrypted backup owner recovery has submitted work");
        this.#requireSessionCurrent();
        if (!(await input.recheckLocalState()))
          throw new Error("encrypted backup owner recovery local state changed");
        this.#requireSessionCurrent();
        if (await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(key))
          throw new Error("encrypted backup owner recovery has submitted work");
        this.#requireSessionCurrent();
        const latest = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        this.#requireSessionCurrent();
        if (
          latest === undefined ||
          !sameBytes(latest.canonicalCurrentHead, canonicalCurrentHead) ||
          readStatus(latest).localRecoveryVersion !== input.expectedRecoveryVersion
        )
          return "stale";
        await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put({
          ...latest,
          ...readyStatus(input.expectedRecoveryVersion + 1),
        });
        this.#requireSessionCurrent();
        await this.#replaceOwnerDescriptorRows(descriptorRows);
        this.#requireSessionCurrent();
        return "accepted";
      },
    );
  }

  async readLocalRecoveryStatus(): Promise<EncryptedWalletBackupV2LocalRecoveryStatus | null> {
    this.#requireDatabaseBinding();
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      async () => {
        this.#requireSessionCurrent();
        const row = await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(
          this.#authorityKey(),
        );
        this.#requireSessionCurrent();
        if (row === undefined) return null;
        requireOwnerRow(row, this.#scopeId, this.#context);
        return readStatus(row);
      },
    );
  }

  async readNewWritePermission(): Promise<EncryptedWalletBackupV2NewWritePermission> {
    const status = (await this.readLocalRecoveryStatus()) ?? readyStatus(0);
    return Object.freeze({ ...status, canWrite: status.localRecoveryStatus === "ready" });
  }

  async readDescriptorPage(afterBundleId: string | null): Promise<Uint8Array | null> {
    const authority = await this.readCurrentHead();
    if (authority === null) return null;
    const page = enumerateEncryptedWalletBackupOwnerDescriptorPages(authority).find(
      (item) => item.afterBundleId === afterBundleId,
    );
    if (page === undefined) throw new Error("encrypted backup owner descriptor cursor is unknown");
    return encodeEncryptedWalletBackupOwnerDescriptorPage(page);
  }

  async readEnrollmentResult(): Promise<EncryptedWalletBackupAccountOperationResultRecord | null> {
    this.#requireDatabaseBinding();
    const row = await this.#database.encryptedWalletBackupOwnerEnrollmentResults.get(
      this.#enrollmentKey(),
    );
    this.#requireSessionCurrent();
    return row === undefined ? null : this.#decodeEnrollmentRow(row);
  }

  async commitEnrollmentResult<T>(input: {
    readonly result: EncryptedWalletBackupAccountOperationResultRecord;
    readonly commit: (stored: EncryptedWalletBackupAccountOperationResultRecord) => T;
  }): Promise<T> {
    this.#requireDatabaseBinding();
    const next = decodeEncryptedWalletBackupEnrollmentResultRecord(
      input.result,
      this.#context.realm,
      this.#context.walletId,
      this.#requestAuthPublicKey,
    );
    if (typeof input.commit !== "function")
      throw new Error("backup enrollment callback is invalid");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerEnrollmentResults,
      async () => {
        const key = this.#enrollmentKey();
        this.#requireSessionCurrent();
        const current = await this.#database.encryptedWalletBackupOwnerEnrollmentResults.get(key);
        if (current !== undefined) {
          assertEncryptedWalletBackupEnrollmentResultReplacement(
            this.#decodeEnrollmentRow(current),
            next,
          );
        }
        this.#requireSessionCurrent();
        const row: EncryptedWalletBackupOwnerEnrollmentResultRow = {
          scopeId: this.#scopeId,
          ownerScopeId: this.#context.ownerScopeId,
          realm: this.#context.realm,
          walletId: this.#context.walletId,
          record: structuredClone(next),
        };
        await this.#database.encryptedWalletBackupOwnerEnrollmentResults.put(row);
        this.#requireSessionCurrent();
        return input.commit(structuredClone(next));
      },
    );
  }

  async readRetryScheduler(): Promise<EncryptedWalletBackupOwnerRetrySchedulerRow | null> {
    this.#requireDatabaseBinding();
    const row = await this.#database.encryptedWalletBackupOwnerRetrySchedulers.get(
      this.#enrollmentKey(),
    );
    this.#requireSessionCurrent();
    return row === undefined ? null : this.#decodeRetryRow(row);
  }

  async readPreparedMutation(): Promise<EncryptedWalletBackupOwnerPreparedMutationRow | null> {
    this.#requireDatabaseBinding();
    const row = await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(
      this.#authorityKey(),
    );
    this.#requireSessionCurrent();
    return row === undefined ? null : this.#decodePreparedRow(row);
  }

  async isDesiredAssetSynchronized(
    input: EncryptedWalletBackupV2PreparedDesiredBinding,
  ): Promise<boolean> {
    this.#requireDatabaseBinding();
    const desired = requireDesiredBinding(input);
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      async () => {
        const raw = await this.#database.encryptedWalletBackupOwnerDesiredAssets.get([
          this.#scopeId,
          this.#context.ownerScopeId,
          desired.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (raw === undefined) return false;
        const stored = this.#decodeOwnerDesiredRow(raw);
        if (stored.syncState !== "acknowledged" || !sameOwnerDesiredBinding(stored, desired))
          return false;
        const head = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        if (head === null) return false;
        return desired.desiredAction === "replace"
          ? stored.receiptDigest !== null &&
              head.bundles.some(
                (bundle) =>
                  bundle.assetLocator === desired.assetLocator &&
                  bundle.custodyRevision.toString() === desired.custodyRevision,
              )
          : !head.bundles.some((bundle) => bundle.assetLocator === desired.assetLocator) &&
              (stored.receiptDigest !== null ||
                stored.lastObservedHeadVersion === head.head.headVersion);
      },
    );
  }

  async recordAlreadyAbsentDesired(
    input: EncryptedWalletBackupV2PreparedDesiredBinding,
  ): Promise<"recorded" | "stale-desired"> {
    this.#requireDatabaseBinding();
    const desired = requireDesiredBinding(input);
    if (desired.desiredAction !== "remove")
      throw new Error("only a removal can be recorded as already absent");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      async () => {
        this.#requireSessionCurrent();
        const rawDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (rawDesired === undefined) return "stale-desired";
        const currentDesired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        if (
          currentDesired.custodyRevision !== desired.custodyRevision ||
          currentDesired.desiredAction !== desired.desiredAction ||
          currentDesired.activeProofCount !== desired.activeProofCount
        )
          return "stale-desired";
        const head = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        if (
          head === null ||
          head.bundles.some((bundle) => bundle.assetLocator === desired.assetLocator)
        )
          return "stale-desired";
        const row: EncryptedWalletBackupOwnerDesiredAssetRow = {
          ...this.#identity(),
          ...desired,
          syncState: "acknowledged",
          lastObservedHeadVersion: head.head.headVersion,
          receiptDigest: null,
        };
        await this.#database.encryptedWalletBackupOwnerDesiredAssets.put(row);
        this.#requireSessionCurrent();
        return "recorded";
      },
    );
  }

  /** Preserve a selected owner's local-only intent for the next upload pass. */
  async preserveLocalDesiredPending(
    input: EncryptedWalletBackupV2PreparedDesiredBinding,
  ): Promise<"preserved" | "stale-desired"> {
    this.#requireDatabaseBinding();
    const desired = requireDesiredBinding(input);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      async () => {
        this.#requireSessionCurrent();
        const rawDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (rawDesired === undefined) return "stale-desired";
        const currentDesired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        if (
          currentDesired.custodyRevision !== desired.custodyRevision ||
          currentDesired.desiredAction !== desired.desiredAction ||
          currentDesired.activeProofCount !== desired.activeProofCount
        )
          return "stale-desired";
        const head = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        if (
          head === null ||
          head.bundles.some(({ assetLocator }) => assetLocator === desired.assetLocator)
        )
          return "stale-desired";
        const row: EncryptedWalletBackupOwnerDesiredAssetRow = {
          ...this.#identity(),
          ...desired,
          syncState: "pending",
          lastObservedHeadVersion: head.head.headVersion,
          receiptDigest: null,
        };
        await this.#database.encryptedWalletBackupOwnerDesiredAssets.put(row);
        this.#requireSessionCurrent();
        return "preserved";
      },
    );
  }

  async insertPreparedMutationForDesired(input: {
    readonly prepared: Omit<
      EncryptedWalletBackupV2PreparedMutationRow,
      "scopeId" | "realm" | "walletId" | "enrollmentEpoch"
    >;
    readonly desired: EncryptedWalletBackupV2PreparedDesiredBinding;
  }): Promise<"inserted" | "existing" | "owner-current" | "stale-desired"> {
    this.#requireDatabaseBinding();
    const desired = requireDesiredBinding(input.desired);
    const prepared = this.#decodePreparedRow({ ...this.#identity(), ...input.prepared });
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupOwnerPreparedMutations,
      this.#database.encryptedWalletBackupOwnerAcceptedHeads,
      this.#database.encryptedWalletBackupOwnerActiveDescriptors,
      this.#database.encryptedWalletBackupOwnerDesiredAssets,
      async () => {
        this.#requireSessionCurrent();
        const rawDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        if (rawDesired === undefined)
          throw new Error("encrypted backup owner desired asset is stale");
        const currentDesired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        if (
          currentDesired.scopeId !== this.#scopeId ||
          currentDesired.localAssetKey !== desired.localAssetKey ||
          currentDesired.custodyRevision !== desired.custodyRevision ||
          currentDesired.desiredAction !== desired.desiredAction ||
          currentDesired.activeProofCount !== desired.activeProofCount
        )
          return "stale-desired";
        const head = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        if (head === null) throw new Error("encrypted backup owner accepted head is missing");
        const decoded = decodeEncryptedWalletBackupOwnerUploadGroup({
          bytes: prepared.canonicalUploadGroup,
          expectedContext: this.#context,
          expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
        });
        const envelope = decoded.mutationEvidence.envelope;
        const mutation = envelope.mutation;
        if (
          mutation.mutationId !== prepared.mutationId ||
          envelope.requestDigest !== prepared.requestDigest ||
          mutation.expectedHeadVersion !== head.head.headVersion ||
          mutation.expectedActiveSetDigest !== head.head.activeSetDigest ||
          prepared.localAssetKey !== desired.localAssetKey ||
          prepared.assetLocator !== desired.assetLocator ||
          prepared.custodyRevision !== desired.custodyRevision ||
          prepared.desiredAction !== desired.desiredAction ||
          prepared.activeProofCount !== desired.activeProofCount
        )
          throw new Error("encrypted backup owner prepared mutation binding is invalid");
        requireMutationAssetBinding(mutation, head, desired);
        const key = this.#authorityKey();
        const ownerDesiredKey = [
          this.#scopeId,
          this.#context.ownerScopeId,
          desired.localAssetKey,
        ] as const;
        const currentOwnerDesiredRaw =
          await this.#database.encryptedWalletBackupOwnerDesiredAssets.get(ownerDesiredKey);
        const currentOwnerDesired =
          currentOwnerDesiredRaw === undefined
            ? null
            : this.#decodeOwnerDesiredRow(currentOwnerDesiredRaw);
        this.#requireSessionCurrent();
        if (
          currentOwnerDesired !== null &&
          sameOwnerDesiredBinding(currentOwnerDesired, desired) &&
          currentOwnerDesired.syncState === "acknowledged" &&
          (desired.desiredAction === "replace"
            ? head.bundles.some(
                (bundle) =>
                  bundle.assetLocator === desired.assetLocator &&
                  bundle.custodyRevision.toString() === desired.custodyRevision,
              )
            : !head.bundles.some((bundle) => bundle.assetLocator === desired.assetLocator))
        )
          return "owner-current";
        const currentRaw =
          await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(key);
        this.#requireSessionCurrent();
        if (currentRaw !== undefined) {
          const current = this.#decodePreparedRow(currentRaw);
          if (!samePreparedMutation(current, prepared))
            throw new Error("encrypted backup owner prepared mutation conflicts");
          return "existing";
        }
        const nextOwnerDesired: EncryptedWalletBackupOwnerDesiredAssetRow = {
          scopeId: this.#scopeId,
          ownerScopeId: this.#context.ownerScopeId,
          realm: this.#context.realm,
          walletId: this.#context.walletId,
          enrollmentEpoch: this.#context.enrollmentEpoch,
          localAssetKey: desired.localAssetKey,
          assetLocator: desired.assetLocator,
          custodyRevision: desired.custodyRevision,
          desiredAction: desired.desiredAction,
          activeProofCount: desired.activeProofCount,
          syncState: "pending",
          lastObservedHeadVersion: head.head.headVersion,
          receiptDigest: currentOwnerDesired?.receiptDigest ?? null,
        };
        await this.#database.encryptedWalletBackupOwnerPreparedMutations.add(prepared);
        this.#requireSessionCurrent();
        await this.#database.encryptedWalletBackupOwnerDesiredAssets.put(nextOwnerDesired);
        this.#requireSessionCurrent();
        return "inserted";
      },
    );
  }

  async discardRejectedPreparedMutation(input: {
    readonly mutationId: string;
    readonly requestDigest: string;
  }): Promise<boolean> {
    this.#requireDatabaseBinding();
    if (!/^[0-9a-f]{32}$/.test(input.mutationId) || !/^[0-9a-f]{64}$/.test(input.requestDigest))
      throw new Error("encrypted backup owner prepared mutation match is invalid");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerPreparedMutations,
      async () => {
        this.#requireSessionCurrent();
        const key = this.#authorityKey();
        const row = await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(key);
        this.#requireSessionCurrent();
        if (row === undefined) return false;
        const prepared = this.#decodePreparedRow(row);
        if (
          prepared.mutationId !== input.mutationId ||
          prepared.requestDigest !== input.requestDigest
        )
          return false;
        await this.#database.encryptedWalletBackupOwnerPreparedMutations.delete(key);
        this.#requireSessionCurrent();
        return true;
      },
    );
  }

  async commitVerifiedMutationResult(input: {
    readonly preparedMutation: { readonly mutationId: string; readonly requestDigest: string };
    readonly canonicalUploadGroup: Uint8Array;
    readonly expectedHeadEvidence: unknown;
    readonly receiptEvidence: unknown;
    readonly desired: EncryptedWalletBackupV2PreparedDesiredBinding;
  }): Promise<"committed" | "stale-desired"> {
    this.#requireDatabaseBinding();
    const desired = requireDesiredBinding(input.desired);
    if (
      !/^[0-9a-f]{32}$/.test(input.preparedMutation.mutationId) ||
      !/^[0-9a-f]{64}$/.test(input.preparedMutation.requestDigest)
    )
      throw new Error("encrypted backup owner prepared mutation match is invalid");
    const group = decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: input.canonicalUploadGroup,
      expectedContext: this.#context,
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
    });
    const verifiedReceipt = requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
      input.receiptEvidence,
      this.#context,
    );
    const nextEvidence = applyEncryptedWalletBackupOwnerVerifiedReceipt({
      expectedContext: this.#context,
      expectedHeadEvidence: requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
        input.expectedHeadEvidence,
        this.#context,
      ),
      mutationEvidence: group.mutationEvidence,
      receiptEvidence: verifiedReceipt,
    });
    const mutation = group.mutationEvidence.envelope.mutation;
    const receipt = verifiedReceipt.receipt;
    if (
      mutation.mutationId !== input.preparedMutation.mutationId ||
      group.mutationEvidence.envelope.requestDigest !== input.preparedMutation.requestDigest ||
      receipt.mutationId !== input.preparedMutation.mutationId ||
      receipt.requestDigest !== input.preparedMutation.requestDigest ||
      (mutation.addedBundle?.assetLocator !== desired.assetLocator &&
        desired.desiredAction === "replace") ||
      (desired.desiredAction === "remove" && mutation.addedBundle !== null)
    )
      throw new Error("encrypted backup owner mutation result binding is invalid");
    const encodedMutation = encodeEncryptedWalletBackupOwnerSignedMutation(
      group.mutationEvidence.envelope,
    );
    const encodedReceipt = encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt);
    const nextHeadBytes = encodeEncryptedWalletBackupOwnerCurrentHead(nextEvidence.head);
    const nextDescriptors = nextEvidence.bundles.map(
      (bundle): EncryptedWalletBackupOwnerActiveDescriptorRow => ({
        ...this.#identity(),
        bundleId: bundle.bundleId,
        assetLocator: bundle.assetLocator,
        declaredAmount: bundle.declaredAmount.toString(),
        custodyRevision: bundle.custodyRevision.toString(),
        payloadCommitment: bundle.payloadCommitment,
        objectCount: bundle.objects.length,
        canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
      }),
    );
    const receiptRow: EncryptedWalletBackupOwnerAssetReceiptRow | null =
      receipt.bundleId === null || receipt.bundleDescriptorDigest === null
        ? null
        : {
            ...this.#identity(),
            localAssetKey: desired.localAssetKey,
            assetLocator: desired.assetLocator,
            custodyRevision: desired.custodyRevision,
            bundleId: receipt.bundleId,
            bundleDescriptorDigest: receipt.bundleDescriptorDigest,
            canonicalSignedMutation: encodedMutation,
            canonicalSignedReceipt: encodedReceipt,
          };
    const receiptDigest = digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt);
    return this.#database.transaction(
      "rw",
      [
        this.#database.encryptedWalletBackupV2DesiredAssets,
        this.#database.encryptedWalletBackupOwnerPreparedMutations,
        this.#database.encryptedWalletBackupOwnerAcceptedHeads,
        this.#database.encryptedWalletBackupOwnerActiveDescriptors,
        this.#database.encryptedWalletBackupOwnerAssetReceipts,
        this.#database.encryptedWalletBackupOwnerDesiredAssets,
      ],
      async () => {
        this.#requireSessionCurrent();
        const rawDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        this.#requireSessionCurrent();
        const currentDesired =
          rawDesired === undefined
            ? null
            : decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        const desiredIsCurrent =
          currentDesired !== null &&
          currentDesired.custodyRevision === desired.custodyRevision &&
          currentDesired.desiredAction === desired.desiredAction &&
          currentDesired.activeProofCount === desired.activeProofCount &&
          currentDesired.localAssetKey === desired.localAssetKey;
        const preparedKey = this.#authorityKey();
        const rawPrepared =
          await this.#database.encryptedWalletBackupOwnerPreparedMutations.get(preparedKey);
        this.#requireSessionCurrent();
        if (rawPrepared === undefined)
          throw new Error("encrypted backup owner prepared row is absent");
        const prepared = this.#decodePreparedRow(rawPrepared);
        if (
          prepared.mutationId !== input.preparedMutation.mutationId ||
          prepared.requestDigest !== input.preparedMutation.requestDigest ||
          !sameBytes(prepared.canonicalUploadGroup, input.canonicalUploadGroup) ||
          !samePreparedMutation(prepared, {
            ...prepared,
            ...desired,
            mutationId: input.preparedMutation.mutationId,
            requestDigest: input.preparedMutation.requestDigest,
          })
        )
          throw new Error("encrypted backup owner prepared row changed");
        const currentEvidence = await this.#readCurrentHeadInTransaction();
        this.#requireSessionCurrent();
        const expectedEvidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
          input.expectedHeadEvidence,
          this.#context,
        );
        if (
          currentEvidence === null ||
          currentEvidence.head.headVersion !== expectedEvidence.head.headVersion ||
          currentEvidence.head.activeSetDigest !== expectedEvidence.head.activeSetDigest ||
          !sameDescriptorRows(
            await this.#descriptorRowsInTransaction(),
            expectedEvidence.bundles.map(
              (bundle): EncryptedWalletBackupOwnerActiveDescriptorRow => ({
                ...this.#identity(),
                bundleId: bundle.bundleId,
                assetLocator: bundle.assetLocator,
                declaredAmount: bundle.declaredAmount.toString(),
                custodyRevision: bundle.custodyRevision.toString(),
                payloadCommitment: bundle.payloadCommitment,
                objectCount: bundle.objects.length,
                canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(bundle),
              }),
            ),
          )
        )
          throw new Error("encrypted backup owner receipt predecessor is stale");
        requireMutationAssetBinding(mutation, currentEvidence, desired);
        this.#requireSessionCurrent();
        const key = this.#authorityKey();
        const currentHeadRow =
          await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(key);
        this.#requireSessionCurrent();
        if (currentHeadRow === undefined)
          throw new Error("encrypted backup owner head row is absent");
        requireOwnerRow(currentHeadRow, this.#scopeId, this.#context);
        const nextHeadRow: EncryptedWalletBackupOwnerAcceptedHeadRow = {
          ...this.#identity(),
          headVersion: nextEvidence.head.headVersion,
          activeBundleCount: nextEvidence.head.activeBundleCount,
          activeObjectCount: nextEvidence.head.activeObjectCount,
          activeSetDigest: nextEvidence.head.activeSetDigest,
          canonicalCurrentHead: nextHeadBytes,
          ...readStatus(currentHeadRow),
        };
        const descriptorTable = this.#database.encryptedWalletBackupOwnerActiveDescriptors;
        const existingDescriptorKeys = await descriptorTable
          .where("[scopeId+ownerScopeId+realm+walletId+enrollmentEpoch]")
          .equals(key)
          .primaryKeys();
        this.#requireSessionCurrent();
        const receiptKey: [string, string, string, string, number, string] = [
          ...key,
          desired.localAssetKey,
        ];
        if (receiptRow === null)
          await this.#database.encryptedWalletBackupOwnerAssetReceipts.delete(receiptKey);
        else await this.#database.encryptedWalletBackupOwnerAssetReceipts.put(receiptRow);
        this.#requireSessionCurrent();
        await this.#database.encryptedWalletBackupOwnerAcceptedHeads.put(nextHeadRow);
        this.#requireSessionCurrent();
        await descriptorTable.bulkDelete(existingDescriptorKeys);
        this.#requireSessionCurrent();
        if (nextDescriptors.length > 0) await descriptorTable.bulkPut(nextDescriptors);
        this.#requireSessionCurrent();
        const ownerDesiredKey = [
          this.#scopeId,
          this.#context.ownerScopeId,
          desired.localAssetKey,
        ] as const;
        const currentOwnerDesiredRaw =
          await this.#database.encryptedWalletBackupOwnerDesiredAssets.get(ownerDesiredKey);
        this.#requireSessionCurrent();
        const currentOwnerDesired =
          currentOwnerDesiredRaw === undefined
            ? null
            : this.#decodeOwnerDesiredRow(currentOwnerDesiredRaw);
        if (currentOwnerDesired !== null && !sameOwnerDesiredBinding(currentOwnerDesired, desired))
          throw new Error("encrypted backup owner desired state changed");
        const nextOwnerDesired: EncryptedWalletBackupOwnerDesiredAssetRow = {
          ...this.#identity(),
          localAssetKey: desired.localAssetKey,
          assetLocator: desired.assetLocator,
          custodyRevision: desired.custodyRevision,
          desiredAction: desired.desiredAction,
          activeProofCount: desired.activeProofCount,
          syncState: "acknowledged",
          lastObservedHeadVersion: nextEvidence.head.headVersion,
          receiptDigest,
        };
        await this.#database.encryptedWalletBackupOwnerDesiredAssets.put(nextOwnerDesired);
        this.#requireSessionCurrent();
        await this.#database.encryptedWalletBackupOwnerPreparedMutations.delete(key);
        this.#requireSessionCurrent();
        return desiredIsCurrent ? "committed" : "stale-desired";
      },
    );
  }

  async scheduleRetry(input: {
    readonly attemptId: string;
    readonly minimumDelayMilliseconds: number;
    readonly nowUnixMilliseconds?: number;
  }): Promise<EncryptedWalletBackupOwnerRetrySchedulerRow> {
    this.#requireDatabaseBinding();
    if (
      !/^[0-9a-f]{32}$/.test(input.attemptId) ||
      !Number.isSafeInteger(input.minimumDelayMilliseconds) ||
      input.minimumDelayMilliseconds < 0
    )
      throw new Error("encrypted backup owner retry identity is invalid");
    const now = input.nowUnixMilliseconds ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("encrypted backup owner retry time is invalid");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerRetrySchedulers,
      async () => {
        const key = this.#enrollmentKey();
        this.#requireSessionCurrent();
        const currentRaw = await this.#database.encryptedWalletBackupOwnerRetrySchedulers.get(key);
        const current = currentRaw === undefined ? null : this.#decodeRetryRow(currentRaw);
        this.#requireSessionCurrent();
        if (
          current !== null &&
          current.attemptId === input.attemptId &&
          current.retryNotBeforeUnixMilliseconds > now
        )
          return current;
        const planned = planEncryptedWalletBackupRetry({
          realm: this.#context.realm,
          walletId: this.#context.walletId,
          attemptId: input.attemptId,
          currentStreak: current?.attemptId === input.attemptId ? current.retryStreak : 0,
          minimumDelayMilliseconds: Math.max(
            input.minimumDelayMilliseconds,
            current?.attemptId === input.attemptId
              ? Math.max(1, current.retryNotBeforeUnixMilliseconds - now)
              : 1,
          ),
        });
        const row = this.#decodeRetryRow({
          scopeId: this.#scopeId,
          ownerScopeId: this.#context.ownerScopeId,
          realm: this.#context.realm,
          walletId: this.#context.walletId,
          attemptId: input.attemptId,
          retryStreak: planned.streak,
          retryNotBeforeUnixMilliseconds: Math.max(
            now + planned.delayMilliseconds,
            current?.attemptId === input.attemptId ? current.retryNotBeforeUnixMilliseconds : 0,
          ),
        });
        this.#requireSessionCurrent();
        await this.#database.encryptedWalletBackupOwnerRetrySchedulers.put(row);
        this.#requireSessionCurrent();
        return row;
      },
    );
  }

  async clearRetryScheduler(attemptId: string): Promise<void> {
    this.#requireDatabaseBinding();
    if (!/^[0-9a-f]{32}$/.test(attemptId))
      throw new Error("encrypted backup owner retry attempt is invalid");
    await this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupOwnerRetrySchedulers,
      async () => {
        const key = this.#enrollmentKey();
        const row = await this.#database.encryptedWalletBackupOwnerRetrySchedulers.get(key);
        this.#requireSessionCurrent();
        if (row !== undefined && this.#decodeRetryRow(row).attemptId === attemptId) {
          await this.#database.encryptedWalletBackupOwnerRetrySchedulers.delete(key);
          this.#requireSessionCurrent();
        }
      },
    );
  }

  async #readCurrentHeadInTransaction(
    row?: EncryptedWalletBackupOwnerAcceptedHeadRow,
  ): Promise<EncryptedWalletBackupOwnerCollectedHeadEvidence | null> {
    const resolved =
      row ??
      (await this.#database.encryptedWalletBackupOwnerAcceptedHeads.get(this.#authorityKey()));
    if (resolved === undefined) {
      this.#requireSessionCurrent();
      return null;
    }
    requireOwnerRow(resolved, this.#scopeId, this.#context);
    const head = decodeEncryptedWalletBackupOwnerCurrentHeadWire(resolved.canonicalCurrentHead);
    const descriptors = await this.#database.encryptedWalletBackupOwnerActiveDescriptors
      .where("[scopeId+ownerScopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .toArray();
    this.#requireSessionCurrent();
    return collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head,
        bundles: descriptors.map((descriptor) => this.#decodeDescriptor(descriptor)),
      }),
      this.#context,
    );
  }

  async #descriptorRowsInTransaction(): Promise<EncryptedWalletBackupOwnerActiveDescriptorRow[]> {
    return this.#database.encryptedWalletBackupOwnerActiveDescriptors
      .where("[scopeId+ownerScopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .toArray();
  }

  async #replaceOwnerDescriptorRows(
    rows: readonly EncryptedWalletBackupOwnerActiveDescriptorRow[],
  ): Promise<void> {
    const table = this.#database.encryptedWalletBackupOwnerActiveDescriptors;
    const keys = await table
      .where("[scopeId+ownerScopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .primaryKeys();
    this.#requireSessionCurrent();
    await table.bulkDelete(keys);
    this.#requireSessionCurrent();
    if (rows.length > 0) await table.bulkPut(rows);
    this.#requireSessionCurrent();
  }

  #decodeDescriptor(
    descriptor: EncryptedWalletBackupOwnerActiveDescriptorRow,
  ): ReturnType<typeof decodeEncryptedWalletBackupV2BundleDescriptorWire> {
    requireDescriptorRow(descriptor, this.#scopeId, this.#context);
    const bundle = decodeEncryptedWalletBackupV2BundleDescriptorWire(
      descriptor.canonicalDescriptor,
      this.#context,
    );
    if (
      bundle.bundleId !== descriptor.bundleId ||
      bundle.assetLocator !== descriptor.assetLocator ||
      bundle.custodyRevision.toString() !== descriptor.custodyRevision ||
      bundle.declaredAmount.toString() !== descriptor.declaredAmount ||
      bundle.payloadCommitment !== descriptor.payloadCommitment ||
      bundle.objects.length !== descriptor.objectCount
    )
      throw new Error("encrypted backup owner descriptor row is inconsistent");
    return bundle;
  }

  #authorityKey(): [string, string, string, string, number] {
    return [
      this.#scopeId,
      this.#context.ownerScopeId,
      this.#context.realm,
      this.#context.walletId,
      this.#context.enrollmentEpoch,
    ];
  }

  #enrollmentKey(): [string, string, string, string] {
    return [this.#scopeId, this.#context.ownerScopeId, this.#context.realm, this.#context.walletId];
  }

  #decodeEnrollmentRow(
    value: EncryptedWalletBackupOwnerEnrollmentResultRow,
  ): EncryptedWalletBackupAccountOperationResultRecord {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 5 ||
      value.scopeId !== this.#scopeId ||
      value.ownerScopeId !== this.#context.ownerScopeId ||
      value.realm !== this.#context.realm ||
      value.walletId !== this.#context.walletId
    )
      throw new Error("encrypted backup owner enrollment row is foreign");
    return decodeEncryptedWalletBackupEnrollmentResultRecord(
      value.record,
      this.#context.realm,
      this.#context.walletId,
      this.#requestAuthPublicKey,
    );
  }

  #decodeRetryRow(
    value: EncryptedWalletBackupOwnerRetrySchedulerRow,
  ): EncryptedWalletBackupOwnerRetrySchedulerRow {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 7 ||
      value.scopeId !== this.#scopeId ||
      value.ownerScopeId !== this.#context.ownerScopeId ||
      value.realm !== this.#context.realm ||
      value.walletId !== this.#context.walletId ||
      !/^[0-9a-f]{32}$/.test(value.attemptId) ||
      !Number.isSafeInteger(value.retryStreak) ||
      value.retryStreak < 0 ||
      value.retryStreak > ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX ||
      !Number.isSafeInteger(value.retryNotBeforeUnixMilliseconds) ||
      value.retryNotBeforeUnixMilliseconds < 0
    )
      throw new Error("encrypted backup owner retry row is foreign");
    return Object.freeze({ ...value });
  }

  #decodePreparedRow(
    value: EncryptedWalletBackupOwnerPreparedMutationRow,
  ): EncryptedWalletBackupOwnerPreparedMutationRow {
    const expectedKeys = [
      "activeProofCount",
      "assetLocator",
      "canonicalUploadGroup",
      "createdAtUnixMilliseconds",
      "custodyRevision",
      "desiredAction",
      "enrollmentEpoch",
      "localAssetKey",
      "mutationId",
      "ownerScopeId",
      "realm",
      "requestDigest",
      "scopeId",
      "walletId",
    ].sort();
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== expectedKeys.length ||
      Object.keys(value)
        .sort()
        .some((key, index) => key !== expectedKeys[index]) ||
      value.scopeId !== this.#scopeId ||
      value.ownerScopeId !== this.#context.ownerScopeId ||
      value.realm !== this.#context.realm ||
      value.walletId !== this.#context.walletId ||
      value.enrollmentEpoch !== this.#context.enrollmentEpoch ||
      !/^[0-9a-f]{32}$/.test(value.mutationId) ||
      !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
      !(value.canonicalUploadGroup instanceof Uint8Array) ||
      !Number.isSafeInteger(value.createdAtUnixMilliseconds) ||
      value.createdAtUnixMilliseconds < 0 ||
      !/^[^\s]{1,512}$/.test(value.localAssetKey) ||
      !/^[0-9a-f]{64}$/.test(value.assetLocator) ||
      !/^(0|[1-9][0-9]*)$/.test(value.custodyRevision) ||
      (value.desiredAction !== "replace" && value.desiredAction !== "remove") ||
      !Number.isSafeInteger(value.activeProofCount) ||
      value.activeProofCount < 0
    )
      throw new Error("encrypted backup owner prepared mutation row is foreign");
    const decoded = decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: value.canonicalUploadGroup,
      expectedContext: this.#context,
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
    });
    const mutation = decoded.mutationEvidence.envelope.mutation;
    if (
      mutation.mutationId !== value.mutationId ||
      decoded.mutationEvidence.envelope.requestDigest !== value.requestDigest ||
      (value.desiredAction === "replace" &&
        (value.activeProofCount < 1 ||
          mutation.addedBundle === null ||
          mutation.addedBundle.assetLocator !== value.assetLocator ||
          mutation.addedBundle.custodyRevision.toString() !== value.custodyRevision)) ||
      (value.desiredAction === "remove" &&
        (value.activeProofCount !== 0 || mutation.addedBundle !== null))
    )
      throw new Error("encrypted backup owner prepared mutation row is inconsistent");
    return Object.freeze({ ...value, canonicalUploadGroup: value.canonicalUploadGroup.slice() });
  }

  #decodeOwnerDesiredRow(
    value: EncryptedWalletBackupOwnerDesiredAssetRow,
  ): EncryptedWalletBackupOwnerDesiredAssetRow {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 13 ||
      value.scopeId !== this.#scopeId ||
      value.ownerScopeId !== this.#context.ownerScopeId ||
      value.realm !== this.#context.realm ||
      value.walletId !== this.#context.walletId ||
      value.enrollmentEpoch !== this.#context.enrollmentEpoch ||
      !/^[^\s]{1,512}$/.test(value.localAssetKey) ||
      !/^[0-9a-f]{64}$/.test(value.assetLocator) ||
      !/^(0|[1-9][0-9]*)$/.test(value.custodyRevision) ||
      (value.desiredAction !== "replace" && value.desiredAction !== "remove") ||
      !Number.isSafeInteger(value.activeProofCount) ||
      value.activeProofCount < 0 ||
      (value.desiredAction === "replace" && value.activeProofCount === 0) ||
      (value.desiredAction === "remove" && value.activeProofCount !== 0) ||
      !["pending", "acknowledged", "conflict", "recovery-required"].includes(value.syncState) ||
      (value.lastObservedHeadVersion !== null &&
        (!Number.isSafeInteger(value.lastObservedHeadVersion) ||
          value.lastObservedHeadVersion < 0)) ||
      (value.receiptDigest !== null && !/^[0-9a-f]{64}$/.test(value.receiptDigest))
    )
      throw new Error("encrypted backup owner desired state is foreign");
    return Object.freeze({ ...value });
  }

  #identity(): Pick<
    EncryptedWalletBackupOwnerAcceptedHeadRow,
    "scopeId" | "ownerScopeId" | "realm" | "walletId" | "enrollmentEpoch"
  > {
    return { scopeId: this.#scopeId, ...this.#context };
  }

  #requireDatabaseBinding(): void {
    if (this.#database.name !== browserWalletDatabaseName(this.#scopeId))
      throw new Error("encrypted backup owner database is foreign");
    this.#requireSessionCurrent();
  }

  #requireSessionCurrent(): void {
    if (!this.#isCurrent()) throw new Error("encrypted backup owner session changed");
  }
}

function requireProfile(profile: EncryptedWalletBackupOwnerAuthorityProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    !/^[^\s]{1,128}$/.test(profile.scopeId) ||
    !/^[0-9a-f]{64}$/.test(profile.ownerScopeId) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(profile.realm) ||
    !/^[0-9a-f]{64}$/.test(profile.walletId) ||
    !/^[0-9a-f]{64}$/.test(profile.requestAuthPublicKey) ||
    typeof profile.isCurrent !== "function" ||
    !Number.isSafeInteger(profile.enrollmentEpoch) ||
    profile.enrollmentEpoch < 1 ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId)
  )
    throw new Error("encrypted backup owner database profile is invalid");
}

function requireOwnerRow(
  row: EncryptedWalletBackupOwnerAcceptedHeadRow,
  scopeId: string,
  context: EncryptedWalletBackupOwnerContext,
): void {
  if (
    row.scopeId !== scopeId ||
    row.ownerScopeId !== context.ownerScopeId ||
    row.realm !== context.realm ||
    row.walletId !== context.walletId ||
    row.enrollmentEpoch !== context.enrollmentEpoch
  )
    throw new Error("encrypted backup owner head row is foreign");
  readStatus(row);
}

function requireDescriptorRow(
  row: EncryptedWalletBackupOwnerActiveDescriptorRow,
  scopeId: string,
  context: EncryptedWalletBackupOwnerContext,
): void {
  if (
    row.scopeId !== scopeId ||
    row.ownerScopeId !== context.ownerScopeId ||
    row.realm !== context.realm ||
    row.walletId !== context.walletId ||
    row.enrollmentEpoch !== context.enrollmentEpoch
  )
    throw new Error("encrypted backup owner descriptor row is foreign");
}

function readyStatus(version: number) {
  return {
    localRecoveryStatus: "ready" as const,
    localRecoveryReason: "none" as const,
    localRecoveryVersion: version,
  };
}

function recoveryRequiredStatus(
  current: EncryptedWalletBackupV2LocalRecoveryStatus,
): EncryptedWalletBackupV2LocalRecoveryStatus {
  const nextVersion = current.localRecoveryVersion + 1;
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 0)
    throw new Error("encrypted backup owner recovery version is invalid");
  return {
    localRecoveryStatus: "recovery-required",
    localRecoveryReason: "genuine-conflict",
    localRecoveryVersion: nextVersion,
  };
}

function readStatus(row: EncryptedWalletBackupOwnerAcceptedHeadRow) {
  if (
    (row.localRecoveryStatus !== "ready" && row.localRecoveryStatus !== "recovery-required") ||
    (row.localRecoveryReason !== "none" && row.localRecoveryReason !== "genuine-conflict") ||
    !Number.isSafeInteger(row.localRecoveryVersion) ||
    row.localRecoveryVersion < 0
  )
    throw new Error("encrypted backup owner local recovery status is invalid");
  return {
    localRecoveryStatus: row.localRecoveryStatus,
    localRecoveryReason: row.localRecoveryReason,
    localRecoveryVersion: row.localRecoveryVersion,
  };
}

function sameDescriptorRows(
  left: readonly EncryptedWalletBackupOwnerActiveDescriptorRow[],
  right: readonly EncryptedWalletBackupOwnerActiveDescriptorRow[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  const sortedRight = [...right].sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  return sortedLeft.every((row, index) => {
    const other = sortedRight[index]!;
    return (
      row.bundleId === other.bundleId &&
      row.scopeId === other.scopeId &&
      row.ownerScopeId === other.ownerScopeId &&
      row.realm === other.realm &&
      row.walletId === other.walletId &&
      row.enrollmentEpoch === other.enrollmentEpoch &&
      row.assetLocator === other.assetLocator &&
      row.declaredAmount === other.declaredAmount &&
      row.custodyRevision === other.custodyRevision &&
      row.payloadCommitment === other.payloadCommitment &&
      row.objectCount === other.objectCount &&
      sameBytes(row.canonicalDescriptor, other.canonicalDescriptor)
    );
  });
}

function sameOwnerDesiredBinding(
  row: EncryptedWalletBackupOwnerDesiredAssetRow,
  binding: EncryptedWalletBackupV2PreparedDesiredBinding,
): boolean {
  return (
    row.localAssetKey === binding.localAssetKey &&
    row.assetLocator === binding.assetLocator &&
    row.custodyRevision === binding.custodyRevision &&
    row.desiredAction === binding.desiredAction &&
    row.activeProofCount === binding.activeProofCount
  );
}

function decodeOwnerReceiptRow(
  value: unknown,
  scopeId: string,
  context: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerAssetReceiptRow {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as EncryptedWalletBackupOwnerAssetReceiptRow).scopeId !== scopeId ||
    (value as EncryptedWalletBackupOwnerAssetReceiptRow).ownerScopeId !== context.ownerScopeId ||
    (value as EncryptedWalletBackupOwnerAssetReceiptRow).realm !== context.realm ||
    (value as EncryptedWalletBackupOwnerAssetReceiptRow).walletId !== context.walletId ||
    (value as EncryptedWalletBackupOwnerAssetReceiptRow).enrollmentEpoch !==
      context.enrollmentEpoch ||
    typeof (value as EncryptedWalletBackupOwnerAssetReceiptRow).localAssetKey !== "string" ||
    !/^[0-9a-f]{64}$/.test((value as EncryptedWalletBackupOwnerAssetReceiptRow).assetLocator) ||
    !/^(0|[1-9][0-9]*)$/.test(
      (value as EncryptedWalletBackupOwnerAssetReceiptRow).custodyRevision,
    ) ||
    !/^[0-9a-f]{32}$/.test((value as EncryptedWalletBackupOwnerAssetReceiptRow).bundleId) ||
    !/^[0-9a-f]{64}$/.test(
      (value as EncryptedWalletBackupOwnerAssetReceiptRow).bundleDescriptorDigest,
    ) ||
    !(
      (value as EncryptedWalletBackupOwnerAssetReceiptRow).canonicalSignedMutation instanceof
      Uint8Array
    ) ||
    !(
      (value as EncryptedWalletBackupOwnerAssetReceiptRow).canonicalSignedReceipt instanceof
      Uint8Array
    )
  )
    throw new Error("encrypted backup owner receipt row is invalid");
  const receipt = value as EncryptedWalletBackupOwnerAssetReceiptRow;
  return Object.freeze({
    ...receipt,
    canonicalSignedMutation: new Uint8Array(receipt.canonicalSignedMutation),
    canonicalSignedReceipt: new Uint8Array(receipt.canonicalSignedReceipt),
  });
}

function matchesDesiredBinding(
  row: EncryptedWalletBackupV2DesiredAssetRow,
  binding: EncryptedWalletBackupV2PreparedDesiredBinding,
): boolean {
  return (
    row.localAssetKey === binding.localAssetKey &&
    row.custodyRevision === binding.custodyRevision &&
    row.desiredAction === binding.desiredAction &&
    row.activeProofCount === binding.activeProofCount
  );
}

function sameCanonicalDesiredRow(
  left: EncryptedWalletBackupV2DesiredAssetRow,
  right: EncryptedWalletBackupV2DesiredAssetRow,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.localAssetKey === right.localAssetKey &&
    left.mintUrl === right.mintUrl &&
    left.unit === right.unit &&
    left.assetIdentity === right.assetIdentity &&
    left.custodyRevision === right.custodyRevision &&
    left.activeProofCount === right.activeProofCount &&
    left.desiredAction === right.desiredAction &&
    JSON.stringify(left.terminalCtfContext) === JSON.stringify(right.terminalCtfContext) &&
    JSON.stringify(left.removalIntent) === JSON.stringify(right.removalIntent)
  );
}

function sameOwnerDesiredRow(
  left: EncryptedWalletBackupOwnerDesiredAssetRow,
  right: EncryptedWalletBackupOwnerDesiredAssetRow,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.ownerScopeId === right.ownerScopeId &&
    left.realm === right.realm &&
    left.walletId === right.walletId &&
    left.enrollmentEpoch === right.enrollmentEpoch &&
    sameOwnerDesiredBinding(left, right) &&
    left.syncState === right.syncState &&
    left.lastObservedHeadVersion === right.lastObservedHeadVersion &&
    left.receiptDigest === right.receiptDigest
  );
}

function ownerHeadMatchesReceipt(
  evidence: EncryptedWalletBackupOwnerCollectedHeadEvidence,
  receipt: EncryptedWalletBackupOwnerAssetReceiptRow,
  binding: EncryptedWalletBackupV2PreparedDesiredBinding,
): boolean {
  const matches = evidence.bundles.filter((bundle) => bundle.assetLocator === binding.assetLocator);
  return (
    matches.length === 1 &&
    matches[0]!.bundleId === receipt.bundleId &&
    matches[0]!.custodyRevision.toString() === binding.custodyRevision &&
    digestEncryptedWalletBackupV2BundleDescriptor(matches[0]!) === receipt.bundleDescriptorDigest
  );
}

function freezeBackupReceiptSnapshot(
  snapshot: EncryptedWalletBackupOwnerBackupReceiptSnapshot,
): EncryptedWalletBackupOwnerBackupReceiptSnapshot {
  return Object.freeze({
    desired: Object.freeze({ ...snapshot.desired }),
    ownerDesired: Object.freeze({ ...snapshot.ownerDesired }),
    receipt: decodeOwnerReceiptRow(snapshot.receipt, snapshot.receipt.scopeId, {
      ownerScopeId: snapshot.receipt.ownerScopeId,
      realm: snapshot.receipt.realm,
      walletId: snapshot.receipt.walletId,
      enrollmentEpoch: snapshot.receipt.enrollmentEpoch,
    }),
    collectedHeadEvidence: snapshot.collectedHeadEvidence,
  });
}

function sameOwnerReceiptRow(
  left: EncryptedWalletBackupOwnerAssetReceiptRow,
  right: EncryptedWalletBackupOwnerAssetReceiptRow,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.ownerScopeId === right.ownerScopeId &&
    left.realm === right.realm &&
    left.walletId === right.walletId &&
    left.enrollmentEpoch === right.enrollmentEpoch &&
    left.localAssetKey === right.localAssetKey &&
    left.assetLocator === right.assetLocator &&
    left.custodyRevision === right.custodyRevision &&
    left.bundleId === right.bundleId &&
    left.bundleDescriptorDigest === right.bundleDescriptorDigest &&
    sameBytes(left.canonicalSignedMutation, right.canonicalSignedMutation) &&
    sameBytes(left.canonicalSignedReceipt, right.canonicalSignedReceipt)
  );
}

function requireMutationAssetBinding(
  mutation: ReturnType<
    typeof decodeEncryptedWalletBackupOwnerUploadGroup
  >["mutationEvidence"]["envelope"]["mutation"],
  head: EncryptedWalletBackupOwnerCollectedHeadEvidence,
  desired: EncryptedWalletBackupV2PreparedDesiredBinding,
): void {
  const existing = head.bundles.filter((bundle) => bundle.assetLocator === desired.assetLocator);
  if (existing.length > 1)
    throw new Error("encrypted backup owner asset is duplicated in the current head");
  const expectedSuperseded = existing.map(({ bundleId }) => bundleId).sort();
  const actualSuperseded = [...mutation.supersededBundleIds].sort();
  if (
    expectedSuperseded.length !== actualSuperseded.length ||
    expectedSuperseded.some((bundleId, index) => bundleId !== actualSuperseded[index]) ||
    (desired.desiredAction === "replace" &&
      (mutation.addedBundle === null ||
        mutation.addedBundle.assetLocator !== desired.assetLocator ||
        mutation.addedBundle.custodyRevision.toString() !== desired.custodyRevision)) ||
    (desired.desiredAction === "remove" &&
      (desired.activeProofCount !== 0 || existing.length !== 1 || mutation.addedBundle !== null))
  )
    throw new Error("encrypted backup owner mutation does not match desired asset");
}

function requireDesiredBinding(
  value: EncryptedWalletBackupV2PreparedDesiredBinding,
): EncryptedWalletBackupV2PreparedDesiredBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !/^[^\s]{1,512}$/.test(value.localAssetKey) ||
    !/^[0-9a-f]{64}$/.test(value.assetLocator) ||
    !/^(0|[1-9][0-9]*)$/.test(value.custodyRevision) ||
    (value.desiredAction !== "replace" && value.desiredAction !== "remove") ||
    !Number.isSafeInteger(value.activeProofCount) ||
    value.activeProofCount < 0
  )
    throw new Error("encrypted backup owner desired binding is invalid");
  return Object.freeze({ ...value });
}

function samePreparedMutation(
  left: EncryptedWalletBackupOwnerPreparedMutationRow,
  right: EncryptedWalletBackupOwnerPreparedMutationRow,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.ownerScopeId === right.ownerScopeId &&
    left.realm === right.realm &&
    left.walletId === right.walletId &&
    left.enrollmentEpoch === right.enrollmentEpoch &&
    left.mutationId === right.mutationId &&
    left.requestDigest === right.requestDigest &&
    sameBytes(left.canonicalUploadGroup, right.canonicalUploadGroup) &&
    left.localAssetKey === right.localAssetKey &&
    left.assetLocator === right.assetLocator &&
    left.custodyRevision === right.custodyRevision &&
    left.desiredAction === right.desiredAction &&
    left.activeProofCount === right.activeProofCount
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
