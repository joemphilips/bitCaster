import Dexie from "dexie";
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { BitcasterDB, EncryptedWalletBackupDexiePreparedSourceRow } from "./proof-db";

export interface EncryptedWalletBackupPreparedSourceDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly vaultId: string;
}

/**
 * Persists immutable prepared sources before snapshot population.
 * Snapshot pins must re-read these rows in their own Dexie transaction.
 */
export class EncryptedWalletBackupPreparedSourceDexieStore
  implements
    EncryptedWalletBackupPreparedRecordSnapshotStore,
    EncryptedWalletBackupPreparedRecordSnapshotBatchStore
{
  readonly #database: BitcasterDB;
  readonly #realm: string;
  readonly #vaultId: string;

  constructor(profile: EncryptedWalletBackupPreparedSourceDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#realm = profile.realm;
    this.#vaultId = profile.vaultId;
  }

  async insertPreparedSource(record: PersistedPreparedEncryptedWalletBackupRecord): Promise<void> {
    const row = sourceRow(record, this.#realm, this.#vaultId);
    await this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupPreparedSources,
      async () => {
        const existing = await this.#database.encryptedWalletBackupPreparedSources.get([
          row.realm,
          row.vaultId,
          row.recordKindCode,
          row.recordId,
          row.revision,
          row.bodyReference,
        ]);
        if (existing === undefined) {
          await this.#database.encryptedWalletBackupPreparedSources.add(row);
          return;
        }
        if (!sameSource(existing, row))
          throw new Error("prepared source conflicts with existing content");
      },
    );
  }

  async withCommittedPreparedRecordSnapshot<T>(
    recordId: string,
    read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
    sourceDescriptor?: Uint8Array,
  ): Promise<T> {
    return this.withCommittedPreparedRecordSnapshotBatch(
      [recordId],
      (rows) => read(rows[0]!),
      sourceDescriptor === undefined ? undefined : [sourceDescriptor],
    );
  }

  async withCommittedPreparedRecordSnapshotBatch<T>(
    recordIds: readonly string[],
    read: (rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[]) => T,
    sourceDescriptors?: readonly Uint8Array[],
  ): Promise<T> {
    if (!Array.isArray(recordIds) || recordIds.length < 1 || recordIds.length > 256)
      throw new Error("prepared source snapshot batch is invalid");
    if (new Set(recordIds).size !== recordIds.length)
      throw new Error("prepared source snapshot ids are duplicated");
    if (sourceDescriptors !== undefined && sourceDescriptors.length !== recordIds.length)
      throw new Error("prepared source snapshot descriptors are invalid");
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupPreparedSources,
      async () => {
        const rows =
          sourceDescriptors === undefined
            ? await this.#readUnambiguousSources(recordIds)
            : await this.#readExactSources(recordIds, sourceDescriptors);
        return read(Object.freeze(rows));
      },
    );
  }

  async #readExactSources(
    recordIds: readonly string[],
    canonicalDescriptors: readonly Uint8Array[],
  ): Promise<EncryptedWalletBackupPreparedRecordSnapshot[]> {
    const descriptors = canonicalDescriptors.map((canonicalDescriptor, index) => {
      const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(canonicalDescriptor);
      if (
        descriptor.realm !== this.#realm ||
        descriptor.vaultId !== this.#vaultId ||
        descriptor.recordId !== recordIds[index]
      ) {
        throw new Error("prepared source snapshot descriptor is foreign");
      }
      return descriptor;
    });
    const rows = await this.#database.encryptedWalletBackupPreparedSources.bulkGet(
      descriptors.map((descriptor) => [
        this.#realm,
        this.#vaultId,
        0,
        descriptor.recordId,
        descriptor.revision,
        descriptor.bodyReference,
      ]),
    );
    return rows.map((row, index) => {
      if (row === undefined) throw new Error("prepared source is absent");
      if (!equalBytes(row.canonicalDescriptor, canonicalDescriptors[index]!))
        throw new Error("prepared source changed");
      return snapshotOf(row);
    });
  }

  async #readUnambiguousSources(
    recordIds: readonly string[],
  ): Promise<EncryptedWalletBackupPreparedRecordSnapshot[]> {
    const snapshots: EncryptedWalletBackupPreparedRecordSnapshot[] = [];
    for (const recordId of recordIds) {
      const row = await this.#readUnambiguousSource(recordId);
      if (row === undefined) throw new Error("prepared source is absent");
      snapshots.push(snapshotOf(row));
    }
    return snapshots;
  }

  async #readUnambiguousSource(
    recordId: string,
  ): Promise<EncryptedWalletBackupDexiePreparedSourceRow | undefined> {
    const rows = await this.#database.encryptedWalletBackupPreparedSources
      .where("[realm+vaultId+recordKindCode+recordId]")
      .equals([this.#realm, this.#vaultId, 0, recordId])
      .limit(2)
      .toArray();
    if (rows.length > 1)
      throw new Error("prepared source snapshot requires an exact source descriptor");
    return rows[0];
  }
}

function sameSource(
  left: EncryptedWalletBackupDexiePreparedSourceRow,
  right: EncryptedWalletBackupDexiePreparedSourceRow,
): boolean {
  return (
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.recordKindCode === right.recordKindCode &&
    left.recordId === right.recordId &&
    left.commitment === right.commitment &&
    left.bodyReference === right.bodyReference &&
    left.revision === right.revision &&
    left.snapshotId === right.snapshotId &&
    left.snapshotRevision === right.snapshotRevision &&
    equalBytes(left.canonicalDescriptor, right.canonicalDescriptor)
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function requireProfile(profile: EncryptedWalletBackupPreparedSourceDatabaseProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    typeof profile.realm !== "string" ||
    profile.realm.length < 1 ||
    profile.realm.length > 64 ||
    !/^[0-9a-f]{64}$/.test(profile.vaultId) ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId)
  ) {
    throw new Error("encrypted wallet backup prepared source database profile is invalid");
  }
}

function sourceRow(
  record: PersistedPreparedEncryptedWalletBackupRecord,
  realm: string,
  vaultId: string,
): EncryptedWalletBackupDexiePreparedSourceRow {
  const canonicalDescriptor = encodeEncryptedWalletBackupPreparedSourceDescriptor(record);
  const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(canonicalDescriptor);
  if (descriptor.realm !== realm || descriptor.vaultId !== vaultId)
    throw new Error("prepared source belongs to a foreign wallet profile");
  return {
    realm,
    vaultId,
    recordKindCode: descriptor.recordKindCode,
    recordId: descriptor.recordId,
    commitment: descriptor.commitment,
    bodyReference: descriptor.bodyReference,
    revision: descriptor.revision,
    snapshotId: record.snapshotId,
    snapshotRevision: record.snapshotRevision,
    canonicalDescriptor: canonicalDescriptor.slice(),
  };
}

function snapshotOf(
  row: EncryptedWalletBackupDexiePreparedSourceRow,
): EncryptedWalletBackupPreparedRecordSnapshot {
  const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(row.canonicalDescriptor);
  if (
    descriptor.realm !== row.realm ||
    descriptor.vaultId !== row.vaultId ||
    descriptor.recordId !== row.recordId ||
    descriptor.commitment !== row.commitment ||
    descriptor.bodyReference !== row.bodyReference ||
    descriptor.revision !== row.revision ||
    row.snapshotId.length < 1 ||
    !Number.isSafeInteger(row.snapshotRevision) ||
    row.snapshotRevision < 0
  ) {
    throw new Error("prepared source row changed");
  }
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: row.snapshotId,
    snapshotRevision: row.snapshotRevision,
    recordId: row.recordId,
    commitment: row.commitment,
    recordKindCode: 0,
  });
}
