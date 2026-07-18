import { deriveDurableCustodyWalletId } from "./durableCustody.ts";
import { decode } from "cborg";
import {
  ENCRYPTED_WALLET_BACKUP_DATA_CBOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
  type EncryptedWalletBackupKeyHandle,
} from "./encryptedWalletBackup.ts";
import { encodeCanonicalBackupCbor as encodeCanonical } from "./encryptedWalletBackupCbor.ts";
import {
  requireEncryptedWalletBackupKeyWalletId,
  requireIssuedEncryptedWalletBackupKeyHandle,
  signEncryptedWalletBackupPreparationCapability,
  verifyEncryptedWalletBackupPreparationCapability,
} from "./encryptedWalletBackupKeyAuthority.ts";
import { validatePreparedEncryptedWalletBackupRecord } from "./encryptedWalletBackupPreparedRecordValidation.ts";
import {
  issuePreparedEncryptedWalletBackupRecord,
  requirePreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupRecordKindCode,
  type PreparedEncryptedWalletBackupRecord,
} from "./encryptedWalletBackupRecord.ts";

export interface PersistedPreparedEncryptedWalletBackupRecord {
  readonly schemaVersion: 1;
  readonly realm: string;
  readonly vaultId: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
  readonly canonicalRecord: Uint8Array;
  readonly canonicalManifestEntry: Uint8Array;
  readonly authenticationTag: Uint8Array;
}

export interface EncryptedWalletBackupPreparedRecordSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
}

export interface EncryptedWalletBackupPreparedRecordSnapshotStore {
  withCommittedPreparedRecordSnapshot<T>(
    recordId: string,
    read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
  ): Promise<T>;
}

export async function sealPreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly seed: Uint8Array;
  readonly record: PreparedEncryptedWalletBackupRecord;
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore;
}): Promise<PersistedPreparedEncryptedWalletBackupRecord> {
  const keyHandle = requireMatchingKeyHandle(input.keyHandle, input.seed);
  const authority = requirePreparedEncryptedWalletBackupRecord(input.record);
  if (authority.keyHandle !== keyHandle)
    throw new Error("prepared backup record belongs to a foreign key");
  const candidate = candidateFromAuthority(keyHandle, authority);
  validateCandidate(candidate, input.seed);
  await requireCommittedSnapshot(input.snapshotStore, snapshotOf(candidate));
  const authenticationTag =
    await signEncryptedWalletBackupPreparationCapability(
      keyHandle,
      capabilityPayload(candidate),
    );
  return Object.freeze({ ...candidate, authenticationTag });
}

export async function rehydratePreparedEncryptedWalletBackupRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly seed: Uint8Array;
  readonly persisted: PersistedPreparedEncryptedWalletBackupRecord;
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore;
}): Promise<PreparedEncryptedWalletBackupRecord> {
  const keyHandle = requireMatchingKeyHandle(input.keyHandle, input.seed);
  const persisted = requirePersistedRecord(input.persisted);
  requireKeyBinding(keyHandle, persisted);
  await verifyEncryptedWalletBackupPreparationCapability(
    keyHandle,
    capabilityPayload(persisted),
    persisted.authenticationTag,
  );
  validateCandidate(persisted, input.seed);
  await requireCommittedSnapshot(input.snapshotStore, snapshotOf(persisted));
  return issueRehydratedRecord(keyHandle, persisted);
}

type CapabilityCandidate = Omit<
  PersistedPreparedEncryptedWalletBackupRecord,
  "authenticationTag"
>;

function candidateFromAuthority(
  keyHandle: EncryptedWalletBackupKeyHandle,
  authority: ReturnType<typeof requirePreparedEncryptedWalletBackupRecord>,
): CapabilityCandidate {
  return Object.freeze({
    schemaVersion: 1,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    snapshotId: requireText(authority.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireInteger(
      authority.snapshotRevision,
      "snapshot revision",
    ),
    recordId: requireFingerprint(authority.recordId, "record id"),
    commitment: requireFingerprint(authority.commitment, "record commitment"),
    recordKindCode: requireRecordKind(authority.recordKindCode),
    canonicalRecord: authority.canonicalRecord.slice(),
    canonicalManifestEntry: encodeCanonical(authority.manifestEntry),
  });
}

function validateCandidate(
  candidate: CapabilityCandidate,
  seed: Uint8Array,
): void {
  const validated = validatePreparedEncryptedWalletBackupRecord({
    seed,
    canonicalRecord: candidate.canonicalRecord,
    canonicalManifestEntry: candidate.canonicalManifestEntry,
  });
  if (
    validated.recordId !== candidate.recordId ||
    validated.commitment !== candidate.commitment ||
    validated.recordKindCode !== candidate.recordKindCode
  )
    throw new Error("prepared backup record authority changed");
}

function requirePersistedRecord(
  value: PersistedPreparedEncryptedWalletBackupRecord,
): PersistedPreparedEncryptedWalletBackupRecord {
  const record = requireStrictRecord(value);
  const candidate = candidateFromPersistedRecord(record);
  const authenticationTag = requireBytes(
    record.authenticationTag,
    32,
    "authentication tag",
  );
  return Object.freeze({ ...candidate, authenticationTag });
}

function candidateFromPersistedRecord(
  record: Record<string, unknown>,
): CapabilityCandidate {
  return Object.freeze({
    schemaVersion: 1,
    realm: requireText(record.realm, 64, "realm"),
    vaultId: requireFingerprint(record.vaultId, "vault id"),
    snapshotId: requireText(record.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireInteger(
      record.snapshotRevision,
      "snapshot revision",
    ),
    recordId: requireFingerprint(record.recordId, "record id"),
    commitment: requireFingerprint(record.commitment, "record commitment"),
    recordKindCode: requireRecordKind(record.recordKindCode),
    canonicalRecord: requireBytesRange(
      record.canonicalRecord,
      1,
      ENCRYPTED_WALLET_BACKUP_DATA_CBOR_MAX_BYTES,
      "canonical record",
    ),
    canonicalManifestEntry: requireBytesRange(
      record.canonicalManifestEntry,
      1,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
      "canonical manifest entry",
    ),
  });
}

function requireStrictRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("persisted prepared backup record is invalid");
  const record = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "realm",
    "vaultId",
    "snapshotId",
    "snapshotRevision",
    "recordId",
    "commitment",
    "recordKindCode",
    "canonicalRecord",
    "canonicalManifestEntry",
    "authenticationTag",
  ];
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !(field in record))
  )
    throw new Error("persisted prepared backup record is invalid");
  return record;
}

function capabilityPayload(value: CapabilityCandidate): Uint8Array {
  return encodeCanonical([
    1,
    "prepared-record-capability",
    value.realm,
    hexBytes(value.vaultId),
    value.snapshotId,
    value.snapshotRevision,
    hexBytes(value.recordId),
    hexBytes(value.commitment),
    value.recordKindCode,
    value.canonicalRecord,
    value.canonicalManifestEntry,
  ]);
}

function snapshotOf(
  value: CapabilityCandidate,
): EncryptedWalletBackupPreparedRecordSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    recordId: value.recordId,
    commitment: value.commitment,
    recordKindCode: value.recordKindCode,
  });
}

async function requireCommittedSnapshot(
  store: EncryptedWalletBackupPreparedRecordSnapshotStore,
  expected: EncryptedWalletBackupPreparedRecordSnapshot,
): Promise<void> {
  if (!store || typeof store.withCommittedPreparedRecordSnapshot !== "function")
    throw new Error("prepared backup snapshot store is invalid");
  const sentinel = Object.freeze({ committed: true });
  let calls = 0;
  const returned = await store.withCommittedPreparedRecordSnapshot(
    expected.recordId,
    (raw) => {
      if (calls++ !== 0)
        throw new Error("prepared backup snapshot callback is invalid");
      requireExactSnapshot(expected, raw);
      return sentinel;
    },
  );
  if (calls !== 1 || returned !== sentinel)
    throw new Error(
      "prepared backup snapshot callback must be synchronous and exact",
    );
}

function requireExactSnapshot(
  expected: EncryptedWalletBackupPreparedRecordSnapshot,
  actual: EncryptedWalletBackupPreparedRecordSnapshot,
): void {
  const snapshot = requireStrictSnapshot(actual);
  if (
    snapshot.snapshotId !== expected.snapshotId ||
    snapshot.snapshotRevision !== expected.snapshotRevision ||
    snapshot.recordId !== expected.recordId ||
    snapshot.commitment !== expected.commitment ||
    snapshot.recordKindCode !== expected.recordKindCode
  )
    throw new Error("committed prepared backup snapshot changed");
}

function requireStrictSnapshot(
  value: unknown,
): EncryptedWalletBackupPreparedRecordSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("committed prepared backup snapshot is invalid");
  const record = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "snapshotId",
    "snapshotRevision",
    "recordId",
    "commitment",
    "recordKindCode",
  ];
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !(field in record))
  )
    throw new Error("committed prepared backup snapshot is invalid");
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: requireText(record.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireInteger(
      record.snapshotRevision,
      "snapshot revision",
    ),
    recordId: requireFingerprint(record.recordId, "record id"),
    commitment: requireFingerprint(record.commitment, "record commitment"),
    recordKindCode: requireRecordKind(record.recordKindCode),
  });
}

function issueRehydratedRecord(
  keyHandle: EncryptedWalletBackupKeyHandle,
  persisted: PersistedPreparedEncryptedWalletBackupRecord,
): PreparedEncryptedWalletBackupRecord {
  const manifestEntry = decodeCanonicalManifestEntry(
    persisted.canonicalManifestEntry,
  );
  const handle = Object.freeze({
    recordId: persisted.recordId,
    commitment: persisted.commitment,
    recordKindCode: persisted.recordKindCode,
  });
  return issuePreparedEncryptedWalletBackupRecord(handle, {
    ...handle,
    keyHandle,
    canonicalRecord: persisted.canonicalRecord,
    snapshotId: persisted.snapshotId,
    snapshotRevision: persisted.snapshotRevision,
    manifestEntry,
  });
}

function decodeCanonicalManifestEntry(bytes: Uint8Array): readonly unknown[] {
  const value = decode(bytes);
  if (!Array.isArray(value))
    throw new Error("prepared backup manifest entry is invalid");
  return Object.freeze(value);
}

function requireMatchingKeyHandle(
  value: EncryptedWalletBackupKeyHandle,
  seed: Uint8Array,
): EncryptedWalletBackupKeyHandle {
  const handle = requireIssuedEncryptedWalletBackupKeyHandle(value);
  if (
    !(seed instanceof Uint8Array) ||
    seed.byteLength !== 64 ||
    requireEncryptedWalletBackupKeyWalletId(handle) !==
      deriveDurableCustodyWalletId(seed)
  )
    throw new Error("backup key handle does not match the seed");
  return handle;
}

function requireKeyBinding(
  keyHandle: EncryptedWalletBackupKeyHandle,
  persisted: PersistedPreparedEncryptedWalletBackupRecord,
): void {
  if (
    persisted.realm !== keyHandle.realm ||
    persisted.vaultId !== keyHandle.vaultId
  )
    throw new Error(
      "persisted prepared backup record belongs to a foreign vault",
    );
}

function requireText(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new Error(`prepared backup ${name} is invalid`);
  return value;
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`prepared backup ${name} is invalid`);
  return value as number;
}

function requireFingerprint(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(`prepared backup ${name} is invalid`);
  return value;
}

function requireRecordKind(
  value: unknown,
): EncryptedWalletBackupRecordKindCode {
  if (value !== 0 && value !== 1 && value !== 2)
    throw new Error("prepared backup record kind is invalid");
  return value;
}

function requireBytes(
  value: unknown,
  length: number,
  name: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`prepared backup ${name} is invalid`);
  return value.slice();
}

function requireBytesRange(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  )
    throw new Error(`prepared backup ${name} is invalid`);
  return value.slice();
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}
