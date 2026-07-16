export type DurableWalletSendDeliveryPolicyKind =
  | "user-export"
  | "durable-recipient-ack";

export interface DurableWalletSendDeliveryPreparationCapability {
  readonly schemaVersion: 1;
  readonly policyKind: DurableWalletSendDeliveryPolicyKind;
  readonly walletOperationId: string;
  readonly activityId: string;
  readonly intentFingerprint: string;
}

interface DurableWalletSendDeliveryPreparationBinding {
  policyKind: DurableWalletSendDeliveryPolicyKind;
  walletOperationId: string;
  activityId: string;
  intentFingerprint: string;
}

const preparationAuthorities = new WeakMap<
  DurableWalletSendDeliveryPreparationCapability,
  DurableWalletSendDeliveryPreparationBinding
>();

export function issueDurableWalletSendDeliveryPreparationCapability<
  T extends DurableWalletSendDeliveryPreparationCapability,
>(
  preparation: T,
  binding: DurableWalletSendDeliveryPreparationBinding,
): T {
  preparationAuthorities.set(preparation, binding);
  return preparation;
}

export function requireDurableWalletSendDeliveryPreparationCapability(
  preparation: DurableWalletSendDeliveryPreparationCapability,
  expected: DurableWalletSendDeliveryPreparationBinding,
): void {
  const authority = preparationAuthorities.get(preparation);
  if (
    authority?.policyKind !== expected.policyKind ||
    authority.walletOperationId !== expected.walletOperationId ||
    authority.activityId !== expected.activityId ||
    authority.intentFingerprint !== expected.intentFingerprint
  ) {
    throw new Error("durable wallet-send delivery preparation is invalid");
  }
}
