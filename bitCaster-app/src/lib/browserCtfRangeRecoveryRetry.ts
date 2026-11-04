import { clearBrowserCtfRangeMessageRetry } from "@/stores/ctf-range-order-messages";
import { publishBrowserCtfRangeRecoveryWake } from "./browserCtfRangeOrderRecoveryWake";
import { sharedBrowserCtfRangeRecoverySchedule } from "./browserCtfRangeRecoverySchedule";

/**
 * The user asks for one more replay of a halted range-order recovery. It sends
 * at most one mint request. The same refusal halts the operation again.
 */
export async function retryBrowserCtfRangeOrderRecovery(input: {
  readonly scopeId: string;
  readonly operationId: string;
}): Promise<void> {
  sharedBrowserCtfRangeRecoverySchedule().resume(input.scopeId, input.operationId);
  await clearBrowserCtfRangeMessageRetry(input);
  publishBrowserCtfRangeRecoveryWake({ scopeId: input.scopeId });
}
