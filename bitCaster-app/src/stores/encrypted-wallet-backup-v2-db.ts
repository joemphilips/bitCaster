import Dexie from "dexie";
import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
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
  EncryptedWalletBackupV2ReceiptRow,
} from "./proof-db";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";

export interface EncryptedWalletBackupV2DexieAuthorityProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly enrollmentEpoch: number;
  readonly requestAuthPublicKey: string;
}

export interface EncryptedWalletBackupV2PreparedMutationInput {
  readonly mutationId: string;
  readonly requestDigest: string;
  readonly localRevision: number;
  readonly canonicalUploadGroup: Uint8Array;
  readonly createdAtUnixMilliseconds: number;
}

export interface EncryptedWalletBackupV2ReceiptInput {
  readonly canonicalSignedReceipt: Uint8Array;
  readonly acknowledgedLocalRevision: number;
  readonly verifiedReceipt: unknown;
}

export interface EncryptedWalletBackupV2PreparedMutationMatch {
  readonly mutationId: string;
  readonly requestDigest: string;
}

/** Strict V2-only Dexie primitives. This class never performs service I/O. */
export class EncryptedWalletBackupV2DexieAuthorityStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #realm: string;
  readonly #vaultId: string;
  readonly #enrollmentEpoch: number;
  readonly #requestAuthPublicKey: string;

  constructor(profile: EncryptedWalletBackupV2DexieAuthorityProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#scopeId = profile.scopeId;
    this.#realm = profile.realm;
    this.#vaultId = profile.vaultId;
    this.#enrollmentEpoch = profile.enrollmentEpoch;
    this.#requestAuthPublicKey = profile.requestAuthPublicKey;
  }

  async readDirtyRevision(): Promise<number> {
    const row = await this.#database.encryptedWalletBackupV2DirtyRevisions.get(this.#scopeId);
    if (row === undefined) return 0;
    if (
      !isExactRecord(row, ["scopeId", "revision"]) ||
      row.scopeId !== this.#scopeId ||
      !isNonnegativeSafeInteger(row.revision)
    ) {
      throw new Error("encrypted wallet backup v2 dirty revision row is invalid");
    }
    return row.revision;
  }

  async readPreparedMutation(): Promise<EncryptedWalletBackupV2PreparedMutationRow | null> {
    const row = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
      this.#authorityKey(),
    );
    return row === undefined ? null : this.#decodePreparedRow(row);
  }

  /** Adds the one immutable prepared mutation or proves the exact replay is safe. */
  async insertPreparedMutation(
    input: EncryptedWalletBackupV2PreparedMutationInput,
  ): Promise<"inserted" | "existing"> {
    this.#requireDatabaseBinding();
    const next = this.#preparedRow(input);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2PreparedMutations,
      this.#database.encryptedWalletBackupV2AcceptedHeads,
      async () => {
        await this.#requirePreparedMatchesAcceptedHead(input);
        const current = await this.#database.encryptedWalletBackupV2PreparedMutations.get(
          this.#authorityKey(),
        );
        if (current === undefined) {
          await this.#database.encryptedWalletBackupV2PreparedMutations.add(next);
          return "inserted";
        }
        const decoded = this.#decodePreparedRow(current);
        if (
          decoded.mutationId !== next.mutationId ||
          decoded.requestDigest !== next.requestDigest ||
          decoded.localRevision !== next.localRevision ||
          decoded.createdAtUnixMilliseconds !== next.createdAtUnixMilliseconds ||
          !sameBytes(decoded.canonicalUploadGroup, next.canonicalUploadGroup)
        ) {
          throw new Error("encrypted wallet backup v2 prepared mutation conflicts");
        }
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
      async () => {
        if (await this.#mayReplaceAcceptedAuthority(authority)) {
          await this.#database.encryptedWalletBackupV2AcceptedHeads.put(authority.head);
          await this.#replaceDescriptorRows(authority.descriptors);
        }
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

  async readReceipt(): Promise<EncryptedWalletBackupV2ReceiptRow | null> {
    const row = await this.#database.encryptedWalletBackupV2Receipts.get(this.#authorityKey());
    return row === undefined ? null : this.#decodeReceiptRow(row);
  }

  /** Atomically commits a verified receipt with its result head and active descriptors. */
  async commitVerifiedReceipt(input: {
    readonly receipt: EncryptedWalletBackupV2ReceiptInput;
    readonly collectedHeadEvidence: unknown;
    readonly preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch;
  }): Promise<void> {
    this.#requireDatabaseBinding();
    const verified = requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(
      input.receipt.verifiedReceipt,
    ).receipt;
    const receipt = this.#receiptRow(input.receipt);
    if (
      receipt.mutationId !== verified.mutationId ||
      receipt.requestDigest !== verified.requestDigest ||
      !sameBytes(
        receipt.canonicalSignedReceipt,
        encodeEncryptedWalletBackupV2BundleSupersessionReceipt(verified),
      )
    ) {
      throw new Error("encrypted wallet backup v2 verified receipt is invalid");
    }
    const authority = this.#headAuthorityRows(input.collectedHeadEvidence);
    if (
      !sameBytes(
        encodeEncryptedWalletBackupV2CurrentHead(verified.resultHead),
        authority.head.canonicalCurrentHead,
      )
    ) {
      throw new Error("encrypted wallet backup v2 receipt result head is invalid");
    }
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupV2Receipts,
      this.#database.encryptedWalletBackupV2AcceptedHeads,
      this.#database.encryptedWalletBackupV2ActiveDescriptors,
      this.#database.encryptedWalletBackupV2PreparedMutations,
      async () => {
        await this.#requirePreparedReceiptBinding(input.preparedMutation, receipt);
        await this.#database.encryptedWalletBackupV2Receipts.put(receipt);
        if (await this.#mayReplaceAcceptedAuthority(authority)) {
          await this.#database.encryptedWalletBackupV2AcceptedHeads.put(authority.head);
          await this.#replaceDescriptorRows(authority.descriptors);
        }
        await this.#database.encryptedWalletBackupV2PreparedMutations.delete(this.#authorityKey());
      },
    );
  }

  async listActiveDescriptors(): Promise<readonly EncryptedWalletBackupV2ActiveDescriptorRow[]> {
    const rows = await this.#database.encryptedWalletBackupV2ActiveDescriptors
      .where("[scopeId+realm+vaultId+enrollmentEpoch]")
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
    return [this.#scopeId, this.#realm, this.#vaultId, this.#enrollmentEpoch];
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
      !isNonnegativeSafeInteger(input.localRevision) ||
      !isNonnegativeSafeInteger(input.createdAtUnixMilliseconds)
    ) {
      throw new Error("encrypted wallet backup v2 prepared mutation is invalid");
    }
    return {
      ...this.#identity(),
      mutationId,
      requestDigest,
      localRevision: input.localRevision,
      canonicalUploadGroup,
      createdAtUnixMilliseconds: input.createdAtUnixMilliseconds,
    };
  }

  #decodePreparedRow(value: unknown): EncryptedWalletBackupV2PreparedMutationRow {
    if (!isExactRecord(value, preparedFields))
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
    receipt: EncryptedWalletBackupV2ReceiptRow,
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
      receipt.mutationId !== mutationId ||
      receipt.requestDigest !== requestDigest ||
      receipt.acknowledgedLocalRevision !== prepared.localRevision
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
      vaultId: row.vaultId,
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

  #receiptRow(
    input: Pick<
      EncryptedWalletBackupV2ReceiptInput,
      "canonicalSignedReceipt" | "acknowledgedLocalRevision"
    >,
  ): EncryptedWalletBackupV2ReceiptRow {
    const canonicalSignedReceipt = requireBytes(input.canonicalSignedReceipt, 1, 65_536);
    const receipt =
      decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(canonicalSignedReceipt);
    this.#requireContext(receipt);
    if (
      !isNonnegativeSafeInteger(input.acknowledgedLocalRevision) ||
      !sameBytes(
        canonicalSignedReceipt,
        encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
      )
    ) {
      throw new Error("encrypted wallet backup v2 receipt row is invalid");
    }
    return {
      ...this.#identity(),
      mutationId: receipt.mutationId,
      requestDigest: receipt.requestDigest,
      acknowledgedLocalRevision: input.acknowledgedLocalRevision,
      canonicalSignedReceipt,
    };
  }

  #decodeReceiptRow(value: unknown): EncryptedWalletBackupV2ReceiptRow {
    if (!isExactRecord(value, receiptFields))
      throw new Error("encrypted wallet backup v2 receipt row is invalid");
    const row = value as EncryptedWalletBackupV2ReceiptRow;
    this.#requireIdentity(row);
    const decoded = this.#receiptRow(row);
    if (decoded.mutationId !== row.mutationId || decoded.requestDigest !== row.requestDigest) {
      throw new Error("encrypted wallet backup v2 receipt mirrors are invalid");
    }
    return decoded;
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
      .where("[scopeId+realm+vaultId+enrollmentEpoch]")
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
      .where("[scopeId+realm+vaultId+enrollmentEpoch]")
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
      decoded.operationLocator !== row.operationLocator ||
      decoded.payloadCommitment !== row.payloadCommitment ||
      decoded.objectCount !== row.objectCount
    ) {
      throw new Error("encrypted wallet backup v2 descriptor mirrors are invalid");
    }
    return decoded;
  }

  #identity(): Pick<
    EncryptedWalletBackupV2PreparedMutationRow,
    "scopeId" | "realm" | "vaultId" | "enrollmentEpoch"
  > {
    return {
      scopeId: this.#scopeId,
      realm: this.#realm,
      vaultId: this.#vaultId,
      enrollmentEpoch: this.#enrollmentEpoch,
    };
  }

  #context(): {
    readonly realm: string;
    readonly vaultId: string;
    readonly enrollmentEpoch: number;
  } {
    return { realm: this.#realm, vaultId: this.#vaultId, enrollmentEpoch: this.#enrollmentEpoch };
  }

  #requireIdentity(value: {
    readonly scopeId: string;
    readonly realm: string;
    readonly vaultId: string;
    readonly enrollmentEpoch: number;
  }): void {
    if (
      value.scopeId !== this.#scopeId ||
      value.realm !== this.#realm ||
      value.vaultId !== this.#vaultId ||
      value.enrollmentEpoch !== this.#enrollmentEpoch
    ) {
      throw new Error("encrypted wallet backup v2 authority row is foreign");
    }
  }

  #requireContext(value: {
    readonly realm: string;
    readonly vaultId: string;
    readonly enrollmentEpoch: number;
  }): void {
    if (
      value.realm !== this.#realm ||
      value.vaultId !== this.#vaultId ||
      value.enrollmentEpoch !== this.#enrollmentEpoch
    ) {
      throw new Error("encrypted wallet backup v2 authority artifact is foreign");
    }
  }
}

const preparedFields = [
  "scopeId",
  "realm",
  "vaultId",
  "enrollmentEpoch",
  "mutationId",
  "requestDigest",
  "localRevision",
  "canonicalUploadGroup",
  "createdAtUnixMilliseconds",
] as const;
const headFields = [
  "scopeId",
  "realm",
  "vaultId",
  "enrollmentEpoch",
  "headVersion",
  "activeBundleCount",
  "activeObjectCount",
  "activeSetDigest",
  "canonicalCurrentHead",
] as const;
const receiptFields = [
  "scopeId",
  "realm",
  "vaultId",
  "enrollmentEpoch",
  "mutationId",
  "requestDigest",
  "acknowledgedLocalRevision",
  "canonicalSignedReceipt",
] as const;
const descriptorFields = [
  "scopeId",
  "realm",
  "vaultId",
  "enrollmentEpoch",
  "bundleId",
  "operationLocator",
  "payloadCommitment",
  "objectCount",
  "canonicalDescriptor",
] as const;

function requireProfile(profile: EncryptedWalletBackupV2DexieAuthorityProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    !isSafeScopeId(profile.scopeId) ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(profile.realm) ||
    !isHex(profile.vaultId, 32) ||
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
    "scopeId" | "realm" | "vaultId" | "enrollmentEpoch"
  >,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  canonicalDescriptor: Uint8Array,
): EncryptedWalletBackupV2ActiveDescriptorRow {
  return {
    ...identity,
    bundleId: descriptor.bundleId,
    operationLocator: descriptor.operationLocator,
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
      row.operationLocator === sortedRight[index]?.operationLocator &&
      row.payloadCommitment === sortedRight[index]?.payloadCommitment &&
      row.objectCount === sortedRight[index]?.objectCount &&
      sameBytes(row.canonicalDescriptor, sortedRight[index]!.canonicalDescriptor),
  );
}
