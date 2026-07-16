import {
  describeDurableWalletSendToken,
  planDurableWalletSendDeliveryAdmission,
  requireDurableWalletSendDeliveryAdmission,
  requireDurableWalletSendResultWithinAdmission,
  requireExactDurableWalletSendToken,
  type DurableWalletSendDeliveryAdmission,
} from "@bitcaster/client-sdk/durableWalletSendDelivery";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ProofOperationRecord } from "./proof-db";
import { requireFixedFullSpanUint8Array } from "./gui-durable-storage-binary";
import { GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS } from "./gui-durable-storage-artifacts";

export const GUI_WALLET_SEND_DELIVERY_METADATA_KEY =
  "guiWalletSendDelivery" as const;
/** Browser bearer-export policy; deliberately independent of engine HTTP. */
export const GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX = 1 * 1_024 * 1_024;
export const GUI_WALLET_SEND_PROOF_COUNT_LIMIT_MAX = 256;
export const GUI_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX = 8 * 1_024 * 1_024;
const RANDOM_FILL_CHUNK_BYTES = 65_536;

export interface GuiWalletSendDeliveryMetadata {
  schemaVersion: 1;
  mode: "user-export";
  admission: DurableWalletSendDeliveryAdmission;
}

export interface GuiWalletSendDeliveryPayloadRow {
  walletId: string;
  operationId: string;
  custodyOperationId: string;
  encodedToken: string;
  tokenDigest: string;
  tokenByteLength: number;
  createdAt: number;
}

export type GuiWalletSendDeliveryPayloadSnapshot = Omit<
  GuiWalletSendDeliveryPayloadRow,
  "encodedToken"
>;

export interface GuiWalletSendDeliveryReservationRow {
  walletId: string;
  operationId: string;
  custodyOperationId: string;
  admissionFingerprint: string;
  reservedBytes: number;
  paddingDigest: string;
  padding: Uint8Array;
  createdAt: number;
}

export type GuiWalletSendDeliveryReservationSnapshot = Omit<
  GuiWalletSendDeliveryReservationRow,
  "padding"
>;

export function guiWalletSendDeliveryMetadata(input: {
  mintUrl: string;
  unit: string;
  sendOutputs: readonly {
    secret: string;
    blindedMessage: { id: string };
  }[];
  keepOutputs?: readonly { secret: string; blindedMessage: { id: string } }[];
  passthroughProofs?: readonly { secret: string; id: string }[];
  inputProofs?: readonly { secret: string; id: string }[];
}): GuiWalletSendDeliveryMetadata {
  return {
    schemaVersion: 1,
    mode: "user-export",
    admission: planDurableWalletSendDeliveryAdmission({
      outputPlan: input,
      limits: {
        encodedTokenBytes: GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
        proofCount: GUI_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
        durableStorageBytes: GUI_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
        nativeOperationRowBytes:
          GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofOperations,
      },
    }),
  };
}

export function createGuiWalletSendDeliveryReservationRow(
  operation: ProofOperationRecord,
): GuiWalletSendDeliveryReservationRow {
  const metadata = readGuiWalletSendDeliveryMetadata(operation);
  if (operation.kind !== "wallet-send" || metadata?.mode !== "user-export") {
    throw new Error("GUI wallet-send reservation has no user-export operation");
  }
  const padding = new Uint8Array(
    metadata.admission.durableStorageBytesRequired,
  );
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure wallet-send reservation generation is unavailable");
  }
  for (
    let offset = 0;
    offset < padding.byteLength;
    offset += RANDOM_FILL_CHUNK_BYTES
  ) {
    globalThis.crypto.getRandomValues(
      padding.subarray(
        offset,
        Math.min(offset + RANDOM_FILL_CHUNK_BYTES, padding.byteLength),
      ),
    );
  }
  return requireGuiWalletSendDeliveryReservationRow(
    {
      walletId: operation.walletId,
      operationId: operation.operationId,
      custodyOperationId: operation.custodyOperationId,
      admissionFingerprint: deriveDurableCustodyArtifactFingerprint(
        metadata.admission,
      ),
      reservedBytes: padding.byteLength,
      paddingDigest: bytesToHex(sha256(padding)),
      padding,
      createdAt: operation.createdAt,
    },
    operation,
  );
}

export function requireGuiWalletSendDeliveryReservationRow(
  value: unknown,
  operation: Pick<
    ProofOperationRecord,
    | "walletId"
    | "operationId"
    | "custodyOperationId"
    | "kind"
    | "metadata"
    | "createdAt"
  >,
): GuiWalletSendDeliveryReservationRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI wallet-send reservation is invalid");
  }
  const row = value as Record<string, unknown>;
  const metadata = readGuiWalletSendDeliveryMetadata(operation);
  const padding = requireFixedFullSpanUint8Array(
    row.padding,
    "GUI wallet-send reservation padding",
    GUI_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
  );
  const expectedFingerprint = metadata
    ? deriveDurableCustodyArtifactFingerprint(metadata.admission)
    : "";
  if (
    Object.keys(row).length !== 8 ||
    operation.kind !== "wallet-send" ||
    metadata?.mode !== "user-export" ||
    typeof operation.walletId !== "string" ||
    !/^[0-9a-f]{64}$/.test(operation.walletId) ||
    typeof operation.operationId !== "string" ||
    operation.operationId.length < 1 ||
    operation.operationId.length > 512 ||
    typeof operation.custodyOperationId !== "string" ||
    operation.custodyOperationId.length < 1 ||
    operation.custodyOperationId.length > 512 ||
    row.walletId !== operation.walletId ||
    row.operationId !== operation.operationId ||
    row.custodyOperationId !== operation.custodyOperationId ||
    row.admissionFingerprint !== expectedFingerprint ||
    row.reservedBytes !== metadata.admission.durableStorageBytesRequired ||
    padding.byteLength !== row.reservedBytes ||
    typeof row.paddingDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.paddingDigest) ||
    bytesToHex(sha256(padding)) !== row.paddingDigest ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt !== operation.createdAt
  ) {
    throw new Error("GUI wallet-send reservation is invalid");
  }
  return { ...row, padding } as GuiWalletSendDeliveryReservationRow;
}

export function guiWalletSendDeliveryReservationSnapshot(
  row: GuiWalletSendDeliveryReservationRow,
): GuiWalletSendDeliveryReservationSnapshot {
  const { padding: _padding, ...snapshot } = row;
  return snapshot;
}

export function readGuiWalletSendDeliveryMetadata(
  operation: Pick<ProofOperationRecord, "kind" | "metadata">,
): GuiWalletSendDeliveryMetadata | null {
  const value = operation.metadata[GUI_WALLET_SEND_DELIVERY_METADATA_KEY];
  if (value === undefined) return null;
  if (
    operation.kind !== "wallet-send" ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("GUI wallet send delivery metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    record.mode !== "user-export"
  ) {
    throw new Error("GUI wallet send delivery metadata is invalid");
  }
  return {
    schemaVersion: 1,
    mode: record.mode,
    admission: requireDurableWalletSendDeliveryAdmission(record.admission),
  };
}

export function requireExactGuiWalletSendUserExportToken(
  operation: Pick<
    ProofOperationRecord,
    | "walletId"
    | "operationId"
    | "custodyOperationId"
    | "kind"
    | "state"
    | "mintUrl"
    | "metadata"
    | "resultProofs"
  >,
  payload: GuiWalletSendDeliveryPayloadRow,
  expectedToken?: string,
): string {
  if (
    operation.kind !== "wallet-send" ||
    operation.state !== "completed" ||
    readGuiWalletSendDeliveryMetadata(operation)?.mode !== "user-export" ||
    !operation.resultProofs
  ) {
    throw new Error("GUI wallet send has no completed user-export result");
  }
  const row = requireGuiWalletSendDeliveryPayloadRow(
    payload,
    operation.walletId,
    operation.operationId,
    operation.custodyOperationId,
  );
  const token = row.encodedToken;
  if (expectedToken !== undefined && token !== expectedToken) {
    throw new Error("GUI wallet send exact token is missing or conflicting");
  }
  const send = operation.resultProofs.send;
  const metadata = readGuiWalletSendDeliveryMetadata(operation);
  if (!send || typeof operation.metadata.unit !== "string" || !metadata) {
    throw new Error("GUI wallet send exact token conflicts with its result");
  }
  const descriptor = requireExactDurableWalletSendToken({
    encodedToken: token,
    mintUrl: operation.mintUrl,
    unit: operation.metadata.unit,
    sendProofs: send,
  });
  if (
    descriptor.tokenDigest !== row.tokenDigest ||
    descriptor.byteLength !== row.tokenByteLength
  ) {
    throw new Error("GUI wallet send payload descriptor is inconsistent");
  }
  requireDurableWalletSendResultWithinAdmission({
    admission: metadata.admission,
    encodedToken: token,
    sendProofCount: send.length,
    resultProofCount: Object.values(operation.resultProofs).flat().length,
  });
  return token;
}

export function guiWalletSendTokenFingerprint(encodedToken: string): string {
  return describeDurableWalletSendToken(encodedToken).tokenDigest;
}

export function createGuiWalletSendDeliveryPayloadRow(
  operation: ProofOperationRecord,
  encodedToken: string,
): GuiWalletSendDeliveryPayloadRow {
  const descriptor = describeDurableWalletSendToken(encodedToken);
  const row = {
    walletId: operation.walletId,
    operationId: operation.operationId,
    custodyOperationId: operation.custodyOperationId,
    encodedToken,
    tokenDigest: descriptor.tokenDigest,
    tokenByteLength: descriptor.byteLength,
    createdAt: operation.createdAt,
  } satisfies GuiWalletSendDeliveryPayloadRow;
  requireExactGuiWalletSendUserExportToken(operation, row, encodedToken);
  return row;
}

export function requireGuiWalletSendDeliveryPayloadRow(
  value: unknown,
  expectedWalletId?: string,
  expectedOperationId?: string,
  expectedCustodyOperationId?: string,
): GuiWalletSendDeliveryPayloadRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI wallet send delivery payload is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 7 ||
    typeof row.walletId !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.walletId) ||
    typeof row.operationId !== "string" ||
    row.operationId.length === 0 ||
    row.operationId.length > 512 ||
    typeof row.custodyOperationId !== "string" ||
    row.custodyOperationId.length === 0 ||
    row.custodyOperationId.length > 512 ||
    typeof row.encodedToken !== "string" ||
    typeof row.tokenDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.tokenDigest) ||
    !Number.isSafeInteger(row.tokenByteLength) ||
    (row.tokenByteLength as number) < 1 ||
    !Number.isSafeInteger(row.createdAt) ||
    (row.createdAt as number) < 0 ||
    (expectedWalletId !== undefined && row.walletId !== expectedWalletId) ||
    (expectedOperationId !== undefined &&
      row.operationId !== expectedOperationId) ||
    (expectedCustodyOperationId !== undefined &&
      row.custodyOperationId !== expectedCustodyOperationId)
  ) {
    throw new Error("GUI wallet send delivery payload is invalid");
  }
  const descriptor = describeDurableWalletSendToken(row.encodedToken);
  if (descriptor.byteLength > GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX) {
    throw new Error("GUI wallet send delivery payload exceeds its byte limit");
  }
  if (
    descriptor.tokenDigest !== row.tokenDigest ||
    descriptor.byteLength !== row.tokenByteLength
  ) {
    throw new Error("GUI wallet send delivery payload is corrupt");
  }
  return row as unknown as GuiWalletSendDeliveryPayloadRow;
}

export function guiWalletSendDeliveryPayloadSnapshot(
  row: GuiWalletSendDeliveryPayloadRow,
): GuiWalletSendDeliveryPayloadSnapshot {
  const validated = requireGuiWalletSendDeliveryPayloadRow(row);
  return {
    walletId: validated.walletId,
    operationId: validated.operationId,
    custodyOperationId: validated.custodyOperationId,
    tokenDigest: validated.tokenDigest,
    tokenByteLength: validated.tokenByteLength,
    createdAt: validated.createdAt,
  };
}
