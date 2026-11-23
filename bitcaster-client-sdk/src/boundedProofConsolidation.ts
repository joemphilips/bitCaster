import { splitAmount } from '@cashu/cashu-ts'

export interface ProofAmountCount {
  readonly amount: string
  readonly count: number
}

export interface ProofConsolidationRound {
  readonly inputs: string[]
  readonly outputs: string[]
  readonly fee: string
}

export type BoundedProofConsolidationPlan =
  | {
      readonly kind: 'ready'
      readonly consolidationRounds: ProofConsolidationRound[]
      readonly selectedInputs: string[]
      readonly consolidationFee: string
      readonly sourceFee: string
    }
  | {
      readonly kind: 'insufficient'
      readonly consolidationRounds: ProofConsolidationRound[]
    }
  | {
      readonly kind: 'not-reducible'
      readonly consolidationRounds: ProofConsolidationRound[]
    }
  | {
      readonly kind: 'round-limit'
      readonly consolidationRounds: ProofConsolidationRound[]
    }

export function planBoundedProofConsolidation(input: {
  readonly inventory: readonly ProofAmountCount[]
  readonly target: string
  readonly inputFeePpk: number
  readonly maxInputs: number
  readonly maxRounds: number
  readonly keysetKeys: Readonly<Record<string, string>>
}): BoundedProofConsolidationPlan {
  const target = positiveBigInt(input.target, 'consolidation target')
  const inputFeePpk = positiveInteger(input.inputFeePpk, 'consolidation input fee')
  const maxInputs = boundedInteger(input.maxInputs, 1, 256, 'consolidation input limit')
  const maxRounds = boundedInteger(input.maxRounds, 0, 4_096, 'consolidation round limit')
  const inventory = inventoryCounts(input.inventory)
  const consolidationRounds: ProofConsolidationRound[] = []
  let consolidationFee = 0n

  for (let round = 0; ; round += 1) {
    const selected = takeLargest(inventory, maxInputs)
    if (selected.length === 0) {
      return { kind: 'insufficient', consolidationRounds }
    }
    const sufficientSelection = findSufficientPrefix(selected, target, inputFeePpk)
    if (sufficientSelection !== null) {
      return {
        kind: 'ready',
        consolidationRounds,
        selectedInputs: sufficientSelection.inputs.map(String),
        consolidationFee: consolidationFee.toString(),
        sourceFee: sufficientSelection.fee.toString(),
      }
    }
    if (inventorySize(inventory) <= maxInputs) {
      return { kind: 'insufficient', consolidationRounds }
    }
    if (round >= maxRounds) {
      return { kind: 'round-limit', consolidationRounds }
    }
    const sourceFee = feeForInputs(inputFeePpk, selected.length)
    const outputAmount = sum(selected) - sourceFee
    if (outputAmount <= 0n) {
      return { kind: 'insufficient', consolidationRounds }
    }
    const outputs = splitAmount(outputAmount, { ...input.keysetKeys }).map((amount) =>
      BigInt(amount.toString()),
    )
    if (outputs.length >= selected.length) {
      return { kind: 'not-reducible', consolidationRounds }
    }
    removeAmounts(inventory, selected)
    addAmounts(inventory, outputs)
    consolidationFee += sourceFee
    consolidationRounds.push({
      inputs: selected.map(String),
      outputs: outputs.map(String),
      fee: sourceFee.toString(),
    })
  }
}

function findSufficientPrefix(
  selected: readonly bigint[],
  target: bigint,
  inputFeePpk: number,
): { readonly inputs: bigint[]; readonly fee: bigint } | null {
  let selectedTotal = 0n
  for (let index = 0; index < selected.length; index += 1) {
    selectedTotal += selected[index]!
    const fee = feeForInputs(inputFeePpk, index + 1)
    if (selectedTotal - fee >= target) {
      return { inputs: selected.slice(0, index + 1), fee }
    }
  }
  return null
}

function inventoryCounts(rows: readonly ProofAmountCount[]): Map<bigint, number> {
  const counts = new Map<bigint, number>()
  for (const row of rows) {
    const amount = positiveBigInt(row.amount, 'proof amount')
    const count = positiveInteger(row.count, 'proof amount count')
    counts.set(amount, safeCount((counts.get(amount) ?? 0) + count))
  }
  return counts
}

function takeLargest(counts: ReadonlyMap<bigint, number>, limit: number): bigint[] {
  const result: bigint[] = []
  const amounts = [...counts.keys()].sort((left, right) =>
    left > right ? -1 : left < right ? 1 : 0,
  )
  for (const amount of amounts) {
    const count = counts.get(amount) ?? 0
    const taken = Math.min(count, limit - result.length)
    for (let index = 0; index < taken; index += 1) result.push(amount)
    if (result.length === limit) break
  }
  return result
}

function removeAmounts(counts: Map<bigint, number>, amounts: readonly bigint[]): void {
  for (const amount of amounts) {
    const count = counts.get(amount)
    if (count === undefined || count < 1) throw new Error('proof inventory changed during planning')
    if (count === 1) counts.delete(amount)
    else counts.set(amount, count - 1)
  }
}

function addAmounts(counts: Map<bigint, number>, amounts: readonly bigint[]): void {
  for (const amount of amounts) {
    if (amount <= 0n) throw new Error('consolidation output amount is invalid')
    counts.set(amount, safeCount((counts.get(amount) ?? 0) + 1))
  }
}

function inventorySize(counts: ReadonlyMap<bigint, number>): number {
  let size = 0
  for (const count of counts.values()) size = safeCount(size + count)
  return size
}

function sum(amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n)
}

function feeForInputs(inputFeePpk: number, count: number): bigint {
  return (BigInt(inputFeePpk) * BigInt(count) + 999n) / 1_000n
}

function positiveBigInt(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`)
  return BigInt(value)
}

function positiveInteger(value: number, label: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label)
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('proof inventory count exceeds the safe integer bound')
  }
  return value
}
