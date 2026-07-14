import { buildTokenHoldings } from '@bitcaster-market/client-sdk/tradingClient'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { normalizeMarketBaseAsset } from '@bitcaster-market/client-sdk/marketUnits'
import type { DaemonState, StoredProofRecord } from './state.ts'
import type { DaemonWalletHoldingTotals } from './stateSqlite.ts'

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
          amount: amountToNumber(record.proof.amount),
        })
      }
    } else {
      baseUnitProofs.push({ amount: amountToNumber(record.proof.amount) })
    }
  }

  // Complement proof tracking is intentionally empty in this phase. The final
  // proof validity/spend gate remains the Cashu/mint settlement path; this is a
  // client-side UX pre-submit feasibility check only.
  return buildTokenHoldings(primitiveProofsByAtom, {}, baseUnitProofs)
}

export function buildDaemonTokenHoldingsFromTotals(
  totals: DaemonWalletHoldingTotals,
) {
  const primitiveProofsByAtom: Record<string, number> = {}
  for (const [outcomeSetId, amount] of Object.entries(
    totals.outcomeAmountsBySet,
  )) {
    for (const atom of atomsFromOutcomeSet(outcomeSetId)) {
      primitiveProofsByAtom[atom] = (primitiveProofsByAtom[atom] ?? 0) + amount
    }
  }
  return {
    primitiveProofsByAtom,
    complementProofsByAtom: {},
    baseUnitProofs: totals.baseUnitProofs,
  }
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
