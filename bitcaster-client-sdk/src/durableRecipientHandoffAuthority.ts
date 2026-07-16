export interface DurableRecipientCustodyHandoffCapability {
  readonly kind: "durable-recipient-custody-handoff";
}

interface DurableRecipientCustodyHandoffBinding {
  policyKind: "durable-recipient-ack";
  deliveryIntentFingerprint: string;
  walletId: string;
  operationId: string;
  custodyDeliveryId: string;
  payloadHandle: string;
  payloadFingerprint: string;
  mintUrl: string;
  unit: string;
}

const handoffAuthority = new WeakMap<
  DurableRecipientCustodyHandoffCapability,
  DurableRecipientCustodyHandoffBinding
>();

export function issueDurableRecipientCustodyHandoffCapability(
  binding: DurableRecipientCustodyHandoffBinding,
): DurableRecipientCustodyHandoffCapability {
  const capability = Object.freeze({
    kind: "durable-recipient-custody-handoff" as const,
  });
  handoffAuthority.set(capability, binding);
  return capability;
}

export function requireDurableRecipientCustodyHandoffCapability(
  capability: DurableRecipientCustodyHandoffCapability,
  expected: Pick<
    DurableRecipientCustodyHandoffBinding,
    | "policyKind"
    | "deliveryIntentFingerprint"
    | "walletId"
    | "operationId"
    | "custodyDeliveryId"
    | "payloadHandle"
    | "payloadFingerprint"
    | "mintUrl"
    | "unit"
  >,
): void {
  const binding = handoffAuthority.get(capability);
  if (
    binding?.walletId !== expected.walletId ||
    binding.policyKind !== expected.policyKind ||
    binding.deliveryIntentFingerprint !==
      expected.deliveryIntentFingerprint ||
    binding.operationId !== expected.operationId ||
    binding.custodyDeliveryId !== expected.custodyDeliveryId ||
    binding.payloadHandle !== expected.payloadHandle ||
    binding.payloadFingerprint !== expected.payloadFingerprint ||
    binding.mintUrl !== expected.mintUrl ||
    binding.unit !== expected.unit
  ) {
    throw new Error("durable recipient custody handoff authority is invalid");
  }
}
