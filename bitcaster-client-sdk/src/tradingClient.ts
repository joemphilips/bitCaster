export const RATIO_TARGET = 0.4
export const RATIO_MIN = 0.05
export const RATIO_MAX = 0.6

// 2n+1 token holdings: n primitive outcome tokens, n complement tokens, and one base-unit bucket.
export interface TokenHoldings {
  primitiveProofsByAtom: Record<string, number>
  complementProofsByAtom: Record<string, number>
  baseUnitProofs: number
}

export type Reservations = Record<string, number>

export function vcsAvailable(holdings: TokenHoldings, reservations: Reservations): number {
  const atoms = new Set([
    ...Object.keys(holdings.primitiveProofsByAtom),
    ...Object.keys(holdings.complementProofsByAtom),
    ...Object.keys(reservations),
  ])

  if (atoms.size === 0) return 0

  let available = Number.POSITIVE_INFINITY
  for (const atom of atoms) {
    const primitive = finiteOrZero(holdings.primitiveProofsByAtom[atom])
    const complement = finiteOrZero(holdings.complementProofsByAtom[atom])
    const reserved = finiteOrZero(reservations[atom])
    available = Math.min(available, Math.max(0, primitive + complement - reserved))
  }

  return Math.floor(available)
}

export function computeTokenRatio(holdings: TokenHoldings): {
  baseUnitRatio: number
  withinBounds: boolean
} {
  const baseUnitProofs = Math.max(0, finiteOrZero(holdings.baseUnitProofs))
  const ctfProofs = vcsAvailable(holdings, {})
  const total = baseUnitProofs + ctfProofs
  const baseUnitRatio = total > 0 ? baseUnitProofs / total : RATIO_TARGET

  return {
    baseUnitRatio,
    withinBounds: baseUnitRatio >= RATIO_MIN && baseUnitRatio <= RATIO_MAX,
  }
}

export function canBackOrder(
  order: { side: 'bid' | 'ask'; sizeSubunits: number; shareFaceSubunits: number },
  holdings: TokenHoldings,
  reserves: Reservations,
  divisibility: number,
): { canBack: boolean; maxShares: number } {
  if (!isPositiveFinite(order.sizeSubunits) || !isPositiveFinite(order.shareFaceSubunits)) {
    return { canBack: false, maxShares: 0 }
  }
  if (!Number.isInteger(divisibility) || divisibility <= 0) {
    return { canBack: false, maxShares: 0 }
  }

  const requiredShares = Math.ceil(order.sizeSubunits / order.shareFaceSubunits)

  if (order.side === 'bid') {
    // Buys are backed by base-unit collateral (sats), not VCS.
    // The buyer pays sats and receives outcome tokens at settlement.
    const availableBase = Math.max(0, finiteOrZero(holdings.baseUnitProofs))
    const maxShares = Math.floor(availableBase / order.shareFaceSubunits)
    return {
      canBack: maxShares >= requiredShares,
      maxShares,
    }
  }

  // Sells (asks) are backed by VCS — the seller delivers outcome tokens
  // (directly or via complement merge) and receives sats.
  const maxShares = Math.floor(vcsAvailable(holdings, reserves) / order.shareFaceSubunits)
  return {
    canBack: maxShares >= requiredShares,
    maxShares,
  }
}

export function buildTokenHoldings(
  primitiveProofsByAtom: Record<string, { amount: number }[]>,
  complementProofsByAtom: Record<string, { amount: number }[]>,
  baseUnitProofs: { amount: number }[],
): TokenHoldings {
  return {
    primitiveProofsByAtom: sumProofsByAtom(primitiveProofsByAtom),
    complementProofsByAtom: sumProofsByAtom(complementProofsByAtom),
    baseUnitProofs: sumProofs(baseUnitProofs),
  }
}

function sumProofsByAtom(
  proofsByAtom: Record<string, { amount: number }[]>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(proofsByAtom).map(([atom, proofs]) => [atom, sumProofs(proofs)]),
  )
}

function sumProofs(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, proof) => sum + finiteOrZero(proof.amount), 0)
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}
