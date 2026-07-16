import {
  deriveDurableCustodyArtifactFingerprint,
} from "./durableCustody.ts";
import {
  decodeDurableRecipientCreditPolicy,
  type DurableRecipientCreditPolicy,
} from "./durableRecipientDelivery.ts";
import {
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  type DurableWalletSendOperation,
} from "./durableWalletOperation.ts";
import {
  planDurableWalletSendDeliveryAdmission,
  requireDurableWalletSendDeliveryAdmission,
  type DurableWalletSendDeliveryAdmission,
} from "./durableWalletSendDelivery.ts";
import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import {
  issueDurableWalletSendDeliveryPreparationCapability,
  type DurableWalletSendDeliveryPolicyKind,
  type DurableWalletSendDeliveryPreparationCapability,
} from "./durableWalletSendPreparationAuthority.ts";
import { createStrictCodec } from "./strictCodec.ts";

const {
  requireExactFields,
  requirePositiveDecimal,
  requireRecord,
  requireText,
} = createStrictCodec({
  errorPrefix: "durable wallet-send preparation",
  exactFieldsError: "durable wallet-send preparation fields are invalid",
});

export interface DurableRecipientDeliveryIntent {
  deliveryId: string;
  accountSubject: string;
  recipientKind: string;
  purpose: string;
  destinationId: string;
  mintUrl: string;
  unit: string;
  requestedAmount: string;
  creditPolicy: DurableRecipientCreditPolicy;
}

export type DurableWalletSendDeliveryPolicy =
  | { kind: "user-export" }
  | {
      kind: "durable-recipient-ack";
      recipient: DurableRecipientDeliveryIntent;
    };

export interface DurableWalletSendDeliveryPreparation
  extends DurableWalletSendDeliveryPreparationCapability {
  readonly walletRequestFingerprint: string;
  readonly walletOutputPlanFingerprint: string;
  readonly policy: DurableWalletSendDeliveryPolicy;
  readonly admission: DurableWalletSendDeliveryAdmission;
}

export function prepareDurableWalletSendDelivery(input: {
  walletOperation: unknown;
  policy: DurableWalletSendDeliveryPolicy;
  admission: unknown;
}): DurableWalletSendDeliveryPreparation {
  const walletOperation = requireWalletSend(input.walletOperation);
  const authority = deriveDurableWalletOperationAuthority(walletOperation);
  const policy = decodePolicy(input.policy);
  const admission = canonicalAdmission(walletOperation, input.admission);
  validatePolicyAgainstWallet(policy, walletOperation);
  return brandPreparation({
    schemaVersion: 1,
    policyKind: policy.kind,
    walletOperationId: walletOperation.operationId,
    activityId:
      policy.kind === "user-export"
        ? walletOperation.operationId
        : policy.recipient.deliveryId,
    walletRequestFingerprint: authority.requestFingerprint,
    walletOutputPlanFingerprint: authority.outputPlanFingerprint,
    policy,
    admission,
    intentFingerprint: deriveIntentFingerprint({
      policy,
      walletOperationId: walletOperation.operationId,
      walletRequestFingerprint: authority.requestFingerprint,
      walletOutputPlanFingerprint: authority.outputPlanFingerprint,
      admission,
    }),
  });
}

export function decodeDurableWalletSendDeliveryPreparation(
  value: unknown,
): DurableWalletSendDeliveryPreparation {
  const record = requireRecord(value, "durable wallet-send preparation");
  requireExactFields(record, [
    "schemaVersion",
    "policyKind",
    "walletOperationId",
    "activityId",
    "walletRequestFingerprint",
    "walletOutputPlanFingerprint",
    "policy",
    "admission",
    "intentFingerprint",
  ]);
  if (record.schemaVersion !== 1) {
    throw new Error("durable wallet-send preparation version is invalid");
  }
  const policy = decodePolicy(record.policy);
  if (record.policyKind !== policy.kind) {
    throw new Error("durable wallet-send preparation policy is invalid");
  }
  const decoded = {
    schemaVersion: 1 as const,
    policyKind: policy.kind,
    walletOperationId: requireText(
      record.walletOperationId,
      "wallet operation id",
      512,
    ),
    activityId: requireText(record.activityId, "activity id", 512),
    walletRequestFingerprint: requireFingerprint(
      record.walletRequestFingerprint,
      "wallet request fingerprint",
    ),
    walletOutputPlanFingerprint: requireFingerprint(
      record.walletOutputPlanFingerprint,
      "wallet output plan fingerprint",
    ),
    policy,
    admission: requireDurableWalletSendDeliveryAdmission(record.admission),
    intentFingerprint: requireFingerprint(
      record.intentFingerprint,
      "delivery intent fingerprint",
    ),
  } satisfies DurableWalletSendDeliveryPreparation;
  const expectedFingerprint = deriveIntentFingerprint(decoded);
  const expectedActivityId =
    policy.kind === "user-export"
      ? decoded.walletOperationId
      : policy.recipient.deliveryId;
  if (
    decoded.activityId !== expectedActivityId ||
    decoded.intentFingerprint !== expectedFingerprint
  ) {
    throw new Error("durable wallet-send preparation fingerprint is invalid");
  }
  return brandPreparation(decoded);
}

export function requireDurableWalletSendDeliveryPreparationForOperation(
  value: unknown,
  walletOperationValue: unknown,
): DurableWalletSendDeliveryPreparation {
  const walletOperation = requireWalletSend(walletOperationValue);
  const preparation = decodeDurableWalletSendDeliveryPreparation(value);
  const canonical = prepareDurableWalletSendDelivery({
    walletOperation,
    policy: preparation.policy,
    admission: preparation.admission,
  });
  if (
    deriveDurableCustodyArtifactFingerprint(preparation) !==
    deriveDurableCustodyArtifactFingerprint(canonical)
  ) {
    throw new Error(
      "durable wallet-send preparation does not match its exact operation",
    );
  }
  return preparation;
}

function canonicalAdmission(
  operation: DurableWalletSendOperation,
  value: unknown,
): DurableWalletSendDeliveryAdmission {
  const supplied = requireDurableWalletSendDeliveryAdmission(value);
  const canonical = planDurableWalletSendDeliveryAdmission({
    outputPlan: {
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      sendOutputs: operation.preview.sendOutputs,
      keepOutputs: operation.preview.keepOutputs,
      passthroughProofs: operation.preview.unselectedProofs,
      inputProofs: operation.preview.inputs,
    },
    limits: {
      encodedTokenBytes: supplied.encodedTokenBytesLimit,
      proofCount: supplied.proofCountLimit,
      durableStorageBytes: supplied.durableStorageBytesLimit,
      nativeOperationRowBytes: supplied.nativeOperationRowBytesLimit,
    },
  });
  if (
    deriveDurableCustodyArtifactFingerprint(supplied) !==
    deriveDurableCustodyArtifactFingerprint(canonical)
  ) {
    throw new Error(
      "durable wallet-send preparation admission is not canonical",
    );
  }
  return canonical;
}

function validatePolicyAgainstWallet(
  policy: DurableWalletSendDeliveryPolicy,
  operation: DurableWalletSendOperation,
): void {
  if (policy.kind === "user-export") return;
  if (
    policy.recipient.mintUrl !== operation.mintUrl ||
    policy.recipient.unit !== operation.unit ||
    policy.recipient.requestedAmount !== operation.preview.amount
  ) {
    throw new Error(
      "durable recipient intent does not match its wallet operation",
    );
  }
}

function decodePolicy(value: unknown): DurableWalletSendDeliveryPolicy {
  const policy = requireRecord(value, "durable wallet-send policy");
  if (policy.kind === "user-export") {
    requireExactFields(policy, ["kind"]);
    return { kind: "user-export" };
  }
  if (policy.kind !== "durable-recipient-ack") {
    throw new Error("durable wallet-send policy is invalid");
  }
  requireExactFields(policy, ["kind", "recipient"]);
  return {
    kind: "durable-recipient-ack",
    recipient: decodeRecipientIntent(policy.recipient),
  };
}

function decodeRecipientIntent(value: unknown): DurableRecipientDeliveryIntent {
  const intent = requireRecord(value, "durable recipient intent");
  requireExactFields(intent, [
    "deliveryId",
    "accountSubject",
    "recipientKind",
    "purpose",
    "destinationId",
    "mintUrl",
    "unit",
    "requestedAmount",
    "creditPolicy",
  ]);
  const decoded = {
    deliveryId: requireText(intent.deliveryId, "delivery id", 256),
    accountSubject: requireText(intent.accountSubject, "account subject", 512),
    recipientKind: requireText(intent.recipientKind, "recipient kind", 128),
    purpose: requireText(intent.purpose, "purpose", 128),
    destinationId: requireText(intent.destinationId, "destination id", 512),
    mintUrl: normalizeDurableWalletMintUrl(
      requireText(intent.mintUrl, "mint URL", 2_048),
    ),
    unit: requireText(intent.unit, "unit", 64),
    requestedAmount: requirePositiveDecimal(
      intent.requestedAmount,
      "requested amount",
    ),
    creditPolicy: decodeDurableRecipientCreditPolicy(intent.creditPolicy),
  };
  return decoded;
}

function deriveIntentFingerprint(input: {
  policy: DurableWalletSendDeliveryPolicy;
  walletOperationId: string;
  walletRequestFingerprint: string;
  walletOutputPlanFingerprint: string;
  admission: DurableWalletSendDeliveryAdmission;
}): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "durable-wallet-send-delivery-intent/v1",
    policy: input.policy,
    walletOperationId: input.walletOperationId,
    walletRequestFingerprint: input.walletRequestFingerprint,
    walletOutputPlanFingerprint: input.walletOutputPlanFingerprint,
    admittedPayloadEnvelope: input.admission,
  });
}

function brandPreparation(
  value: DurableWalletSendDeliveryPreparation,
): DurableWalletSendDeliveryPreparation {
  const preparation = deepFreeze(structuredClone(value));
  return issueDurableWalletSendDeliveryPreparationCapability(preparation, {
    policyKind: preparation.policyKind,
    walletOperationId: preparation.walletOperationId,
    activityId: preparation.activityId,
    intentFingerprint: preparation.intentFingerprint,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function requireWalletSend(value: unknown): DurableWalletSendOperation {
  const operation = decodeDurableWalletOperation(value);
  if (operation.kind !== "wallet-send") {
    throw new Error("durable wallet-send preparation requires wallet-send");
  }
  return operation;
}

function requireFingerprint(value: unknown, name: string): string {
  const fingerprint = requireText(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`durable wallet-send preparation ${name} is invalid`);
  }
  return fingerprint;
}

export type { DurableWalletSendDeliveryPolicyKind };
