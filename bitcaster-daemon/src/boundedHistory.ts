import type { DatabaseSync } from 'node:sqlite'

export const DAEMON_HISTORY_PAGE_LIMIT = 256
export const DAEMON_HISTORY_PAGE_BYTES_MAX = 4 * 1_024 * 1_024

export interface CustodyHistoryRow {
  readonly operationId: string
  readonly revision: number
  readonly semanticKind: string
  readonly operationState: string
  readonly updatedAtMs: number
}

export interface CustodyHistoryPage {
  readonly rows: readonly CustodyHistoryRow[]
  readonly nextCursor: string | null
  readonly estimatedBytes: number
}

export function readBoundedCustodyHistory(
  database: DatabaseSync,
  scopeId: string,
  cursor: string | null = null,
): CustodyHistoryPage {
  const [cursorTime, cursorId] = decodeHistoryCursor(cursor)
  const rows = database
    .prepare(
      `SELECT operation_id AS operationId, revision, semantic_kind AS semanticKind,
         operation_state AS operationState, updated_at_ms AS updatedAtMs
       FROM custody_operations
       WHERE scope_id = ?
         AND (? IS NULL OR updated_at_ms < ?
           OR (updated_at_ms = ? AND operation_id < ?))
       ORDER BY updated_at_ms DESC, operation_id DESC
       LIMIT ?`,
    )
    .all(
      scopeId,
      cursorTime,
      cursorTime,
      cursorTime,
      cursorId,
      DAEMON_HISTORY_PAGE_LIMIT + 1,
    ) as unknown as CustodyHistoryRow[]
  const { rows: selected } = takeBoundedCustodyHistoryRows(rows)
  let last = selected.at(-1)
  let nextCursor =
    selected.length < rows.length && last !== undefined
      ? `${last.updatedAtMs}:${encodeURIComponent(last.operationId)}`
      : null
  let exactPageBytes = custodyHistorySerializedPageBytes(selected, nextCursor)
  while (exactPageBytes > DAEMON_HISTORY_PAGE_BYTES_MAX && selected.length > 0) {
    selected.pop()
    last = selected.at(-1)
    nextCursor =
      last === undefined ? null : `${last.updatedAtMs}:${encodeURIComponent(last.operationId)}`
    exactPageBytes = custodyHistorySerializedPageBytes(selected, nextCursor)
  }
  return {
    rows: selected,
    estimatedBytes: exactPageBytes,
    nextCursor,
  }
}

export function takeBoundedCustodyHistoryRows(rows: readonly CustodyHistoryRow[]): {
  rows: CustodyHistoryRow[]
  serializedBytes: number
} {
  const selected: CustodyHistoryRow[] = []
  let serializedBytes = custodyHistorySerializedPageBytes(selected, null)
  for (const row of rows) {
    if (selected.length === DAEMON_HISTORY_PAGE_LIMIT) break
    const candidate = [...selected, row]
    const candidateBytes = custodyHistorySerializedPageBytes(candidate, null)
    if (candidateBytes > DAEMON_HISTORY_PAGE_BYTES_MAX) break
    selected.push(row)
    serializedBytes = candidateBytes
  }
  return { rows: selected, serializedBytes }
}

export function custodyHistorySerializedPageBytes(
  rows: readonly CustodyHistoryRow[],
  nextCursor: string | null,
): number {
  let estimatedBytes = 0
  for (;;) {
    const exact = new TextEncoder().encode(
      JSON.stringify({ rows, nextCursor, estimatedBytes }),
    ).length
    if (exact === estimatedBytes) return exact
    estimatedBytes = exact
  }
}

function decodeHistoryCursor(cursor: string | null): [number | null, string] {
  if (cursor === null) return [null, '']
  const separator = cursor.indexOf(':')
  const time = Number(cursor.slice(0, separator))
  const operationId = decodeURIComponent(cursor.slice(separator + 1))
  if (separator <= 0 || !Number.isSafeInteger(time) || time < 0 || operationId.length === 0) {
    throw new Error('custody history cursor is invalid')
  }
  return [time, operationId]
}
