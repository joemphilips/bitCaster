import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  measureCanonicalBackupCbor,
} from "./encryptedWalletBackupCbor.ts";
import { decodeEncryptedWalletBackupManifestEntry } from "./encryptedWalletBackup.ts";
import {
  decodePendingSendProgressionCode,
  derivePendingSendProgressionCommitment,
  derivePendingSendProgressionFragmentRecordId,
  encodePendingSendProgressionCode,
} from "./encryptedWalletBackupPendingSendProgressionCodec.ts";
import {
  derivePendingSendParentCommitment,
  derivePendingSendParentFragmentRecordId,
} from "./encryptedWalletBackupPendingSendParentCodec.ts";

export const ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_ROW_MAX = 256 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_BYTES_MAX =
  1_048_576 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX = 512 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ENTRY_MAX = 512 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_COUNT_MAX = 1_024 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_BYTES_MAX = 65_532 as const;

export interface EncryptedWalletBackupManifestLogicalBinding {
  readonly recordKindCode: 0 | 1 | 2;
  readonly recordId: string;
  readonly commitment: string;
}

export interface EncryptedWalletBackupManifestSnapshotRow extends EncryptedWalletBackupManifestLogicalBinding {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordOrdinal: number;
  readonly dataObjectId: string;
  readonly dataObjectDigest: string;
  readonly logicalRecordId: string | null;
  readonly parentCommitment: string | null;
  readonly progressionCode: number | null;
  readonly childCommitment: string | null;
  readonly fragmentIndex: number | null;
  readonly fragmentCount: number | null;
  readonly canonicalManifestEntry: Uint8Array;
}

export interface EncryptedWalletBackupManifestInventoryLeaf {
  readonly leafIndex: number;
  readonly entryCount: number;
  readonly first: EncryptedWalletBackupManifestLogicalBinding;
  readonly last: EncryptedWalletBackupManifestLogicalBinding;
  readonly digest: string;
}

export function normalizeEncryptedWalletBackupManifestSnapshotRow(input: {
  readonly buildId: string;
  readonly sourceOrdinal: number;
  readonly sourceRecordOrdinal: number;
  readonly canonicalManifestEntry: Uint8Array;
}): EncryptedWalletBackupManifestSnapshotRow {
  const canonical = requireCanonicalEntry(input.canonicalManifestEntry);
  const entry = decodeEncryptedWalletBackupManifestEntry(decode(canonical));
  return Object.freeze({
    schemaVersion: 1,
    buildId: requireText(input.buildId, 128, "build id"),
    sourceOrdinal: requireInteger(
      input.sourceOrdinal,
      0,
      1_023,
      "source ordinal",
    ),
    sourceRecordOrdinal: requireInteger(
      input.sourceRecordOrdinal,
      0,
      511,
      "source record ordinal",
    ),
    recordKindCode: entry.recordKindCode,
    recordId: entry.recordId,
    commitment: entry.commitment,
    dataObjectId: entry.dataObjectId,
    dataObjectDigest: entry.dataDigest,
    ...pendingMetadata(entry),
    canonicalManifestEntry: canonical,
  });
}

export function compareEncryptedWalletBackupManifestBindings(
  left: EncryptedWalletBackupManifestLogicalBinding,
  right: EncryptedWalletBackupManifestLogicalBinding,
) {
  return (
    left.recordKindCode - right.recordKindCode ||
    compareText(left.recordId, right.recordId) ||
    compareText(left.commitment, right.commitment)
  );
}

export function encryptedWalletBackupManifestBindingKey(
  value: EncryptedWalletBackupManifestLogicalBinding,
) {
  requireBinding(value);
  return `${value.recordKindCode}:${value.recordId}:${value.commitment}`;
}

export function encryptedWalletBackupManifestPendingGroupKey(
  row: EncryptedWalletBackupManifestSnapshotRow,
) {
  return row.logicalRecordId === null
    ? null
    : `${row.logicalRecordId}:${row.recordKindCode}`;
}

export function digestEncryptedWalletBackupInventoryLeaf(input: {
  readonly leafIndex: number;
  readonly bindings: readonly EncryptedWalletBackupManifestLogicalBinding[];
}): EncryptedWalletBackupManifestInventoryLeaf {
  const leafIndex = requireInteger(input.leafIndex, 0, 1_023, "leaf index");
  const bindings = requireOrderedBindings(input.bindings);
  if (
    bindings.length < 1 ||
    bindings.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX
  )
    throw new Error("encrypted backup manifest inventory leaf is invalid");
  return Object.freeze({
    leafIndex,
    entryCount: bindings.length,
    first: bindings[0]!,
    last: bindings.at(-1)!,
    digest: digest([
      1,
      "encrypted-wallet-backup-inventory-leaf",
      leafIndex,
      bindings.map(bindingWire),
    ]),
  });
}

export function digestEncryptedWalletBackupInventoryRoot(input: {
  readonly recordCount: number;
  readonly leaves: readonly EncryptedWalletBackupManifestInventoryLeaf[];
}) {
  const count = requireInteger(input.recordCount, 0, 524_288, "record count");
  let observed = 0;
  for (let index = 0; index < input.leaves.length; index += 1) {
    const leaf = input.leaves[index]!;
    const previous = input.leaves[index - 1];
    if (
      leaf.leafIndex !== index ||
      (index > 0 &&
        compareEncryptedWalletBackupManifestBindings(
          previous!.last,
          leaf.first,
        ) >= 0) ||
      (previous !== undefined && sameLogicalIdentity(previous.last, leaf.first))
    )
      throw new Error("encrypted backup manifest inventory leaves are invalid");
    observed += leaf.entryCount;
  }
  if (observed !== count)
    throw new Error("encrypted backup manifest inventory count is invalid");
  return digest([
    1,
    "encrypted-wallet-backup-inventory-root",
    count,
    input.leaves.map((leaf) => [
      leaf.leafIndex,
      leaf.entryCount,
      hexToBytes(leaf.digest),
    ]),
  ]);
}

export function digestEncryptedWalletBackupLogicalInventory(
  input: readonly EncryptedWalletBackupManifestLogicalBinding[],
) {
  const bindings = [...input]
    .map(requireBinding)
    .sort(compareEncryptedWalletBackupManifestBindings);
  const leaves: EncryptedWalletBackupManifestInventoryLeaf[] = [];
  for (
    let offset = 0;
    offset < bindings.length;
    offset += ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX
  )
    leaves.push(
      digestEncryptedWalletBackupInventoryLeaf({
        leafIndex: leaves.length,
        bindings: bindings.slice(
          offset,
          offset + ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
        ),
      }),
    );
  return Object.freeze({
    recordCount: bindings.length,
    leaves: Object.freeze(leaves),
    root: digestEncryptedWalletBackupInventoryRoot({
      recordCount: bindings.length,
      leaves,
    }),
  });
}

export function validateEncryptedWalletBackupPendingGroup(
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
) {
  if (rows.length < 1 || rows.length > 1_024)
    throw new Error("encrypted backup pending group is invalid");
  const first = rows[0]!;
  if (first.logicalRecordId === null || first.fragmentCount !== rows.length)
    throw new Error("encrypted backup pending group is incomplete");
  validatePendingFragmentRows(rows, first);
  validatePendingAggregate(rows, first);
  return Object.freeze({
    groupKey: encryptedWalletBackupManifestPendingGroupKey(first)!,
    logicalRecordId: first.logicalRecordId,
    recordKindCode: first.recordKindCode as 1 | 2,
    parentCommitment: first.parentCommitment!,
    progressionCode: first.progressionCode,
    childCommitment: first.childCommitment,
    fragmentCount: rows.length,
    digest: digest([
      1,
      "encrypted-wallet-backup-pending-group",
      rows.map((row) => [
        row.fragmentIndex,
        hexToBytes(row.recordId),
        hexToBytes(row.commitment),
      ]),
    ]),
  });
}

function validatePendingFragmentRows(
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
  first: EncryptedWalletBackupManifestSnapshotRow,
) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (
      encryptedWalletBackupManifestPendingGroupKey(row) !==
        encryptedWalletBackupManifestPendingGroupKey(first) ||
      row.fragmentIndex !== index ||
      row.fragmentCount !== rows.length ||
      row.parentCommitment !== first.parentCommitment ||
      row.progressionCode !== first.progressionCode ||
      row.childCommitment !== first.childCommitment
    )
      throw new Error("encrypted backup pending group is invalid");
    const expectedRecordId =
      row.recordKindCode === 1
        ? derivePendingSendParentFragmentRecordId(row.logicalRecordId!, index)
        : derivePendingSendProgressionFragmentRecordId({
            logicalRecordId: row.logicalRecordId!,
            parentCommitment: row.parentCommitment!,
            progression: decodePendingSendProgressionCode(row.progressionCode),
            fragmentIndex: index,
          });
    if (row.recordId !== expectedRecordId)
      throw new Error("encrypted backup pending group record id is invalid");
  }
}

function validatePendingAggregate(
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
  first: EncryptedWalletBackupManifestSnapshotRow,
) {
  if (first.logicalRecordId === null || first.parentCommitment === null)
    throw new Error("encrypted backup pending aggregate is invalid");
  const fragmentCommitments = rows.map(({ commitment }) => commitment);
  if (
    first.recordKindCode === 1 &&
    derivePendingSendParentCommitment(
      first.logicalRecordId,
      fragmentCommitments,
    ) !== first.parentCommitment
  )
    throw new Error(
      "encrypted backup pending parent aggregate commitment is invalid",
    );
  if (
    first.recordKindCode === 2 &&
    derivePendingSendProgressionCommitment({
      logicalRecordId: first.logicalRecordId,
      parentCommitment: first.parentCommitment,
      progression: decodePendingSendProgressionCode(first.progressionCode),
      fragmentCommitments,
    }) !== first.childCommitment
  )
    throw new Error(
      "encrypted backup pending child aggregate commitment is invalid",
    );
}

export function measureEncryptedWalletBackupManifestPage(
  generation: number,
  snapshotNonce: Uint8Array,
  pageIndex: number,
  entries: readonly Uint8Array[],
) {
  return measureCanonicalBackupCbor([
    1,
    2,
    generation,
    snapshotNonce,
    pageIndex,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_COUNT_MAX,
    entries.map((entry) => decode(entry)),
  ]);
}

function requireCanonicalEntry(value: unknown) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_BYTES_MAX
  )
    throw new Error("encrypted backup manifest entry is invalid");
  const bytes = value.slice();
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    throw new Error("encrypted backup manifest entry is invalid");
  }
  if (!Array.isArray(decoded) || !bytesEqual(bytes, encodeCanonical(decoded)))
    throw new Error("encrypted backup manifest entry is invalid");
  return bytes;
}

function pendingMetadata(
  entry: ReturnType<typeof decodeEncryptedWalletBackupManifestEntry>,
) {
  switch (entry.recordKindCode) {
    case 0:
      return emptyPending();
    case 1:
      return Object.freeze({
        logicalRecordId: entry.logicalRecordId,
        parentCommitment: entry.parentCommitment,
        progressionCode: null,
        childCommitment: null,
        fragmentIndex: entry.fragmentIndex,
        fragmentCount: entry.fragmentCount,
      });
    case 2:
      return Object.freeze({
        logicalRecordId: entry.logicalRecordId,
        parentCommitment: entry.parentCommitment,
        progressionCode: encodePendingSendProgressionCode(entry.progression),
        childCommitment: entry.childCommitment,
        fragmentIndex: entry.fragmentIndex,
        fragmentCount: entry.fragmentCount,
      });
  }
}

function emptyPending() {
  return Object.freeze({
    logicalRecordId: null,
    parentCommitment: null,
    progressionCode: null,
    childCommitment: null,
    fragmentIndex: null,
    fragmentCount: null,
  });
}
function requireOrderedBindings(
  values: readonly EncryptedWalletBackupManifestLogicalBinding[],
) {
  const rows = values.map(requireBinding);
  for (let index = 1; index < rows.length; index += 1) {
    if (sameLogicalIdentity(rows[index - 1]!, rows[index]!))
      throw new Error(
        "encrypted backup manifest logical record identity is duplicated",
      );
    if (
      compareEncryptedWalletBackupManifestBindings(
        rows[index - 1]!,
        rows[index]!,
      ) >= 0
    )
      throw new Error("encrypted backup manifest inventory order is invalid");
  }
  return rows;
}
function sameLogicalIdentity(
  left: EncryptedWalletBackupManifestLogicalBinding,
  right: EncryptedWalletBackupManifestLogicalBinding,
) {
  return (
    left.recordKindCode === right.recordKindCode &&
    left.recordId === right.recordId
  );
}
function requireBinding(value: EncryptedWalletBackupManifestLogicalBinding) {
  if (
    !value ||
    (value.recordKindCode !== 0 &&
      value.recordKindCode !== 1 &&
      value.recordKindCode !== 2)
  )
    throw new Error("encrypted backup manifest binding is invalid");
  return Object.freeze({
    recordKindCode: value.recordKindCode,
    recordId: lowerHex(value.recordId, 32),
    commitment: lowerHex(value.commitment, 32),
  });
}
function bindingWire(value: EncryptedWalletBackupManifestLogicalBinding) {
  return [
    value.recordKindCode,
    hexToBytes(value.recordId),
    hexToBytes(value.commitment),
  ];
}
function digest(value: unknown) {
  return bytesToHex(sha256(encodeCanonical(value)));
}
function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function lowerHex(value: unknown, bytes: number) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)
  )
    throw new Error("encrypted backup manifest hex is invalid");
  return value;
}
function requireInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`encrypted backup manifest ${label} is invalid`);
  return value as number;
}
function requireText(value: unknown, max: number, label: string) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > max
  )
    throw new Error(`encrypted backup manifest ${label} is invalid`);
  return value;
}
function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
