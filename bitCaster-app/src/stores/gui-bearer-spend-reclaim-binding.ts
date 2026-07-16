import type {
  DurableBearerSpendDeliveryRecord,
  DurableBearerSpendReclaimIntent,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";

export const GUI_BEARER_SPEND_RECLAIM_METADATA_KEY = "guiBearerSpendReclaim";

export interface GuiBearerSpendReclaimBinding {
  schemaVersion: 1;
  deliveryId: string;
  parentOperationId: string;
  walletSendOperationId: string;
  tokenDigest: string;
  reclaimOperationId: string;
  requestFingerprint: string;
  approvedInputFingerprint: string;
  approvedInputAmount: string;
  approvedFee: string;
  approvedReturnAmount: string;
}

export function createGuiBearerSpendReclaimBinding(input: {
  record: DurableBearerSpendDeliveryRecord;
  intent: DurableBearerSpendReclaimIntent;
}): GuiBearerSpendReclaimBinding {
  return requireGuiBearerSpendReclaimBinding({
    schemaVersion: 1,
    deliveryId: input.record.deliveryId,
    parentOperationId: input.record.parentOperationId,
    walletSendOperationId: operationIdFromPayloadHandle(
      input.record.payloadHandle,
    ),
    tokenDigest: input.record.tokenDigest,
    reclaimOperationId: input.intent.operationId,
    requestFingerprint: input.intent.requestFingerprint,
    approvedInputFingerprint: input.intent.approvedInputFingerprint,
    approvedInputAmount: input.intent.approvedInputAmount,
    approvedFee: input.intent.approvedFee,
    approvedReturnAmount: input.intent.approvedReturnAmount,
  });
}

export function readGuiBearerSpendReclaimBinding(input: {
  metadata: Record<string, unknown>;
  operationId: string;
}): GuiBearerSpendReclaimBinding | null {
  const value = input.metadata[GUI_BEARER_SPEND_RECLAIM_METADATA_KEY];
  if (value === undefined) return null;
  const binding = requireGuiBearerSpendReclaimBinding(value);
  if (binding.reclaimOperationId !== input.operationId) {
    throw new Error("GUI bearer reclaim binding operation is invalid");
  }
  return binding;
}

export function requireGuiBearerSpendReclaimBinding(
  value: unknown,
): GuiBearerSpendReclaimBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI bearer reclaim binding is invalid");
  }
  const binding = value as Record<string, unknown>;
  if (
    Object.keys(binding).length !== 11 ||
    binding.schemaVersion !== 1 ||
    !isIdentifier(binding.deliveryId) ||
    !isIdentifier(binding.parentOperationId) ||
    !isIdentifier(binding.walletSendOperationId) ||
    !isIdentifier(binding.reclaimOperationId) ||
    !isFingerprint(binding.tokenDigest) ||
    !isFingerprint(binding.requestFingerprint) ||
    !isFingerprint(binding.approvedInputFingerprint) ||
    !isPositiveAmount(binding.approvedInputAmount) ||
    !isNonnegativeAmount(binding.approvedFee) ||
    !isPositiveAmount(binding.approvedReturnAmount)
  ) {
    throw new Error("GUI bearer reclaim binding is invalid");
  }
  return {
    schemaVersion: 1,
    deliveryId: binding.deliveryId,
    parentOperationId: binding.parentOperationId,
    walletSendOperationId: binding.walletSendOperationId,
    tokenDigest: binding.tokenDigest,
    reclaimOperationId: binding.reclaimOperationId,
    requestFingerprint: binding.requestFingerprint,
    approvedInputFingerprint: binding.approvedInputFingerprint,
    approvedInputAmount: binding.approvedInputAmount,
    approvedFee: binding.approvedFee,
    approvedReturnAmount: binding.approvedReturnAmount,
  };
}

export function sameGuiBearerSpendReclaimBinding(
  left: GuiBearerSpendReclaimBinding,
  right: GuiBearerSpendReclaimBinding,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.deliveryId === right.deliveryId &&
    left.parentOperationId === right.parentOperationId &&
    left.walletSendOperationId === right.walletSendOperationId &&
    left.tokenDigest === right.tokenDigest &&
    left.reclaimOperationId === right.reclaimOperationId &&
    left.requestFingerprint === right.requestFingerprint &&
    left.approvedInputFingerprint === right.approvedInputFingerprint &&
    left.approvedInputAmount === right.approvedInputAmount &&
    left.approvedFee === right.approvedFee &&
    left.approvedReturnAmount === right.approvedReturnAmount
  );
}

function operationIdFromPayloadHandle(value: string): string {
  const prefix = "wallet-send:";
  if (!value.startsWith(prefix)) {
    throw new Error("GUI bearer reclaim payload handle is invalid");
  }
  const operationId = value.slice(prefix.length);
  if (!isIdentifier(operationId)) {
    throw new Error("GUI bearer reclaim payload handle is invalid");
  }
  return operationId;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPositiveAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isNonnegativeAmount(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}
