import type {
  DurableCustodyRecord,
  DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import type { CtfRangeOrderPreparationLifecycle } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { readActiveCtfRangePreparationByClientOrderId } from "@/stores/ctf-range-order-db";
import { BrowserDurableCustodyAdapter } from "@/stores/durable-custody-db";
import { db, type BitcasterDB } from "@/stores/proof-db";
import type { PendingTrade } from "@/stores/pendingTrades";
import { browserCustodyOperationId } from "./browserCtfRangeOrderSource";

export interface BrowserTradeRecoveryObservation {
  readonly lifecycleState: CtfRangeOrderPreparationLifecycle;
  readonly resultState: DurableCustodyRecord["operation"]["result"]["state"] | null;
}

/** Read exact local facts only. An applied result does not prove that its outputs remain spendable. */
export async function readBrowserTradeRecoveryObservation(
  scope: Extract<DurableCustodyScope, { scopeKind: "wallet" }>,
  trade: Pick<PendingTrade, "walletId" | "marketId" | "orderId" | "clientOrderId">,
  database: BitcasterDB = db,
): Promise<BrowserTradeRecoveryObservation | null> {
  if (trade.walletId !== scope.walletId || !trade.clientOrderId) return null;
  if (
    deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: scope.walletId }) !== scope.scopeId
  ) {
    throw new Error("Trade recovery scope is inconsistent.");
  }
  return database.transaction(
    "r",
    database.ctfRangePreparations,
    database.custodyOperations,
    async () => {
      const journal = await readActiveCtfRangePreparationByClientOrderId(
        scope.scopeId,
        trade.clientOrderId!,
        database,
      );
      if (journal === null) return null;
      if (
        journal.orderRouteId !== trade.marketId ||
        journal.capability?.orderId !== trade.orderId
      ) {
        throw new Error("Trade recovery identity is inconsistent.");
      }
      const custody = await new BrowserDurableCustodyAdapter(database).readOperation(
        scope,
        browserCustodyOperationId(scope, journal.rangeOperationId),
      );
      if (
        custody !== null &&
        (custody.scope.scopeId !== scope.scopeId ||
          custody.operation.retainedOperationKey !== journal.rangeOperationId ||
          custody.operation.custodyContext.normalizedMint !== journal.normalizedMint ||
          custody.operation.custodyContext.unit !== journal.unit)
      )
        throw new Error("Trade custody identity is inconsistent.");
      return {
        lifecycleState: journal.lifecycleState,
        resultState: custody?.operation.result.state ?? null,
      };
    },
  );
}
