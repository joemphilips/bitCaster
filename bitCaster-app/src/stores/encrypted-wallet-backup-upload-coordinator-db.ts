import Dexie from "dexie";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import {
  createEncryptedWalletBackupCoordinatorStore,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  measureEncryptedWalletBackupCoordinatorPersistenceRowBytes,
  measureEncryptedWalletBackupUploadBatchRecordBytes,
  type EncryptedWalletBackupActiveUploadAttemptRecord,
  type EncryptedWalletBackupCoordinatorStore,
  type EncryptedWalletBackupUploadAttemptCursorStore,
  type EncryptedWalletBackupUploadBatchRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import type {
  EncryptedWalletBackupCoordinatorPersistencePort,
  EncryptedWalletBackupCoordinatorPersistenceReservation,
  EncryptedWalletBackupCoordinatorPersistenceTransaction,
} from "@bitcaster/client-sdk";
import type { EncryptedWalletBackupSyncAttemptRecord } from "@bitcaster/client-sdk/encryptedWalletBackup";
import type {
  BitcasterDB,
  EncryptedWalletBackupDexieUploadAttemptRow,
  EncryptedWalletBackupDexieUploadBatchRow,
  EncryptedWalletBackupDexieUploadCasAttemptRow,
  EncryptedWalletBackupDexieUploadCursorRow,
} from "./proof-db";

/** Dexie-only mechanics for the SDK-owned upload coordinator. */
export class EncryptedWalletBackupUploadCoordinatorDexiePort implements EncryptedWalletBackupCoordinatorPersistencePort {
  readonly #database: BitcasterDB;

  constructor(database: BitcasterDB) {
    if (!(database instanceof Dexie))
      throw new Error("backup upload coordinator database is invalid");
    this.#database = database;
  }

  async transaction<T>(
    reservation: EncryptedWalletBackupCoordinatorPersistenceReservation,
    operation: (transaction: EncryptedWalletBackupCoordinatorPersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    requireReservation(reservation);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupUploadAttempts,
      this.#database.encryptedWalletBackupUploadCursors,
      this.#database.encryptedWalletBackupUploadBatches,
      this.#database.encryptedWalletBackupUploadCasAttempts,
      async () => {
        const transaction = new UploadCoordinatorTransaction(this.#database, reservation);
        const result = await operation(transaction);
        transaction.finish();
        return result;
      },
    );
  }
}

/** Builds the SDK coordinator over the Dexie-only raw persistence port. */
export function createEncryptedWalletBackupUploadCoordinatorDexieStore(
  database: BitcasterDB,
): EncryptedWalletBackupUploadAttemptCursorStore & EncryptedWalletBackupCoordinatorStore {
  return createEncryptedWalletBackupCoordinatorStore(
    new EncryptedWalletBackupUploadCoordinatorDexiePort(database),
  );
}

class UploadCoordinatorTransaction implements EncryptedWalletBackupCoordinatorPersistenceTransaction {
  readonly nowUnixMilliseconds = Date.now();
  readonly #database: BitcasterDB;
  readonly #ledger: ReservationLedger;
  readonly #attemptRows = new Map<string, EncryptedWalletBackupDexieUploadAttemptRow | null>();
  readonly #cursorRows = new Map<string, EncryptedWalletBackupDexieUploadCursorRow | null>();
  readonly #batchRows = new Map<string, EncryptedWalletBackupDexieUploadBatchRow | null>();
  readonly #casAttemptRows = new Map<
    string,
    EncryptedWalletBackupDexieUploadCasAttemptRow | null
  >();
  readonly #attemptScopes = new Set<string>();
  readonly #batchPartitions = new Set<string>();
  readonly #casAttemptPartitions = new Set<string>();

  constructor(
    database: BitcasterDB,
    reservation: EncryptedWalletBackupCoordinatorPersistenceReservation,
  ) {
    this.#database = database;
    this.#ledger = new ReservationLedger(reservation);
  }

  async readAttempt(attemptId: string): Promise<unknown | null> {
    const row = await this.#attemptRow(attemptId);
    return row === null ? null : cloneValue(row.record);
  }

  async readAttemptsForScope(
    input: Readonly<{ realm: string; vaultId: string; maximumRows: 2 }>,
  ): Promise<readonly unknown[]> {
    requireLimit(input.maximumRows, 2, "backup upload attempt scope read");
    const scope = attemptScope(input.realm, input.vaultId);
    if (!this.#attemptScopes.has(scope)) {
      await this.#database.encryptedWalletBackupUploadAttempts
        .where("[realm+vaultId]")
        .equals([input.realm, input.vaultId])
        .limit(input.maximumRows)
        .each((row) => {
          if (
            row.realm !== input.realm ||
            row.vaultId !== input.vaultId ||
            row.record.attemptId !== row.attemptId
          ) {
            throw new Error("backup upload attempt scope row is invalid");
          }
          this.#cacheRead(this.#attemptRows, row.attemptId, row);
        });
      this.#attemptScopes.add(scope);
    }
    return [...this.#attemptRows.values()]
      .filter(
        (row): row is EncryptedWalletBackupDexieUploadAttemptRow =>
          row !== null && row.realm === input.realm && row.vaultId === input.vaultId,
      )
      .slice(0, input.maximumRows)
      .map((row) => cloneValue(row.record));
  }

  async readCursor(attemptId: string): Promise<Uint8Array | null> {
    const row = await this.#cursorRow(attemptId);
    return row === null ? null : row.canonicalCursor.slice();
  }

  async readBatch(batchId: string): Promise<unknown | null> {
    const row = await this.#batchRowFor(batchId);
    return row === null ? null : this.#hydrateBatch(row);
  }

  async readBatchesForAttempt(
    input: Readonly<{ attemptId: string; maximumRows: 64 }>,
  ): Promise<readonly unknown[]> {
    requireLimit(input.maximumRows, 64, "backup upload batch partition read");
    const attempt = await this.#attemptFor(input.attemptId);
    if (!this.#batchPartitions.has(input.attemptId)) {
      await this.#database.encryptedWalletBackupUploadBatches
        .where("attemptId")
        .equals(input.attemptId)
        .limit(input.maximumRows)
        .each((row) => {
          if (row.attemptId !== input.attemptId || row.record.attemptId !== row.attemptId)
            throw new Error("backup upload batch partition row is invalid");
          this.#cacheRead(this.#batchRows, row.batchId, row);
        });
      this.#batchPartitions.add(input.attemptId);
    }
    return Object.freeze(
      [...this.#batchRows.values()]
        .filter(
          (row): row is EncryptedWalletBackupDexieUploadBatchRow =>
            row !== null && row.attemptId === input.attemptId,
        )
        .slice(0, input.maximumRows)
        .map((row) => this.#hydrateBatchWithAttempt(row, attempt)),
    );
  }

  async readCasAttempt(attemptId: string): Promise<unknown | null> {
    const row = await this.#casAttemptRow(attemptId);
    return row === null ? null : cloneValue(row.record);
  }

  async readCasAttemptsForUploadAttempt(
    input: Readonly<{ uploadAttemptId: string; maximumRows: 2 }>,
  ): Promise<readonly unknown[]> {
    requireLimit(input.maximumRows, 2, "backup upload linked CAS read");
    if (!this.#casAttemptPartitions.has(input.uploadAttemptId)) {
      await this.#database.encryptedWalletBackupUploadCasAttempts
        .where("uploadAttemptId")
        .equals(input.uploadAttemptId)
        .limit(input.maximumRows)
        .each((row) => {
          if (
            row.uploadAttemptId !== input.uploadAttemptId ||
            row.record.uploadAttemptId !== row.uploadAttemptId
          )
            throw new Error("backup upload CAS partition row is invalid");
          this.#cacheRead(this.#casAttemptRows, row.attemptId, row);
        });
      this.#casAttemptPartitions.add(input.uploadAttemptId);
    }
    return [...this.#casAttemptRows.values()]
      .filter(
        (row): row is EncryptedWalletBackupDexieUploadCasAttemptRow =>
          row !== null && row.uploadAttemptId === input.uploadAttemptId,
      )
      .slice(0, input.maximumRows)
      .map((row) => cloneValue(row.record));
  }

  async insertAttempt(record: EncryptedWalletBackupActiveUploadAttemptRecord): Promise<void> {
    const row = attemptRow(record);
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadAttempts.add(row);
    this.#attemptRows.set(row.attemptId, cloneValue(row));
  }

  async replaceAttempt(
    expected: EncryptedWalletBackupActiveUploadAttemptRecord,
    next: EncryptedWalletBackupActiveUploadAttemptRecord,
  ): Promise<void> {
    const current = await this.#attemptRow(expected.attemptId);
    if (current === null || !sameValue(current.record, expected))
      throw new Error("backup upload attempt is stale");
    const row = attemptRow(next);
    if (row.attemptId !== expected.attemptId)
      throw new Error("backup upload attempt identity changed");
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadAttempts.put(row);
    this.#attemptRows.set(row.attemptId, cloneValue(row));
  }

  async deleteAttempt(expected: EncryptedWalletBackupActiveUploadAttemptRecord): Promise<void> {
    const current = await this.#attemptRow(expected.attemptId);
    if (current === null || !sameValue(current.record, expected))
      throw new Error("backup upload attempt is stale");
    this.#ledger.write(current);
    await this.#database.encryptedWalletBackupUploadAttempts.delete(expected.attemptId);
    this.#attemptRows.set(expected.attemptId, null);
  }

  async insertCursor(
    input: Readonly<{ attemptId: string; canonicalCursor: Uint8Array }>,
  ): Promise<void> {
    const row = cursorRow(input);
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadCursors.add(row);
    this.#cursorRows.set(row.attemptId, cloneValue(row));
  }

  async replaceCursor(
    input: Readonly<{
      attemptId: string;
      expectedCanonicalCursor: Uint8Array;
      nextCanonicalCursor: Uint8Array;
    }>,
  ): Promise<void> {
    const current = await this.#cursorRow(input.attemptId);
    if (current === null || !sameBytes(current.canonicalCursor, input.expectedCanonicalCursor))
      throw new Error("backup upload cursor is stale");
    const row = cursorRow({
      attemptId: input.attemptId,
      canonicalCursor: input.nextCanonicalCursor,
    });
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadCursors.put(row);
    this.#cursorRows.set(row.attemptId, cloneValue(row));
  }

  async deleteCursor(
    input: Readonly<{ attemptId: string; expectedCanonicalCursor: Uint8Array }>,
  ): Promise<void> {
    const current = await this.#cursorRow(input.attemptId);
    if (current === null || !sameBytes(current.canonicalCursor, input.expectedCanonicalCursor))
      throw new Error("backup upload cursor is stale");
    this.#ledger.write(current);
    await this.#database.encryptedWalletBackupUploadCursors.delete(input.attemptId);
    this.#cursorRows.set(input.attemptId, null);
  }

  async insertBatch(record: EncryptedWalletBackupUploadBatchRecord): Promise<void> {
    const row = await this.#batchRow(record);
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadBatches.add(row);
    this.#batchRows.set(row.batchId, cloneValue(row));
  }

  async replaceBatch(
    expected: EncryptedWalletBackupUploadBatchRecord,
    next: EncryptedWalletBackupUploadBatchRecord,
  ): Promise<void> {
    const current = await this.#batchRowFor(expected.batchId);
    if (current === null || !sameValue(await this.#hydrateBatch(current), expected))
      throw new Error("backup upload batch is stale");
    const row = await this.#batchRow(next);
    if (row.batchId !== expected.batchId) throw new Error("backup upload batch identity changed");
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadBatches.put(row);
    this.#batchRows.set(row.batchId, cloneValue(row));
  }

  async deleteBatch(expected: EncryptedWalletBackupUploadBatchRecord): Promise<void> {
    const current = await this.#batchRowFor(expected.batchId);
    if (current === null || !sameValue(await this.#hydrateBatch(current), expected))
      throw new Error("backup upload batch is stale");
    this.#ledger.write(current);
    await this.#database.encryptedWalletBackupUploadBatches.delete(expected.batchId);
    this.#batchRows.set(expected.batchId, null);
  }

  async insertCasAttempt(record: EncryptedWalletBackupSyncAttemptRecord): Promise<void> {
    const row = casAttemptRow(record);
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadCasAttempts.add(row);
    this.#casAttemptRows.set(row.attemptId, cloneValue(row));
  }

  async replaceCasAttempt(
    expected: EncryptedWalletBackupSyncAttemptRecord,
    next: EncryptedWalletBackupSyncAttemptRecord,
  ): Promise<void> {
    const current = await this.#casAttemptRow(expected.attemptId);
    if (current === null || !sameValue(current.record, expected))
      throw new Error("backup upload CAS attempt is stale");
    const row = casAttemptRow(next);
    if (row.attemptId !== expected.attemptId)
      throw new Error("backup upload CAS attempt identity changed");
    this.#ledger.write(row);
    await this.#database.encryptedWalletBackupUploadCasAttempts.put(row);
    this.#casAttemptRows.set(row.attemptId, cloneValue(row));
  }

  async deleteCasAttempt(expected: EncryptedWalletBackupSyncAttemptRecord): Promise<void> {
    const current = await this.#casAttemptRow(expected.attemptId);
    if (current === null || !sameValue(current.record, expected))
      throw new Error("backup upload CAS attempt is stale");
    this.#ledger.write(current);
    await this.#database.encryptedWalletBackupUploadCasAttempts.delete(expected.attemptId);
    this.#casAttemptRows.set(expected.attemptId, null);
  }

  finish(): void {
    this.#ledger.finish();
  }

  async #hydrateBatch(
    row: EncryptedWalletBackupDexieUploadBatchRow,
  ): Promise<EncryptedWalletBackupUploadBatchRecord> {
    const attempt = await this.#attemptFor(row.attemptId);
    return this.#hydrateBatchWithAttempt(row, attempt);
  }

  #hydrateBatchWithAttempt(
    row: EncryptedWalletBackupDexieUploadBatchRow,
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
  ): EncryptedWalletBackupUploadBatchRecord {
    if (row.authorityDigest !== batchAuthorityDigest(attempt))
      throw new Error("backup upload batch authority does not match its attempt");
    return {
      ...row.record,
      canonicalTargetHead: attempt.canonicalTargetHead,
      canonicalTargetReferenceSet: attempt.canonicalTargetReferenceSet,
      canonicalInheritedReferenceSet: attempt.canonicalInheritedReferenceSet,
    };
  }

  async #batchRow(
    record: EncryptedWalletBackupUploadBatchRecord,
  ): Promise<EncryptedWalletBackupDexieUploadBatchRow> {
    const attempt = await this.#attemptFor(record.attemptId);
    if (
      !sameBytes(record.canonicalTargetHead, attempt.canonicalTargetHead) ||
      !sameBytes(record.canonicalTargetReferenceSet, attempt.canonicalTargetReferenceSet) ||
      !sameBytes(record.canonicalInheritedReferenceSet, attempt.canonicalInheritedReferenceSet)
    ) {
      throw new Error("backup upload batch authority does not match its attempt");
    }
    if (
      measureEncryptedWalletBackupUploadBatchRecordBytes(record) >
      ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX
    ) {
      throw new Error("backup upload batch exceeds the persisted transaction byte limit");
    }
    const {
      canonicalTargetHead: _canonicalTargetHead,
      canonicalTargetReferenceSet: _canonicalTargetReferenceSet,
      canonicalInheritedReferenceSet: _canonicalInheritedReferenceSet,
      ...compact
    } = record;
    return {
      batchId: record.batchId,
      attemptId: record.attemptId,
      authorityDigest: batchAuthorityDigest(attempt),
      record: cloneValue(compact),
    };
  }

  async #attemptFor(attemptId: string): Promise<EncryptedWalletBackupActiveUploadAttemptRecord> {
    const row = await this.#attemptRow(attemptId);
    if (row === null) throw new Error("backup upload batch attempt is absent");
    return cloneValue(row.record);
  }

  async #attemptRow(attemptId: string): Promise<EncryptedWalletBackupDexieUploadAttemptRow | null> {
    if (this.#attemptRows.has(attemptId)) return cloneCached(this.#attemptRows.get(attemptId));
    const row = await this.#database.encryptedWalletBackupUploadAttempts.get(attemptId);
    return this.#cacheRead(this.#attemptRows, attemptId, row);
  }

  async #cursorRow(attemptId: string): Promise<EncryptedWalletBackupDexieUploadCursorRow | null> {
    if (this.#cursorRows.has(attemptId)) return cloneCached(this.#cursorRows.get(attemptId));
    const row = await this.#database.encryptedWalletBackupUploadCursors.get(attemptId);
    return this.#cacheRead(this.#cursorRows, attemptId, row);
  }

  async #batchRowFor(batchId: string): Promise<EncryptedWalletBackupDexieUploadBatchRow | null> {
    if (this.#batchRows.has(batchId)) return cloneCached(this.#batchRows.get(batchId));
    const row = await this.#database.encryptedWalletBackupUploadBatches.get(batchId);
    return this.#cacheRead(this.#batchRows, batchId, row);
  }

  async #casAttemptRow(
    attemptId: string,
  ): Promise<EncryptedWalletBackupDexieUploadCasAttemptRow | null> {
    if (this.#casAttemptRows.has(attemptId))
      return cloneCached(this.#casAttemptRows.get(attemptId));
    const row = await this.#database.encryptedWalletBackupUploadCasAttempts.get(attemptId);
    return this.#cacheRead(this.#casAttemptRows, attemptId, row);
  }

  #cacheRead<T>(cache: Map<string, T | null>, key: string, row: T | undefined): T | null {
    const cached = row === undefined ? null : cloneValue(row);
    cache.set(key, cached);
    if (cached !== null) this.#ledger.read(cached);
    return cloneCached(cached);
  }
}

class ReservationLedger {
  readonly #reservation: EncryptedWalletBackupCoordinatorPersistenceReservation;
  #readRows = 0;
  #readBytes = 0;
  #writeRows = 0;
  #writeBytes = 0;

  constructor(reservation: EncryptedWalletBackupCoordinatorPersistenceReservation) {
    this.#reservation = reservation;
  }

  read(value: unknown | undefined): void {
    if (value === undefined) return;
    this.#readRows += 1;
    this.#readBytes += measureEncryptedWalletBackupCoordinatorPersistenceRowBytes(value);
    this.#requireCapacity();
  }

  write(value: unknown): void {
    this.#writeRows += 1;
    this.#writeBytes += measureEncryptedWalletBackupCoordinatorPersistenceRowBytes(value);
    this.#requireCapacity();
  }

  finish(): void {
    this.#requireCapacity();
  }

  #requireCapacity(): void {
    if (
      this.#readRows > this.#reservation.readRows ||
      this.#readBytes > this.#reservation.readBytes ||
      this.#writeRows > this.#reservation.writeRows ||
      this.#writeBytes > this.#reservation.writeBytes
    ) {
      throw new Error("backup upload coordinator transaction exceeds its reservation");
    }
  }
}

function requireReservation(value: EncryptedWalletBackupCoordinatorPersistenceReservation): void {
  if (
    !isCapacity(value.readRows) ||
    !isCapacity(value.writeRows) ||
    !isCapacity(value.readBytes) ||
    !isCapacity(value.writeBytes)
  ) {
    throw new Error("backup upload coordinator reservation is invalid");
  }
}

function isCapacity(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireLimit(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label} limit is invalid`);
}

function attemptRow(
  record: EncryptedWalletBackupActiveUploadAttemptRecord,
): EncryptedWalletBackupDexieUploadAttemptRow {
  return {
    attemptId: record.attemptId,
    realm: record.realm,
    vaultId: record.vaultId,
    record: cloneValue(record),
  };
}

function cursorRow(
  input: Readonly<{ attemptId: string; canonicalCursor: Uint8Array }>,
): EncryptedWalletBackupDexieUploadCursorRow {
  if (!(input.canonicalCursor instanceof Uint8Array))
    throw new Error("backup upload cursor is invalid");
  return { attemptId: input.attemptId, canonicalCursor: input.canonicalCursor.slice() };
}

function casAttemptRow(
  record: EncryptedWalletBackupSyncAttemptRecord,
): EncryptedWalletBackupDexieUploadCasAttemptRow {
  return {
    attemptId: record.attemptId,
    uploadAttemptId: record.uploadAttemptId,
    record: cloneValue(record),
  };
}

function batchAuthorityDigest(attempt: EncryptedWalletBackupActiveUploadAttemptRecord): string {
  return bytesToHex(
    sha256(
      concatBytes(
        byteLengthPrefix(attempt.canonicalTargetHead),
        attempt.canonicalTargetHead,
        byteLengthPrefix(attempt.canonicalTargetReferenceSet),
        attempt.canonicalTargetReferenceSet,
        byteLengthPrefix(attempt.canonicalInheritedReferenceSet),
        attempt.canonicalInheritedReferenceSet,
      ),
    ),
  );
}

function byteLengthPrefix(value: Uint8Array): Uint8Array {
  const length = value.byteLength;
  return Uint8Array.of(length >>> 24, length >>> 16, length >>> 8, length);
}

function attemptScope(realm: string, vaultId: string): string {
  return `${realm.length}:${realm}${vaultId.length}:${vaultId}`;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneCached<T>(value: T | null | undefined): T | null {
  return value === null || value === undefined ? null : cloneValue(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) return sameBytes(left, right);
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameValue(value, right[key as keyof typeof right]),
    )
  );
}
