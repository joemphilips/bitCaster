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
  inputFeePpkByKeyset?: Record<string, number>,
): T[] | null {
  if (!Number.isFinite(target)) {
    return source.length > 0 ? [...source] : null
  }

  const sameKeyset = takeProofsForLockFromSingleKeyset(source, target, inputFeePpkByKeyset)
  if (sameKeyset) return sameKeyset

  return takeGreedyProofs(source, target, inputFeePpkByKeyset)
}

export function subtractProofs<T extends AmountProofLike>(
  source: readonly T[],
  take: readonly T[],
): T[] {
  const taken = new Set(take.map((p) => proofKey(p)))
  return source.filter((p) => !taken.has(proofKey(p)))
}

export function keysetToOutcomeCollection<T>(
  rows: readonly T[],
  read: (row: T) => { keysetId?: string; outcomeCollection?: string | null },
): Map<string, string> {
  const result = new Map<string, string>()
  for (const row of rows) {
    const { keysetId, outcomeCollection } = read(row)
    if (!outcomeCollection) continue
    if (!keysetId) throw new Error('Outcome proof is missing keyset id')
    const existing = result.get(keysetId)
    if (existing && existing !== outcomeCollection) {
      throw new Error(`Keyset ${keysetId} maps to both ${existing} and ${outcomeCollection}`)
    }
    result.set(keysetId, outcomeCollection)
  }
  return result
}

export function computeInputFeeSubunitsFromPpk(inputFeePpk: number): number {
  if (!Number.isSafeInteger(inputFeePpk) || inputFeePpk < 0) {
    throw new Error('input_fee_ppk total must be a non-negative safe integer')
  }
  return Math.ceil(inputFeePpk / 1_000)
}

export function computeInputFeeSatsForProofs(
  proofs: readonly AmountProofLike[],
  inputFeePpkByKeyset: Record<string, number>,
): number {
  let feePpk = 0
  for (const proof of proofs) {
    if (!proof.id) throw new Error('Input proof is missing keyset id')
    const inputFeePpk = inputFeePpkByKeyset[proof.id]
    if (!Number.isSafeInteger(inputFeePpk) || inputFeePpk < 0) {
      throw new Error(`Missing input_fee_ppk for keyset ${proof.id}`)
    }
    feePpk += inputFeePpk
  }
  return computeInputFeeSubunitsFromPpk(feePpk)
}

function takeProofsForLockFromSingleKeyset<T extends AmountProofLike>(
  source: readonly T[],
  target: number,
  inputFeePpkByKeyset?: Record<string, number>,
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
        const taken = takeGreedyProofs(group, target, inputFeePpkByKeyset)
        return taken
          ? {
              taken,
              overpay: spendableProofAmount(taken, inputFeePpkByKeyset) - target,
              proofCount: taken.length,
            }
          : null
      })
      .filter(
        (candidate): candidate is { taken: T[]; overpay: number; proofCount: number } =>
          candidate !== null,
      )
      .sort((a, b) => a.overpay - b.overpay || a.proofCount - b.proofCount)[0]?.taken ?? null
  )
}

function takeGreedyProofs<T extends AmountProofLike>(
  source: readonly T[],
  target: number,
  inputFeePpkByKeyset?: Record<string, number>,
): T[] | null {
  const sorted = [...source].sort((a, b) => amountToNumber(b.amount) - amountToNumber(a.amount))
  const taken: T[] = []
  let spendable = 0
  for (const p of sorted) {
    if (spendable >= target) break
    taken.push(p)
    spendable = spendableProofAmount(taken, inputFeePpkByKeyset)
  }
  return spendable >= target ? taken : null
}

function spendableProofAmount(
  proofs: readonly AmountProofLike[],
  inputFeePpkByKeyset?: Record<string, number>,
): number {
  const face = sumProofs(proofs)
  if (!inputFeePpkByKeyset) return face
  return face - computeInputFeeSatsForProofs(proofs, inputFeePpkByKeyset)
}

function proofKey(p: AmountProofLike): string {
  return `${p.id ?? ''}:${p.secret ?? ''}:${p.C ?? ''}`
}

export function amountToNumber(amount: unknown): number {
  if (typeof amount === 'number') return validateAmountNumber(amount)
  if (typeof amount === 'bigint') return validateAmountNumber(Number(amount))
  if (typeof amount === 'string') return validateAmountNumber(Number(amount))
  if (
    amount &&
    typeof amount === 'object' &&
    'toNumber' in amount &&
    typeof amount.toNumber === 'function'
  ) {
    return validateAmountNumber(Number(amount.toNumber()))
  }
  if (amount && typeof amount === 'object' && 'value' in amount) {
    return amountToNumber((amount as { value: unknown }).value)
  }
  return validateAmountNumber(Number(amount))
}

function validateAmountNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cashu amount must be a non-negative safe integer')
  }
  return value
}
