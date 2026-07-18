import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  decodeDurableBearerSpendDeliveryRecord,
  encodeDurableBearerSpendDeliveryRecord,
  type DurableBearerSpendDeliveryRecord,
} from "./durableBearerSpendDelivery.ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  encodeBoundedDurableArtifact,
} from "./durableCustody.ts";
import type {
  DurableWalletOutputData,
  DurableWalletProof,
} from "./durableWalletOperation.ts";
import {
  DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX,
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
} from "./durableWalletOperation.ts";
import { decodeDurableWalletSendExactPayloadMetadata } from "./durableWalletSendExactPayload.ts";
import { DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX } from "./durableWalletSendDelivery.ts";
import { encodeCanonicalBackupCbor } from "./encryptedWalletBackupCbor.ts";
import { ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD } from "./encryptedWalletBackupRecord.ts";

export const ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES = 16 * 1_024;
export const ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX =
  16 * 1_024 * 1_024;
export const ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT =
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX /
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES;

const IDENTIFIER_MAX_BYTES = 512;

export interface DecodedEncryptedWalletBackupPendingSendParentFragment {
  readonly recordId: string;
  readonly commitment: string;
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
}

export interface DecodedEncryptedWalletBackupPendingSendParentPayload {
  readonly recordId: string;
  readonly walletOperation: EncryptedWalletBackupPendingSendOperation;
  readonly exactPayloadMetadata: ReturnType<
    typeof decodeDurableWalletSendExactPayloadMetadata
  >;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
  readonly encodedToken: string;
  readonly proofOrder: readonly string[];
}

export interface EncryptedWalletBackupPendingSendOperation {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly kind: "wallet-send";
  readonly mintUrl: string;
  readonly unit: string;
  readonly preview: Readonly<{
    amount: string;
    fees: string;
    keysetId: string;
    inputs: readonly DurableWalletProof[];
    sendOutputs: readonly DurableWalletOutputData[];
    keepOutputs: readonly DurableWalletOutputData[];
    unselectedProofCount: number;
    unselectedProofsFingerprint: string;
  }>;
  readonly requestFingerprint: string;
  readonly outputPlanFingerprint: string;
}

export function projectEncryptedWalletBackupPendingSendOperation(
  value: unknown,
): EncryptedWalletBackupPendingSendOperation {
  const operation = decodeDurableWalletOperation(value);
  if (operation.kind !== "wallet-send") {
    throw new Error("pending-send wallet operation is invalid");
  }
  const authority = deriveDurableWalletOperationAuthority(operation);
  return Object.freeze({
    schemaVersion: 1,
    operationId: operation.operationId,
    kind: operation.kind,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    preview: Object.freeze({
      amount: operation.preview.amount,
      fees: operation.preview.fees,
      keysetId: operation.preview.keysetId,
      inputs: structuredClone(operation.preview.inputs),
      sendOutputs: structuredClone(operation.preview.sendOutputs),
      keepOutputs: structuredClone(operation.preview.keepOutputs),
      unselectedProofCount: operation.preview.unselectedProofs.length,
      unselectedProofsFingerprint: deriveDurableCustodyArtifactFingerprint(
        operation.preview.unselectedProofs,
      ),
    }),
    requestFingerprint: authority.requestFingerprint,
    outputPlanFingerprint: authority.outputPlanFingerprint,
  });
}

type PendingSendParentFragmentFields = Omit<
  DecodedEncryptedWalletBackupPendingSendParentFragment,
  "fragment"
> & { readonly fragment: Uint8Array };

export function decodeEncryptedWalletBackupPendingSendParentFragment(
  value: unknown,
): DecodedEncryptedWalletBackupPendingSendParentFragment {
  if (
    !Array.isArray(value) ||
    value.length !== 10 ||
    value[0] !== 1 ||
    value[1] !== ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD
  ) {
    throw new Error("pending-send parent fragment is invalid");
  }
  const fields = decodeParentFragmentFields(value);
  requireValidParentFragmentBinding(fields);
  return Object.freeze(fields);
}

function decodeParentFragmentFields(
  value: readonly unknown[],
): PendingSendParentFragmentFields {
  const recordId = bytesToHex(requireBytes(value[2], 32, "fragment record id"));
  const commitment = bytesToHex(
    requireBytes(value[3], 32, "fragment commitment"),
  );
  const logicalRecordId = bytesToHex(
    requireBytes(value[4], 32, "logical record id"),
  );
  const parentCommitment = bytesToHex(
    requireBytes(value[5], 32, "parent commitment"),
  );
  const fragmentIndex = requireInteger(
    value[6],
    0,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT - 1,
    "fragment index",
  );
  const fragmentCount = requireInteger(
    value[7],
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT,
    "fragment count",
  );
  const totalBytes = requireInteger(
    value[8],
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    "parent bytes",
  );
  const fragment = requireBytesRange(
    value[9],
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
    "fragment",
  );
  return {
    recordId,
    commitment,
    logicalRecordId,
    parentCommitment,
    fragmentIndex,
    fragmentCount,
    totalBytes,
    fragment,
  };
}

function requireValidParentFragmentBinding(
  fields: PendingSendParentFragmentFields,
): void {
  const {
    recordId,
    commitment,
    logicalRecordId,
    fragmentIndex,
    fragmentCount,
    totalBytes,
    fragment,
  } = fields;
  const expectedCommitment = deriveFragmentCommitment(
    logicalRecordId,
    fragmentIndex,
    fragmentCount,
    totalBytes,
    fragment,
  );
  if (
    commitment !== expectedCommitment ||
    recordId !==
      derivePendingSendParentFragmentRecordId(logicalRecordId, fragmentIndex) ||
    fragmentIndex >= fragmentCount ||
    (fragmentIndex + 1 < fragmentCount &&
      fragment.byteLength !==
        ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES)
  ) {
    throw new Error("pending-send parent fragment is invalid");
  }
}

export function validateEncryptedWalletBackupPendingSendParentFragments(
  records: readonly DecodedEncryptedWalletBackupPendingSendParentFragment[],
): { logicalRecordId: string; parentCommitment: string; payload: Uint8Array } {
  if (
    records.length < 1 ||
    records.length > ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT
  ) {
    throw new Error("pending-send fragment set is invalid");
  }
  const first = records[0]!;
  const seenIds = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    requireValidParentFragmentBinding(record);
    if (
      record.fragmentIndex !== index ||
      record.fragmentCount !== records.length ||
      record.totalBytes !== first.totalBytes ||
      record.logicalRecordId !== first.logicalRecordId ||
      record.parentCommitment !== first.parentCommitment ||
      seenIds.has(record.recordId) ||
      derivePendingSendParentFragmentRecordId(record.logicalRecordId, index) !==
        record.recordId
    ) {
      throw new Error("pending-send fragment set is invalid");
    }
    seenIds.add(record.recordId);
    totalBytes += record.fragment.byteLength;
  }
  if (totalBytes !== first.totalBytes) {
    throw new Error("pending-send fragment set is invalid");
  }
  const parentCommitment = derivePendingSendParentCommitment(
    first.logicalRecordId,
    records.map(({ commitment }) => commitment),
  );
  if (parentCommitment !== first.parentCommitment) {
    throw new Error("pending-send parent commitment is invalid");
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const record of records) {
    payload.set(record.fragment, offset);
    offset += record.fragment.byteLength;
  }
  return { logicalRecordId: first.logicalRecordId, parentCommitment, payload };
}

export function decodeEncryptedWalletBackupPendingSendParentPayload(
  value: Uint8Array,
): DecodedEncryptedWalletBackupPendingSendParentPayload {
  const decoded = decode(value);
  if (
    !equalBytes(value, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 7 ||
    decoded[0] !== 1
  ) {
    throw new Error("pending-send parent payload is invalid");
  }
  const recordId = requireIdentifier(decoded[1], "record id");
  const walletOperation = decodeEncryptedWalletBackupPendingSendOperation(
    decodeArtifact(decoded[2], "wallet operation"),
  );
  const exactPayloadMetadata = decodeDurableWalletSendExactPayloadMetadata(
    decodeArtifact(decoded[3], "exact payload"),
  );
  const deliveryRecord = decodeDeliveryArtifact(decoded[4]);
  const encodedToken = new TextDecoder("utf-8", { fatal: true }).decode(
    requireBytesRange(
      decoded[5],
      1,
      DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
      "token",
    ),
  );
  if (
    !Array.isArray(decoded[6]) ||
    decoded[6].length !== deliveryRecord.proofEntries.length
  ) {
    throw new Error("pending-send proof order is invalid");
  }
  const proofOrder = decoded[6].map((item) =>
    requireIdentifier(item, "proof order"),
  );
  return {
    recordId,
    walletOperation,
    exactPayloadMetadata,
    deliveryRecord,
    encodedToken,
    proofOrder,
  };
}

export function decodeEncryptedWalletBackupPendingSendOperation(
  value: unknown,
): EncryptedWalletBackupPendingSendOperation {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "operationId",
      "kind",
      "mintUrl",
      "unit",
      "preview",
      "requestFingerprint",
      "outputPlanFingerprint",
    ],
    "wallet operation",
  );
  const preview = requireExactRecord(
    record.preview,
    [
      "amount",
      "fees",
      "keysetId",
      "inputs",
      "sendOutputs",
      "keepOutputs",
      "unselectedProofCount",
      "unselectedProofsFingerprint",
    ],
    "wallet operation preview",
  );
  const selected = decodeSelectedPendingSendOperation(record, preview);
  const unselectedProofCount = requireInteger(
    preview.unselectedProofCount,
    0,
    DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX,
    "unselected proof count",
  );
  return pendingSendProjection(record, selected, {
    unselectedProofCount,
    unselectedProofsFingerprint: requireFingerprint(
      preview.unselectedProofsFingerprint,
      "unselected proofs fingerprint",
    ),
  });
}

function decodeSelectedPendingSendOperation(
  record: Record<string, unknown>,
  preview: Record<string, unknown>,
) {
  const operation = decodeDurableWalletOperation({
    schemaVersion: record.schemaVersion,
    operationId: record.operationId,
    kind: record.kind,
    mintUrl: record.mintUrl,
    unit: record.unit,
    preview: {
      amount: preview.amount,
      fees: preview.fees,
      keysetId: preview.keysetId,
      inputs: preview.inputs,
      sendOutputs: preview.sendOutputs,
      keepOutputs: preview.keepOutputs,
      unselectedProofs: [],
    },
  });
  if (operation.kind !== "wallet-send") {
    throw new Error("pending-send wallet operation is invalid");
  }
  return operation;
}

function pendingSendProjection(
  record: Record<string, unknown>,
  selected: Extract<
    ReturnType<typeof decodeDurableWalletOperation>,
    { kind: "wallet-send" }
  >,
  unselected: Readonly<{
    unselectedProofCount: number;
    unselectedProofsFingerprint: string;
  }>,
): EncryptedWalletBackupPendingSendOperation {
  return {
    schemaVersion: 1,
    operationId: selected.operationId,
    kind: selected.kind,
    mintUrl: selected.mintUrl,
    unit: selected.unit,
    preview: {
      amount: selected.preview.amount,
      fees: selected.preview.fees,
      keysetId: selected.preview.keysetId,
      inputs: selected.preview.inputs,
      sendOutputs: selected.preview.sendOutputs,
      keepOutputs: selected.preview.keepOutputs,
      ...unselected,
    },
    requestFingerprint: requireFingerprint(
      record.requestFingerprint,
      "request fingerprint",
    ),
    outputPlanFingerprint: requireFingerprint(
      record.outputPlanFingerprint,
      "output plan fingerprint",
    ),
  };
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !(field in record))
  ) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  return record;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`pending-send ${label} is invalid`);
  }
  return value;
}

export function encodeEncryptedWalletBackupPendingSendParentArtifact(
  value: unknown,
  label: string,
): Uint8Array {
  try {
    return encodeBoundedDurableArtifact(
      value,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    );
  } catch (error) {
    throw new Error(`pending-send ${label} is invalid`, { cause: error });
  }
}

export function derivePendingSendLogicalRecordId(recordId: string): string {
  return bytesToHex(
    sha256(
      encodeCanonicalBackupCbor([
        1,
        "pending-send-logical-record-id",
        recordId,
      ]),
    ),
  );
}

export function derivePendingSendParentFragmentRecordId(
  logicalRecordId: string,
  fragmentIndex: number,
): string {
  return bytesToHex(
    sha256(
      encodeCanonicalBackupCbor([
        1,
        "pending-send-parent-fragment-record-id",
        hexToBytes(logicalRecordId),
        fragmentIndex,
      ]),
    ),
  );
}

export function derivePendingSendParentCommitment(
  logicalRecordId: string,
  fragmentCommitments: readonly string[],
): string {
  return bytesToHex(
    sha256(
      encodeCanonicalBackupCbor([
        1,
        "pending-send-parent",
        hexToBytes(logicalRecordId),
        fragmentCommitments.map(hexToBytes),
      ]),
    ),
  );
}

export function derivePendingSendParentFragmentCommitment(input: {
  readonly logicalRecordId: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
}): string {
  return deriveFragmentCommitment(
    input.logicalRecordId,
    input.fragmentIndex,
    input.fragmentCount,
    input.totalBytes,
    input.fragment,
  );
}

function deriveFragmentCommitment(
  logicalRecordId: string,
  fragmentIndex: number,
  fragmentCount: number,
  totalBytes: number,
  fragment: Uint8Array,
): string {
  return bytesToHex(
    sha256(
      encodeCanonicalBackupCbor([
        1,
        "wallet-record-commitment",
        ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
        hexToBytes(logicalRecordId),
        fragmentIndex,
        fragmentCount,
        totalBytes,
        fragment,
      ]),
    ),
  );
}

function decodeArtifact(value: unknown, label: string): unknown {
  const bytes = requireBytesRange(
    value,
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    label,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error(`pending-send ${label} is invalid`);
  }
  if (
    !equalBytes(
      bytes,
      encodeEncryptedWalletBackupPendingSendParentArtifact(parsed, label),
    )
  ) {
    throw new Error(`pending-send ${label} is noncanonical`);
  }
  return parsed;
}

function decodeDeliveryArtifact(
  value: unknown,
): DurableBearerSpendDeliveryRecord {
  const bytes = requireBytesRange(
    value,
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    "delivery record",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("pending-send delivery record is invalid");
  }
  const record = decodeDurableBearerSpendDeliveryRecord(parsed);
  const canonical = encodeDurableBearerSpendDeliveryRecord(
    record,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
  );
  if (!equalBytes(bytes, canonical)) {
    throw new Error("pending-send delivery record is noncanonical");
  }
  return record;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`pending-send ${label} is invalid`);
  const length = new TextEncoder().encode(value).byteLength;
  if (length < 1 || length > IDENTIFIER_MAX_BYTES)
    throw new Error(`pending-send ${label} is invalid`);
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

function requireBytes(
  value: unknown,
  length: number,
  label: string,
): Uint8Array {
  return requireBytesRange(value, length, length, label);
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
