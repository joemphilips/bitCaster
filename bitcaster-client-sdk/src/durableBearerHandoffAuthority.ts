export interface DurableBearerCustodyHandoffCapability {
  readonly kind: "durable-bearer-custody-handoff";
}

interface DurableBearerCustodyHandoffBinding {
  walletId: string;
  operationId: string;
  deliveryId: string;
  payloadHandle: string;
  payloadFingerprint: string;
  mintUrl: string;
  unit: string;
}

const handoffAuthority = new WeakMap<
  DurableBearerCustodyHandoffCapability,
  DurableBearerCustodyHandoffBinding
>();

export function issueDurableBearerCustodyHandoffCapability(
  binding: DurableBearerCustodyHandoffBinding,
): DurableBearerCustodyHandoffCapability {
  const capability = Object.freeze({
    kind: "durable-bearer-custody-handoff" as const,
  });
  handoffAuthority.set(capability, binding);
  return capability;
}

export function requireDurableBearerCustodyHandoffCapability(
  capability: DurableBearerCustodyHandoffCapability,
  expected: DurableBearerCustodyHandoffBinding,
): void {
  const binding = handoffAuthority.get(capability);
  if (
    binding?.walletId !== expected.walletId ||
    binding.operationId !== expected.operationId ||
    binding.deliveryId !== expected.deliveryId ||
    binding.payloadHandle !== expected.payloadHandle ||
    binding.payloadFingerprint !== expected.payloadFingerprint ||
    binding.mintUrl !== expected.mintUrl ||
    binding.unit !== expected.unit
  ) {
    throw new Error("durable bearer custody handoff authority is invalid");
  }
}
