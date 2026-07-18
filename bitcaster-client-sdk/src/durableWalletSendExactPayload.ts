import { deriveDurableCustodyArtifactFingerprint } from "./durableCustody.ts";
import { requireExactDurableWalletSendResult } from "./durableWalletOperation.ts";
import {
  requireDurableWalletSendResultWithinAdmission,
  requireExactDurableWalletSendToken,
} from "./durableWalletSendDelivery.ts";
import {
  decodeDurableWalletSendDeliveryPreparation,
  requireDurableWalletSendDeliveryPreparationForOperation,
  type DurableWalletSendDeliveryPreparation,
} from "./durableWalletSendDeliveryPreparation.ts";
import {
  issueDurableWalletSendExactPayloadCapability,
  requireDurableWalletSendExactPayloadCapability,
  type DurableWalletSendExactPayloadCapability,
} from "./durableWalletSendExactPayloadAuthority.ts";
import { createStrictCodec } from "./strictCodec.ts";

const {
  requireRecord,
  requireExactFields,
  requireText,
  requirePositiveDecimal,
} = createStrictCodec({
  errorPrefix: "durable wallet-send exact payload",
  exactFieldsError: "durable wallet-send exact payload fields are invalid",
});

export interface DurableWalletSendExactPayload extends DurableWalletSendExactPayloadCapability {
  readonly preparation: DurableWalletSendDeliveryPreparation;
  readonly walletOperationId: string;
  readonly walletRequestFingerprint: string;
  readonly walletOutputPlanFingerprint: string;
  readonly resultFingerprint: string;
  readonly payloadHandle: string;
  readonly tokenDigest: string;
  readonly encodedTokenBytes: number;
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: string;
}

export function planDurableWalletSendExactPayload(input: {
  preparation: unknown;
  walletOperation: unknown;
  resultGroups: unknown;
  payloadHandle: string;
  encodedToken: string;
}): DurableWalletSendExactPayload {
  const { preparation, result, descriptor, mintUrl, unit } =
    resolveExactPayloadPlan(input);
  const payloadHandle = requireText(input.payloadHandle, "payload handle", 512);
  const payload = Object.freeze({
    kind: "durable-wallet-send-exact-payload" as const,
    preparation,
    walletOperationId: result.walletOperationId,
    walletRequestFingerprint: result.requestFingerprint,
    walletOutputPlanFingerprint: result.outputPlanFingerprint,
    resultFingerprint: result.resultFingerprint,
    payloadHandle,
    tokenDigest: descriptor.tokenDigest,
    encodedTokenBytes: descriptor.byteLength,
    mintUrl,
    unit,
    amount: result.amount,
  });
  return issueDurableWalletSendExactPayloadCapability(payload, {
    policyKind: preparation.policyKind,
    deliveryIntentFingerprint: preparation.intentFingerprint,
    walletOperationId: result.walletOperationId,
    activityId: preparation.activityId,
    walletRequestFingerprint: result.requestFingerprint,
    walletOutputPlanFingerprint: result.outputPlanFingerprint,
    resultFingerprint: result.resultFingerprint,
    payloadHandle,
    tokenDigest: descriptor.tokenDigest,
    encodedTokenBytes: descriptor.byteLength,
    mintUrl,
    unit,
    amount: result.amount,
    encodedToken: input.encodedToken,
  });
}

export function decodeDurableWalletSendExactPayloadMetadata(
  value: unknown,
): Omit<DurableWalletSendExactPayload, "kind"> {
  const record = requireRecord(value, "durable wallet-send exact payload");
  requireExactPayloadFields(record);
  const preparation = decodeDurableWalletSendDeliveryPreparation(
    record.preparation,
  );
  const decoded = decodeExactPayloadMetadata(record, preparation);
  assertMetadataMatchesPreparation(decoded);
  return decoded;
}

function requireExactPayloadFields(record: Record<string, unknown>): void {
  requireExactFields(record, [
    "preparation",
    "walletOperationId",
    "walletRequestFingerprint",
    "walletOutputPlanFingerprint",
    "resultFingerprint",
    "payloadHandle",
    "tokenDigest",
    "encodedTokenBytes",
    "mintUrl",
    "unit",
    "amount",
  ]);
}

function decodeExactPayloadMetadata(
  record: Record<string, unknown>,
  preparation: DurableWalletSendDeliveryPreparation,
): Omit<DurableWalletSendExactPayload, "kind"> {
  return {
    preparation,
    walletOperationId: requireText(
      record.walletOperationId,
      "wallet operation id",
      512,
    ),
    walletRequestFingerprint: requireFingerprint(
      record.walletRequestFingerprint,
      "wallet request fingerprint",
    ),
    walletOutputPlanFingerprint: requireFingerprint(
      record.walletOutputPlanFingerprint,
      "wallet output plan fingerprint",
    ),
    resultFingerprint: requireFingerprint(
      record.resultFingerprint,
      "result fingerprint",
    ),
    payloadHandle: requireText(record.payloadHandle, "payload handle", 512),
    tokenDigest: requireFingerprint(record.tokenDigest, "token digest"),
    encodedTokenBytes: requirePositiveInteger(
      record.encodedTokenBytes,
      "encoded token bytes",
    ),
    mintUrl: requireText(record.mintUrl, "mint URL", 2_048),
    unit: requireText(record.unit, "unit", 64),
    amount: requirePositiveDecimal(record.amount, "amount"),
  };
}

function assertMetadataMatchesPreparation(
  decoded: Omit<DurableWalletSendExactPayload, "kind">,
): void {
  const preparation = decoded.preparation;
  if (
    decoded.walletOperationId !== preparation.walletOperationId ||
    decoded.walletRequestFingerprint !== preparation.walletRequestFingerprint ||
    decoded.walletOutputPlanFingerprint !==
      preparation.walletOutputPlanFingerprint ||
    decoded.encodedTokenBytes >
      preparation.admission.encodedTokenBytesUpperBound ||
    (preparation.policy.kind === "durable-recipient-ack" &&
      (decoded.mintUrl !== preparation.policy.recipient.mintUrl ||
        decoded.unit !== preparation.policy.recipient.unit ||
        decoded.amount !== preparation.policy.recipient.requestedAmount))
  ) {
    throw new Error("durable wallet-send exact payload metadata is invalid");
  }
}

export function describeDurableWalletSendExactPayload(
  exactPayload: DurableWalletSendExactPayload,
): Omit<DurableWalletSendExactPayload, "kind"> {
  const binding = requireDurableWalletSendExactPayloadCapability(exactPayload);
  return decodeDurableWalletSendExactPayloadMetadata({
    preparation: exactPayload.preparation,
    walletOperationId: binding.walletOperationId,
    walletRequestFingerprint: binding.walletRequestFingerprint,
    walletOutputPlanFingerprint: binding.walletOutputPlanFingerprint,
    resultFingerprint: binding.resultFingerprint,
    payloadHandle: binding.payloadHandle,
    tokenDigest: binding.tokenDigest,
    encodedTokenBytes: binding.encodedTokenBytes,
    mintUrl: binding.mintUrl,
    unit: binding.unit,
    amount: binding.amount,
  });
}

/**
 * Rebuilds the non-clonable exact-payload capability from one committed row.
 * It reuses the exact persisted operation and result groups; it never plans
 * outputs or selects proofs.
 */
export function rehydrateDurableWalletSendExactPayload(input: {
  readonly metadata: unknown;
  readonly walletOperation: unknown;
  readonly resultGroups: unknown;
  readonly encodedToken: string;
}): DurableWalletSendExactPayload {
  const metadata = decodeDurableWalletSendExactPayloadMetadata(input.metadata);
  const preparation = requireDurableWalletSendDeliveryPreparationForOperation(
    metadata.preparation,
    input.walletOperation,
  );
  const exactPayload = planDurableWalletSendExactPayload({
    preparation,
    walletOperation: input.walletOperation,
    resultGroups: input.resultGroups,
    payloadHandle: metadata.payloadHandle,
    encodedToken: input.encodedToken,
  });
  requireSameDurableWalletSendExactPayload(metadata, exactPayload);
  return exactPayload;
}

export function requireSameDurableWalletSendExactPayload(
  expectedValue: unknown,
  actual: DurableWalletSendExactPayload,
): void {
  const expected = decodeDurableWalletSendExactPayloadMetadata(expectedValue);
  const actualBinding = requireDurableWalletSendExactPayloadCapability(actual);
  const actualMetadata = {
    preparation: actual.preparation,
    walletOperationId: actualBinding.walletOperationId,
    walletRequestFingerprint: actualBinding.walletRequestFingerprint,
    walletOutputPlanFingerprint: actualBinding.walletOutputPlanFingerprint,
    resultFingerprint: actualBinding.resultFingerprint,
    payloadHandle: actualBinding.payloadHandle,
    tokenDigest: actualBinding.tokenDigest,
    encodedTokenBytes: actualBinding.encodedTokenBytes,
    mintUrl: actualBinding.mintUrl,
    unit: actualBinding.unit,
    amount: actualBinding.amount,
  };
  if (
    deriveDurableCustodyArtifactFingerprint(expected) !==
    deriveDurableCustodyArtifactFingerprint(actualMetadata)
  ) {
    throw new Error("durable wallet-send exact payload conflicts");
  }
}

function resolveExactPayloadPlan(input: {
  preparation: unknown;
  walletOperation: unknown;
  resultGroups: unknown;
  encodedToken: string;
}) {
  const preparation = requireDurableWalletSendDeliveryPreparationForOperation(
    input.preparation,
    input.walletOperation,
  );
  const result = requireExactDurableWalletSendResult({
    walletOperation: input.walletOperation,
    resultGroups: input.resultGroups,
  });
  const wallet = requireWalletSendShape(input.walletOperation);
  const recipient =
    preparation.policy.kind === "durable-recipient-ack"
      ? preparation.policy.recipient
      : null;
  const mintUrl = recipient?.mintUrl ?? wallet.mintUrl;
  const unit = recipient?.unit ?? wallet.unit;
  const descriptor = requireExactDurableWalletSendToken({
    encodedToken: input.encodedToken,
    mintUrl,
    unit,
    sendProofs: result.sendProofs,
  });
  requireDurableWalletSendResultWithinAdmission({
    admission: preparation.admission,
    encodedToken: input.encodedToken,
    sendProofCount: result.sendProofs.length,
    resultProofCount: Object.values(result.resultGroups).reduce(
      (count, proofs) => count + proofs.length,
      0,
    ),
  });
  if (recipient && recipient.requestedAmount !== result.amount) {
    throw new Error("durable recipient exact payload amount is invalid");
  }
  return { preparation, result, descriptor, mintUrl, unit };
}

function requireWalletSendShape(value: unknown): {
  kind: "wallet-send";
  mintUrl: string;
  unit: string;
} {
  const record = requireRecord(value, "wallet operation");
  if (
    record.kind !== "wallet-send" ||
    typeof record.mintUrl !== "string" ||
    typeof record.unit !== "string"
  ) {
    throw new Error("durable wallet-send exact payload requires wallet-send");
  }
  return {
    kind: "wallet-send",
    mintUrl: record.mintUrl,
    unit: record.unit,
  };
}

function requireFingerprint(value: unknown, name: string): string {
  const fingerprint = requireText(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`durable wallet-send exact payload ${name} is invalid`);
  }
  return fingerprint;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`durable wallet-send exact payload ${name} is invalid`);
  }
  return value as number;
}
