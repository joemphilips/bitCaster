import { useLiveQuery } from "dexie-react-hooks";
import {
  readCtfRangeOrderLocks,
  walletDatabaseFor,
  type CtfRangeOrderLock,
} from "@/lib/ctfRangeOrderFunds";

const NO_LOCKS: Readonly<Record<string, CtfRangeOrderLock>> = {};

/**
 * The locks of these journal operations of one wallet, by operation, or
 * undefined before the first read. The query reads the journal, so the refund
 * that ends an operation removes its lock. It reads only the database of this
 * wallet; while another wallet's database is active, it gives no locks.
 */
export function useCtfRangeOrderLocks(
  scopeId: string | null,
  operationIds: readonly string[],
): Readonly<Record<string, CtfRangeOrderLock>> | undefined {
  const key = JSON.stringify([...operationIds].sort());
  return useLiveQuery(async () => {
    const ids = JSON.parse(key) as string[];
    if (scopeId === null || ids.length === 0) return NO_LOCKS;
    const database = walletDatabaseFor(scopeId);
    if (database === null) return NO_LOCKS;
    try {
      return await readCtfRangeOrderLocks(scopeId, ids, database);
    } catch {
      // Without its journal facts, the funds sentence names no amount or time.
      return NO_LOCKS;
    }
  }, [scopeId, key]);
}
