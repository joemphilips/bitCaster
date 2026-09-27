import { splitAmount, type Proof } from '@cashu/cashu-ts'
import {
  amountToNumber,
  computeInputFeeSubunitsFromPpk,
  computeInputFeeSubunitsForProofs,
  sumProofs,
  takeProofsForLock,
} from './proofSelection.ts'

export interface CtfRangeCapabilitySourceKeyset {
  readonly id: string
  readonly inputFeePpk: number
  readonly keys: Readonly<Record<string, string>>
}

/**
 * Names why no bounded source can fund a refused plan. `offered` means the
 * offered holding cannot cover the requested face. `collateral` means a Sell
 * holding covers the face within the mint bounds, but bounded regular cash
 * cannot pay the joint preparation fee. `mint-limits` means the cash would
 * pay that fee, but the selection exceeds the mint input or output bound.
 */
export type CtfRangeSourceShortfall = 'offered' | 'collateral' | 'mint-limits'

export type CtfRangeCapabilitySourcePlan =
  | {
      readonly kind: 'same-keyset-swap'
      readonly inputs: readonly Proof[]
      readonly inputFee: number
      readonly authorizationAmounts: readonly number[]
      readonly changeAmount: number
    }
  | {
      readonly kind: 'mixed-source-ctf-convert'
      readonly offeredInputs: readonly Proof[]
      readonly collateralInputs: readonly Proof[]
      readonly inputFee: number
      readonly authorizationAmounts: readonly number[]
      readonly offeredChangeAmounts: readonly number[]
      readonly collateralChangeAmounts: readonly number[]
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
  | { readonly kind: 'source-unavailable'; readonly shortfall: CtfRangeSourceShortfall }

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
  assertSourceCandidates(input)

  if (input.side === 'Buy') {
    return (
      planSameKeysetSource(input, authorizationAmounts, target, maxInputs, maxOutputs) ?? {
        kind: 'source-unavailable',
        shortfall: 'offered',
      }
    )
  }

  const mixed = planMixedSource(input, authorizationAmounts, target, maxInputs, maxOutputs)
  if (mixed.kind === 'mixed-source-ctf-convert') return mixed

  const offered = planSameKeysetSource(input, authorizationAmounts, target, maxInputs, maxOutputs)
  if (offered !== null) return offered

  switch (mixed.shortfall) {
    case 'offered':
      return planCollateralSource(input, authorizationAmounts, target, maxInputs, maxOutputs)
    case 'collateral':
    case 'mint-limits':
      // The held shares cover the face. Collateral-only conversion would
      // mint new shares instead of exiting the held ones, so name the shortfall.
      return { kind: 'source-unavailable', shortfall: mixed.shortfall }
    default:
      return assertNever(mixed.shortfall)
  }
}

type MixedSourceResult =
  | Extract<CtfRangeCapabilitySourcePlan, { kind: 'mixed-source-ctf-convert' }>
  | { readonly kind: 'refused'; readonly shortfall: CtfRangeSourceShortfall }

function planMixedSource(
  input: Parameters<typeof planCtfRangeCapabilitySource>[0],
  authorizationAmounts: readonly number[],
  target: number,
  maxInputs: number,
  maxOutputs: number,
): MixedSourceResult {
  const offered = takeProofsForLock(input.offeredCandidates, target)
  if (offered === null) return { kind: 'refused', shortfall: 'offered' }

  const remainingInputs = maxInputs - offered.length
  if (remainingInputs <= 0) {
    return { kind: 'refused', shortfall: inputBoundShortfall(input, offered) }
  }
  const collateral = selectCollateralForJointFee(
    offered,
    input.offeredKeyset,
    input.collateralCandidates,
    input.collateralKeyset,
    remainingInputs,
  )
  switch (collateral.kind) {
    case 'selected':
      break
    case 'fragmented':
      return { kind: 'refused', shortfall: inputBoundShortfall(input, offered) }
    case 'absent':
      return { kind: 'refused', shortfall: 'collateral' }
    default:
      return assertNever(collateral)
  }

  const inputs = [...offered, ...collateral.proofs]
  const inputFee = sourceFee(inputs, input.offeredKeyset, input.collateralKeyset)
  const offeredChangeAmounts = splitPositiveAmount(
    checkedSubtract(sumProofs(offered), target, 'offered change'),
    input.offeredKeyset.keys,
  )
  const collateralChangeAmounts = splitPositiveAmount(
    checkedSubtract(sumProofs(collateral.proofs), inputFee, 'collateral change'),
    input.collateralKeyset.keys,
  )
  if (
    authorizationAmounts.length + offeredChangeAmounts.length + collateralChangeAmounts.length >
    maxOutputs
  ) {
    return { kind: 'refused', shortfall: 'mint-limits' }
  }

  return {
    kind: 'mixed-source-ctf-convert',
    offeredInputs: offered,
    collateralInputs: collateral.proofs,
    inputFee,
    authorizationAmounts,
    offeredChangeAmounts,
    collateralChangeAmounts,
  }
}

/**
 * The input bound blocked the fee cash. Name the mint limit only when the
 * same deterministic selection, without that bound, finds cash for the joint
 * fee. Otherwise the missing cash is the actionable fact.
 */
function inputBoundShortfall(
  input: Parameters<typeof planCtfRangeCapabilitySource>[0],
  offered: readonly Proof[],
): CtfRangeSourceShortfall {
  const unbounded = selectCollateralForJointFee(
    offered,
    input.offeredKeyset,
    input.collateralCandidates,
    input.collateralKeyset,
    Math.max(1, input.collateralCandidates.length),
  )
  return unbounded.kind === 'selected' ? 'mint-limits' : 'collateral'
}

function selectCollateralForJointFee(
  offeredInputs: readonly Proof[],
  offeredKeyset: CtfRangeCapabilitySourceKeyset,
  candidates: readonly Proof[],
  collateralKeyset: CtfRangeCapabilitySourceKeyset,
  maxInputs: number,
): SourceSelection {
  const initialFeePpk = checkedAddFeePpk(
    sourceFeePpk(offeredInputs, offeredKeyset),
    collateralKeyset.inputFeePpk,
  )
  let targetFee = computeInputFeeSubunitsFromPpk(initialFeePpk)

  for (let attempt = 0; attempt < maxInputs; attempt += 1) {
    const selected = selectGrossSource(candidates, targetFee, maxInputs)
    if (selected.kind !== 'selected') return selected

    const fee = sourceFee([...offeredInputs, ...selected.proofs], offeredKeyset, collateralKeyset)
    if (sumProofs(selected.proofs) >= fee) return selected

    // Adding another regular input can add another fee unit. Re-select by the
    // exact joint fee, using the existing deterministic greedy primitive.
    targetFee = fee
  }
  return { kind: 'absent' }
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
  if (collateral.kind === 'absent') return { kind: 'source-unavailable', shortfall: 'offered' }
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

function selectGrossSource(
  candidates: readonly Proof[],
  target: number,
  maxInputs: number,
): SourceSelection {
  const selected = takeProofsForLock(candidates, target)
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

function sourceFee(
  proofs: readonly Proof[],
  offeredKeyset: CtfRangeCapabilitySourceKeyset,
  collateralKeyset: CtfRangeCapabilitySourceKeyset = offeredKeyset,
): number {
  return computeInputFeeSubunitsForProofs(proofs, {
    [offeredKeyset.id]: offeredKeyset.inputFeePpk,
    [collateralKeyset.id]: collateralKeyset.inputFeePpk,
  })
}

function sourceFeePpk(proofs: readonly Proof[], keyset: CtfRangeCapabilitySourceKeyset): number {
  const total = keyset.inputFeePpk * proofs.length
  if (!Number.isSafeInteger(total)) {
    throw new Error('CTF range source input fee exceeds the safe integer range')
  }
  return total
}

function checkedAddFeePpk(total: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || total > Number.MAX_SAFE_INTEGER - amount) {
    throw new Error('CTF range source input fee exceeds the safe integer range')
  }
  return total + amount
}

function assertSourceCandidates(input: Parameters<typeof planCtfRangeCapabilitySource>[0]): void {
  const seenSecrets = new Set<string>()
  for (const [candidates, keyset, label] of [
    [input.offeredCandidates, input.offeredKeyset, 'offered'],
    [input.collateralCandidates, input.collateralKeyset, 'collateral'],
  ] as const) {
    const groupSecrets = new Set<string>()
    for (const proof of candidates) {
      if (proof.id !== keyset.id) {
        throw new Error(`CTF range ${label} source candidates contain a foreign keyset`)
      }
      if (amountToNumber(proof.amount) <= 0 || proof.secret.length === 0 || proof.C.length === 0) {
        throw new Error(`CTF range ${label} source candidate is invalid`)
      }
      if (
        groupSecrets.has(proof.secret) ||
        (input.side === 'Sell' && seenSecrets.has(proof.secret))
      ) {
        throw new Error('CTF range source candidates contain a duplicate proof')
      }
      groupSecrets.add(proof.secret)
      seenSecrets.add(proof.secret)
    }
  }
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

function assertNever(value: never): never {
  throw new Error(`unsupported CTF range source variant: ${String(value)}`)
}
