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
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import type { BrowserCustodyOperationRow } from "@/stores/durable-custody-types";

/**
 * Where the reserved funds of one order attempt are. `refunded` is the exact
 * refund fact: the refund aborts the custody operation of the range order,
 * admits the refund proofs and ends the journal in one transaction.
 * `settled` is a settlement that reconciled the custody operation: the trade
 * completed. A journal that ended in another way is `ended`.
 */
export type CtfRangeOrderFunds =
  | { readonly kind: "active"; readonly lifecycleState: CtfRangeOrderPreparationLifecycle }
  | { readonly kind: "refunded" }
  | { readonly kind: "settled" }
  | { readonly kind: "ended" };

/**
 * The active database, only when it is the database of this wallet. Each
 * wallet has its own database, and a wallet switch replaces the active one.
 * A caller holds the returned database for all its reads, so a switch during
 * the reads cannot mix two wallets.
 */
export function walletDatabaseFor(scopeId: string): BitcasterDB | null {
  const database = db;
  try {
    return database.name === browserWalletDatabaseName(scopeId) ? database : null;
  } catch {
    return null;
  }
}

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
  return custody === undefined ? { kind: "ended" } : custodyOutcome(custody.operationState);
}

function custodyOutcome(state: BrowserCustodyOperationRow["operationState"]): CtfRangeOrderFunds {
  switch (state) {
    case "aborted":
      return { kind: "refunded" };
    case "reconciled":
      return { kind: "settled" };
    case "dispatch-intent":
    case "transport-attempted":
      return { kind: "ended" };
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
    case "settled":
    case "ended":
      return null;
    default:
      return assertNever(funds);
  }
}
