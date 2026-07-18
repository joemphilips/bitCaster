import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  decodeDurableBearerSpendDeliveryRecord,
  encodeDurableBearerSpendDeliveryRecord,
  type DurableBearerSpendDeliveryRecord,
} from "./durableBearerSpendDelivery.ts";
import { encodeCanonicalBackupCbor } from "./encryptedWalletBackupCbor.ts";
import {
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
} from "./encryptedWalletBackupRecord.ts";
import {
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
} from "./encryptedWalletBackupPendingSendParentCodec.ts";

export type EncryptedWalletBackupPendingSendChildProgression =
  | "cancellation-intent"
  | "partial"
  | "recipient-finalization"
  | "reclaim-completion";

export interface DecodedEncryptedWalletBackupPendingSendProgressionFragment {
  readonly recordId: string;
  readonly commitment: string;
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly childCommitment: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
}

export interface DecodedEncryptedWalletBackupPendingSendProgressionPayload {
  readonly recordId: string;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
}

export function decodeEncryptedWalletBackupPendingSendProgressionFragment(
  value: unknown,
): DecodedEncryptedWalletBackupPendingSendProgressionFragment {
  if (
    !Array.isArray(value) ||
    value.length !== 12 ||
    value[0] !== 1 ||
    value[1] !== ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD
  ) {
    throw new Error("pending-send progression fragment is invalid");
  }
  const fields = decodeProgressionFragmentFields(value);
  requireValidProgressionFragment(fields);
  return Object.freeze(fields);
}

function decodeProgressionFragmentFields(
  value: readonly unknown[],
): DecodedEncryptedWalletBackupPendingSendProgressionFragment {
  return {
    recordId: requireFingerprint(value[2], "progression record id"),
    commitment: requireFingerprint(value[3], "progression commitment"),
    logicalRecordId: requireFingerprint(value[4], "logical record id"),
    parentCommitment: requireFingerprint(value[5], "parent commitment"),
    progression: decodePendingSendProgressionCode(value[6]),
    childCommitment: requireFingerprint(value[7], "child commitment"),
    fragmentIndex: requireInteger(
      value[8],
      0,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT - 1,
      "fragment index",
    ),
    fragmentCount: requireInteger(
      value[9],
      1,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT,
      "fragment count",
    ),
    totalBytes: requireInteger(
      value[10],
      1,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
      "progression bytes",
    ),
    fragment: requireBytesRange(
      value[11],
      1,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
      "progression fragment",
    ),
  };
}

export function validateEncryptedWalletBackupPendingSendProgressionFragments(
  records: readonly DecodedEncryptedWalletBackupPendingSendProgressionFragment[],
): Readonly<{
  logicalRecordId: string;
  parentCommitment: string;
  progression: EncryptedWalletBackupPendingSendChildProgression;
  childCommitment: string;
  payload: Uint8Array;
}> {
  if (
    records.length < 1 ||
    records.length > ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT
  ) {
    throw new Error("pending-send progression fragment set is invalid");
  }
  const first = records[0]!;
  let totalBytes = 0;
  const seenIds = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    requireValidProgressionFragment(record);
    if (
      record.fragmentIndex !== index ||
      record.fragmentCount !== records.length ||
      record.totalBytes !== first.totalBytes ||
      record.logicalRecordId !== first.logicalRecordId ||
      record.parentCommitment !== first.parentCommitment ||
      record.progression !== first.progression ||
      record.childCommitment !== first.childCommitment ||
      seenIds.has(record.recordId)
    ) {
      throw new Error("pending-send progression fragment set is invalid");
    }
    seenIds.add(record.recordId);
    totalBytes += record.fragment.byteLength;
  }
  if (
    totalBytes !== first.totalBytes ||
    derivePendingSendProgressionCommitment({
      logicalRecordId: first.logicalRecordId,
      parentCommitment: first.parentCommitment,
      progression: first.progression,
      fragmentCommitments: records.map(({ commitment }) => commitment),
    }) !== first.childCommitment
  ) {
    throw new Error("pending-send progression commitment is invalid");
  }
  return Object.freeze({
    logicalRecordId: first.logicalRecordId,
    parentCommitment: first.parentCommitment,
    progression: first.progression,
    childCommitment: first.childCommitment,
    payload: concatenateFragments(records, totalBytes),
  });
}

export function decodeEncryptedWalletBackupPendingSendProgressionPayload(
  bytes: Uint8Array,
): DecodedEncryptedWalletBackupPendingSendProgressionPayload {
  const decoded = decode(bytes);
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    decoded[0] !== 1
  ) {
    throw new Error("pending-send progression payload is invalid");
  }
  return Object.freeze({
    recordId: requireIdentifier(decoded[1], "pending-send record id"),
    deliveryRecord: decodeDeliveryArtifact(decoded[2]),
  });
}

export function derivePendingSendProgressionFragmentRecordId(input: {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly fragmentIndex: number;
}): string {
  return hashCanonical([
    1,
    "pending-send-progression-fragment-record-id",
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
    hexToBytes(input.logicalRecordId),
    hexToBytes(input.parentCommitment),
    encodePendingSendProgressionCode(input.progression),
    input.fragmentIndex,
  ]);
}

export function derivePendingSendProgressionFragmentCommitment(input: {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
}): string {
  return hashCanonical([
    1,
    "wallet-record-commitment",
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
    hexToBytes(input.logicalRecordId),
    hexToBytes(input.parentCommitment),
    encodePendingSendProgressionCode(input.progression),
    input.fragmentIndex,
    input.fragmentCount,
    input.totalBytes,
    input.fragment,
  ]);
}

export function derivePendingSendProgressionCommitment(input: {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly fragmentCommitments: readonly string[];
}): string {
  return hashCanonical([
    1,
    "pending-send-progression",
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
    hexToBytes(input.logicalRecordId),
    hexToBytes(input.parentCommitment),
    encodePendingSendProgressionCode(input.progression),
    input.fragmentCommitments.map(hexToBytes),
  ]);
}

export function encodePendingSendProgressionCode(
  value: EncryptedWalletBackupPendingSendChildProgression,
): 0 | 1 | 2 | 3 {
  switch (value) {
    case "cancellation-intent":
      return 0;
    case "partial":
      return 1;
    case "recipient-finalization":
      return 2;
    case "reclaim-completion":
      return 3;
    default:
      return assertNever(value);
  }
}

export function decodePendingSendProgressionCode(
  value: unknown,
): EncryptedWalletBackupPendingSendChildProgression {
  switch (value) {
    case 0:
      return "cancellation-intent";
    case 1:
      return "partial";
    case 2:
      return "recipient-finalization";
    case 3:
      return "reclaim-completion";
    default:
      throw new Error("pending-send progression is invalid");
  }
}

function requireValidProgressionFragment(
  value: DecodedEncryptedWalletBackupPendingSendProgressionFragment,
): void {
  if (
    value.fragmentIndex >= value.fragmentCount ||
    (value.fragmentIndex + 1 < value.fragmentCount &&
      value.fragment.byteLength !==
        ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES) ||
    value.recordId !==
      derivePendingSendProgressionFragmentRecordId(value) ||
    value.commitment !==
      derivePendingSendProgressionFragmentCommitment(value)
  ) {
    throw new Error("pending-send progression fragment is invalid");
  }
}

function concatenateFragments(
  records: readonly DecodedEncryptedWalletBackupPendingSendProgressionFragment[],
  totalBytes: number,
): Uint8Array {
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const record of records) {
    payload.set(record.fragment, offset);
    offset += record.fragment.byteLength;
  }
  return payload;
}

function decodeDeliveryArtifact(value: unknown): DurableBearerSpendDeliveryRecord {
  const bytes = requireBytesRange(
    value,
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    "delivery record",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("pending-send progression delivery record is invalid");
  }
  const record = decodeDurableBearerSpendDeliveryRecord(parsed);
  if (
    !equalBytes(
      bytes,
      encodeDurableBearerSpendDeliveryRecord(
        record,
        ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
      ),
    )
  ) {
    throw new Error("pending-send progression delivery record is noncanonical");
  }
  return record;
}

function requireFingerprint(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  return bytesToHex(value);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const length = new TextEncoder().encode(value).byteLength;
  if (length < 1 || length > 512) throw new Error(`${label} is invalid`);
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  return value as number;
}

function requireBytesRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  return value.slice();
}

function hashCanonical(value: unknown): string {
  return bytesToHex(sha256(encodeCanonicalBackupCbor(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertNever(value: never): never {
  throw new Error(`unhandled pending-send progression: ${String(value)}`);
}
