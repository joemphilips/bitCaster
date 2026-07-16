import {
  createDurableRecipientDeliveryRecord,
  decodeDurableRecipientDeliveryEvidence,
  decodeDurableRecipientDeliveryRecord,
  reduceDurableRecipientDelivery,
  type DurableRecipientDeliveryEvidence,
  type DurableRecipientDeliveryRecord,
  type DurableRecipientDeliveryRequest,
  type DurableRecipientDeliveryState,
} from "./durableRecipientDelivery.ts";
import {
  issueDurableRecipientSubmissionAuthority,
} from "./durableRecipientSubmissionAuthority.ts";
import type { DurableRecipientSubmissionAuthority } from "./durableRecipientSubmission.ts";
import {
  decodeDurableWalletSendExactPayloadMetadata,
  describeDurableWalletSendExactPayload,
  planDurableWalletSendExactPayload,
  requireSameDurableWalletSendExactPayload,
  type DurableWalletSendExactPayload,
} from "./durableWalletSendExactPayload.ts";
import {
  requireDurableWalletSendExactPayloadCapability,
} from "./durableWalletSendExactPayloadAuthority.ts";
import { createStrictCodec } from "./strictCodec.ts";

const {
  requireExactFields,
  requireRecord,
} = createStrictCodec({
  errorPrefix: "durable outgoing recipient delivery",
  exactFieldsError: "durable outgoing recipient delivery fields are invalid",
});

export const DURABLE_OUTGOING_RECIPIENT_DELIVERY_SCHEMA_VERSION = 1 as const;

export interface DurableOutgoingRecipientDeliveryRecord {
  schemaVersion: 1;
  delivery: DurableRecipientDeliveryRecord;
  exactPayload: Omit<DurableWalletSendExactPayload, "kind">;
}

export interface DurableOutgoingRecipientDeliveryExactPayloadStore {
  loadExactPayload(
    reference: Omit<DurableWalletSendExactPayload, "kind">,
  ): Promise<{
    walletOperation: unknown;
    resultGroups: unknown;
    encodedToken: string;
  }>;
}

export interface DurableOutgoingRecipientDeliveryTransport {
  readStatus(
    request: DurableRecipientDeliveryRequest,
  ): Promise<DurableRecipientDeliveryEvidence>;
  submitExact(
    authority: DurableRecipientSubmissionAuthority,
  ): Promise<DurableOutgoingRecipientDeliverySubmitOutcome>;
}

export type DurableOutgoingRecipientDeliverySubmitOutcome =
  | { kind: "accepted" }
  | {
      kind: "evidence";
      evidence: DurableRecipientDeliveryEvidence;
    };

export type DurableOutgoingRecipientDeliveryAdvanceResult = {
  kind: DurableRecipientDeliveryState["kind"];
  source: "local" | "status" | "submit-accepted" | "submit-evidence";
  record: DurableOutgoingRecipientDeliveryRecord;
};

export function createDurableOutgoingRecipientDeliveryRecord(input: {
  exactPayload: DurableWalletSendExactPayload;
}): DurableOutgoingRecipientDeliveryRecord {
  const exactPayload = describeDurableWalletSendExactPayload(
    input.exactPayload,
  );
  const policy = exactPayload.preparation.policy;
  if (policy.kind !== "durable-recipient-ack") {
    throw new Error("durable outgoing recipient requires recipient policy");
  }
  return decodeDurableOutgoingRecipientDeliveryRecord({
    schemaVersion: DURABLE_OUTGOING_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    delivery: createDurableRecipientDeliveryRecord({
      ...policy.recipient,
      encodedToken: readEncodedToken(input.exactPayload),
    }),
    exactPayload,
  });
}

export function decodeDurableOutgoingRecipientDeliveryRecord(
  value: unknown,
): DurableOutgoingRecipientDeliveryRecord {
  const record = requireRecord(value, "durable outgoing recipient delivery");
  requireExactFields(record, ["schemaVersion", "delivery", "exactPayload"]);
  if (
    record.schemaVersion !==
    DURABLE_OUTGOING_RECIPIENT_DELIVERY_SCHEMA_VERSION
  ) {
    throw new Error(
      "durable outgoing recipient delivery version is invalid",
    );
  }
  const delivery = decodeDurableRecipientDeliveryRecord(record.delivery);
  const exactPayload = decodeDurableWalletSendExactPayloadMetadata(
    record.exactPayload,
  );
  assertDeliveryMatchesExactPayload(delivery, exactPayload);
  return {
    schemaVersion: DURABLE_OUTGOING_RECIPIENT_DELIVERY_SCHEMA_VERSION,
    delivery,
    exactPayload,
  };
}

/**
 * Performs one bounded status-first attempt. The local exact payload is loaded
 * and revalidated only when submission remains necessary.
 */
export async function advanceDurableOutgoingRecipientDeliveryOnce(input: {
  record: unknown;
  exactPayloadStore: DurableOutgoingRecipientDeliveryExactPayloadStore;
  transport: DurableOutgoingRecipientDeliveryTransport;
}): Promise<DurableOutgoingRecipientDeliveryAdvanceResult> {
  const initial = decodeDurableOutgoingRecipientDeliveryRecord(input.record);
  if (initial.delivery.state.kind === "credited") {
    return advanceResult(initial, "local");
  }
  const statusEvidence = decodeDurableRecipientDeliveryEvidence(
    await input.transport.readStatus(initial.delivery.request),
  );
  const afterStatus = replaceDelivery(
    initial,
    reduceDurableRecipientDelivery(initial.delivery, statusEvidence),
  );
  if (afterStatus.delivery.state.kind !== "pending") {
    return advanceResult(afterStatus, "status");
  }

  const loaded = await input.exactPayloadStore.loadExactPayload(
    structuredClone(afterStatus.exactPayload),
  );
  const exactPayload = planDurableWalletSendExactPayload({
    preparation: afterStatus.exactPayload.preparation,
    walletOperation: loaded.walletOperation,
    resultGroups: loaded.resultGroups,
    payloadHandle: afterStatus.exactPayload.payloadHandle,
    encodedToken: loaded.encodedToken,
  });
  requireSameDurableWalletSendExactPayload(
    afterStatus.exactPayload,
    exactPayload,
  );
  const submit = decodeSubmitOutcome(
    await input.transport.submitExact(
      issueDurableRecipientSubmissionAuthority({
        request: afterStatus.delivery.request,
        encodedToken: loaded.encodedToken,
      }),
    ),
  );
  if (submit.kind === "accepted") {
    return advanceResult(afterStatus, "submit-accepted");
  }
  return advanceResult(
    replaceDelivery(
      afterStatus,
      reduceDurableRecipientDelivery(
        afterStatus.delivery,
        submit.evidence,
      ),
    ),
    "submit-evidence",
  );
}

function replaceDelivery(
  record: DurableOutgoingRecipientDeliveryRecord,
  delivery: DurableRecipientDeliveryRecord,
): DurableOutgoingRecipientDeliveryRecord {
  return decodeDurableOutgoingRecipientDeliveryRecord({
    ...record,
    delivery,
  });
}

function assertDeliveryMatchesExactPayload(
  delivery: DurableRecipientDeliveryRecord,
  exactPayload: Omit<DurableWalletSendExactPayload, "kind">,
): void {
  const policy = exactPayload.preparation.policy;
  const request = delivery.request;
  if (
    policy.kind !== "durable-recipient-ack" ||
    request.deliveryId !== policy.recipient.deliveryId ||
    request.accountSubject !== policy.recipient.accountSubject ||
    request.recipientKind !== policy.recipient.recipientKind ||
    request.purpose !== policy.recipient.purpose ||
    request.destinationId !== policy.recipient.destinationId ||
    request.productBinding !== policy.recipient.productBinding ||
    request.mintUrl !== policy.recipient.mintUrl ||
    request.unit !== policy.recipient.unit ||
    request.requestedAmount !== policy.recipient.requestedAmount ||
    request.creditPolicy.kind !== policy.recipient.creditPolicy.kind ||
    request.tokenDigest !== exactPayload.tokenDigest ||
    request.encodedTokenBytes !== exactPayload.encodedTokenBytes ||
    request.mintUrl !== exactPayload.mintUrl ||
    request.unit !== exactPayload.unit ||
    request.requestedAmount !== exactPayload.amount
  ) {
    throw new Error(
      "durable outgoing recipient delivery conflicts with exact payload",
    );
  }
}

function readEncodedToken(exactPayload: DurableWalletSendExactPayload): string {
  const binding =
    requireDurableWalletSendExactPayloadCapability(exactPayload);
  if (binding.policyKind !== "durable-recipient-ack") {
    throw new Error("durable outgoing recipient exact payload is invalid");
  }
  return binding.encodedToken;
}

function decodeSubmitOutcome(
  value: unknown,
): DurableOutgoingRecipientDeliverySubmitOutcome {
  const outcome = requireRecord(value, "durable recipient submit outcome");
  if (outcome.kind === "accepted") {
    requireExactFields(outcome, ["kind"]);
    return { kind: "accepted" };
  }
  if (outcome.kind === "evidence") {
    requireExactFields(outcome, ["kind", "evidence"]);
    return {
      kind: "evidence",
      evidence: decodeDurableRecipientDeliveryEvidence(outcome.evidence),
    };
  }
  throw new Error("durable recipient submit outcome kind is invalid");
}

function advanceResult(
  record: DurableOutgoingRecipientDeliveryRecord,
  source: DurableOutgoingRecipientDeliveryAdvanceResult["source"],
): DurableOutgoingRecipientDeliveryAdvanceResult {
  return { kind: record.delivery.state.kind, source, record };
}
