import Dexie from "dexie";
import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire,
  decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  encodeEncryptedWalletBackupV2CurrentHead,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2CollectedHeadEvidence,
} from "@bitcaster/client-sdk";
import type {
  BitcasterDB,
  EncryptedWalletBackupV2AcceptedHeadRow,
  EncryptedWalletBackupV2ActiveDescriptorRow,
  EncryptedWalletBackupV2PreparedMutationRow,
  EncryptedWalletBackupV2AssetReceiptRow,
} from "./proof-db";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "./browser-encrypted-wallet-backup-v2-desired-asset";

export interface EncryptedWalletBackupV2DexieAuthorityProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly walletId: string;
  readonly enrollmentEpoch: number;
  readonly requestAuthPublicKey: string;
}

export interface EncryptedWalletBackupV2PreparedMutationInput {
  readonly mutationId: string;
  readonly requestDigest: string;
  readonly canonicalUploadGroup: Uint8Array;
  readonly createdAtUnixMilliseconds: number;
  readonly localAssetKey: string;
  readonly assetLocator: string;
  readonly custodyRevision: string;
  readonly desiredAction: "replace" | "remove";
  readonly activeProofCount: number;
}

export interface EncryptedWalletBackupV2PreparedDesiredBinding {
  readonly localAssetKey: string;
  readonly assetLocator: string;
  readonly custodyRevision: string;
  readonly desiredAction: "replace" | "remove";
  readonly activeProofCount: number;
}

export interface EncryptedWalletBackupV2PreparedMutationMatch {
  readonly mutationId: string;
  readonly requestDigest: string;
}

export interface EncryptedWalletBackupV2AssetReceiptBinding extends EncryptedWalletBackupV2PreparedDesiredBinding {
  readonly bundleId: string | null;
  readonly bundleDescriptorDigest: string | null;
}

/** Strict V2-only Dexie primitives. This class never performs service I/O. */
export class EncryptedWalletBackupV2DexieAuthorityStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #realm: string;
  readonly #walletId: string;
  readonly #enrollmentEpoch: number;
  readonly #requestAuthPublicKey: string;

  constructor(profile: EncryptedWalletBackupV2DexieAuthorityProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#scopeId = profile.scopeId;
    this.#realm = profile.realm;
    this.#walletId = profile.walletId;
    this.#enrollmentEpoch = profile.enrollmentEpoch;
    this.#requestAuthPublicKey = profile.requestAuthPublicKey;
  }

  async readPreparedMutation(): Promise<EncryptedWalletBackupV2PreparedMutationRow | null> {
    const row = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
      this.#authorityKey(),
    );
    return row === undefined ? null : this.#decodePreparedRow(row);
  }

  /** Deletes only one mutation that the service definitely rejected. */
  async discardRejectedPreparedMutation(
    input: EncryptedWalletBackupV2PreparedMutationMatch,
  ): Promise<boolean> {
    this.#requireDatabaseBinding();
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2PreparedMutations,
      () => this.#deletePreparedIfMatch(input),
    );
  }

  /** Persists exact upload bytes only while the exact desired asset and head still match. */
  async insertPreparedMutationForDesired(input: {
    readonly prepared: EncryptedWalletBackupV2PreparedMutationInput;
    readonly desired: EncryptedWalletBackupV2PreparedDesiredBinding;
  }): Promise<"inserted" | "existing"> {
    this.#requireDatabaseBinding();
    const next = this.#preparedRow(input.prepared);
    const desired = requireDesiredBinding(input.desired);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupV2PreparedMutations,
      this.#database.encryptedWalletBackupV2AcceptedHeads,
      async () => {
        const rawDesired = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        if (rawDesired === undefined || !sameDesiredBinding(rawDesired, desired))
          throw new Error("encrypted wallet backup v2 desired asset is stale");
        await this.#requirePreparedMatchesAcceptedHead(input.prepared);
        const current = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
          this.#authorityKey(),
        );
        if (current === undefined) {
          await this.#database.encryptedWalletBackupV2PreparedMutations.add(next);
          return "inserted";
        }
        const decoded = this.#decodePreparedRow(current);
        if (
          !sameBytes(decoded.canonicalUploadGroup, next.canonicalUploadGroup) ||
          decoded.localAssetKey !== next.localAssetKey ||
          decoded.assetLocator !== next.assetLocator ||
          decoded.custodyRevision !== next.custodyRevision ||
          decoded.desiredAction !== next.desiredAction ||
          decoded.activeProofCount !== next.activeProofCount
        )
          throw new Error("encrypted wallet backup v2 prepared mutation conflicts");
        return "existing";
      },
    );
  }

  /** Atomically accepts a competing head, active descriptors, and stale prepared deletion. */
  async acceptCompetingHead(input: {
    readonly collectedHeadEvidence: unknown;
    readonly stalePreparedMutation: EncryptedWalletBackupV2PreparedMutationMatch;
  }): Promise<{ readonly deletedStalePreparedMutation: boolean }> {
    this.#requireDatabaseBinding();
    const authority = this.#headAuthorityRows(input.collectedHeadEvidence);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2AcceptedHeads,
      this.#database.encryptedWalletBackupV2ActiveDescriptors,
      this.#database.encryptedWalletBackupV2PreparedMutations,
      this.#database.encryptedWalletBackupV2DesiredAssets,
      async () => {
        if (await this.#mayReplaceAcceptedAuthority(authority)) {
          await this.#database.encryptedWalletBackupV2AcceptedHeads.put(authority.head);
          await this.#replaceDescriptorRows(authority.descriptors);
        }
        await this.#requeueAcknowledgedDesiredAssets();
        return Object.freeze({
          deletedStalePreparedMutation: await this.#deletePreparedIfMatch(
            input.stalePreparedMutation,
          ),
        });
      },
    );
  }

  async readAcceptedHead(): Promise<EncryptedWalletBackupV2AcceptedHeadRow | null> {
    const row = await this.#database.encryptedWalletBackupV2AcceptedHeads.get(this.#authorityKey());
    return row === undefined ? null : this.#decodeHeadRow(row);
  }

  async readAssetReceipt(
    localAssetKey: string,
  ): Promise<EncryptedWalletBackupV2AssetReceiptRow | null> {
    const key = requireDesiredBinding({
      localAssetKey,
      assetLocator: "00".repeat(32),
      custodyRevision: "0",
      desiredAction: "remove",
      activeProofCount: 0,
    }).localAssetKey;
    const row = await this.#database.encryptedWalletBackupV2AssetReceipts.get([
      ...this.#authorityKey(),
      key,
    ]);
    return row === undefined ? null : this.#decodeAssetReceiptRow(row);
  }

  async acknowledgeAbsentRemoval(
    binding: EncryptedWalletBackupV2PreparedDesiredBinding,
  ): Promise<void> {
    const desired = requireDesiredBinding(binding);
    if (desired.desiredAction !== "remove" || desired.activeProofCount !== 0)
      throw new Error("encrypted wallet backup v2 removal intent is invalid");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.encryptedWalletBackupV2AssetReceipts,
      async () => {
        const raw = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
          this.#scopeId,
          desired.localAssetKey,
        ]);
        if (raw === undefined || !sameDesiredBinding(raw, desired))
          throw new Error("encrypted wallet backup v2 desired asset is stale");
        await this.#database.encryptedWalletBackupV2AssetReceipts.delete([
          ...this.#authorityKey(),
          desired.localAssetKey,
        ]);
        await this.#database.encryptedWalletBackupV2DesiredAssets.delete([
          this.#scopeId,
          desired.localAssetKey,
        ]);
      },
    );
  }

  /** Commits the exact receipt artifact for one asset with the receipt-result head. */
  async commitVerifiedAssetReceipt(input: {
    readonly binding: EncryptedWalletBackupV2AssetReceiptBinding;
    readonly canonicalSignedMutation: Uint8Array;
    readonly canonicalSignedReceipt: Uint8Array;
    readonly verifiedReceipt: unknown;
    readonly collectedHeadEvidence: unknown;
    readonly preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch;
  }): Promise<void> {
    this.#requireDatabaseBinding();
    const binding = requireAssetReceiptBinding(input.binding);
    const verified = requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(
      input.verifiedReceipt,
    ).receipt;
    const mutation = decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
      input.canonicalSignedMutation,
    );
    if (
      !sameBytes(
        input.canonicalSignedMutation,
        encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(mutation),
      )
    )
      throw new Error("encrypted wallet backup v2 signed mutation is invalid");
    const authority = this.#headAuthorityRows(input.collectedHeadEvidence);
    if (
      !sameBytes(
        encodeEncryptedWalletBackupV2CurrentHead(verified.resultHead),
        authority.head.canonicalCurrentHead,
      )
    )
      throw new Error("encrypted wallet backup v2 receipt result head is invalid");
    if (
      mutation.mutation.mutationId !== input.preparedMutation.mutationId ||
      mutation.requestDigest !== input.preparedMutation.requestDigest ||
      verified.mutationId !== input.preparedMutation.mutationId ||
      verified.requestDigest !== input.preparedMutation.requestDigest
    )
      throw new Error("encrypted wallet backup v2 receipt mutation binding is invalid");
    const assetReceipt =
      verified.bundleId === null
        ? null
        : this.#assetReceiptRow(
            binding,
            verified,
            input.canonicalSignedMutation,
            input.canonicalSignedReceipt,
          );
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2AssetReceipts,
      this.#database.encryptedWalletBackupV2AcceptedHeads,
      this.#database.encryptedWalletBackupV2ActiveDescriptors,
      this.#database.encryptedWalletBackupV2PreparedMutations,
      this.#database.encryptedWalletBackupV2DesiredAssets,
      async () => {
        await this.#requirePreparedReceiptBinding(input.preparedMutation, binding);
        if (assetReceipt === null)
          await this.#database.encryptedWalletBackupV2AssetReceipts.delete([
            ...this.#authorityKey(),
            binding.localAssetKey,
          ]);
        else await this.#database.encryptedWalletBackupV2AssetReceipts.put(assetReceipt);
        await this.#commitReceiptAuthority(authority, mutation.mutation);
        await this.#database.encryptedWalletBackupV2PreparedMutations.delete(this.#authorityKey());
        await this.#acknowledgeExactDesiredAsset(binding);
      },
    );
  }

  async listActiveDescriptors(): Promise<readonly EncryptedWalletBackupV2ActiveDescriptorRow[]> {
    const rows = await this.#database.encryptedWalletBackupV2ActiveDescriptors
      .where("[scopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .toArray();
    if (rows.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX) {
      throw new Error("encrypted wallet backup v2 descriptor rows exceed the limit");
    }
    const decoded = rows.map((row) => this.#decodeDescriptorRow(row));
    if (new Set(decoded.map((row) => row.bundleId)).size !== decoded.length) {
      throw new Error("encrypted wallet backup v2 descriptor rows are duplicated");
    }
    return Object.freeze(
      decoded.sort((left, right) => left.bundleId.localeCompare(right.bundleId)),
    );
  }

  #authorityKey(): [string, string, string, number] {
    return [this.#scopeId, this.#realm, this.#walletId, this.#enrollmentEpoch];
  }

  #requireDatabaseBinding(): void {
    if (this.#database.name !== browserWalletDatabaseName(this.#scopeId)) {
      throw new Error("encrypted wallet backup v2 authority database is foreign");
    }
  }

  #preparedRow(
    input: EncryptedWalletBackupV2PreparedMutationInput,
  ): EncryptedWalletBackupV2PreparedMutationRow {
    const canonicalUploadGroup = requireBytes(input.canonicalUploadGroup, 1, 4 * 1024 * 1024);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: canonicalUploadGroup,
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
      expectedContext: this.#context(),
    });
    const mutation = group.mutationEvidence.envelope.mutation;
    const mutationId = requireHex(input.mutationId, 16, "mutation id");
    const requestDigest = requireHex(input.requestDigest, 32, "request digest");
    if (
      mutation.mutationId !== mutationId ||
      group.mutationEvidence.envelope.requestDigest !== requestDigest ||
      !isNonnegativeSafeInteger(input.createdAtUnixMilliseconds)
    ) {
      throw new Error("encrypted wallet backup v2 prepared mutation is invalid");
    }
    const binding = requireDesiredBinding(input);
    const added = mutation.addedBundle;
    if (
      (binding.desiredAction === "remove" && added !== null) ||
      (binding.desiredAction === "replace" &&
        (added === null ||
          added.assetLocator !== binding.assetLocator ||
          added.custodyRevision.toString() !== binding.custodyRevision))
    ) {
      throw new Error("encrypted wallet backup v2 prepared asset binding is invalid");
    }
    return {
      ...this.#identity(),
      mutationId,
      requestDigest,
      canonicalUploadGroup,
      createdAtUnixMilliseconds: input.createdAtUnixMilliseconds,
      ...binding,
    };
  }

  #decodePreparedRow(value: unknown): EncryptedWalletBackupV2PreparedMutationRow {
    if (!isPreparedRecord(value))
      throw new Error("encrypted wallet backup v2 prepared row is invalid");
    const row = value as EncryptedWalletBackupV2PreparedMutationRow;
    this.#requireIdentity(row);
    return this.#preparedRow(row);
  }

  async #deletePreparedIfMatch(
    input: EncryptedWalletBackupV2PreparedMutationMatch,
  ): Promise<boolean> {
    const mutationId = requireHex(input.mutationId, 16, "mutation id");
    const requestDigest = requireHex(input.requestDigest, 32, "request digest");
    const current = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
      this.#authorityKey(),
    );
    if (current === undefined) return false;
    const decoded = this.#decodePreparedRow(current);
    if (decoded.mutationId !== mutationId || decoded.requestDigest !== requestDigest) return false;
    await this.#database.encryptedWalletBackupV2PreparedMutations.delete(this.#authorityKey());
    return true;
  }

  async #requirePreparedReceiptBinding(
    match: EncryptedWalletBackupV2PreparedMutationMatch,
    binding: EncryptedWalletBackupV2AssetReceiptBinding,
  ): Promise<void> {
    const mutationId = requireHex(match.mutationId, 16, "mutation id");
    const requestDigest = requireHex(match.requestDigest, 32, "request digest");
    const current = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
      this.#authorityKey(),
    );
    if (current === undefined)
      throw new Error("encrypted wallet backup v2 prepared mutation is absent");
    const prepared = this.#decodePreparedRow(current);
    if (
      prepared.mutationId !== mutationId ||
      prepared.requestDigest !== requestDigest ||
      prepared.localAssetKey !== binding.localAssetKey ||
      prepared.assetLocator !== binding.assetLocator ||
      prepared.custodyRevision !== binding.custodyRevision ||
      prepared.desiredAction !== binding.desiredAction ||
      prepared.activeProofCount !== binding.activeProofCount
    ) {
      throw new Error("encrypted wallet backup v2 prepared receipt binding is invalid");
    }
  }

  async #requirePreparedMatchesAcceptedHead(
    input: EncryptedWalletBackupV2PreparedMutationInput,
  ): Promise<void> {
    const accepted = await this.#database.encryptedWalletBackupV2AcceptedHeads.get(
      this.#authorityKey(),
    );
    if (accepted === undefined)
      throw new Error("encrypted wallet backup v2 accepted head is absent");
    const head = this.#decodeHeadRow(accepted);
    const mutation = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: requireBytes(input.canonicalUploadGroup, 1, 4 * 1024 * 1024),
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
      expectedContext: this.#context(),
    }).mutationEvidence.envelope.mutation;
    if (
      mutation.expectedHeadVersion !== head.headVersion ||
      mutation.expectedActiveSetDigest !== head.activeSetDigest
    ) {
      throw new Error("encrypted wallet backup v2 prepared mutation head is stale");
    }
  }

  #headAuthorityRows(value: unknown): {
    readonly head: EncryptedWalletBackupV2AcceptedHeadRow;
    readonly descriptors: readonly EncryptedWalletBackupV2ActiveDescriptorRow[];
  } {
    const evidence = requireEncryptedWalletBackupV2CollectedHeadEvidence(value);
    this.#requireContext(evidence.head);
    const head = this.#headRow(evidence.head);
    const descriptors = evidence.bundles.map((descriptor) => {
      const bytes = encodeEncryptedWalletBackupV2BundleDescriptor(descriptor);
      return this.#descriptorRow(bytes);
    });
    if (
      descriptors.length !== evidence.head.activeBundleCount ||
      !sameBytes(head.canonicalCurrentHead, encodeEncryptedWalletBackupV2CurrentHead(evidence.head))
    ) {
      throw new Error("encrypted wallet backup v2 collected head evidence is invalid");
    }
    return { head, descriptors };
  }

  #headRow(
    head: EncryptedWalletBackupV2CollectedHeadEvidence["head"],
  ): EncryptedWalletBackupV2AcceptedHeadRow {
    this.#requireContext(head);
    const canonicalCurrentHead = encodeEncryptedWalletBackupV2CurrentHead(head);
    return {
      ...this.#identity(),
      headVersion: head.headVersion,
      activeBundleCount: head.activeBundleCount,
      activeObjectCount: head.activeObjectCount,
      activeSetDigest: head.activeSetDigest,
      canonicalCurrentHead,
    };
  }

  #decodeHeadRow(value: unknown): EncryptedWalletBackupV2AcceptedHeadRow {
    if (!isExactRecord(value, headFields))
      throw new Error("encrypted wallet backup v2 accepted head row is invalid");
    const row = value as EncryptedWalletBackupV2AcceptedHeadRow;
    this.#requireIdentity(row);
    const decoded = this.#headRow({
      formatVersion: 2,
      realm: row.realm,
      walletId: row.walletId,
      enrollmentEpoch: row.enrollmentEpoch,
      headVersion: row.headVersion,
      activeBundleCount: row.activeBundleCount,
      activeObjectCount: row.activeObjectCount,
      activeSetDigest: row.activeSetDigest,
    });
    if (!sameBytes(decoded.canonicalCurrentHead, row.canonicalCurrentHead)) {
      throw new Error("encrypted wallet backup v2 accepted head wire is invalid");
    }
    return decoded;
  }

  #assetReceiptRow(
    binding: EncryptedWalletBackupV2AssetReceiptBinding,
    receipt: ReturnType<
      typeof requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt
    >["receipt"],
    canonicalSignedMutation: Uint8Array,
    canonicalSignedReceipt: Uint8Array,
  ): EncryptedWalletBackupV2AssetReceiptRow {
    if (
      receipt.bundleId !== binding.bundleId ||
      receipt.bundleDescriptorDigest !== binding.bundleDescriptorDigest ||
      binding.bundleId === null ||
      binding.bundleDescriptorDigest === null ||
      !sameBytes(
        canonicalSignedReceipt,
        encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
      )
    )
      throw new Error("encrypted wallet backup v2 asset receipt is invalid");
    return {
      ...this.#identity(),
      localAssetKey: binding.localAssetKey,
      assetLocator: binding.assetLocator,
      custodyRevision: binding.custodyRevision,
      bundleId: binding.bundleId,
      bundleDescriptorDigest: binding.bundleDescriptorDigest,
      canonicalSignedMutation: canonicalSignedMutation.slice(),
      canonicalSignedReceipt: canonicalSignedReceipt.slice(),
    };
  }

  #decodeAssetReceiptRow(value: unknown): EncryptedWalletBackupV2AssetReceiptRow {
    if (!isExactRecord(value, assetReceiptFields))
      throw new Error("encrypted wallet backup v2 asset receipt row is invalid");
    const row = value as EncryptedWalletBackupV2AssetReceiptRow;
    this.#requireIdentity(row);
    const binding = requireAssetReceiptBinding({
      localAssetKey: row.localAssetKey,
      assetLocator: row.assetLocator,
      custodyRevision: row.custodyRevision,
      desiredAction: "replace",
      activeProofCount: 1,
      bundleId: row.bundleId,
      bundleDescriptorDigest: row.bundleDescriptorDigest,
    });
    const mutation = decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
      row.canonicalSignedMutation,
    );
    const receipt = decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(
      row.canonicalSignedReceipt,
    );
    if (
      mutation.mutation.addedBundle === null ||
      mutation.mutation.addedBundle.assetLocator !== binding.assetLocator ||
      mutation.mutation.addedBundle.custodyRevision.toString() !== binding.custodyRevision ||
      receipt.bundleId !== binding.bundleId ||
      receipt.bundleDescriptorDigest !== binding.bundleDescriptorDigest
    )
      throw new Error("encrypted wallet backup v2 asset receipt binding is invalid");
    return {
      ...row,
      canonicalSignedMutation: row.canonicalSignedMutation.slice(),
      canonicalSignedReceipt: row.canonicalSignedReceipt.slice(),
    };
  }

  async #acknowledgeExactDesiredAsset(
    binding: EncryptedWalletBackupV2AssetReceiptBinding,
  ): Promise<void> {
    const raw = await this.#database.encryptedWalletBackupV2DesiredAssets.get([
      this.#scopeId,
      binding.localAssetKey,
    ]);
    if (raw === undefined || !sameDesiredBinding(raw, binding)) return;
    if (binding.desiredAction === "remove") {
      await this.#database.encryptedWalletBackupV2DesiredAssets.delete([
        this.#scopeId,
        binding.localAssetKey,
      ]);
      return;
    }
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    await this.#database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
    });
  }

  async #commitReceiptAuthority(
    authority: {
      readonly head: EncryptedWalletBackupV2AcceptedHeadRow;
      readonly descriptors: readonly EncryptedWalletBackupV2ActiveDescriptorRow[];
    },
    mutation: ReturnType<
      typeof decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire
    >["mutation"],
  ): Promise<void> {
    const rawHead = await this.#database.encryptedWalletBackupV2AcceptedHeads.get(
      this.#authorityKey(),
    );
    if (rawHead === undefined)
      throw new Error("encrypted wallet backup v2 accepted head is absent");
    const current = this.#decodeHeadRow(rawHead);
    if (
      mutation.expectedHeadVersion !== current.headVersion ||
      mutation.expectedActiveSetDigest !== current.activeSetDigest ||
      authority.head.headVersion !== current.headVersion + 1
    ) {
      throw new Error("encrypted wallet backup v2 receipt head is stale");
    }
    const supersededKeys: [string, string, string, number, string][] =
      mutation.supersededBundleIds.map((bundleId) => [...this.#authorityKey(), bundleId]);
    if (supersededKeys.length > 0) {
      const superseded =
        await this.#database.encryptedWalletBackupV2ActiveDescriptors.bulkGet(supersededKeys);
      if (superseded.some((row) => row === undefined)) {
        throw new Error("encrypted wallet backup v2 superseded descriptor is absent");
      }
      superseded.forEach((row) => this.#decodeDescriptorRow(row));
      await this.#database.encryptedWalletBackupV2ActiveDescriptors.bulkDelete(supersededKeys);
    }
    if (mutation.addedBundle !== null) {
      await this.#database.encryptedWalletBackupV2ActiveDescriptors.put(
        this.#descriptorRow(encodeEncryptedWalletBackupV2BundleDescriptor(mutation.addedBundle)),
      );
    }
    await this.#database.encryptedWalletBackupV2AcceptedHeads.put(authority.head);
  }

  async #requeueAcknowledgedDesiredAssets(): Promise<void> {
    const rawRows = await this.#database.encryptedWalletBackupV2DesiredAssets
      .where("[scopeId+localAssetKey]")
      .between([this.#scopeId, Dexie.minKey], [this.#scopeId, Dexie.maxKey])
      .limit(257)
      .toArray();
    if (rawRows.length > 256)
      throw new Error("encrypted wallet backup v2 desired asset rows exceed the limit");
    const rows = rawRows.map(decodeEncryptedWalletBackupV2DesiredAssetRow);
    const acknowledged = rows.filter(({ syncState }) => syncState === "acknowledged");
    if (acknowledged.length === 0) return;
    await this.#database.encryptedWalletBackupV2DesiredAssets.bulkPut(
      acknowledged.map((row) => ({ ...row, syncState: "pending" as const })),
    );
  }

  #descriptorRow(canonicalDescriptor: Uint8Array): EncryptedWalletBackupV2ActiveDescriptorRow {
    const bytes = requireBytes(canonicalDescriptor, 1, 65_536);
    const descriptor = decodeEncryptedWalletBackupV2BundleDescriptorWire(bytes, this.#context());
    if (!sameBytes(bytes, encodeEncryptedWalletBackupV2BundleDescriptor(descriptor))) {
      throw new Error("encrypted wallet backup v2 descriptor wire is invalid");
    }
    return descriptorRow(this.#identity(), descriptor, bytes);
  }

  async #replaceDescriptorRows(
    rows: readonly EncryptedWalletBackupV2ActiveDescriptorRow[],
  ): Promise<void> {
    const current = await this.#database.encryptedWalletBackupV2ActiveDescriptors
      .where("[scopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .primaryKeys();
    await this.#database.encryptedWalletBackupV2ActiveDescriptors.bulkDelete(current);
    await this.#database.encryptedWalletBackupV2ActiveDescriptors.bulkAdd(rows);
  }

  async #mayReplaceAcceptedAuthority(next: {
    readonly head: EncryptedWalletBackupV2AcceptedHeadRow;
    readonly descriptors: readonly EncryptedWalletBackupV2ActiveDescriptorRow[];
  }): Promise<boolean> {
    const current = await this.#database.encryptedWalletBackupV2AcceptedHeads.get(
      this.#authorityKey(),
    );
    if (current === undefined) return true;
    const head = this.#decodeHeadRow(current);
    const descriptors = await this.#readCurrentDescriptorRows();
    if (next.head.headVersion < head.headVersion) {
      throw new Error("encrypted wallet backup v2 accepted head is stale");
    }
    if (next.head.headVersion > head.headVersion) return true;
    if (
      !sameBytes(next.head.canonicalCurrentHead, head.canonicalCurrentHead) ||
      !sameDescriptorRows(next.descriptors, descriptors)
    ) {
      throw new Error("encrypted wallet backup v2 accepted head conflicts");
    }
    return false;
  }

  async #readCurrentDescriptorRows(): Promise<
    readonly EncryptedWalletBackupV2ActiveDescriptorRow[]
  > {
    const rows = await this.#database.encryptedWalletBackupV2ActiveDescriptors
      .where("[scopeId+realm+walletId+enrollmentEpoch]")
      .equals(this.#authorityKey())
      .toArray();
    return rows.map((row) => this.#decodeDescriptorRow(row));
  }

  #decodeDescriptorRow(value: unknown): EncryptedWalletBackupV2ActiveDescriptorRow {
    if (!isExactRecord(value, descriptorFields))
      throw new Error("encrypted wallet backup v2 descriptor row is invalid");
    const row = value as EncryptedWalletBackupV2ActiveDescriptorRow;
    this.#requireIdentity(row);
    const decoded = this.#descriptorRow(row.canonicalDescriptor);
    if (
      decoded.bundleId !== row.bundleId ||
      decoded.assetLocator !== row.assetLocator ||
      decoded.declaredAmount !== requireDecimalUint64(row.declaredAmount) ||
      decoded.custodyRevision !== requireDecimalUint64(row.custodyRevision) ||
      decoded.payloadCommitment !== row.payloadCommitment ||
      decoded.objectCount !== row.objectCount
    ) {
      throw new Error("encrypted wallet backup v2 descriptor mirrors are invalid");
    }
    return decoded;
  }

  #identity(): Pick<
    EncryptedWalletBackupV2PreparedMutationRow,
    "scopeId" | "realm" | "walletId" | "enrollmentEpoch"
  > {
    return {
      scopeId: this.#scopeId,
      realm: this.#realm,
      walletId: this.#walletId,
      enrollmentEpoch: this.#enrollmentEpoch,
    };
  }

  #context(): {
    readonly realm: string;
    readonly walletId: string;
    readonly enrollmentEpoch: number;
  } {
    return { realm: this.#realm, walletId: this.#walletId, enrollmentEpoch: this.#enrollmentEpoch };
  }

  #requireIdentity(value: {
    readonly scopeId: string;
    readonly realm: string;
    readonly walletId: string;
    readonly enrollmentEpoch: number;
  }): void {
    if (
      value.scopeId !== this.#scopeId ||
      value.realm !== this.#realm ||
      value.walletId !== this.#walletId ||
      value.enrollmentEpoch !== this.#enrollmentEpoch
    ) {
      throw new Error("encrypted wallet backup v2 authority row is foreign");
    }
  }

  #requireContext(value: {
    readonly realm: string;
    readonly walletId: string;
    readonly enrollmentEpoch: number;
  }): void {
    if (
      value.realm !== this.#realm ||
      value.walletId !== this.#walletId ||
      value.enrollmentEpoch !== this.#enrollmentEpoch
    ) {
      throw new Error("encrypted wallet backup v2 authority artifact is foreign");
    }
  }
}

const preparedFields = [
  "scopeId",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "mutationId",
  "requestDigest",
  "canonicalUploadGroup",
  "createdAtUnixMilliseconds",
  "localAssetKey",
  "assetLocator",
  "custodyRevision",
  "desiredAction",
  "activeProofCount",
] as const;
const headFields = [
  "scopeId",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "headVersion",
  "activeBundleCount",
  "activeObjectCount",
  "activeSetDigest",
  "canonicalCurrentHead",
] as const;
const descriptorFields = [
  "scopeId",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "bundleId",
  "assetLocator",
  "declaredAmount",
  "custodyRevision",
  "payloadCommitment",
  "objectCount",
  "canonicalDescriptor",
] as const;
const assetReceiptFields = [
  "scopeId",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "localAssetKey",
  "assetLocator",
  "custodyRevision",
  "bundleId",
  "bundleDescriptorDigest",
  "canonicalSignedMutation",
  "canonicalSignedReceipt",
] as const;

function requireProfile(profile: EncryptedWalletBackupV2DexieAuthorityProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    !isSafeScopeId(profile.scopeId) ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(profile.realm) ||
    !isHex(profile.walletId, 32) ||
    !Number.isSafeInteger(profile.enrollmentEpoch) ||
    profile.enrollmentEpoch < 1 ||
    !isHex(profile.requestAuthPublicKey, 32)
  ) {
    throw new Error("encrypted wallet backup v2 authority profile is invalid");
  }
}

function descriptorRow(
  identity: Pick<
    EncryptedWalletBackupV2ActiveDescriptorRow,
    "scopeId" | "realm" | "walletId" | "enrollmentEpoch"
  >,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  canonicalDescriptor: Uint8Array,
): EncryptedWalletBackupV2ActiveDescriptorRow {
  return {
    ...identity,
    bundleId: descriptor.bundleId,
    assetLocator: descriptor.assetLocator,
    declaredAmount: decimalUint64(descriptor.declaredAmount),
    custodyRevision: decimalUint64(descriptor.custodyRevision),
    payloadCommitment: descriptor.payloadCommitment,
    objectCount: descriptor.objects.length,
    canonicalDescriptor,
  };
}

function isExactRecord(value: unknown, fields: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isPreparedRecord(value: unknown): boolean {
  return isExactRecord(value, preparedFields);
}

function requireBytes(value: unknown, minimum: number, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error("encrypted wallet backup v2 canonical bytes are invalid");
  }
  return value.slice();
}

function requireHex(value: unknown, bytes: number, label: string): string {
  if (!isHex(value, bytes)) throw new Error(`encrypted wallet backup v2 ${label} is invalid`);
  return value;
}

function decimalUint64(value: bigint): string {
  if (value < 0n || value > 18_446_744_073_709_551_615n)
    throw new Error("encrypted wallet backup v2 uint64 is invalid");
  return value.toString();
}

function requireDecimalUint64(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new Error("encrypted wallet backup v2 uint64 is invalid");
  return decimalUint64(BigInt(value));
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

function isSafeScopeId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    decodeDurableCustodyScopeId(value);
    return true;
  } catch {
    return false;
  }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function sameDescriptorRows(
  left: readonly EncryptedWalletBackupV2ActiveDescriptorRow[],
  right: readonly EncryptedWalletBackupV2ActiveDescriptorRow[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  const sortedRight = [...right].sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  return sortedLeft.every(
    (row, index) =>
      row.bundleId === sortedRight[index]?.bundleId &&
      row.assetLocator === sortedRight[index]?.assetLocator &&
      row.declaredAmount === sortedRight[index]?.declaredAmount &&
      row.custodyRevision === sortedRight[index]?.custodyRevision &&
      row.payloadCommitment === sortedRight[index]?.payloadCommitment &&
      row.objectCount === sortedRight[index]?.objectCount &&
      sameBytes(row.canonicalDescriptor, sortedRight[index]!.canonicalDescriptor),
  );
}

function requireDesiredBinding(
  value: EncryptedWalletBackupV2PreparedDesiredBinding,
): EncryptedWalletBackupV2PreparedDesiredBinding {
  if (
    typeof value.localAssetKey !== "string" ||
    value.localAssetKey.length < 1 ||
    !isHex(value.assetLocator, 32) ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value.custodyRevision) ||
    BigInt(value.custodyRevision) > 18_446_744_073_709_551_615n ||
    (value.desiredAction !== "replace" && value.desiredAction !== "remove") ||
    !isNonnegativeSafeInteger(value.activeProofCount) ||
    value.activeProofCount > 512 ||
    (value.activeProofCount === 0 ? "remove" : "replace") !== value.desiredAction
  ) {
    throw new Error("encrypted wallet backup v2 desired asset binding is invalid");
  }
  return {
    localAssetKey: value.localAssetKey,
    assetLocator: value.assetLocator,
    custodyRevision: value.custodyRevision,
    desiredAction: value.desiredAction,
    activeProofCount: value.activeProofCount,
  };
}

function sameDesiredBinding(
  value: unknown,
  expected: EncryptedWalletBackupV2PreparedDesiredBinding,
): boolean {
  let row: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>;
  try {
    row = decodeEncryptedWalletBackupV2DesiredAssetRow(value);
  } catch {
    return false;
  }
  return (
    row.syncState === "pending" &&
    row.localAssetKey === expected.localAssetKey &&
    row.custodyRevision === expected.custodyRevision &&
    row.desiredAction === expected.desiredAction &&
    row.activeProofCount === expected.activeProofCount
  );
}

function requireAssetReceiptBinding(
  value: EncryptedWalletBackupV2AssetReceiptBinding,
): EncryptedWalletBackupV2AssetReceiptBinding {
  const desired = requireDesiredBinding(value);
  if (
    (value.bundleId === null) !== (value.bundleDescriptorDigest === null) ||
    (value.bundleId !== null &&
      (!isHex(value.bundleId, 16) || !isHex(value.bundleDescriptorDigest, 32)))
  )
    throw new Error("encrypted wallet backup v2 asset receipt binding is invalid");
  return {
    ...desired,
    bundleId: value.bundleId,
    bundleDescriptorDigest: value.bundleDescriptorDigest,
  };
}
