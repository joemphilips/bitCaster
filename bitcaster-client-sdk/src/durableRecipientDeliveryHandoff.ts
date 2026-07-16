import {
  acknowledgeDurableCustodyWalletSendRecipient,
  classifyDurableCustodyWalletSendRecipientBoundary,
  decodeDurableCustodyRecord,
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyState,
  type DurableCustodyWalletStorageBoundary,
} from "./durableCustody.ts";
import {
  decodeDurableRecipientDeliveryRecord,
  reduceDurableRecipientDelivery,
  verifyDurableRecipientCredit,
  type DurableRecipientDeliveryRecord,
} from "./durableRecipientDelivery.ts";
import {
  decodeDurableOutgoingRecipientDeliveryRecord,
  type DurableOutgoingRecipientDeliveryRecord,
} from "./durableOutgoingRecipientDelivery.ts";
import { issueDurableRecipientCustodyHandoffCapability } from "./durableRecipientHandoffAuthority.ts";
import {
  requireSameDurableWalletSendExactPayload,
  type DurableWalletSendExactPayload,
} from "./durableWalletSendExactPayload.ts";
import {
  requireDurableWalletSendExactPayloadCapability,
} from "./durableWalletSendExactPayloadAuthority.ts";

interface RecipientCustodyHandoffPlanAuthority {
  previousCustodyFingerprint: string;
  nextCustodyFingerprint: string;
  recipientRecordFingerprint: string;
}

export interface DurableRecipientDeliveryCustodyHandoffPlan {
  readonly recipientRecord: DurableRecipientDeliveryRecord;
  readonly custodyState: DurableCustodyState;
}

const handoffPlanAuthorities = new WeakMap<
  DurableRecipientDeliveryCustodyHandoffPlan,
  RecipientCustodyHandoffPlanAuthority
>();

/**
 * Couples one terminal recipient record to the exact persisted wallet-send.
 * The wallet binding activityId is the external recipient delivery id.
 */
export function planDurableRecipientDeliveryCustodyHandoff(input: {
  exactPayload: DurableWalletSendExactPayload;
  custodyState: DurableCustodyState;
  outgoingRecipient: unknown;
  evidence?: unknown;
  authorization: DurableCustodyOwnerAuthorization;
}): DurableRecipientDeliveryCustodyHandoffPlan {
  const outgoingRecipient = terminalRecipientRecord(
    input.outgoingRecipient,
    input.evidence,
  );
  const recipientRecord = outgoingRecipient.delivery;
  const custody = decodeDurableCustodyRecord(input.custodyState.operation);
  const custodyBinding = requireRecipientCustodyBinding(
    input.exactPayload,
    custody,
    outgoingRecipient,
  );
  const capability = issueDurableRecipientCustodyHandoffCapability({
    ...custodyBinding,
    policyKind: "durable-recipient-ack",
    deliveryIntentFingerprint:
      outgoingRecipient.exactPayload.preparation.intentFingerprint,
  });
  const custodyState = acknowledgeDurableCustodyWalletSendRecipient(
    input.custodyState,
    { ...input.authorization, capability },
  );
  classifyDurableCustodyWalletSendRecipientBoundary({
    previous: input.custodyState.operation,
    next: custodyState.operation,
    capability,
  });
  return brandPlan(input.custodyState, custodyState, recipientRecord);
}

export function classifyDurableRecipientDeliveryCustodyHandoffPlan(input: {
  previousCustodyState: DurableCustodyState;
  plan: DurableRecipientDeliveryCustodyHandoffPlan;
}): DurableCustodyWalletStorageBoundary {
  const authority = handoffPlanAuthorities.get(input.plan);
  if (
    authority?.previousCustodyFingerprint !==
      planFingerprint(input.previousCustodyState) ||
    authority.nextCustodyFingerprint !==
      planFingerprint(input.plan.custodyState) ||
    authority.recipientRecordFingerprint !==
      planFingerprint(
        decodeDurableRecipientDeliveryRecord(input.plan.recipientRecord),
      )
  ) {
    throw new Error("durable recipient custody handoff plan is invalid");
  }
  return "reconciliation-only";
}

function terminalRecipientRecord(
  value: unknown,
  evidence: unknown | undefined,
): DurableOutgoingRecipientDeliveryRecord {
  const record = decodeDurableOutgoingRecipientDeliveryRecord(value);
  const delivery =
    evidence === undefined
      ? record.delivery
      : reduceDurableRecipientDelivery(record.delivery, evidence);
  if (delivery.state.kind !== "credited") {
    throw new Error("durable recipient delivery is not credited");
  }
  return decodeDurableOutgoingRecipientDeliveryRecord({
    ...record,
    delivery,
  });
}

function requireRecipientCustodyBinding(
  exactPayload: DurableWalletSendExactPayload,
  custody: ReturnType<typeof decodeDurableCustodyRecord>,
  outgoingRecipient: DurableOutgoingRecipientDeliveryRecord,
): {
  walletId: string;
  operationId: string;
  custodyDeliveryId: string;
  payloadHandle: string;
  payloadFingerprint: string;
  mintUrl: string;
  unit: string;
} {
  const recipient = outgoingRecipient.delivery;
  requireSameDurableWalletSendExactPayload(
    outgoingRecipient.exactPayload,
    exactPayload,
  );
  const authority =
    requireDurableWalletSendExactPayloadCapability(exactPayload);
  if (authority.policyKind !== "durable-recipient-ack") {
    throw new Error("durable recipient custody policy is invalid");
  }
  const tuple = requireRecipientCustodyTuple({
    custody,
    recipient,
    authority,
  });
  requireAuthorizedCredit(authority.amount, recipient);
  return {
    walletId: tuple.walletId,
    operationId: custody.operation.operationId,
    custodyDeliveryId: tuple.custodyDeliveryId,
    payloadHandle: tuple.payloadHandle,
    payloadFingerprint: tuple.payloadFingerprint,
    mintUrl: custody.operation.custodyContext.normalizedMint,
    unit: custody.operation.custodyContext.unit,
  };
}

function requireRecipientCustodyTuple(input: {
  custody: ReturnType<typeof decodeDurableCustodyRecord>;
  recipient: DurableRecipientDeliveryRecord;
  authority: ReturnType<
    typeof requireDurableWalletSendExactPayloadCapability
  >;
}): {
  walletId: string;
  custodyDeliveryId: string;
  payloadHandle: string;
  payloadFingerprint: string;
} {
  const { custody, recipient, authority } = input;
  const binding = custody.operation.binding;
  const delivery = custody.operation.delivery;
  if (
    custody.scope.scopeKind !== "wallet" ||
    binding.kind !== "wallet" ||
    binding.activityId !== recipient.request.deliveryId ||
    authority.walletOperationId !== custody.operation.retainedOperationKey ||
    authority.deliveryIntentFingerprint !==
      custody.operation.privateMaterial.publicFingerprint ||
    authority.resultFingerprint !== custody.operation.result.resultFingerprint ||
    authority.mintUrl !== custody.operation.custodyContext.normalizedMint ||
    authority.unit !== custody.operation.custodyContext.unit ||
    recipient.request.mintUrl !== authority.mintUrl ||
    recipient.request.unit !== authority.unit ||
    delivery.deliveryKind !== "outbox" ||
    delivery.state !== "pending" ||
    delivery.deliveryId === null ||
    delivery.payloadHandle === null ||
    delivery.payloadFingerprint === null ||
    delivery.payloadHandle !== authority.payloadHandle ||
    delivery.payloadFingerprint !== recipient.request.tokenDigest ||
    delivery.payloadFingerprint !== authority.tokenDigest ||
    recipient.request.encodedTokenBytes !== authority.encodedTokenBytes
  ) {
    throw new Error("durable recipient custody authority is invalid");
  }
  return {
    walletId: custody.scope.walletId,
    custodyDeliveryId: delivery.deliveryId,
    payloadHandle: delivery.payloadHandle,
    payloadFingerprint: delivery.payloadFingerprint,
  };
}

function requireAuthorizedCredit(
  exactAmount: string,
  recipient: DurableRecipientDeliveryRecord,
): void {
  if (
    recipient.state.kind !== "credited" ||
    exactAmount !== recipient.request.requestedAmount
  ) {
    throw new Error("durable recipient delivery amount is invalid");
  }
  verifyDurableRecipientCredit({
    request: recipient.request,
    creditedAmount: recipient.state.creditedAmount,
    creditVerification: recipient.state.creditVerification,
  });
}

function brandPlan(
  previous: DurableCustodyState,
  next: DurableCustodyState,
  recipientRecord: DurableRecipientDeliveryRecord,
): DurableRecipientDeliveryCustodyHandoffPlan {
  const plan = Object.freeze({
    recipientRecord,
    custodyState: next,
  });
  handoffPlanAuthorities.set(plan, {
    previousCustodyFingerprint: planFingerprint(previous),
    nextCustodyFingerprint: planFingerprint(next),
    recipientRecordFingerprint: planFingerprint(recipientRecord),
  });
  return plan;
}

function planFingerprint(value: unknown): string {
  return deriveDurableCustodyArtifactFingerprint(value);
}
