import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import { describeDurableWalletSendToken } from "./durableWalletSendDelivery.ts";

export const DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION = 1 as const;

export interface DurableRecipientDeliveryRequest {
  schemaVersion: 1;
  deliveryId: string;
  accountSubject: string;
  recipientKind: string;
  purpose: string;
  destinationId: string;
  mintUrl: string;
  unit: string;
  requestedAmount: number;
  tokenDigest: string;
  encodedTokenBytes: number;
}

export type DurableRecipientDeliveryState =
  | { kind: "pending" }
  | {
      kind: "received";
      receiptOperationId: string;
      receivedAtMs: number;
    }
  | {
      kind: "credited";
      receiptOperationId: string;
      receivedAtMs: number;
      creditedAmount: number;
      businessEventId: string;
      creditedAtMs: number;
    };

export interface DurableRecipientDeliveryRecord {
  schemaVersion: 1;
  request: DurableRecipientDeliveryRequest;
  state: DurableRecipientDeliveryState;
}

export type DurableRecipientDeliveryEvidence =
  | { kind: "not-found" }
  | {
      kind: "received";
      request: DurableRecipientDeliveryRequest;
      receiptOperationId: string;
      receivedAtMs: number;
    }
  | {
      kind: "credited";
      request: DurableRecipientDeliveryRequest;
      receiptOperationId: string;
      receivedAtMs: number;
      creditedAmount: number;
      businessEventId: string;
      creditedAtMs: number;
    };

export function createDurableRecipientDeliveryRecord(input: {
  deliveryId: string;
  accountSubject: string;
  recipientKind: string;
  purpose: string;
  destinationId: string;
  mintUrl: string;
  unit: string;
  requestedAmount: number;
  encodedToken: string;
}): DurableRecipientDeliveryRecord {
  const descriptor = describeDurableWalletSendToken(input.encodedToken);
  return decodeDurableRecipientDeliveryRecord({
    schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    request: {
      schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
      deliveryId: input.deliveryId,
      accountSubject: input.accountSubject,
      recipientKind: input.recipientKind,
      purpose: input.purpose,
      destinationId: input.destinationId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      requestedAmount: input.requestedAmount,
      tokenDigest: descriptor.tokenDigest,
      encodedTokenBytes: descriptor.byteLength,
    },
    state: { kind: "pending" },
  });
}

export function reduceDurableRecipientDelivery(
  value: unknown,
  evidenceValue: unknown,
): DurableRecipientDeliveryRecord {
  const record = decodeDurableRecipientDeliveryRecord(value);
  const evidence = decodeDurableRecipientDeliveryEvidence(evidenceValue);
  if (evidence.kind === "not-found") return record;
  assertSameRequest(record.request, evidence.request);
  return {
    ...record,
    state: reduceState(record.state, evidence),
  };
}

export function decodeDurableRecipientDeliveryRecord(
  value: unknown,
): DurableRecipientDeliveryRecord {
  const record = requireRecord(value, "durable recipient delivery");
  requireExactFields(record, ["schemaVersion", "request", "state"]);
  if (record.schemaVersion !== DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION) {
    throw new Error("unsupported durable recipient delivery schema version");
  }
  return {
    schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    request: decodeRequest(record.request),
    state: decodeState(record.state),
  };
}

export function decodeDurableRecipientDeliveryEvidence(
  value: unknown,
): DurableRecipientDeliveryEvidence {
  const evidence = requireRecord(value, "durable recipient delivery evidence");
  if (evidence.kind === "not-found") {
    requireExactFields(evidence, ["kind"]);
    return { kind: "not-found" };
  }
  if (evidence.kind === "received") {
    requireExactFields(evidence, [
      "kind",
      "request",
      "receiptOperationId",
      "receivedAtMs",
    ]);
    return decodeReceivedEvidence(evidence);
  }
  if (evidence.kind === "credited") {
    requireExactFields(evidence, [
      "kind",
      "request",
      "receiptOperationId",
      "receivedAtMs",
      "creditedAmount",
      "businessEventId",
      "creditedAtMs",
    ]);
    return decodeCreditedEvidence(evidence);
  }
  throw new Error("durable recipient delivery evidence kind is invalid");
}

function decodeRequest(value: unknown): DurableRecipientDeliveryRequest {
  const request = requireRecord(value, "durable recipient delivery request");
  requireExactFields(request, [
    "schemaVersion",
    "deliveryId",
    "accountSubject",
    "recipientKind",
    "purpose",
    "destinationId",
    "mintUrl",
    "unit",
    "requestedAmount",
    "tokenDigest",
    "encodedTokenBytes",
  ]);
  if (request.schemaVersion !== DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION) {
    throw new Error("unsupported durable recipient delivery request version");
  }
  return {
    schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    deliveryId: requireText(request.deliveryId, "delivery id", 256),
    accountSubject: requireText(request.accountSubject, "account subject", 512),
    recipientKind: requireText(request.recipientKind, "recipient kind", 128),
    purpose: requireText(request.purpose, "purpose", 128),
    destinationId: requireText(request.destinationId, "destination id", 512),
    mintUrl: normalizeDurableWalletMintUrl(
      requireText(request.mintUrl, "mint URL", 2_048),
    ),
    unit: requireText(request.unit, "unit", 64),
    requestedAmount: requirePositiveInteger(
      request.requestedAmount,
      "requested amount",
    ),
    tokenDigest: requireDigest(request.tokenDigest),
    encodedTokenBytes: requirePositiveInteger(
      request.encodedTokenBytes,
      "encoded token bytes",
    ),
  };
}

function decodeState(value: unknown): DurableRecipientDeliveryState {
  const state = requireRecord(value, "durable recipient delivery state");
  if (state.kind === "pending") {
    requireExactFields(state, ["kind"]);
    return { kind: "pending" };
  }
  if (state.kind === "received") {
    requireExactFields(state, ["kind", "receiptOperationId", "receivedAtMs"]);
    return decodeReceivedFields(state);
  }
  if (state.kind === "credited") {
    requireExactFields(state, [
      "kind",
      "receiptOperationId",
      "receivedAtMs",
      "creditedAmount",
      "businessEventId",
      "creditedAtMs",
    ]);
    return decodeCreditedFields(state);
  }
  throw new Error("durable recipient delivery state kind is invalid");
}

function decodeReceivedEvidence(
  value: Record<string, unknown>,
): Extract<DurableRecipientDeliveryEvidence, { kind: "received" }> {
  return {
    request: decodeRequest(value.request),
    ...decodeReceivedFields(value),
  };
}

function decodeCreditedEvidence(
  value: Record<string, unknown>,
): Extract<DurableRecipientDeliveryEvidence, { kind: "credited" }> {
  return {
    request: decodeRequest(value.request),
    ...decodeCreditedFields(value),
  };
}

function decodeReceivedFields(value: Record<string, unknown>): {
  kind: "received";
  receiptOperationId: string;
  receivedAtMs: number;
} {
  return {
    kind: "received",
    receiptOperationId: requireText(
      value.receiptOperationId,
      "receipt operation id",
      512,
    ),
    receivedAtMs: requireTimestamp(value.receivedAtMs, "received time"),
  };
}

function decodeCreditedFields(value: Record<string, unknown>): {
  kind: "credited";
  receiptOperationId: string;
  receivedAtMs: number;
  creditedAmount: number;
  businessEventId: string;
  creditedAtMs: number;
} {
  const receivedAtMs = requireTimestamp(value.receivedAtMs, "received time");
  const creditedAtMs = requireTimestamp(value.creditedAtMs, "credited time");
  if (creditedAtMs < receivedAtMs) {
    throw new Error("durable recipient credit precedes its receipt");
  }
  return {
    kind: "credited",
    receiptOperationId: requireText(
      value.receiptOperationId,
      "receipt operation id",
      512,
    ),
    receivedAtMs,
    creditedAmount: requirePositiveInteger(
      value.creditedAmount,
      "credited amount",
    ),
    businessEventId: requireText(
      value.businessEventId,
      "business event id",
      512,
    ),
    creditedAtMs,
  };
}

function reduceState(
  current: DurableRecipientDeliveryState,
  evidence: Exclude<DurableRecipientDeliveryEvidence, { kind: "not-found" }>,
): DurableRecipientDeliveryState {
  if (evidence.kind === "received") {
    const received = receivedState(evidence);
    if (current.kind === "pending") return received;
    if (current.kind === "credited") return current;
    assertSameState(current, received);
    return current;
  }
  const credited = creditedState(evidence);
  if (current.kind === "pending") return credited;
  if (current.receiptOperationId !== credited.receiptOperationId) {
    throw new Error("durable recipient receipt operation conflicts");
  }
  if (current.receivedAtMs !== credited.receivedAtMs) {
    throw new Error("durable recipient receipt time conflicts");
  }
  if (current.kind === "received") return credited;
  assertSameState(current, credited);
  return current;
}

function receivedState(
  evidence: Extract<DurableRecipientDeliveryEvidence, { kind: "received" }>,
): Extract<DurableRecipientDeliveryState, { kind: "received" }> {
  return {
    kind: "received",
    receiptOperationId: evidence.receiptOperationId,
    receivedAtMs: evidence.receivedAtMs,
  };
}

function creditedState(
  evidence: Extract<DurableRecipientDeliveryEvidence, { kind: "credited" }>,
): Extract<DurableRecipientDeliveryState, { kind: "credited" }> {
  return {
    kind: "credited",
    receiptOperationId: evidence.receiptOperationId,
    receivedAtMs: evidence.receivedAtMs,
    creditedAmount: evidence.creditedAmount,
    businessEventId: evidence.businessEventId,
    creditedAtMs: evidence.creditedAtMs,
  };
}

function assertSameRequest(
  actual: DurableRecipientDeliveryRequest,
  expected: DurableRecipientDeliveryRequest,
): void {
  for (const key of Object.keys(
    actual,
  ) as (keyof DurableRecipientDeliveryRequest)[]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`durable recipient delivery request ${key} conflicts`);
    }
  }
}

function assertSameState(
  actual: Exclude<DurableRecipientDeliveryState, { kind: "pending" }>,
  expected: Exclude<DurableRecipientDeliveryState, { kind: "pending" }>,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("durable recipient delivery result conflicts");
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error("durable recipient delivery fields are invalid");
  }
}

function requireText(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new Error(`durable recipient delivery ${name} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`durable recipient delivery ${name} is invalid`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`durable recipient delivery ${name} is invalid`);
  }
  return value as number;
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("durable recipient delivery token digest is invalid");
  }
  return value;
}
