import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import { describeDurableWalletSendToken } from "./durableWalletSendDelivery.ts";
import { createStrictCodec } from "./strictCodec.ts";

export const DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION = 1 as const;

const {
  requireExactFields,
  requireNonNegativeDecimal,
  requirePositiveDecimal,
  requireRecord,
  requireText,
} = createStrictCodec({
  errorPrefix: "durable recipient delivery",
  exactFieldsError: "durable recipient delivery fields are invalid",
});

export type DurableRecipientCreditPolicy =
  | { kind: "exact-amount" }
  | { kind: "net-of-receive-fee" };

export type DurableRecipientCreditVerification =
  | { kind: "exact-amount" }
  | {
      kind: "net-of-receive-fee";
      receiveFeeAmount: string;
    };

export interface DurableRecipientDeliveryRequest {
  schemaVersion: 1;
  deliveryId: string;
  accountSubject: string;
  recipientKind: string;
  purpose: string;
  destinationId: string;
  mintUrl: string;
  unit: string;
  requestedAmount: string;
  creditPolicy: DurableRecipientCreditPolicy;
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
      creditedAmount: string;
      creditVerification: DurableRecipientCreditVerification;
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
      creditedAmount: string;
      creditVerification: DurableRecipientCreditVerification;
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
  requestedAmount: string;
  creditPolicy: DurableRecipientCreditPolicy;
  encodedToken: string;
}): DurableRecipientDeliveryRecord {
  const token = describeDurableWalletSendToken(input.encodedToken);
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
      creditPolicy: input.creditPolicy,
      tokenDigest: token.tokenDigest,
      encodedTokenBytes: token.byteLength,
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
  const request = decodeRequest(record.request);
  const state = decodeState(record.state);
  if (state.kind === "credited") {
    verifyDurableRecipientCredit({
      request,
      creditedAmount: state.creditedAmount,
      creditVerification: state.creditVerification,
    });
  }
  return {
    schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    request,
    state,
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
      "creditVerification",
      "businessEventId",
      "creditedAtMs",
    ]);
    return decodeCreditedEvidence(evidence);
  }
  throw new Error("durable recipient delivery evidence kind is invalid");
}

function decodeRequest(value: unknown): DurableRecipientDeliveryRequest {
  const raw = requireRecord(value, "durable recipient delivery request");
  requireExactFields(raw, [
    "schemaVersion",
    "deliveryId",
    "accountSubject",
    "recipientKind",
    "purpose",
    "destinationId",
    "mintUrl",
    "unit",
    "requestedAmount",
    "creditPolicy",
    "tokenDigest",
    "encodedTokenBytes",
  ]);
  if (raw.schemaVersion !== DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION) {
    throw new Error("unsupported durable recipient delivery request version");
  }
  const request = {
    schemaVersion: DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    deliveryId: requireText(raw.deliveryId, "delivery id", 256),
    accountSubject: requireText(raw.accountSubject, "account subject", 512),
    recipientKind: requireText(raw.recipientKind, "recipient kind", 128),
    purpose: requireText(raw.purpose, "purpose", 128),
    destinationId: requireText(raw.destinationId, "destination id", 512),
    mintUrl: normalizeDurableWalletMintUrl(
      requireText(raw.mintUrl, "mint URL", 2_048),
    ),
    unit: requireText(raw.unit, "unit", 64),
    requestedAmount: requirePositiveDecimal(
      raw.requestedAmount,
      "requested amount",
    ),
    creditPolicy: decodeDurableRecipientCreditPolicy(raw.creditPolicy),
    tokenDigest: requireDigest(raw.tokenDigest),
    encodedTokenBytes: requirePositiveInteger(
      raw.encodedTokenBytes,
      "encoded token bytes",
    ),
  };
  return request;
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
      "creditVerification",
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
  const request = decodeRequest(value.request);
  const fields = decodeCreditedFields(value);
  verifyDurableRecipientCredit({
    request,
    creditedAmount: fields.creditedAmount,
    creditVerification: fields.creditVerification,
  });
  return {
    request,
    ...fields,
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
  creditedAmount: string;
  creditVerification: DurableRecipientCreditVerification;
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
    creditedAmount: requirePositiveDecimal(
      value.creditedAmount,
      "credited amount",
    ),
    creditVerification: decodeDurableRecipientCreditVerification(
      value.creditVerification,
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
    creditVerification: evidence.creditVerification,
    businessEventId: evidence.businessEventId,
    creditedAtMs: evidence.creditedAtMs,
  };
}

export function decodeDurableRecipientCreditPolicy(
  value: unknown,
): DurableRecipientCreditPolicy {
  const policy = requireRecord(value, "durable recipient credit policy");
  requireExactFields(policy, ["kind"]);
  switch (policy.kind) {
    case "exact-amount":
      return { kind: "exact-amount" };
    case "net-of-receive-fee":
      return { kind: "net-of-receive-fee" };
    default:
      throw new Error("durable recipient credit policy is invalid");
  }
}

export function decodeDurableRecipientCreditVerification(
  value: unknown,
): DurableRecipientCreditVerification {
  const verification = requireRecord(
    value,
    "durable recipient credit verification",
  );
  switch (verification.kind) {
    case "exact-amount":
      requireExactFields(verification, ["kind"]);
      return { kind: "exact-amount" };
    case "net-of-receive-fee":
      requireExactFields(verification, ["kind", "receiveFeeAmount"]);
      return {
        kind: "net-of-receive-fee",
        receiveFeeAmount: requireNonNegativeDecimal(
          verification.receiveFeeAmount,
          "receive fee amount",
        ),
      };
    default:
      throw new Error("durable recipient credit verification is invalid");
  }
}

export function verifyDurableRecipientCredit(input: {
  request: DurableRecipientDeliveryRequest;
  creditedAmount: string;
  creditVerification: DurableRecipientCreditVerification;
}): void {
  const creditedAmount = requirePositiveDecimal(
    input.creditedAmount,
    "credited amount",
  );
  const verification = decodeDurableRecipientCreditVerification(
    input.creditVerification,
  );
  switch (input.request.creditPolicy.kind) {
    case "exact-amount":
      if (
        verification.kind !== "exact-amount" ||
        creditedAmount !== input.request.requestedAmount
      ) {
        throw new Error("exact recipient credit verification is invalid");
      }
      return;
    case "net-of-receive-fee":
      if (
        verification.kind !== "net-of-receive-fee" ||
        BigInt(creditedAmount) + BigInt(verification.receiveFeeAmount) !==
          BigInt(input.request.requestedAmount)
      ) {
        throw new Error("net recipient credit verification is invalid");
      }
      return;
    default:
      return assertNever(input.request.creditPolicy);
  }
}

function assertSameRequest(
  actual: DurableRecipientDeliveryRequest,
  expected: DurableRecipientDeliveryRequest,
): void {
  for (const key of Object.keys(
    actual,
  ) as (keyof DurableRecipientDeliveryRequest)[]) {
    if (key === "creditPolicy") {
      if (actual.creditPolicy.kind !== expected.creditPolicy.kind) {
        throw new Error(
          "durable recipient delivery request creditPolicy conflicts",
        );
      }
      continue;
    }
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

function assertNever(value: never): never {
  throw new Error(`unhandled durable recipient credit variant: ${value}`);
}
