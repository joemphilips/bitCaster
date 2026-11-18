import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { assertNever } from "@/lib/enumDiscipline";

/** Only `terminal` ends a journal operation. */
export function isTerminalCtfRangePreparation(
  lifecycleState: CtfRangeOrderPreparationLifecycle,
): boolean {
  switch (lifecycleState) {
    case "terminal":
      return true;
    case "prepared":
    case "order-requested":
    case "order-request-rejected":
    case "capability-requested":
    case "capability-bound":
    case "order-submitted":
    case "submission-rejected":
      return false;
    default:
      return assertNever(lifecycleState);
  }
}

/**
 * A refused request moves only to `terminal`. The wallet records an engine
 * refusal as an order alert. A user stop also ends here, because no attempt
 * committed, and it has no order alert.
 */
export function isLocalCtfRangeOrderRefusal(
  lifecycleState: CtfRangeOrderPreparationLifecycle,
): boolean {
  switch (lifecycleState) {
    case "order-request-rejected":
    case "submission-rejected":
      return true;
    case "prepared":
    case "order-requested":
    case "capability-requested":
    case "capability-bound":
    case "order-submitted":
    case "terminal":
      return false;
    default:
      return assertNever(lifecycleState);
  }
}
