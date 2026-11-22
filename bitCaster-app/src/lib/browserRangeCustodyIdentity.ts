import { deriveDurableCustodyOperationId } from "@bitcaster/client-sdk/durableCustody";

/** The custody operation that holds the inputs of one browser range order. */
export function browserRangeCustodyOperationId(scopeId: string, rangeOperationId: string): string {
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: rangeOperationId,
    binding: { kind: "wallet", activityId: rangeOperationId, stage: "send" },
  });
}
