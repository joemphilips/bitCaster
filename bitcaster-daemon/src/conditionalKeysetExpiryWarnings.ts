import type { DatabaseSync } from 'node:sqlite'
import {
  CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNING_CODE,
  type ConditionalKeysetFinalExpiryWarning,
} from './protocol.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'

/** A held conditional keyset gets a warning less than 7 days before its final expiry. */
export const CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
/** The earliest expiries come first. The bound keeps an order submission frame small. */
export const CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNINGS_MAX = 32
/**
 * The proof import (durableWalletProofImportCoordinator.ts) stores the NUT-02
 * `final_expiry` in Unix seconds in `keyset_expiry_ms`. Its key and request
 * path identify its rows. A value below 10^12 is before 2001 as milliseconds,
 * so it cannot be the expiry of a keyset that a mint signs today. This reader
 * multiplies such a value by 1000. Other writers store milliseconds.
 */
const PROOF_IMPORT_KEY_PATTERN = 'completed-proof-import:*'
const PROOF_IMPORT_REQUEST_PATH = '/internal/custody/completed-proof-import'
const SECONDS_EXPIRY_BOUND = 1_000_000_000_000

/**
 * The profile has no table of keyset expiries. Two local sources give the
 * `final_expiry` of one held keyset:
 *
 * - An order on its condition. The private range operation of the order
 *   (`conditional-keyset-swap`) keeps `expiryAuthority.conditionalKeysets`:
 *   each conditional keyset of the condition with its own `final_expiry` in
 *   Unix seconds, as the mint listed it when the daemon prepared the order.
 *   This source covers a bought position, whose settlement also binds the
 *   regular input keyset.
 * - A custody operation that binds only that keyset, for example the import
 *   of a received token or an order refund. Its `keyset_expiry_ms` is the
 *   earliest final expiry of all its keysets, so an operation with more
 *   keysets does not give the expiry of one keyset.
 *
 * NUT-02 derives the keyset id from its `final_expiry`, so both sources give
 * one value. A held keyset with no source, for example one from a
 * complete-set split only, gets no warning.
 *
 * A keyset is held when the wallet has an unretired proof of it, or custody
 * has an unspent selectable or locked proof of it, for example the input of
 * a pending order refund.
 */
const HELD_CONDITIONAL_KEYSET_EXPIRIES_SQL = `
  WITH scope(id) AS (
    SELECT wallet_scope_id FROM daemon_profile WHERE singleton = 1
  ),
  held(condition_id, keyset_id) AS (
    SELECT proof.condition_id, proof.keyset_id
    FROM target_wallet_proofs AS proof JOIN scope ON proof.scope_id = scope.id
    WHERE proof.asset_kind = 'outcome' AND proof.retired_by_operation_id IS NULL
    UNION
    SELECT proof.condition_id, proof.keyset_id
    FROM custody_proofs AS proof JOIN scope ON proof.scope_id = scope.id
    WHERE proof.condition_id IS NOT NULL
      AND proof.nut07_state <> 'SPENT'
      AND proof.selectability IN ('selectable', 'locked')
      AND NOT EXISTS (
        SELECT 1 FROM target_wallet_proofs AS retired
        WHERE retired.scope_id = proof.scope_id
          AND retired.retired_custody_proof_id = proof.proof_id
      )
  ),
  single_keyset(keyset_id, expiry_ms) AS (
    SELECT binding.keyset_id, MIN(
      CASE
        WHEN operation.semantic_kind = 'generic-receive'
          AND operation.wallet_stage = 'receive'
          AND operation.request_path = ?
          AND operation.retained_operation_key GLOB ?
          AND operation.keyset_expiry_ms < ?
        THEN operation.keyset_expiry_ms * 1000
        ELSE operation.keyset_expiry_ms
      END
    )
    FROM custody_verification_bindings AS binding
    JOIN scope ON binding.scope_id = scope.id
    JOIN custody_operations AS operation
      ON operation.scope_id = binding.scope_id AND operation.operation_id = binding.operation_id
    WHERE operation.keyset_expiry_ms IS NOT NULL
      AND binding.keyset_id IN (SELECT keyset_id FROM held)
      AND NOT EXISTS (
        SELECT 1 FROM custody_verification_bindings AS other
        WHERE other.scope_id = binding.scope_id
          AND other.operation_id = binding.operation_id
          AND other.keyset_id <> binding.keyset_id
      )
    GROUP BY binding.keyset_id
  ),
  order_operation(keyset_id, operation_id) AS (
    -- One order per held keyset is enough: every order on the condition lists the same expiry.
    SELECT binding.keyset_id, MIN(binding.operation_id)
    FROM custody_verification_bindings AS binding
    JOIN scope ON binding.scope_id = scope.id
    JOIN custody_operations AS operation
      ON operation.scope_id = binding.scope_id AND operation.operation_id = binding.operation_id
    WHERE operation.semantic_kind = 'conditional-keyset-swap'
      AND binding.keyset_id IN (SELECT keyset_id FROM held)
    GROUP BY binding.keyset_id
  ),
  order_authority(keyset_id, expiry_ms) AS (
    -- CROSS JOIN keeps this order, so the read parses one artifact for each held keyset.
    SELECT order_operation.keyset_id, json_extract(entry.value, '$.finalExpiry') * 1000
    FROM order_operation
    CROSS JOIN custody_operations AS operation
    CROSS JOIN custody_artifacts AS artifact
    CROSS JOIN json_each(
      CAST(artifact.body AS TEXT),
      '$.expiryAuthority.conditionalKeysets'
    ) AS entry
    WHERE operation.scope_id = (SELECT id FROM scope)
      AND operation.operation_id = order_operation.operation_id
      AND artifact.scope_id = operation.scope_id
      AND artifact.artifact_id = operation.private_artifact_id
      AND artifact.encoding = 'canonical-json'
      AND json_extract(entry.value, '$.keysetId') = order_operation.keyset_id
      AND json_type(entry.value, '$.finalExpiry') = 'integer'
  ),
  expiry(keyset_id, expiry_ms) AS (
    SELECT keyset_id, MIN(expiry_ms)
    FROM (
      SELECT keyset_id, expiry_ms FROM single_keyset
      UNION ALL
      SELECT keyset_id, expiry_ms FROM order_authority
    )
    GROUP BY keyset_id
  )
  SELECT held.condition_id AS conditionId, held.keyset_id AS keysetId,
    expiry.expiry_ms AS expiryMs
  FROM held JOIN expiry ON expiry.keyset_id = held.keyset_id
  WHERE expiry.expiry_ms - ? < ?
  ORDER BY expiry.expiry_ms, held.condition_id, held.keyset_id
  LIMIT ?`

/** The warnings of the held conditional keysets. It reads only the local profile. */
export function readConditionalKeysetExpiryWarnings(
  database: DatabaseSync,
  nowMs: number,
): ConditionalKeysetFinalExpiryWarning[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('warning time is invalid')
  const rows = database
    .prepare(HELD_CONDITIONAL_KEYSET_EXPIRIES_SQL)
    .all(
      PROOF_IMPORT_REQUEST_PATH,
      PROOF_IMPORT_KEY_PATTERN,
      SECONDS_EXPIRY_BOUND,
      nowMs,
      CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNING_WINDOW_MS,
      CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNINGS_MAX,
    ) as Array<{ conditionId: unknown; keysetId: unknown; expiryMs: unknown }>
  return rows.map((row) => {
    if (
      typeof row.conditionId !== 'string' ||
      typeof row.keysetId !== 'string' ||
      !Number.isSafeInteger(row.expiryMs) ||
      (row.expiryMs as number) < 0
    ) {
      throw new Error('held conditional keyset expiry is invalid')
    }
    return {
      code: CONDITIONAL_KEYSET_FINAL_EXPIRY_WARNING_CODE,
      conditionId: row.conditionId,
      keysetId: row.keysetId,
      finalExpiryAt: new Date(row.expiryMs as number).toISOString(),
    }
  })
}

export function readDaemonConditionalKeysetExpiryWarnings(
  directory: string,
  nowMs: number,
): Promise<ConditionalKeysetFinalExpiryWarning[]> {
  return createDaemonStateSqliteSession(directory).read((database) =>
    readConditionalKeysetExpiryWarnings(database, nowMs),
  )
}
