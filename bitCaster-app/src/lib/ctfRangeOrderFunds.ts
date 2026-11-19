import type {
  CtfRangeOrderPreparationLifecycle,
  CtfRangeOrderPreparationRecord,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import {
  decodeCtfRangeOrderPreparationFromRecord,
  planPersistedCtfRangeOrderAuthorization,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import type { BrowserCtfRangeOrderErrorCode } from "@/lib/browserCtfRangeOrderCoordinator";
import type { TradeRetryRequest } from "@/stores/tradeRetryRequest";
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
 * The funds that an active order attempt holds until its authorization
 * expires. Display state only: it grants no funds authority.
 */
export interface CtfRangeOrderLock {
  readonly side: "Buy" | "Sell";
  /** The planned authorization inputs: msat for a Buy, share face subunits for a Sell. */
  readonly lockedSubunits: number;
  readonly divisibility: number;
  /** The authorization expiry. The refund can start at this time. */
  readonly unlockAtMs: number;
  /** The order that a Retry starts again from. */
  readonly retry: TradeRetryRequest;
}

/**
 * The lock of one journal record, or null when its preparation does not
 * decode. The SDK plans the same exact inputs that the source preparation
 * created, so this reads no custody row.
 */
export function ctfRangeOrderLock(
  record: CtfRangeOrderPreparationRecord,
): CtfRangeOrderLock | null {
  let lockedSubunits: number;
  try {
    lockedSubunits = Number(
      planPersistedCtfRangeOrderAuthorization(decodeCtfRangeOrderPreparationFromRecord(record))
        .inputAmount,
    );
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(lockedSubunits)) return null;
  return {
    side: record.side,
    lockedSubunits,
    divisibility: record.divisibility,
    unlockAtMs: record.authorizationExpiresAtUnixSeconds * 1_000,
    retry: {
      conditionId: record.conditionId,
      orderRouteId: record.orderRouteId,
      tokenSide: record.tokenSide,
      side: record.side,
      amountSubunits: record.amountSubunits,
    },
  };
}

/** The locks of the active journal records among these operations, by operation. */
export async function readCtfRangeOrderLocks(
  scopeId: string,
  operationIds: readonly string[],
  database: BitcasterDB = db,
): Promise<Record<string, CtfRangeOrderLock>> {
  const locks: Record<string, CtfRangeOrderLock> = {};
  for (const operationId of operationIds) {
    const record = await readCtfRangePreparation(scopeId, operationId, database);
    if (record === null || isTerminalCtfRangePreparation(record.lifecycleState)) continue;
    const lock = ctfRangeOrderLock(record);
    if (lock !== null) locks[operationId] = lock;
  }
  return locks;
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
