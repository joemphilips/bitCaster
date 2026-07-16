import {
  createDurableOutgoingRecipientDeliveryRecord,
  decodeDurableOutgoingRecipientDeliveryRecord,
  type DurableOutgoingRecipientDeliveryRecord,
} from "@bitcaster/client-sdk/durableOutgoingRecipientDelivery";
import {
  decodeDurableRecipientDeliveryIntent,
  type DurableRecipientDeliveryIntent,
} from "@bitcaster/client-sdk/durableWalletSendDeliveryPreparation";
import type { DurableWalletSendExactPayload } from "@bitcaster/client-sdk/durableWalletSendExactPayload";
import type { GuiWalletSendDeliveryMetadata } from "./gui-wallet-send-delivery";
import {
  assertGuiOutgoingRecipientAdapterMatchesDelivery,
  requireGuiOutgoingRecipientAdapter,
  type GuiOutgoingRecipientAdapter,
} from "./gui-outgoing-recipient-adapter";

interface PreparedGuiOutgoingRecipientDelivery {
  kind: "prepared";
  recipient: DurableRecipientDeliveryIntent;
}

interface ActiveGuiOutgoingRecipientDelivery {
  kind: "active";
  record: DurableOutgoingRecipientDeliveryRecord;
}

export interface GuiOutgoingRecipientDeliveryRow {
  walletId: string;
  deliveryId: string;
  operationId: string;
  adapter: GuiOutgoingRecipientAdapter;
  revision: number;
  active: 0 | 1;
  nextAttemptAtMs: number;
  attemptCount: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  delivery:
    | PreparedGuiOutgoingRecipientDelivery
    | ActiveGuiOutgoingRecipientDelivery;
}

export function createPreparedGuiOutgoingRecipientDeliveryRow(input: {
  walletId: string;
  operationId: string;
  metadata: GuiWalletSendDeliveryMetadata;
  nowMs: number;
}): GuiOutgoingRecipientDeliveryRow | undefined {
  if (input.metadata.mode !== "durable-recipient-ack") return undefined;
  return requireGuiOutgoingRecipientDeliveryRow({
    walletId: input.walletId,
    deliveryId: input.metadata.recipient.deliveryId,
    operationId: input.operationId,
    adapter: input.metadata.adapter,
    revision: 0,
    active: 1,
    nextAttemptAtMs: 0,
    attemptCount: 0,
    lastError: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    delivery: {
      kind: "prepared",
      recipient: input.metadata.recipient,
    },
  });
}

export function completeGuiOutgoingRecipientDeliveryRow(
  currentValue: unknown,
  exactPayload: DurableWalletSendExactPayload,
  nowMs: number,
): GuiOutgoingRecipientDeliveryRow {
  const current = requireGuiOutgoingRecipientDeliveryRow(currentValue);
  const record = createDurableOutgoingRecipientDeliveryRecord({
    exactPayload,
  });
  const recipient = record.delivery.request;
  if (
    current.delivery.kind !== "prepared" ||
    current.deliveryId !== recipient.deliveryId ||
    current.delivery.recipient.deliveryId !== recipient.deliveryId ||
    current.delivery.recipient.accountSubject !== recipient.accountSubject ||
    current.delivery.recipient.recipientKind !== recipient.recipientKind ||
    current.delivery.recipient.purpose !== recipient.purpose ||
    current.delivery.recipient.destinationId !== recipient.destinationId ||
    current.delivery.recipient.productBinding !== recipient.productBinding ||
    current.delivery.recipient.mintUrl !== recipient.mintUrl ||
    current.delivery.recipient.unit !== recipient.unit ||
    current.delivery.recipient.requestedAmount !==
      recipient.requestedAmount ||
    current.delivery.recipient.creditPolicy.kind !==
      recipient.creditPolicy.kind
  ) {
    throw new Error("GUI outgoing recipient completion conflicts");
  }
  return requireGuiOutgoingRecipientDeliveryRow({
    ...current,
    revision: current.revision + 1,
    updatedAtMs: requireMonotonicTime(nowMs, current.updatedAtMs),
    delivery: { kind: "active", record },
  });
}

export function updateGuiOutgoingRecipientDeliveryRow(input: {
  current: unknown;
  record: unknown;
  nowMs: number;
  nextAttemptAtMs: number;
  attemptCount: number;
  lastError: string | null;
}): GuiOutgoingRecipientDeliveryRow {
  const current = requireGuiOutgoingRecipientDeliveryRow(input.current);
  const record = decodeDurableOutgoingRecipientDeliveryRecord(input.record);
  if (
    current.delivery.kind !== "active" ||
    current.deliveryId !== record.delivery.request.deliveryId ||
    current.operationId !== record.exactPayload.walletOperationId
  ) {
    throw new Error("GUI outgoing recipient update conflicts");
  }
  const active = record.delivery.state.kind === "credited" ? 0 : 1;
  return requireGuiOutgoingRecipientDeliveryRow({
    ...current,
    revision: current.revision + 1,
    active,
    nextAttemptAtMs: active === 0 ? Number.MAX_SAFE_INTEGER : input.nextAttemptAtMs,
    attemptCount: input.attemptCount,
    lastError: input.lastError,
    updatedAtMs: requireMonotonicTime(input.nowMs, current.updatedAtMs),
    delivery: { kind: "active", record },
  });
}

export function requireGuiOutgoingRecipientDeliveryRow(
  value: unknown,
  expectedWalletId?: string,
  expectedDeliveryId?: string,
  expectedOperationId?: string,
): GuiOutgoingRecipientDeliveryRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI outgoing recipient row is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 12 ||
    typeof row.walletId !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.walletId) ||
    typeof row.deliveryId !== "string" ||
    row.deliveryId.length < 1 ||
    row.deliveryId.length > 256 ||
    typeof row.operationId !== "string" ||
    row.operationId.length < 1 ||
    row.operationId.length > 512 ||
    !isNonnegativeSafeInteger(row.revision) ||
    (row.active !== 0 && row.active !== 1) ||
    !isNonnegativeSafeInteger(row.nextAttemptAtMs) ||
    !isNonnegativeSafeInteger(row.attemptCount) ||
    (row.lastError !== null &&
      (typeof row.lastError !== "string" ||
        row.lastError.length < 1 ||
        row.lastError.length > 1_024)) ||
    !isNonnegativeSafeInteger(row.createdAtMs) ||
    !isNonnegativeSafeInteger(row.updatedAtMs) ||
    (row.updatedAtMs as number) < (row.createdAtMs as number) ||
    (expectedWalletId !== undefined && row.walletId !== expectedWalletId) ||
    (expectedDeliveryId !== undefined &&
      row.deliveryId !== expectedDeliveryId) ||
    (expectedOperationId !== undefined &&
      row.operationId !== expectedOperationId)
  ) {
    throw new Error("GUI outgoing recipient row is invalid");
  }
  const delivery = decodeDelivery(row.delivery);
  const adapter = requireGuiOutgoingRecipientAdapter(row.adapter);
  assertGuiOutgoingRecipientAdapterMatchesDelivery(
    adapter,
    delivery.kind === "prepared"
      ? delivery.recipient
      : delivery.record.delivery.request,
  );
  const stateKind =
    delivery.kind === "prepared"
      ? "prepared"
      : delivery.record.delivery.state.kind;
  if (
    delivery.kind === "prepared" &&
    delivery.recipient.deliveryId !== row.deliveryId
  ) {
    throw new Error("GUI outgoing recipient row is invalid");
  }
  if (
    delivery.kind === "active" &&
    (delivery.record.delivery.request.deliveryId !== row.deliveryId ||
      delivery.record.exactPayload.walletOperationId !== row.operationId)
  ) {
    throw new Error("GUI outgoing recipient row is invalid");
  }
  const expectedActive = stateKind === "credited" ? 0 : 1;
  if (
    row.active !== expectedActive ||
    (expectedActive === 0 && row.nextAttemptAtMs !== Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("GUI outgoing recipient row is invalid");
  }
  return {
    walletId: row.walletId as string,
    deliveryId: row.deliveryId as string,
    operationId: row.operationId as string,
    adapter,
    revision: row.revision as number,
    active: expectedActive,
    nextAttemptAtMs: row.nextAttemptAtMs as number,
    attemptCount: row.attemptCount as number,
    lastError: row.lastError as string | null,
    createdAtMs: row.createdAtMs as number,
    updatedAtMs: row.updatedAtMs as number,
    delivery,
  };
}

function decodeDelivery(
  value: unknown,
):
  | PreparedGuiOutgoingRecipientDelivery
  | ActiveGuiOutgoingRecipientDelivery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI outgoing recipient delivery is invalid");
  }
  const delivery = value as Record<string, unknown>;
  if (
    delivery.kind === "prepared" &&
    Object.keys(delivery).length === 2
  ) {
    return {
      kind: delivery.kind,
      recipient: decodeDurableRecipientDeliveryIntent(delivery.recipient),
    };
  }
  if (delivery.kind === "active" && Object.keys(delivery).length === 2) {
    return {
      kind: delivery.kind,
      record: decodeDurableOutgoingRecipientDeliveryRecord(delivery.record),
    };
  }
  throw new Error("GUI outgoing recipient delivery is invalid");
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireMonotonicTime(value: number, previous: number): number {
  if (!isNonnegativeSafeInteger(value)) {
    throw new Error("GUI outgoing recipient time is invalid");
  }
  return Math.max(value, previous);
}
