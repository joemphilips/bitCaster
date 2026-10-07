import type { DatabaseSync } from 'node:sqlite'

export const COUNTER_MINT_ALIAS_ERROR = 'daemon keyset counter is bound to another mint URL'

export function assertCounterMintBinding(
  database: DatabaseSync,
  scopeId: string,
  keysetId: string,
  normalizedMint: string,
): void {
  const conflict = database
    .prepare(
      `SELECT 1 FROM target_keyset_counters
       WHERE scope_id = ? AND keyset_id = ? AND normalized_mint <> ?
       UNION ALL
       SELECT 1 FROM custody_keyset_counters
       WHERE scope_id = ? AND keyset_id = ? AND normalized_mint <> ?
       LIMIT 1`,
    )
    .get(scopeId, keysetId, normalizedMint, scopeId, keysetId, normalizedMint)
  if (conflict !== undefined) throw new Error(COUNTER_MINT_ALIAS_ERROR)
}
