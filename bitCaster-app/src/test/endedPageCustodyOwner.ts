import {
  claimDurableCustodyScope,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import type { BitcasterDB } from "../stores/proof-db";

/**
 * Write the scope claim of another page, for example a page that ended
 * without a release. This page does not run that owner, so a later claim of
 * this page replaces it. Its authorization stays valid until then.
 */
export async function claimScopeForEndedPage(
  database: BitcasterDB,
  scope: DurableCustodyScope,
  input: { incarnationId: string; observedAtMs: number; leaseExpiresAtMs: number },
): Promise<DurableCustodyOwnerAuthorization> {
  await new BrowserDurableCustodyAdapter(database).ensureScope(scope, input.observedAtMs);
  return database.transaction("rw", database.custodyScopes, async () => {
    const row = await database.custodyScopes.get(scope.scopeId);
    if (row === undefined) throw new Error("test custody scope is missing");
    const state = claimDurableCustodyScope(row.state, input);
    await database.custodyScopes.put({ scopeId: scope.scopeId, state });
    return {
      incarnationId: input.incarnationId,
      fencingEpoch: state.fencingEpoch,
      observedAtMs: input.observedAtMs,
    };
  });
}
