import type { DurableWalletSendDeliveryPolicyKind } from "./durableWalletSendPreparationAuthority.ts";

export interface DurableWalletSendExactPayloadCapability {
  readonly kind: "durable-wallet-send-exact-payload";
}

export interface DurableWalletSendExactPayloadBinding {
  policyKind: DurableWalletSendDeliveryPolicyKind;
  deliveryIntentFingerprint: string;
  walletOperationId: string;
  activityId: string;
  walletRequestFingerprint: string;
  walletOutputPlanFingerprint: string;
  resultFingerprint: string;
  payloadHandle: string;
  tokenDigest: string;
  encodedTokenBytes: number;
  mintUrl: string;
  unit: string;
  amount: string;
  encodedToken: string;
}

const exactPayloadAuthorities = new WeakMap<
  DurableWalletSendExactPayloadCapability,
  DurableWalletSendExactPayloadBinding
>();

export function issueDurableWalletSendExactPayloadCapability<
  T extends DurableWalletSendExactPayloadCapability,
>(
  capability: T,
  binding: DurableWalletSendExactPayloadBinding,
): T {
  exactPayloadAuthorities.set(capability, binding);
  return capability;
}

export function requireDurableWalletSendExactPayloadCapability(
  capability: DurableWalletSendExactPayloadCapability,
): DurableWalletSendExactPayloadBinding {
  const binding = exactPayloadAuthorities.get(capability);
  if (binding === undefined) {
    throw new Error("durable wallet-send exact payload authority is invalid");
  }
  return binding;
}
