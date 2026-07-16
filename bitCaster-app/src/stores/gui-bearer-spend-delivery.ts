import {
  decodeDurableBearerSpendDeliveryRecord,
  isDurableBearerSpendTokenPresentable,
  type DurableBearerSpendDeliveryRecord,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";

export const GUI_BEARER_SPEND_DELIVERY_ADAPTER_SCHEMA_VERSION = 1;

export interface GuiBearerSpendDeliveryRow {
  adapterSchemaVersion: 1;
  walletId: string;
  deliveryId: string;
  parentOperationId: string;
  payloadHandle: string;
  active: 0 | 1;
  presentable: 0 | 1;
  createdAtMs: number;
  nextAttemptAtMs: number | null;
  record: DurableBearerSpendDeliveryRecord;
  updatedAtMs: number;
}

export function createGuiBearerSpendDeliveryRow(
  value: DurableBearerSpendDeliveryRecord,
): GuiBearerSpendDeliveryRow {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  return requireGuiBearerSpendDeliveryRow({
    adapterSchemaVersion: GUI_BEARER_SPEND_DELIVERY_ADAPTER_SCHEMA_VERSION,
    walletId: record.walletId,
    deliveryId: record.deliveryId,
    parentOperationId: record.parentOperationId,
    payloadHandle: record.payloadHandle,
    active: record.state.kind === "pending" ? 1 : 0,
    presentable: isDurableBearerSpendTokenPresentable(record) ? 1 : 0,
    createdAtMs: record.createdAtMs,
    nextAttemptAtMs:
      record.state.kind === "pending" ? record.state.nextAttemptAtMs : null,
    record,
    updatedAtMs:
      record.state.kind === "pending"
        ? (record.state.lastObservedAtMs ?? record.createdAtMs)
        : record.state.completedAtMs,
  });
}

export function requireGuiBearerSpendDeliveryRow(
  value: unknown,
  expectedWalletId?: string,
  expectedDeliveryId?: string,
  expectedParentOperationId?: string,
): GuiBearerSpendDeliveryRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI bearer spend delivery row is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 11 ||
    row.adapterSchemaVersion !==
      GUI_BEARER_SPEND_DELIVERY_ADAPTER_SCHEMA_VERSION
  ) {
    throw new Error("GUI bearer spend delivery row is invalid");
  }
  const record = decodeDurableBearerSpendDeliveryRecord(row.record);
  const active = record.state.kind === "pending" ? 1 : 0;
  const presentable = isDurableBearerSpendTokenPresentable(record) ? 1 : 0;
  const nextAttemptAtMs =
    record.state.kind === "pending" ? record.state.nextAttemptAtMs : null;
  const updatedAtMs =
    record.state.kind === "pending"
      ? (record.state.lastObservedAtMs ?? record.createdAtMs)
      : record.state.completedAtMs;
  if (
    row.walletId !== record.walletId ||
    row.deliveryId !== record.deliveryId ||
    row.parentOperationId !== record.parentOperationId ||
    row.payloadHandle !== record.payloadHandle ||
    row.active !== active ||
    row.presentable !== presentable ||
    row.createdAtMs !== record.createdAtMs ||
    row.nextAttemptAtMs !== nextAttemptAtMs ||
    row.updatedAtMs !== updatedAtMs ||
    (expectedWalletId !== undefined && row.walletId !== expectedWalletId) ||
    (expectedDeliveryId !== undefined &&
      row.deliveryId !== expectedDeliveryId) ||
    (expectedParentOperationId !== undefined &&
      row.parentOperationId !== expectedParentOperationId)
  ) {
    throw new Error("GUI bearer spend delivery row is invalid");
  }
  return {
    adapterSchemaVersion: GUI_BEARER_SPEND_DELIVERY_ADAPTER_SCHEMA_VERSION,
    walletId: record.walletId,
    deliveryId: record.deliveryId,
    parentOperationId: record.parentOperationId,
    payloadHandle: record.payloadHandle,
    active,
    presentable,
    createdAtMs: record.createdAtMs,
    nextAttemptAtMs,
    record,
    updatedAtMs,
  };
}

export function requireGuiBearerSpendDeliveryRowWithinByteBound(
  value: unknown,
  maximumBytes: number,
): GuiBearerSpendDeliveryRow {
  const row = requireGuiBearerSpendDeliveryRow(value);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("GUI bearer spend row byte bound is invalid");
  }
  const artifact = createGuiDurableStorageRowArtifact({
    table: "bearerSpendDeliveries",
    key: [row.walletId, row.deliveryId],
    artifactRole: "private-material",
    row,
  });
  if (
    new TextEncoder().encode(artifact.encodedJson).byteLength > maximumBytes
  ) {
    throw new Error("GUI bearer spend row exceeds its admitted byte bound");
  }
  return row;
}
