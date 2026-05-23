export interface AmountProofLike {
  amount: unknown
  id?: string
  secret?: string
  C?: string
}

export function sumProofs(proofs: readonly AmountProofLike[]): number {
  let total = 0
  for (const p of proofs) total += amountToNumber(p.amount)
  return total
}

export function takeProofsForLock<T extends AmountProofLike>(
  source: readonly T[],
  target: number,
): T[] | null {
  if (!Number.isFinite(target)) {
    return source.length > 0 ? [...source] : null
  }

  const sameKeyset = takeProofsForLockFromSingleKeyset(source, target)
  if (sameKeyset) return sameKeyset

  return takeGreedyProofs(source, target)
}

export function subtractProofs<T extends AmountProofLike>(
  source: readonly T[],
  take: readonly T[],
): T[] {
  const taken = new Set(take.map((p) => proofKey(p)))
  return source.filter((p) => !taken.has(proofKey(p)))
}

function takeProofsForLockFromSingleKeyset<T extends AmountProofLike>(
  source: readonly T[],
  target: number,
): T[] | null {
  const byKeyset = new Map<string, T[]>()
  for (const proof of source) {
    const keysetId = proof.id ?? ''
    const group = byKeyset.get(keysetId)
    if (group) group.push(proof)
    else byKeyset.set(keysetId, [proof])
  }

  return (
    [...byKeyset.values()]
      .map((group) => {
        const taken = takeGreedyProofs(group, target)
        return taken
          ? {
              taken,
              overpay: sumProofs(taken) - target,
              proofCount: taken.length,
            }
          : null
      })
      .filter(
        (
          candidate,
        ): candidate is { taken: T[]; overpay: number; proofCount: number } =>
          candidate !== null,
      )
      .sort((a, b) => a.overpay - b.overpay || a.proofCount - b.proofCount)[0]
      ?.taken ?? null
  )
}

function takeGreedyProofs<T extends AmountProofLike>(
  source: readonly T[],
  target: number,
): T[] | null {
  const sorted = [...source].sort((a, b) => amountToNumber(b.amount) - amountToNumber(a.amount))
  const taken: T[] = []
  let acc = 0
  for (const p of sorted) {
    if (acc >= target) break
    taken.push(p)
    acc += amountToNumber(p.amount)
  }
  return acc >= target ? taken : null
}

function proofKey(p: AmountProofLike): string {
  return `${p.id ?? ''}:${p.secret ?? ''}:${p.C ?? ''}`
}

export function amountToNumber(amount: unknown): number {
  if (typeof amount === 'number') return amount
  if (typeof amount === 'bigint') return Number(amount)
  if (typeof amount === 'string') return Number(amount)
  if (
    amount &&
    typeof amount === 'object' &&
    'toNumber' in amount &&
    typeof amount.toNumber === 'function'
  ) {
    return Number(amount.toNumber())
  }
  if (amount && typeof amount === 'object' && 'value' in amount) {
    return amountToNumber((amount as { value: unknown }).value)
  }
  return Number(amount)
}
