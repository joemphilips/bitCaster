import type { DatabaseSync } from 'node:sqlite'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import {
  emptyDaemonState,
  readDaemonStateFromDatabase,
  summarizeWalletBalance,
  type LockedCustodyBalanceEntry,
  type WalletBalance,
} from './state.ts'

interface LockedCustodyBalanceRow {
  readonly normalizedMint: unknown
  readonly unit: unknown
  readonly conditionId: unknown
  readonly outcomeSetId: unknown
  readonly totalAmount: unknown
}

export function readWalletBalanceFromDatabase(database: DatabaseSync): WalletBalance {
  const state = readDaemonStateFromDatabase(database) ?? emptyDaemonState()
  return summarizeWalletBalance(state, readLockedCustodyBalance(database))
}

export async function readDaemonWalletBalance(directory: string): Promise<WalletBalance> {
  return createDaemonStateSqliteSession(directory).read(readWalletBalanceFromDatabase)
}

function readLockedCustodyBalance(database: DatabaseSync): LockedCustodyBalanceEntry[] {
  const scopeRows = database
    .prepare(
      `SELECT scope_id AS scopeId
       FROM custody_scopes
       WHERE scope_kind = 'wallet'
       LIMIT 2`,
    )
    .all() as Array<{ scopeId: unknown }>
  if (scopeRows.length !== 1 || typeof scopeRows[0]?.scopeId !== 'string') {
    throw new Error('daemon wallet balance requires exactly one custody scope')
  }

  const rows = database
    .prepare(
      `SELECT normalized_mint AS normalizedMint, unit,
         condition_id AS conditionId, outcome_set_id AS outcomeSetId,
         SUM(amount) AS totalAmount
       FROM custody_proofs
       WHERE scope_id = ?
         AND nut07_state = 'UNSPENT'
         AND selectability = 'locked'
       GROUP BY normalized_mint, unit, condition_id, outcome_set_id`,
    )
    .all(scopeRows[0].scopeId) as unknown as LockedCustodyBalanceRow[]
  return rows.map(decodeLockedCustodyBalanceRow)
}

function decodeLockedCustodyBalanceRow(row: LockedCustodyBalanceRow): LockedCustodyBalanceEntry {
  if (typeof row.normalizedMint !== 'string' || row.normalizedMint.length === 0) {
    throw new Error('daemon wallet balance mint is invalid')
  }
  if (row.unit !== 'sat' && row.unit !== 'msat') {
    throw new Error('daemon wallet balance unit is invalid')
  }
  if (!Number.isSafeInteger(row.totalAmount) || Number(row.totalAmount) <= 0) {
    throw new Error('daemon wallet balance amount is invalid')
  }
  const conditionId = nullableText(row.conditionId, 'condition')
  const outcomeSetId = nullableText(row.outcomeSetId, 'outcome set')
  if ((conditionId === null) !== (outcomeSetId === null)) {
    throw new Error('daemon wallet balance outcome identity is incomplete')
  }
  return {
    mintUrl: row.normalizedMint,
    unit: row.unit,
    amount: Number(row.totalAmount),
    conditionId,
    outcomeSetId,
  }
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`daemon wallet balance ${label} is invalid`)
  }
  return value
}
