import { splitAmount, type Proof } from '@cashu/cashu-ts'
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  sumProofs,
  takeProofsForLock,
} from './proofSelection.ts'

export interface CtfRangeCapabilitySourceKeyset {
  readonly id: string
  readonly inputFeePpk: number
  readonly keys: Readonly<Record<string, string>>
}

export type CtfRangeCapabilitySourcePlan =
  | {
      readonly kind: 'same-keyset-swap'
      readonly inputs: readonly Proof[]
      readonly inputFee: number
      readonly authorizationAmounts: readonly number[]
      readonly changeAmount: number
    }
  | {
      readonly kind: 'collateral-ctf-convert'
      readonly inputs: readonly Proof[]
      readonly inputFee: number
      readonly authorizationAmounts: readonly number[]
      readonly complementAmounts: readonly number[]
      readonly collateralChangeAmounts: readonly number[]
    }
  | {
      readonly kind: 'consolidation-required'
      readonly keysetId: string
      readonly selectedInputCount: number
      readonly maxInputs: number
    }
  | { readonly kind: 'source-unavailable' }

type SourceSelection =
  | { readonly kind: 'selected'; readonly proofs: Proof[] }
  | { readonly kind: 'fragmented'; readonly selectedInputCount: number }
  | { readonly kind: 'absent' }

export function planCtfRangeCapabilitySource(input: {
  readonly side: 'Buy' | 'Sell'
  readonly authorizationAmounts: readonly string[]
  readonly offeredKeyset: CtfRangeCapabilitySourceKeyset
  readonly collateralKeyset: CtfRangeCapabilitySourceKeyset
  readonly complementKeyset: CtfRangeCapabilitySourceKeyset
  readonly offeredCandidates: readonly Proof[]
  readonly collateralCandidates: readonly Proof[]
  readonly maxInputs: number
  readonly maxOutputs: number
}): CtfRangeCapabilitySourcePlan {
  const authorizationAmounts = decodeAmounts(input.authorizationAmounts, 'authorization')
  const target = sumAmounts(authorizationAmounts)
  const maxInputs = boundedLimit(input.maxInputs, 'input')
  const maxOutputs = boundedLimit(input.maxOutputs, 'output')
  assertKeyset(input.offeredKeyset, 'offered')
  assertKeyset(input.collateralKeyset, 'collateral')
  assertKeyset(input.complementKeyset, 'complement')

  const offered = planSameKeysetSource(input, authorizationAmounts, target, maxInputs, maxOutputs)
  if (offered !== null) return offered

  if (input.side === 'Buy') return { kind: 'source-unavailable' }
  return planCollateralSource(input, authorizationAmounts, target, maxInputs, maxOutputs)
}

function planSameKeysetSource(
  input: Parameters<typeof planCtfRangeCapabilitySource>[0],
  authorizationAmounts: readonly number[],
  target: number,
  maxInputs: number,
  maxOutputs: number,
): CtfRangeCapabilitySourcePlan | null {
  const offered = selectExactSource(input.offeredCandidates, input.offeredKeyset, target, maxInputs)
  if (offered.kind === 'absent') return null
  if (offered.kind === 'fragmented') {
    return consolidationRequired(input.offeredKeyset.id, offered.selectedInputCount, maxInputs)
  }
  const inputFee = sourceFee(offered.proofs, input.offeredKeyset)
  const changeAmount = checkedSubtract(
    sumProofs(offered.proofs),
    target + inputFee,
    'offered change',
  )
  const changeAmounts = splitPositiveAmount(changeAmount, input.offeredKeyset.keys)
  assertOutputCount(authorizationAmounts.length + changeAmounts.length, maxOutputs)
  return {
    kind: 'same-keyset-swap',
    inputs: offered.proofs,
    inputFee,
    authorizationAmounts,
    changeAmount,
  }
}

function planCollateralSource(
  input: Parameters<typeof planCtfRangeCapabilitySource>[0],
  authorizationAmounts: readonly number[],
  target: number,
  maxInputs: number,
  maxOutputs: number,
): CtfRangeCapabilitySourcePlan {
  const collateral = selectExactSource(
    input.collateralCandidates,
    input.collateralKeyset,
    target,
    maxInputs,
  )
  if (collateral.kind === 'absent') return { kind: 'source-unavailable' }
  if (collateral.kind === 'fragmented') {
    return consolidationRequired(
      input.collateralKeyset.id,
      collateral.selectedInputCount,
      maxInputs,
    )
  }

  const inputFee = sourceFee(collateral.proofs, input.collateralKeyset)
  const collateralChange = checkedSubtract(
    sumProofs(collateral.proofs),
    target + inputFee,
    'collateral change',
  )
  const complementAmounts = splitExactAmount(target, input.complementKeyset.keys, 'complement')
  const collateralChangeAmounts = splitPositiveAmount(collateralChange, input.collateralKeyset.keys)
  assertOutputCount(
    authorizationAmounts.length + complementAmounts.length + collateralChangeAmounts.length,
    maxOutputs,
  )
  return {
    kind: 'collateral-ctf-convert',
    inputs: collateral.proofs,
    inputFee,
    authorizationAmounts,
    complementAmounts,
    collateralChangeAmounts,
  }
}

function selectExactSource(
  candidates: readonly Proof[],
  keyset: CtfRangeCapabilitySourceKeyset,
  target: number,
  maxInputs: number,
): SourceSelection {
  if (candidates.some((proof) => proof.id !== keyset.id)) {
    throw new Error('CTF range source candidates contain a foreign keyset')
  }
  const selected = takeProofsForLock(candidates, target, { [keyset.id]: keyset.inputFeePpk })
  if (selected === null) return { kind: 'absent' }
  return selected.length <= maxInputs
    ? { kind: 'selected', proofs: selected }
    : { kind: 'fragmented', selectedInputCount: selected.length }
}

function consolidationRequired(
  keysetId: string,
  selectedInputCount: number,
  maxInputs: number,
): CtfRangeCapabilitySourcePlan {
  return { kind: 'consolidation-required', keysetId, selectedInputCount, maxInputs }
}

function sourceFee(proofs: readonly Proof[], keyset: CtfRangeCapabilitySourceKeyset): number {
  return computeInputFeeSatsForProofs(proofs, { [keyset.id]: keyset.inputFeePpk })
}

function decodeAmounts(values: readonly string[], label: string): number[] {
  if (values.length === 0) throw new Error(`CTF range ${label} amounts are empty`)
  return values.map((value) => {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`CTF range ${label} amount is invalid`)
    }
    return amountToNumber(value)
  })
}

function splitExactAmount(
  amount: number,
  keys: Readonly<Record<string, string>>,
  label: string,
): number[] {
  const parts = splitAmount(BigInt(amount), { ...keys }).map((part) => amountToNumber(part))
  if (parts.length === 0 || sumAmounts(parts) !== amount) {
    throw new Error(`CTF range ${label} amount is not supported by its keyset`)
  }
  return parts
}

function splitPositiveAmount(amount: number, keys: Readonly<Record<string, string>>): number[] {
  return amount === 0 ? [] : splitExactAmount(amount, keys, 'change')
}

function sumAmounts(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    total += amountToNumber(value)
    if (!Number.isSafeInteger(total)) throw new Error('CTF range source amount overflow')
  }
  return total
}

function checkedSubtract(left: number, right: number, label: string): number {
  const value = left - right
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CTF range ${label} is invalid`)
  }
  return value
}

function boundedLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw new Error(`CTF range ${label} limit is invalid`)
  }
  return value
}

function assertOutputCount(count: number, maxOutputs: number): void {
  if (count > maxOutputs) throw new Error('CTF range source exceeds the mint output limit')
}

function assertKeyset(keyset: CtfRangeCapabilitySourceKeyset, label: string): void {
  if (
    keyset.id.length === 0 ||
    !Number.isSafeInteger(keyset.inputFeePpk) ||
    keyset.inputFeePpk <= 0 ||
    Object.keys(keyset.keys).length === 0
  ) {
    throw new Error(`CTF range ${label} keyset is invalid`)
  }
}
