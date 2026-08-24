import { buildTokenHoldings, type TokenHoldings } from '@bitcaster-market/client-sdk/tradingClient'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  cashuAmountToMarketSubunits,
  normalizeMarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import type { DaemonState, StoredProofRecord } from './state.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'

interface HoldingsRow {
  readonly assetKind: unknown
  readonly unit: unknown
  readonly outcomeSetId: unknown
  readonly totalAmount: unknown
}

export function buildDaemonTokenHoldings(
  state: DaemonState,
  input: { mintUrl?: string; conditionId: string; baseAsset?: string | null },
) {
  const primitiveProofsByAtom: Record<string, Array<{ amount: number }>> = {}
  const baseUnitProofs: Array<{ amount: number }> = []
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset)

  for (const record of state.wallet.proofs) {
    if (record.state !== 'available') continue
    if (input.mintUrl && record.mintUrl !== input.mintUrl) continue
    if (recordBaseAsset(record) !== baseAsset) continue

    if (record.asset.kind === 'Outcome') {
      if (record.asset.conditionId !== input.conditionId) continue
      for (const atom of atomsFromOutcomeSet(record.asset.outcomeSetId)) {
        ;(primitiveProofsByAtom[atom] ??= []).push({
          amount: proofMarketSubunits(record),
        })
      }
    } else {
      baseUnitProofs.push({ amount: proofMarketSubunits(record) })
    }
  }

  // Complement proof tracking is intentionally empty in this phase. The final
  // proof validity/spend gate remains the Cashu/mint settlement path; this is a
  // client-side UX pre-submit feasibility check only.
  return buildTokenHoldings(primitiveProofsByAtom, {}, baseUnitProofs)
}

export async function readDaemonTokenHoldings(
  directory: string,
  input: { mintUrl: string; conditionId: string; baseAsset?: string | null },
): Promise<TokenHoldings> {
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset)
  return createDaemonStateSqliteSession(directory).read((database) => {
    const scopeRows = database
      .prepare(
        `SELECT scope_id AS scopeId
         FROM custody_scopes
         WHERE scope_kind = 'wallet'
         LIMIT 2`,
      )
      .all() as Array<{ scopeId: unknown }>
    if (scopeRows.length !== 1 || typeof scopeRows[0]?.scopeId !== 'string') {
      throw new Error('daemon wallet holdings require exactly one custody scope')
    }
    const rows = database
      .prepare(
        `SELECT asset_kind AS assetKind, unit,
           outcome_set_id AS outcomeSetId, SUM(amount) AS totalAmount
         FROM target_wallet_proofs INDEXED BY target_wallet_proofs_holdings_idx
         WHERE scope_id = ?
           AND normalized_mint = ?
           AND state = 'available'
           AND base_asset = ?
           AND (
             asset_kind = 'sats'
             OR (asset_kind = 'outcome' AND condition_id = ?)
           )
         GROUP BY asset_kind, unit, outcome_set_id`,
      )
      .all(
        scopeRows[0].scopeId,
        input.mintUrl,
        baseAsset,
        input.conditionId,
      ) as unknown as HoldingsRow[]
    return holdingsFromRows(rows)
  })
}

export async function readDaemonAvailableRegularSatBalance(
  directory: string,
  input: { mintUrl: string },
): Promise<number> {
  return createDaemonStateSqliteSession(directory).read((database) => {
    const scopeRows = database
      .prepare(
        `SELECT scope_id AS scopeId
         FROM custody_scopes
         WHERE scope_kind = 'wallet'
         LIMIT 2`,
      )
      .all() as Array<{ scopeId: unknown }>
    if (scopeRows.length !== 1 || typeof scopeRows[0]?.scopeId !== 'string') {
      throw new Error('daemon Score balance requires exactly one custody scope')
    }
    const row = database
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS totalAmount
         FROM target_wallet_proofs INDEXED BY target_wallet_proofs_selection_idx
         WHERE scope_id = ?
           AND normalized_mint = ?
           AND unit = 'sat'
           AND asset_kind = 'sats'
           AND condition_id IS NULL
           AND outcome_set_id IS NULL
           AND state = 'available'`,
      )
      .get(scopeRows[0].scopeId, input.mintUrl) as { totalAmount: unknown }
    if (!Number.isSafeInteger(row.totalAmount) || Number(row.totalAmount) < 0) {
      throw new Error('daemon Score balance aggregate is invalid')
    }
    return Number(row.totalAmount)
  })
}

function holdingsFromRows(rows: readonly HoldingsRow[]): TokenHoldings {
  const primitiveByAtom = new Map<string, number>()
  let baseUnitProofs = 0
  for (const row of rows) {
    const amount = requireAggregatedAmount(row.totalAmount, row.unit)
    if (row.assetKind === 'sats' && row.outcomeSetId === null) {
      baseUnitProofs = safeAdd(baseUnitProofs, amount)
      continue
    }
    if (row.assetKind !== 'outcome' || typeof row.outcomeSetId !== 'string') {
      throw new Error('daemon wallet holdings row is invalid')
    }
    const atoms = atomsFromOutcomeSet(row.outcomeSetId)
    if (atoms.length === 0) throw new Error('daemon wallet outcome set is empty')
    for (const atom of atoms) {
      primitiveByAtom.set(atom, safeAdd(primitiveByAtom.get(atom) ?? 0, amount))
    }
  }
  return {
    primitiveProofsByAtom: Object.fromEntries(primitiveByAtom),
    complementProofsByAtom: {},
    baseUnitProofs,
  }
}

function requireAggregatedAmount(value: unknown, unit: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('daemon wallet holdings aggregate is invalid')
  }
  return cashuAmountToMarketSubunits(value, unit)
}

function safeAdd(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new Error('daemon wallet holdings exceed safe range')
  return sum
}

function proofMarketSubunits(record: StoredProofRecord): number {
  return cashuAmountToMarketSubunits(amountToNumber(record.proof.amount), record.asset.unit)
}

function recordBaseAsset(record: StoredProofRecord): string {
  return normalizeMarketBaseAsset(record.asset.baseAsset)
}

function atomsFromOutcomeSet(outcomeSetId: string): string[] {
  return outcomeSetId
    .split('|')
    .map((atom) => atom.trim())
    .filter(Boolean)
}
