import {
  Amount,
  OutputData,
  splitAmount,
  type CounterSource,
  type ConditionalSwapPreview,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  decodeDurableCustodyProofOperationInput,
  deserializeDurableCustodyOutput,
  serializeDurableCustodyProofInput,
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { prepareCtfRangeOrderAuthorization } from './ctfRangeOrderPreparation.ts'
import { planCtfRangeOrderAuthorization } from './ctfRangeOrderAuthorization.ts'
import {
  planBoundedProofConsolidation,
  type BoundedProofConsolidationPlan,
  type ProofAmountCount,
} from './boundedProofConsolidation.ts'
import type { PersistedCtfRangeOrderPreparation } from './ctfRangeOrderProtocol.ts'
import {
  amountToNumber,
  computeInputFeeSubunitsForProofs,
  sumProofs,
  takeProofsForLock,
} from './proofSelection.ts'
import {
  decodeDurableSeedDerivedOutputPlan,
  matchDurableSeedDerivedProofsToPlan,
  reconstructDurableSeedDerivedOutputs,
  reserveAndConstructDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from './durableSeedDerivedOutputs.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const MIXED_SOURCE_ENDPOINT = 'POST /v1/ctf/convert'
declare const VALIDATED_SOURCE_COMPLETION: unique symbol

export type CtfRangeSourceMode =
  | 'wallet-send'
  | 'conditional-keyset-swap'
  | 'mixed-source-ctf-convert'
  | 'ctf-range-collateral-convert'

export interface ValidatedCtfRangeSourceCompletionOperation {
  readonly operation: DurableCustodyProofOperationInput
  readonly outputs: Record<string, OutputData[]>
  readonly [VALIDATED_SOURCE_COMPLETION]: true
}

export interface CtfRangeSourceWallet {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig: {
      send: { type: 'custom'; data: OutputData[] }
      keep: { type: 'custom'; data: OutputData[] }
    },
  ): Promise<SwapPreview>
  completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareConditionalSwap(options: {
    keysetId: string
    inputs: Proof[]
    outputs: Array<
      | { label: string; kind: 'custom'; data: OutputData[] }
      | { label: string; kind: 'random'; amount: number }
    >
  }): Promise<ConditionalSwapPreview>
  completeConditionalSwap(preview: ConditionalSwapPreview): Promise<Record<string, Proof[]>>
}

export interface CtfRangeSourceResult {
  readonly authorization: readonly Proof[]
  readonly keep: readonly Proof[]
}

export interface CtfRangeSourceKeepDerivationLocator {
  readonly schemaVersion: 1
  readonly kind: 'nut13'
  readonly keysetId: string
  readonly counter: number
}

export function planCtfRangeSourceConsolidation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly inventory: readonly ProofAmountCount[]
  readonly maxRounds: number
}): BoundedProofConsolidationPlan {
  const preparation = input.preparation
  const authorization = planCtfRangeOrderAuthorization({
    side: preparation.side,
    priceNumerator: preparation.priceNumerator,
    amountSubunits: preparation.amountSubunits,
    divisibility: preparation.divisibility,
    inputFeePpk: preparation.offerKeyset.inputFeePpk,
    offerKeysetKeys: preparation.offerKeyset.keys,
    maxPoolEntries: preparation.maxPoolEntries,
    maxInputs: preparation.maxInputs,
  })
  return planBoundedProofConsolidation({
    inventory: input.inventory,
    target: authorization.inputAmount,
    inputFeePpk: preparation.offerKeyset.inputFeePpk,
    maxInputs: preparation.maxInputs,
    maxRounds: input.maxRounds,
    keysetKeys: preparation.offerKeyset.keys,
  })
}

export async function prepareCtfRangeSourceOperation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly wallet: CtfRangeSourceWallet
  readonly candidates: readonly Proof[]
}): Promise<DurableCustodyProofOperationInput | null> {
  const prepared = prepareCtfRangeOrderAuthorization({
    seed: input.seed,
    ...withoutRequest(input.preparation),
  })
  const target = amountToNumber(OutputData.sumOutputAmounts(prepared.authorizationOutputs))
  const selected = takeProofsForLock([...input.candidates], target, {
    [input.preparation.offerKeyset.id]: input.preparation.offerKeyset.inputFeePpk,
  })
  if (selected === null) return null
  const fees = computeInputFeeSubunitsForProofs(selected, {
    [input.preparation.offerKeyset.id]: input.preparation.offerKeyset.inputFeePpk,
  })
  const change = sumProofs(selected) - fees - target
  if (!Number.isSafeInteger(change) || change < 0) {
    throw new Error('range source is underfunded')
  }
  const keep = await reserveSourceKeepOutputs({
    seed: input.seed,
    counterSource: input.counterSource,
    keyset: input.preparation.offerKeyset,
    change,
  })
  return input.preparation.side === 'Buy'
    ? prepareRegularSource(
        input.preparation,
        input.wallet,
        prepared.authorizationOutputs,
        selected,
        fees,
        keep,
      )
    : prepareConditionalSource(
        input.preparation,
        input.wallet,
        prepared.authorizationOutputs,
        selected,
        target,
        fees,
        keep,
      )
}

export async function completeCtfRangeSourceOperation(
  operation: DurableCustodyProofOperationInput,
  wallet: CtfRangeSourceWallet,
): Promise<CtfRangeSourceResult> {
  const validated = validateCtfRangeSourceCompletionOperation(operation)
  return completeValidatedCtfRangeSourceOperation(validated, wallet)
}

export async function completeValidatedCtfRangeSourceOperation(
  validated: ValidatedCtfRangeSourceCompletionOperation,
  wallet: CtfRangeSourceWallet,
): Promise<CtfRangeSourceResult> {
  const operation = validated.operation
  const mode = sourceMode(operation)
  switch (mode) {
    case 'conditional-keyset-swap': {
      const result = await wallet.completeConditionalSwap({
        keysetId: metadataText(operation, 'keysetId'),
        inputs: operation.inputs as Proof[],
        outputDataByLabel: validated.outputs,
      })
      return { authorization: result.authorization ?? [], keep: result.keep ?? [] }
    }
    case 'wallet-send': {
      const result = await wallet.completeSwap({
        amount: Amount.from(metadataNumber(operation, 'amount')),
        fees: Amount.from(metadataNumber(operation, 'fees')),
        keysetId: metadataText(operation, 'keysetId'),
        inputs: operation.inputs as Proof[],
        sendOutputs: validated.outputs.authorization ?? [],
        keepOutputs: validated.outputs.keep ?? [],
        unselectedProofs: [],
      })
      return { authorization: result.send, keep: result.keep }
    }
    default:
      return assertNever(mode)
  }
}

export function validateCtfRangeSourceCompletionOperation(
  operation: DurableCustodyProofOperationInput,
  authority?: {
    readonly seed: Uint8Array
    readonly keyset: { readonly id: string; readonly keys: Readonly<Record<string, string>> }
  },
): ValidatedCtfRangeSourceCompletionOperation {
  const validated = decodeDurableCustodyProofOperationInput(operation)
  assertSourceOperation(validated)
  const outputs = deserializeOutputs(validated.outputs)
  metadataText(validated, 'keysetId')
  metadataNumber(validated, 'amount')
  metadataNumber(validated, 'fees')
  validateKeepPlan(validated, outputs.keep ?? [], authority)
  return { operation: validated, outputs } as ValidatedCtfRangeSourceCompletionOperation
}

export function ctfRangeSourceKeepDerivationLocators(
  operation: DurableCustodyProofOperationInput,
  keep: readonly Proof[],
): readonly CtfRangeSourceKeepDerivationLocator[] {
  const validated = validateCtfRangeSourceCompletionOperation(operation)
  return ctfRangePlannedOutputDerivationLocators(
    metadataKeepPlan(validated.operation),
    keep,
    'range source keep',
  )
}

/** Match returned change proofs to one exact persisted seed-derived output plan. */
export function ctfRangePlannedOutputDerivationLocators(
  planValue: unknown,
  proofs: readonly Proof[],
  label: string,
): readonly CtfRangeSourceKeepDerivationLocator[] {
  if (planValue === null) {
    if (proofs.length !== 0) throw new Error(`${label} proof count is invalid`)
    return []
  }
  const plan = decodeDurableSeedDerivedOutputPlan(planValue)
  if (proofs.length !== plan.counterCount) throw new Error(`${label} proof count is invalid`)
  let ordered: readonly Proof[]
  try {
    ordered = matchDurableSeedDerivedProofsToPlan({ plan, proofs })
  } catch {
    throw new Error(`${label} proof does not match its exact output plan`)
  }
  const planIndex = new Map<Proof, number>()
  ordered.forEach((proof, index) => planIndex.set(proof, index))
  return proofs.map((proof) => {
    const index = planIndex.get(proof)
    if (index === undefined) throw new Error(`${label} proof is foreign or duplicated`)
    return {
      schemaVersion: 1,
      kind: 'nut13',
      keysetId: plan.keysetId,
      counter: plan.counterStart + index,
    }
  })
}

async function prepareRegularSource(
  preparation: PersistedCtfRangeOrderPreparation,
  wallet: CtfRangeSourceWallet,
  authorizationOutputs: OutputData[],
  inputs: Proof[],
  fees: number,
  keep: SourceKeepOutputs,
): Promise<DurableCustodyProofOperationInput> {
  const target = amountToNumber(OutputData.sumOutputAmounts(authorizationOutputs))
  const preview = await wallet.prepareSwapToSend(
    target,
    inputs,
    { includeFees: false, keysetId: preparation.offerKeyset.id },
    {
      send: { type: 'custom', data: authorizationOutputs },
      keep: { type: 'custom', data: [...keep.outputs] },
    },
  )
  assertExactOutputs(preview.sendOutputs ?? [], authorizationOutputs)
  assertExactOutputs(preview.keepOutputs ?? [], [...keep.outputs])
  assertExactFee(preview.fees, fees)
  return sourceOperation(
    preparation,
    'wallet-send',
    preview,
    {
      authorization: preview.sendOutputs ?? [],
      keep: preview.keepOutputs ?? [],
      amount: amountToNumber(preview.amount),
      fees: amountToNumber(preview.fees),
      keysetId: preview.keysetId,
    },
    keep.plan,
  )
}

async function prepareConditionalSource(
  preparation: PersistedCtfRangeOrderPreparation,
  wallet: CtfRangeSourceWallet,
  authorizationOutputs: OutputData[],
  inputs: Proof[],
  target: number,
  fees: number,
  keep: SourceKeepOutputs,
): Promise<DurableCustodyProofOperationInput> {
  const outputs: Parameters<CtfRangeSourceWallet['prepareConditionalSwap']>[0]['outputs'] = [
    { label: 'authorization', kind: 'custom', data: authorizationOutputs },
  ]
  if (keep.outputs.length > 0) {
    outputs.push({ label: 'keep', kind: 'custom', data: [...keep.outputs] })
  }
  const preview = await wallet.prepareConditionalSwap({
    keysetId: preparation.offerKeyset.id,
    inputs,
    outputs,
  })
  assertExactOutputs(preview.outputDataByLabel.authorization ?? [], authorizationOutputs)
  assertExactOutputs(preview.outputDataByLabel.keep ?? [], [...keep.outputs])
  return sourceOperation(
    preparation,
    'conditional-keyset-swap',
    preview,
    {
      authorization: preview.outputDataByLabel.authorization ?? [],
      keep: preview.outputDataByLabel.keep ?? [],
      amount: target,
      fees,
      keysetId: preview.keysetId,
    },
    keep.plan,
  )
}

function sourceOperation(
  preparation: PersistedCtfRangeOrderPreparation,
  sourceMode: 'wallet-send' | 'conditional-keyset-swap',
  preview: SwapPreview | ConditionalSwapPreview,
  output: {
    authorization: OutputData[]
    keep: OutputData[]
    amount: number
    fees: number
    keysetId: string
  },
  keepPlan: DurableSeedDerivedOutputPlan | null,
): DurableCustodyProofOperationInput {
  if (preview.inputs.length < 1 || preview.inputs.length > preparation.maxInputs) {
    throw new Error('range source exceeds the mint input limit')
  }
  return {
    operationId: preparation.sourceOperationId,
    kind:
      sourceMode === 'wallet-send' ? 'ctf-range-regular-source' : 'ctf-range-conditional-source',
    mintUrl: preparation.mintUrl,
    inputs: preview.inputs.map(serializeDurableCustodyProofInput),
    outputs: {
      authorization: output.authorization.map(serializeDurableCustodyOutput),
      keep: output.keep.map(serializeDurableCustodyOutput),
    },
    metadata: {
      purpose: SOURCE_PURPOSE,
      rangeOperationId: preparation.operationId,
      unit: 'msat',
      sourceMode,
      amount: output.amount,
      fees: output.fees,
      keysetId: output.keysetId,
      keepPlan,
    },
  }
}

function deserializeOutputs(
  outputs: DurableCustodyProofOperationInput['outputs'],
): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(outputs).map(([label, values]) => [
      label,
      values.map(deserializeDurableCustodyOutput),
    ]),
  )
}

function assertSourceOperation(operation: DurableCustodyProofOperationInput): void {
  const mode = ctfRangeSourceMode(operation)
  switch (mode) {
    case 'wallet-send':
    case 'conditional-keyset-swap':
      break
    case 'mixed-source-ctf-convert':
    case 'ctf-range-collateral-convert':
      throw new Error('persisted range source mode requires its conversion validator')
    default:
      return assertNever(mode)
  }
  if (
    operation.metadata?.purpose !== SOURCE_PURPOSE ||
    operation.metadata.unit !== 'msat' ||
    !hasExactMetadataKeys(operation.metadata)
  ) {
    throw new Error('persisted range source operation is invalid')
  }
}

/** Return the closed, validated source mode bound to a durable operation. */
export function ctfRangeSourceMode(
  operation: DurableCustodyProofOperationInput,
): CtfRangeSourceMode {
  const mode = operation.metadata?.sourceMode
  switch (operation.kind) {
    case 'ctf-range-regular-source':
      if (mode === 'wallet-send') return mode
      break
    case 'ctf-range-conditional-source':
      if (mode === 'conditional-keyset-swap') return mode
      if (
        mode === 'mixed-source-ctf-convert' &&
        operation.metadata?.endpoint === MIXED_SOURCE_ENDPOINT
      ) {
        return mode
      }
      break
    case 'ctf-range-collateral-convert':
      if (mode === 'ctf-range-collateral-convert') return mode
      break
    default:
      break
  }
  throw new Error('persisted range source mode is invalid for its durable kind')
}

interface SourceKeepOutputs {
  readonly outputs: readonly OutputData[]
  readonly plan: DurableSeedDerivedOutputPlan | null
}

async function reserveSourceKeepOutputs(input: {
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly keyset: { readonly id: string; readonly keys: Readonly<Record<string, string>> }
  readonly change: number
}): Promise<SourceKeepOutputs> {
  if (input.change === 0) return { outputs: [], plan: null }
  const amounts = splitAmount(BigInt(input.change), { ...input.keyset.keys }).map(amountToNumber)
  const total = amounts.reduce((sum, amount) => sum + amount, 0)
  if (amounts.length === 0 || amounts.length > 256 || total !== input.change) {
    throw new Error('range source change is unsupported by its keyset')
  }
  const reserved = await reserveAndConstructDurableSeedDerivedOutputs({
    seed: input.seed,
    counterSource: input.counterSource,
    keyset: input.keyset,
    amounts,
  })
  return { outputs: reserved.outputData, plan: reserved.plan }
}

function validateKeepPlan(
  operation: DurableCustodyProofOperationInput,
  keep: readonly OutputData[],
  authority:
    | {
        readonly seed: Uint8Array
        readonly keyset: { readonly id: string; readonly keys: Readonly<Record<string, string>> }
      }
    | undefined,
): void {
  const plan = metadataKeepPlan(operation)
  if (plan === null) {
    if (keep.length !== 0) throw new Error('range source zero-change plan is invalid')
    return
  }
  const amounts = keep.map((output) => amountToNumber(output.blindedMessage.amount))
  if (amounts.length !== plan.counterCount || !serializedOutputsMatch(plan.outputs, keep)) {
    throw new Error('range source keep plan conflicts with persisted outputs')
  }
  if (plan.keysetId !== metadataText(operation, 'keysetId')) {
    throw new Error('range source keep plan keyset conflicts with metadata')
  }
  if (authority !== undefined) {
    reconstructDurableSeedDerivedOutputs({
      seed: authority.seed,
      keyset: authority.keyset,
      amounts,
      plan,
    })
  }
}

function metadataKeepPlan(
  operation: DurableCustodyProofOperationInput,
): DurableSeedDerivedOutputPlan | null {
  const value = operation.metadata?.keepPlan
  if (value === null) return null
  return decodeDurableSeedDerivedOutputPlan(value)
}

function serializedOutputsMatch(
  left: readonly DurableSeedDerivedOutputPlan['outputs'][number][],
  right: readonly OutputData[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (output, index) => canonical(output) === canonical(OutputData.serialize(right[index]!)),
    )
  )
}

function assertExactFee(actual: Amount, expected: number): void {
  if (amountToNumber(actual) !== expected) {
    throw new Error('range source fee differs from its exact inputs')
  }
}

function hasExactMetadataKeys(value: DurableCustodyProofOperationInput['metadata']): boolean {
  if (value === undefined) return false
  const expected = [
    'amount',
    'fees',
    'keepPlan',
    'keysetId',
    'purpose',
    'rangeOperationId',
    'sourceMode',
    'unit',
  ]
  const present = Object.keys(value)
  return present.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function sourceMode(
  operation: DurableCustodyProofOperationInput,
): 'wallet-send' | 'conditional-keyset-swap' {
  const mode = ctfRangeSourceMode(operation)
  switch (mode) {
    case 'wallet-send':
    case 'conditional-keyset-swap':
      return mode
    case 'mixed-source-ctf-convert':
    case 'ctf-range-collateral-convert':
      throw new Error('persisted range source mode requires its conversion validator')
    default:
      return assertNever(mode)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled range source variant: ${String(value)}`)
}

function metadataText(operation: DurableCustodyProofOperationInput, field: string): string {
  const value = operation.metadata?.[field]
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error(`range source ${field} is invalid`)
  }
  return value
}

function metadataNumber(operation: DurableCustodyProofOperationInput, field: string): number {
  const value = operation.metadata?.[field]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`range source ${field} is invalid`)
  }
  return value as number
}

function assertExactOutputs(actual: OutputData[], expected: OutputData[]): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (output, index) =>
        canonical(OutputData.serialize(output)) !==
        canonical(OutputData.serialize(expected[index]!)),
    )
  ) {
    throw new Error('range source changed exact authorization outputs')
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))
}

function withoutRequest(preparation: PersistedCtfRangeOrderPreparation) {
  const { version: _, request: _request, ...input } = preparation
  return input
}
