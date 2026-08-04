import Dexie from "dexie";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import {
  createEncryptedWalletBackupCoordinatorStore,
  decodeActiveUploadAttemptRecord,
  decodeUploadBatchRecord,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  measureEncryptedWalletBackupCoordinatorPersistenceRowBytes,
  measureEncryptedWalletBackupUploadBatchRecordBytes,
  type EncryptedWalletBackupActiveUploadAttemptRecord,
  type EncryptedWalletBackupCoordinatorStore,
  type EncryptedWalletBackupUploadAttemptCursorStore,
  type EncryptedWalletBackupUploadBatchRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import {
  ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  planEncryptedWalletBackupRetry,
} from "@bitcaster/client-sdk/encryptedWalletBackupRetrySchedule";
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
  EncryptedWalletBackupDexieRetrySchedulerRow,
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

/**
 * Reads one durable attempt without claiming or extending its lease.
 * The upload cycle remains the only operation that can claim this attempt.
 */
export async function findEncryptedWalletBackupUploadAttemptId(
  database: BitcasterDB,
  input: Readonly<{ realm: string; vaultId: string }>,
): Promise<string | null> {
  const attemptIds = await database.encryptedWalletBackupUploadAttempts
    .where("[realm+vaultId]")
    .equals([input.realm, input.vaultId])
    .limit(2)
    .primaryKeys();
  if (attemptIds.length > 1) throw new Error("backup upload attempt scope is invalid");
  if (attemptIds.length === 0) return null;
  const [attemptId] = attemptIds;
  if (typeof attemptId !== "string" || !/^[0-9a-f]{32}$/.test(attemptId)) {
    throw new Error("backup upload attempt scope key is invalid");
  }
  return attemptId;
}

export async function readEncryptedWalletBackupUploadAttemptSummary(
  database: BitcasterDB,
  input: Readonly<{ realm: string; vaultId: string; attemptId: string }>,
): Promise<
  Readonly<{
    ownerId: string;
    leaseExpiresAtUnixMilliseconds: number;
    executionLeaseExpiresAtUnixMilliseconds: number | null;
    lifecycle: EncryptedWalletBackupActiveUploadAttemptRecord["lifecycle"];
  }>
> {
  return database.transaction(
    "r",
    database.encryptedWalletBackupUploadAttempts,
    database.encryptedWalletBackupUploadBatches,
    async () => {
      const row = await database.encryptedWalletBackupUploadAttempts.get(input.attemptId);
      if (row === undefined || row.realm !== input.realm || row.vaultId !== input.vaultId) {
        throw new Error("backup upload attempt scope row is invalid");
      }
      const record = decodeActiveUploadAttemptRecord(row.record);
      if (
        record.realm !== input.realm ||
        record.vaultId !== input.vaultId ||
        record.attemptId !== input.attemptId
      ) {
        throw new Error("backup upload attempt scope row is invalid");
      }
      let executionLeaseExpiresAtUnixMilliseconds: number | null = null;
      if (record.activeBatchId !== null) {
        const batchRow = await database.encryptedWalletBackupUploadBatches.get(
          record.activeBatchId,
        );
        if (batchRow === undefined) throw new Error("backup upload active batch is absent");
        if (batchRow.authorityDigest !== batchAuthorityDigest(record)) {
          throw new Error("backup upload active batch authority is invalid");
        }
        const batch = decodeUploadBatchRecord({
          ...batchRow.record,
          canonicalTargetHead: record.canonicalTargetHead,
          canonicalTargetReferenceSet: record.canonicalTargetReferenceSet,
          canonicalInheritedReferenceSet: record.canonicalInheritedReferenceSet,
        });
        if (batch.batchId !== record.activeBatchId || batch.attemptId !== record.attemptId) {
          throw new Error("backup upload active batch scope is invalid");
        }
        executionLeaseExpiresAtUnixMilliseconds = batch.executionLeaseExpiresAtUnixMilliseconds;
      }
      return Object.freeze({
        ownerId: record.ownerId,
        leaseExpiresAtUnixMilliseconds: record.leaseExpiresAtUnixMilliseconds,
        executionLeaseExpiresAtUnixMilliseconds,
        lifecycle: record.lifecycle,
      });
    },
  );
}

export async function readEncryptedWalletBackupRetryScheduler(
  database: BitcasterDB,
  input: Readonly<{ scopeId: string; realm: string; vaultId: string }>,
): Promise<EncryptedWalletBackupDexieRetrySchedulerRow | null> {
  const row = await database.encryptedWalletBackupRetrySchedulers.get([
    input.scopeId,
    input.realm,
    input.vaultId,
  ]);
  if (row === undefined) return null;
  return validateRetrySchedulerRow(row, input);
}

export async function clearEncryptedWalletBackupRetryScheduler(
  database: BitcasterDB,
  input: Readonly<{ scopeId: string; realm: string; vaultId: string; attemptId: string }>,
): Promise<void> {
  validateRetrySchedulerIdentity(input);
  await database.transaction("rw", database.encryptedWalletBackupRetrySchedulers, async () => {
    const current = await database.encryptedWalletBackupRetrySchedulers.get([
      input.scopeId,
      input.realm,
      input.vaultId,
    ]);
    if (current?.attemptId === input.attemptId) {
      await database.encryptedWalletBackupRetrySchedulers.delete([
        input.scopeId,
        input.realm,
        input.vaultId,
      ]);
    }
  });
}

export async function scheduleEncryptedWalletBackupRetry(
  database: BitcasterDB,
  input: Readonly<{
    scopeId: string;
    realm: string;
    vaultId: string;
    attemptId: string;
    minimumDelayMilliseconds: number;
  }>,
): Promise<EncryptedWalletBackupDexieRetrySchedulerRow> {
  validateRetrySchedulerIdentity(input);
  if (!/^[0-9a-f]{32}$/.test(input.attemptId)) {
    throw new Error("encrypted wallet backup retry scheduler attempt is invalid");
  }
  return database.transaction("rw", database.encryptedWalletBackupRetrySchedulers, async () => {
    const current = await database.encryptedWalletBackupRetrySchedulers.get([
      input.scopeId,
      input.realm,
      input.vaultId,
    ]);
    const now = Date.now();
    const prior =
      current?.attemptId === input.attemptId ? validateRetrySchedulerRow(current, input) : null;
    if (prior !== null && prior.retryNotBeforeUnixMilliseconds > now) return prior;
    const schedule = planEncryptedWalletBackupRetry({
      realm: input.realm,
      vaultId: input.vaultId,
      attemptId: input.attemptId,
      currentStreak: prior?.retryStreak ?? 0,
      minimumDelayMilliseconds: Math.max(
        input.minimumDelayMilliseconds,
        prior === null ? 1 : Math.max(1, prior.retryNotBeforeUnixMilliseconds - now),
      ),
    });
    const row = validateRetrySchedulerRow(
      {
        scopeId: input.scopeId,
        realm: input.realm,
        vaultId: input.vaultId,
        attemptId: input.attemptId,
        retryStreak: schedule.streak,
        retryNotBeforeUnixMilliseconds: Math.max(
          now + schedule.delayMilliseconds,
          prior?.retryNotBeforeUnixMilliseconds ?? 0,
        ),
      },
      input,
    );
    await database.encryptedWalletBackupRetrySchedulers.put(row);
    return row;
  });
}

function validateRetrySchedulerRow(
  row: EncryptedWalletBackupDexieRetrySchedulerRow,
  identity: Readonly<{ scopeId: string; realm: string; vaultId: string }>,
): EncryptedWalletBackupDexieRetrySchedulerRow {
  if (
    typeof row !== "object" ||
    row === null ||
    Object.keys(row).length !== 6 ||
    Object.keys(row).some(
      (key) =>
        key !== "scopeId" &&
        key !== "realm" &&
        key !== "vaultId" &&
        key !== "attemptId" &&
        key !== "retryStreak" &&
        key !== "retryNotBeforeUnixMilliseconds",
    )
  ) {
    throw new Error("encrypted wallet backup retry scheduler row is invalid");
  }
  validateRetrySchedulerIdentity(row);
  if (
    row.scopeId !== identity.scopeId ||
    row.realm !== identity.realm ||
    row.vaultId !== identity.vaultId ||
    !/^[0-9a-f]{32}$/.test(row.attemptId) ||
    !Number.isSafeInteger(row.retryStreak) ||
    row.retryStreak < 0 ||
    row.retryStreak > ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX ||
    !Number.isSafeInteger(row.retryNotBeforeUnixMilliseconds) ||
    row.retryNotBeforeUnixMilliseconds < 0
  ) {
    throw new Error("encrypted wallet backup retry scheduler row is invalid");
  }
  return Object.freeze({ ...row });
}

function validateRetrySchedulerIdentity(
  input: Readonly<{
    scopeId: string;
    realm: string;
    vaultId: string;
  }>,
): void {
  if (
    !/^[^\s]{1,128}$/.test(input.scopeId) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(input.realm) ||
    !/^[0-9a-f]{64}$/.test(input.vaultId)
  ) {
    throw new Error("encrypted wallet backup retry scheduler identity is invalid");
  }
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
