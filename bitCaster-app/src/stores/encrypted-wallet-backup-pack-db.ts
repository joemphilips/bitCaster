import Dexie from "dexie";
import {
  serializeEncryptedWalletBackupBuildCursor,
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPackControl,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  serializeEncryptedWalletBackupStagedObject,
  type EncryptedWalletBackupPackPersistenceStore,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackBinding,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupStagedObject,
} from "@bitcaster/client-sdk/encryptedWalletBackupPackPersistence";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type {
  BitcasterDB,
  EncryptedWalletBackupDexiePackBindingRow,
  EncryptedWalletBackupDexiePreparedRecordRow,
} from "./proof-db";

type ExactVersionExpectation = Readonly<{
  buildId: string;
  buildVersion: number;
  packId: string;
  packVersion: number;
  realm: string;
  vaultId: string;
  snapshotId: string;
  snapshotRevision: number;
}>;

export interface EncryptedWalletBackupPackDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly vaultId: string;
}

/** Dexie persistence for one frozen encrypted wallet-backup pack build. */
export class EncryptedWalletBackupPackDexieStore implements EncryptedWalletBackupPackPersistenceStore {
  readonly #database: BitcasterDB;
  readonly #realm: string;
  readonly #vaultId: string;

  constructor(profile: EncryptedWalletBackupPackDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#realm = profile.realm;
    this.#vaultId = profile.vaultId;
  }

  async withExactVersionTransaction<T>(
    expected: ExactVersionExpectation,
    use: (transaction: EncryptedWalletBackupPackPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    requireBoundProfile(expected, this.#realm, this.#vaultId);
    const database = this.#database;
    return database.transaction(
      "rw",
      database.encryptedWalletBackupBuildCursors,
      database.encryptedWalletBackupPackControls,
      database.encryptedWalletBackupPreparedRecords,
      database.encryptedWalletBackupPackBindings,
      database.encryptedWalletBackupStagedObjects,
      async () => {
        const build = await database.encryptedWalletBackupBuildCursors.get(expected.buildId);
        const pack = await database.encryptedWalletBackupPackControls.get([
          expected.buildId,
          expected.packId,
        ]);
        requireExpectedBuild(build, expected);
        requireExpectedPack(pack, expected);
        return use(new DexiePackTransaction(database, expected));
      },
    );
  }
}

function requireProfile(profile: EncryptedWalletBackupPackDatabaseProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    typeof profile.realm !== "string" ||
    profile.realm.length < 1 ||
    profile.realm.length > 64 ||
    !/^[0-9a-f]{64}$/.test(profile.vaultId)
  ) {
    throw new Error("encrypted wallet backup pack database profile is invalid");
  }
  const expectedName = browserWalletDatabaseName(profile.scopeId);
  if (profile.database.name !== expectedName)
    throw new Error("encrypted wallet backup pack database profile does not match its scope");
}

function requireBoundProfile(
  expected: ExactVersionExpectation,
  realm: string,
  vaultId: string,
): void {
  if (expected.realm !== realm || expected.vaultId !== vaultId)
    throw new Error("backup transaction scope does not match the bound wallet profile");
}

class DexiePackTransaction implements EncryptedWalletBackupPackPersistenceTransaction {
  readonly #database: BitcasterDB;
  readonly #expected: ExactVersionExpectation;
  readonly #preparedRecordSerializedBytes = new Map<string, number>();

  constructor(database: BitcasterDB, expected: ExactVersionExpectation) {
    this.#database = database;
    this.#expected = expected;
  }

  async readBuildCursor(
    buildId: string,
  ): Promise<PersistedEncryptedWalletBackupBuildCursor | null> {
    requireBuildId(buildId, this.#expected);
    const row = await this.#database.encryptedWalletBackupBuildCursors.get(buildId);
    if (row === undefined) return null;
    requireExpectedBuild(row, this.#expected);
    return clone(row);
  }

  async readPackControl(
    buildId: string,
    packId: string,
  ): Promise<PersistedEncryptedWalletBackupPackControl | null> {
    requirePackKey(buildId, packId, this.#expected);
    const row = await this.#database.encryptedWalletBackupPackControls.get([buildId, packId]);
    if (row === undefined) return null;
    requireExpectedPack(row, this.#expected);
    return clone(row);
  }

  async readPackRecordPage(
    buildId: string,
    packId: string,
    afterRecordId: string | null,
    limit: number,
    maxBytes: number,
  ) {
    requirePackKey(buildId, packId, this.#expected);
    requirePageBounds(afterRecordId, limit, maxBytes);
    const rows: Array<{ binding: Uint8Array; prepared: Uint8Array }> = [];
    let serializedBytes = 0;
    let cursor = afterRecordId;
    while (rows.length < limit) {
      const binding = await this.#nextBinding(buildId, packId, cursor);
      if (binding === undefined) break;
      requireBindingScope(binding, this.#expected);
      const prepared = await this.#database.encryptedWalletBackupPreparedRecords.get([
        buildId,
        binding.recordId,
      ]);
      if (prepared === undefined) throw new Error("backup pack binding has no prepared record");
      requirePreparedScope(prepared, this.#expected);
      if (prepared.recordId !== binding.recordId)
        throw new Error("backup pack binding prepared record identity is invalid");
      const serializedBinding = serializeEncryptedWalletBackupPackBinding(bindingRecord(binding));
      const serializedPrepared = serializeEncryptedWalletBackupPreparedBuildRecord(
        preparedRecord(prepared),
      );
      const nextBytes = serializedBinding.byteLength + serializedPrepared.byteLength;
      if (serializedBytes + nextBytes > maxBytes) break;
      rows.push({ binding: serializedBinding.slice(), prepared: serializedPrepared.slice() });
      serializedBytes += nextBytes;
      cursor = binding.recordId;
    }
    return { rows, serializedBytes };
  }

  async readStagedObject(
    buildId: string,
    packId: string,
  ): Promise<PersistedEncryptedWalletBackupStagedObject | null> {
    requirePackKey(buildId, packId, this.#expected);
    const row = await this.#database.encryptedWalletBackupStagedObjects.get([buildId, packId]);
    if (row === undefined) return null;
    requireStagedScope(row, this.#expected);
    return clone(row);
  }

  async insertPreparedRecord(
    row: PersistedEncryptedWalletBackupPreparedBuildRecord,
  ): Promise<void> {
    requirePreparedScope(row, this.#expected);
    const preparedRecordSerializedBytes =
      serializeEncryptedWalletBackupPreparedBuildRecord(row).byteLength;
    const persisted: EncryptedWalletBackupDexiePreparedRecordRow = {
      ...clone(row),
      preparedRecordSerializedBytes,
    };
    await this.#database.encryptedWalletBackupPreparedRecords.add(persisted);
    this.#preparedRecordSerializedBytes.set(
      preparedRecordKey(row.buildId, row.recordId),
      preparedRecordSerializedBytes,
    );
  }

  async insertPackBinding(row: PersistedEncryptedWalletBackupPackBinding): Promise<void> {
    requireBindingScope(row, this.#expected);
    void serializeEncryptedWalletBackupPackBinding(row);
    const preparedRecordSerializedBytes = this.#preparedRecordSerializedBytes.get(
      preparedRecordKey(row.buildId, row.recordId),
    );
    if (preparedRecordSerializedBytes === undefined)
      throw new Error("backup pack binding has no prepared record size");
    const persisted: EncryptedWalletBackupDexiePackBindingRow = {
      ...clone(row),
      preparedRecordSerializedBytes,
    };
    await this.#database.encryptedWalletBackupPackBindings.add(persisted);
  }

  async writeBuildCursor(row: PersistedEncryptedWalletBackupBuildCursor): Promise<void> {
    requireExpectedBuild(row, this.#expected, false);
    void serializeEncryptedWalletBackupBuildCursor(row);
    await this.#database.encryptedWalletBackupBuildCursors.put(clone(row));
  }

  async writePackControl(row: PersistedEncryptedWalletBackupPackControl): Promise<void> {
    requireExpectedPack(row, this.#expected, false);
    void serializeEncryptedWalletBackupPackControl(row);
    await this.#database.encryptedWalletBackupPackControls.put(clone(row));
  }

  async insertStagedObject(row: PersistedEncryptedWalletBackupStagedObject): Promise<void> {
    requireStagedScope(row, this.#expected);
    void serializeEncryptedWalletBackupStagedObject(row);
    await this.#database.encryptedWalletBackupStagedObjects.add(clone(row));
  }

  #nextBinding(buildId: string, packId: string, afterRecordId: string | null) {
    const bindings = this.#database.encryptedWalletBackupPackBindings;
    if (afterRecordId === null) {
      return bindings
        .where("[buildId+packId+recordId]")
        .between([buildId, packId, Dexie.minKey], [buildId, packId, Dexie.maxKey])
        .first();
    }
    return bindings
      .where("[buildId+packId+recordId]")
      .between([buildId, packId, afterRecordId], [buildId, packId, Dexie.maxKey], false, true)
      .first();
  }
}

function preparedRecordKey(buildId: string, recordId: string): string {
  return `${buildId.length}:${buildId}${recordId.length}:${recordId}`;
}

function preparedRecord(
  row: EncryptedWalletBackupDexiePreparedRecordRow,
): PersistedEncryptedWalletBackupPreparedBuildRecord {
  const { preparedRecordSerializedBytes: _preparedRecordSerializedBytes, ...record } = row;
  return record;
}

function bindingRecord(
  row: EncryptedWalletBackupDexiePackBindingRow,
): PersistedEncryptedWalletBackupPackBinding {
  const { preparedRecordSerializedBytes: _preparedRecordSerializedBytes, ...record } = row;
  return record;
}

function requireExpectedBuild(
  row: PersistedEncryptedWalletBackupBuildCursor | undefined,
  expected: ExactVersionExpectation,
  requireVersion = true,
): void {
  if (row === undefined) {
    if (expected.buildVersion !== 0) throw new Error("backup build version is stale");
    return;
  }
  if (
    row.buildId !== expected.buildId ||
    row.realm !== expected.realm ||
    row.vaultId !== expected.vaultId ||
    row.snapshotId !== expected.snapshotId ||
    row.snapshotRevision !== expected.snapshotRevision ||
    (requireVersion && row.version !== expected.buildVersion)
  ) {
    throw new Error("backup build control conflicts with the expected version");
  }
  void serializeEncryptedWalletBackupBuildCursor(row);
}

function requireExpectedPack(
  row: PersistedEncryptedWalletBackupPackControl | undefined,
  expected: ExactVersionExpectation,
  requireVersion = true,
): void {
  if (row === undefined) {
    if (expected.packVersion !== 0) throw new Error("backup pack version is stale");
    return;
  }
  if (
    row.buildId !== expected.buildId ||
    row.packId !== expected.packId ||
    row.realm !== expected.realm ||
    row.vaultId !== expected.vaultId ||
    row.snapshotId !== expected.snapshotId ||
    row.snapshotRevision !== expected.snapshotRevision ||
    (requireVersion && row.version !== expected.packVersion)
  ) {
    throw new Error("backup pack control conflicts with the expected version");
  }
  void serializeEncryptedWalletBackupPackControl(row);
}

function requireBuildId(buildId: string, expected: ExactVersionExpectation): void {
  if (buildId !== expected.buildId)
    throw new Error("backup build id is outside the transaction scope");
}

function requirePackKey(buildId: string, packId: string, expected: ExactVersionExpectation): void {
  requireBuildId(buildId, expected);
  if (packId !== expected.packId)
    throw new Error("backup pack id is outside the transaction scope");
}

function requireBindingScope(
  row: PersistedEncryptedWalletBackupPackBinding,
  expected: ExactVersionExpectation,
): void {
  requirePackKey(row.buildId, row.packId, expected);
  requireScope(row, expected);
}

function requirePreparedScope(
  row: PersistedEncryptedWalletBackupPreparedBuildRecord,
  expected: ExactVersionExpectation,
): void {
  requireBuildId(row.buildId, expected);
  requireScope(row, expected);
  if (
    row.prepared.realm !== expected.realm ||
    row.prepared.vaultId !== expected.vaultId ||
    row.prepared.snapshotId !== expected.snapshotId ||
    row.prepared.snapshotRevision !== expected.snapshotRevision ||
    row.prepared.recordId !== row.recordId
  ) {
    throw new Error("backup prepared record scope is invalid");
  }
}

function requireStagedScope(
  row: PersistedEncryptedWalletBackupStagedObject,
  expected: ExactVersionExpectation,
): void {
  requirePackKey(row.buildId, row.packId, expected);
  requireScope(row, expected);
}

function requireScope(
  row: { realm: string; vaultId: string; snapshotId: string; snapshotRevision: number },
  expected: ExactVersionExpectation,
): void {
  if (
    row.realm !== expected.realm ||
    row.vaultId !== expected.vaultId ||
    row.snapshotId !== expected.snapshotId ||
    row.snapshotRevision !== expected.snapshotRevision
  ) {
    throw new Error("backup row scope is outside the transaction scope");
  }
}

function requirePageBounds(afterRecordId: string | null, limit: number, maxBytes: number): void {
  if (
    (afterRecordId !== null && typeof afterRecordId !== "string") ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  ) {
    throw new Error("backup pack page bounds are invalid");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
