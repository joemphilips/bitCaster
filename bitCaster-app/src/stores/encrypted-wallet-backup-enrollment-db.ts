import Dexie from "dexie";
import type {
  EncryptedWalletBackupAccountOperationResultRecord,
  EncryptedWalletBackupAccountOperationResultStore,
} from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { BitcasterDB, EncryptedWalletBackupDexieEnrollmentResultRow } from "./proof-db";

export interface EncryptedWalletBackupEnrollmentDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly walletId: string;
  readonly requestAuthPublicKey: string;
  /** Runs in the write transaction before an enrollment result is stored. */
  readonly beforeCommit?: () => void;
}

/** Stores the one latest server-authenticated enrollment lifecycle receipt. */
export class EncryptedWalletBackupEnrollmentDexieStore implements EncryptedWalletBackupAccountOperationResultStore {
  readonly #database: BitcasterDB;
  readonly #realm: string;
  readonly #walletId: string;
  readonly #requestAuthPublicKey: string;
  readonly #beforeCommit: (() => void) | undefined;

  constructor(profile: EncryptedWalletBackupEnrollmentDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#realm = profile.realm;
    this.#walletId = profile.walletId;
    this.#requestAuthPublicKey = profile.requestAuthPublicKey;
    this.#beforeCommit = profile.beforeCommit;
  }

  async read(): Promise<EncryptedWalletBackupAccountOperationResultRecord | null> {
    const row = await this.#database.encryptedWalletBackupEnrollmentResults.get([
      this.#realm,
      this.#walletId,
    ]);
    return row === undefined
      ? null
      : decodeRow(row, this.#realm, this.#walletId, this.#requestAuthPublicKey);
  }

  async commitAccountOperationResult<T>(
    result: EncryptedWalletBackupAccountOperationResultRecord,
    commit: (stored: EncryptedWalletBackupAccountOperationResultRecord) => T,
  ): Promise<T> {
    const record = requireRecord(result, this.#realm, this.#walletId, this.#requestAuthPublicKey);
    if (typeof commit !== "function") throw new Error("backup enrollment callback is invalid");
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupEnrollmentResults,
      async () => {
        const current = await this.#database.encryptedWalletBackupEnrollmentResults.get([
          this.#realm,
          this.#walletId,
        ]);
        if (current !== undefined)
          requireReplacement(
            decodeRow(current, this.#realm, this.#walletId, this.#requestAuthPublicKey),
            record,
          );
        this.#beforeCommit?.();
        const row: EncryptedWalletBackupDexieEnrollmentResultRow = {
          realm: this.#realm,
          walletId: this.#walletId,
          record: structuredClone(record),
        };
        await this.#database.encryptedWalletBackupEnrollmentResults.put(row);
        this.#beforeCommit?.();
        return commit(structuredClone(record));
      },
    );
  }
}

function requireReplacement(
  current: EncryptedWalletBackupAccountOperationResultRecord,
  next: EncryptedWalletBackupAccountOperationResultRecord,
): void {
  if (next.observedEnrollmentEpoch < current.observedEnrollmentEpoch) {
    throw new Error("encrypted wallet backup enrollment epoch is stale");
  }
  if (
    next.observedEnrollmentEpoch === current.observedEnrollmentEpoch &&
    !sameRecord(current, next)
  ) {
    throw new Error("encrypted wallet backup enrollment receipt conflicts");
  }
}

function sameRecord(
  left: EncryptedWalletBackupAccountOperationResultRecord,
  right: EncryptedWalletBackupAccountOperationResultRecord,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.intentDigest === right.intentDigest &&
    left.action === right.action &&
    left.realm === right.realm &&
    left.walletId === right.walletId &&
    left.requestAuthPublicKey === right.requestAuthPublicKey &&
    left.expectedEnrollmentEpoch === right.expectedEnrollmentEpoch &&
    left.observedEnrollmentEpoch === right.observedEnrollmentEpoch &&
    left.lifecycle === right.lifecycle &&
    left.result === right.result
  );
}

function requireProfile(profile: EncryptedWalletBackupEnrollmentDatabaseProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(profile.realm) ||
    !/^[0-9a-f]{64}$/.test(profile.walletId) ||
    !isHex(profile.requestAuthPublicKey, 32) ||
    (profile.beforeCommit !== undefined && typeof profile.beforeCommit !== "function") ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId)
  ) {
    throw new Error("encrypted wallet backup enrollment profile is invalid");
  }
}

function decodeRow(
  row: EncryptedWalletBackupDexieEnrollmentResultRow,
  realm: string,
  walletId: string,
  requestAuthPublicKey: string,
): EncryptedWalletBackupAccountOperationResultRecord {
  if (
    typeof row !== "object" ||
    row === null ||
    Object.keys(row).length !== 3 ||
    row.realm !== realm ||
    row.walletId !== walletId
  ) {
    throw new Error("encrypted wallet backup enrollment row is invalid");
  }
  return requireRecord(row.record, realm, walletId, requestAuthPublicKey);
}

function requireRecord(
  value: unknown,
  realm: string,
  walletId: string,
  requestAuthPublicKey: string,
): EncryptedWalletBackupAccountOperationResultRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("encrypted wallet backup enrollment result is invalid");
  }
  const row = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "operationId",
    "intentDigest",
    "action",
    "realm",
    "walletId",
    "requestAuthPublicKey",
    "expectedEnrollmentEpoch",
    "observedEnrollmentEpoch",
    "lifecycle",
    "result",
  ];
  if (Object.keys(row).length !== fields.length || fields.some((field) => !(field in row))) {
    throw new Error("encrypted wallet backup enrollment result is invalid");
  }
  if (
    row.schemaVersion !== 1 ||
    row.realm !== realm ||
    row.walletId !== walletId ||
    !isHex(row.operationId, 16) ||
    !isHex(row.intentDigest, 32) ||
    row.requestAuthPublicKey !== requestAuthPublicKey ||
    row.action !== "enroll" ||
    row.lifecycle !== "active" ||
    (row.result !== "committed" && row.result !== "conflict") ||
    !isEpoch(row.expectedEnrollmentEpoch, 0) ||
    !isEpoch(row.observedEnrollmentEpoch, 1)
  ) {
    throw new Error("encrypted wallet backup enrollment result is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId: row.operationId,
    intentDigest: row.intentDigest,
    action: "enroll",
    realm,
    walletId,
    requestAuthPublicKey,
    expectedEnrollmentEpoch: row.expectedEnrollmentEpoch,
    observedEnrollmentEpoch: row.observedEnrollmentEpoch,
    lifecycle: "active",
    result: row.result,
  });
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

function isEpoch(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
