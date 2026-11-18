import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type { BrowserCtfRangeOrderErrorCode } from "@/lib/browserCtfRangeOrderCoordinator";
import { assertNever } from "@/lib/enumDiscipline";
import { browserRangeCustodyOperationId } from "@/lib/browserRangeCustodyIdentity";
import {
  isLocalCtfRangeOrderRefusal,
  isTerminalCtfRangePreparation,
} from "@/lib/ctfRangeOrderLifecycle";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { isOrderRequestRefusalCode } from "@/stores/ctf-range-order-messages";
import { db, type BitcasterDB } from "@/stores/proof-db";
import type { BrowserCustodyOperationRow } from "@/stores/durable-custody-types";

/**
 * Where the reserved funds of one order attempt are. `refunded` is the exact
 * refund fact: the refund aborts the custody operation of the range order,
 * admits the refund proofs and ends the journal in one transaction. A journal
 * that ended another way, for example through a settlement, is `ended`.
 */
export type CtfRangeOrderFunds =
  | { readonly kind: "active"; readonly lifecycleState: CtfRangeOrderPreparationLifecycle }
  | { readonly kind: "refunded" }
  | { readonly kind: "ended" };

export { browserRangeCustodyOperationId };

export async function readCtfRangeOrderFunds(
  scopeId: string,
  operationId: string,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderFunds> {
  const record = await readCtfRangePreparation(scopeId, operationId, database);
  if (record === null) return { kind: "ended" };
  if (!isTerminalCtfRangePreparation(record.lifecycleState))
    return { kind: "active", lifecycleState: record.lifecycleState };
  const custody = await database.custodyOperations.get([
    scopeId,
    browserRangeCustodyOperationId(scopeId, operationId),
  ]);
  return custody !== undefined && refundedCustody(custody.operationState)
    ? { kind: "refunded" }
    : { kind: "ended" };
}

function refundedCustody(state: BrowserCustodyOperationRow["operationState"]): boolean {
  switch (state) {
    case "aborted":
      return true;
    case "reconciled":
    case "dispatch-intent":
    case "transport-attempted":
      return false;
    default:
      return assertNever(state);
  }
}

/**
 * The funds of a refused order request. A refund follows only while the
 * journal is a local refusal, or after the refund ended it. Other order alerts
 * name no funds.
 */
export function refusedOrderAlertFunds(
  code: BrowserCtfRangeOrderErrorCode,
  funds: CtfRangeOrderFunds,
): "pending" | "refunded" | null {
  if (!isOrderRequestRefusalCode(code)) return null;
  switch (funds.kind) {
    case "active":
      return isLocalCtfRangeOrderRefusal(funds.lifecycleState) ? "pending" : null;
    case "refunded":
      return "refunded";
    case "ended":
      return null;
    default:
      return assertNever(funds);
  }
}
