import {
  Amount,
  OutputData,
  type ConditionalSwapPreview,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import type { ProofConsolidationRound } from './boundedProofConsolidation.ts'
import {
  decodeDurableCustodyProofOperationInput,
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  serializeDurableCustodyProofInput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { amountToNumber, computeInputFeeSatsForProofs, sumProofs } from './proofSelection.ts'

const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
declare const VALIDATED_CONSOLIDATION: unique symbol

export interface CtfRangeConsolidationWallet {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig: {
      send: { type: 'random' }
      keep: { type: 'random' }
    },
  ): Promise<SwapPreview>
  completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareConditionalSwap(options: {
    keysetId: string
    inputs: Proof[]
    outputs: [{ label: 'consolidated'; kind: 'random'; amount: number }]
  }): Promise<ConditionalSwapPreview>
  completeConditionalSwap(preview: ConditionalSwapPreview): Promise<Record<string, Proof[]>>
}

export interface ValidatedCtfRangeConsolidationOperation {
  readonly operation: DurableCustodyProofOperationInput
  readonly outputs: OutputData[]
  readonly [VALIDATED_CONSOLIDATION]: true
}

export async function prepareCtfRangeConsolidationOperation(input: {
  readonly operationId: string
  readonly rangeOperationId: string
  readonly mintUrl: string
  readonly keysetId: string
  readonly inputs: readonly Proof[]
  readonly conditional: boolean
  readonly inputFeePpk: number
  readonly plannedRound: ProofConsolidationRound
  readonly wallet: CtfRangeConsolidationWallet
}): Promise<DurableCustodyProofOperationInput> {
  assertPlannedInputs(input.inputs, input.plannedRound.inputs)
  const fees = computeInputFeeSatsForProofs(input.inputs, {
    [input.keysetId]: input.inputFeePpk,
  })
  if (String(fees) !== input.plannedRound.fee) {
    throw new Error('range consolidation fee differs from its plan')
  }
  const outputAmount = sumProofs(input.inputs) - fees
  if (outputAmount <= 0) throw new Error('range consolidation fee consumes its inputs')

  const preview = await prepareConsolidationPreview(input, outputAmount)
  const outputs = consolidationOutputs(preview, input.conditional)
  assertExactProofs(preview.inputs, input.inputs)
  assertPlannedOutputs(outputs, input.plannedRound.outputs)
  if (outputs.length >= preview.inputs.length) {
    throw new Error('range consolidation does not reduce the proof count')
  }
  if (!input.conditional && regularPreviewHasRemainder(preview as SwapPreview)) {
    throw new Error('range consolidation did not consume its exact inputs')
  }
  return {
    operationId: requireText(input.operationId, 'operation id'),
    kind: input.conditional ? 'conditional-keyset-swap' : 'wallet-send',
    mintUrl: input.mintUrl,
    inputs: preview.inputs.map(serializeDurableCustodyProofInput),
    outputs: { consolidated: outputs.map(serializeDurableCustodyOutput) },
    metadata: {
      purpose: CONSOLIDATION_PURPOSE,
      rangeOperationId: requireText(input.rangeOperationId, 'range operation id'),
      unit: 'msat',
      amount: outputAmount,
      fees,
      keysetId: requireText(input.keysetId, 'keyset id'),
    },
  }
}

function prepareConsolidationPreview(
  input: Parameters<typeof prepareCtfRangeConsolidationOperation>[0],
  outputAmount: number,
): Promise<SwapPreview | ConditionalSwapPreview> {
  return input.conditional
    ? input.wallet.prepareConditionalSwap({
        keysetId: input.keysetId,
        inputs: [...input.inputs],
        outputs: [{ label: 'consolidated', kind: 'random', amount: outputAmount }],
      })
    : input.wallet.prepareSwapToSend(
        outputAmount,
        [...input.inputs],
        { includeFees: false, keysetId: input.keysetId },
        { send: { type: 'random' }, keep: { type: 'random' } },
      )
}

export async function completeCtfRangeConsolidationOperation(
  value: DurableCustodyProofOperationInput | ValidatedCtfRangeConsolidationOperation,
  wallet: CtfRangeConsolidationWallet,
): Promise<readonly Proof[]> {
  const validated = isValidated(value)
    ? value
    : validateCtfRangeConsolidationOperation(value as DurableCustodyProofOperationInput)
  const operation = validated.operation
  if (operation.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap({
      keysetId: metadataText(operation, 'keysetId'),
      inputs: operation.inputs as Proof[],
      outputDataByLabel: { consolidated: validated.outputs },
    })
    return validateCtfRangeConsolidationProofs(validated, result.consolidated)
  }
  const result = await wallet.completeSwap({
    amount: Amount.from(metadataNumber(operation, 'amount')),
    fees: Amount.from(metadataNumber(operation, 'fees')),
    keysetId: metadataText(operation, 'keysetId'),
    inputs: operation.inputs as Proof[],
    sendOutputs: validated.outputs,
    keepOutputs: [],
    unselectedProofs: [],
  })
  if (result.keep.length > 0) {
    throw new Error('range consolidation returned unexpected keep proofs')
  }
  return validateCtfRangeConsolidationProofs(validated, result.send)
}

export function validateCtfRangeConsolidationProofs(
  value: DurableCustodyProofOperationInput | ValidatedCtfRangeConsolidationOperation,
  proofs: readonly Proof[] | undefined,
): readonly Proof[] {
  const validated = isValidated(value)
    ? value
    : validateCtfRangeConsolidationOperation(value as DurableCustodyProofOperationInput)
  if (proofs === undefined || proofs.length !== validated.outputs.length) {
    throw new Error('range consolidation result is incomplete')
  }
  const expected = new Map(
    validated.outputs.map((output) => [new TextDecoder().decode(output.secret), output] as const),
  )
  if (expected.size !== validated.outputs.length) {
    throw new Error('range consolidation outputs contain duplicate secrets')
  }
  const observed = new Set<string>()
  for (const proof of proofs) {
    const output = expected.get(proof.secret)
    if (
      output === undefined ||
      observed.has(proof.secret) ||
      proof.id !== output.blindedMessage.id ||
      amountToNumber(proof.amount) !== amountToNumber(output.blindedMessage.amount)
    ) {
      throw new Error('range consolidation result differs from its exact outputs')
    }
    observed.add(proof.secret)
  }
  if (observed.size !== expected.size) {
    throw new Error('range consolidation result is incomplete')
  }
  return proofs
}

export function validateCtfRangeConsolidationOperation(
  value: DurableCustodyProofOperationInput,
): ValidatedCtfRangeConsolidationOperation {
  const operation = decodeDurableCustodyProofOperationInput(value)
  if (
    (operation.kind !== 'wallet-send' && operation.kind !== 'conditional-keyset-swap') ||
    operation.metadata?.purpose !== CONSOLIDATION_PURPOSE ||
    operation.metadata.unit !== 'msat'
  ) {
    throw new Error('persisted range consolidation operation is invalid')
  }
  requireText(operation.metadata.rangeOperationId, 'range operation id')
  metadataText(operation, 'keysetId')
  metadataNumber(operation, 'amount')
  metadataNumber(operation, 'fees')
  if (Object.keys(operation.outputs).join('\0') !== 'consolidated') {
    throw new Error('range consolidation output groups are invalid')
  }
  const outputs = (operation.outputs.consolidated ?? []).map(deserializeDurableCustodyOutput)
  if (outputs.length >= operation.inputs.length) {
    throw new Error('range consolidation does not reduce the proof count')
  }
  return { operation, outputs } as ValidatedCtfRangeConsolidationOperation
}

function consolidationOutputs(
  preview: SwapPreview | ConditionalSwapPreview,
  conditional: boolean,
): OutputData[] {
  return conditional
    ? ((preview as ConditionalSwapPreview).outputDataByLabel.consolidated ?? [])
    : ((preview as SwapPreview).sendOutputs ?? [])
}

function regularPreviewHasRemainder(preview: SwapPreview): boolean {
  return (preview.unselectedProofs ?? []).length > 0 || (preview.keepOutputs ?? []).length > 0
}

function assertPlannedInputs(inputs: readonly Proof[], planned: readonly string[]): void {
  const actual = inputs.map(({ amount }) => String(amountToNumber(amount)))
  if (canonical(actual) !== canonical(planned)) {
    throw new Error('range consolidation inputs differ from its plan')
  }
}

function assertPlannedOutputs(outputs: readonly OutputData[], planned: readonly string[]): void {
  const actual = outputs
    .map(({ blindedMessage }) => String(amountToNumber(blindedMessage.amount)))
    .sort(compareDecimalStringsDescending)
  const expected = [...planned].sort(compareDecimalStringsDescending)
  if (canonical(actual) !== canonical(expected)) {
    throw new Error('range consolidation outputs differ from its plan')
  }
}

function assertExactProofs(actual: readonly Proof[], expected: readonly Proof[]): void {
  const identity = ({ id, amount, secret, C }: Proof) => ({
    id,
    amount: amountToNumber(amount),
    secret,
    C,
  })
  if (canonical(actual.map(identity)) !== canonical(expected.map(identity))) {
    throw new Error('wallet substituted exact range consolidation inputs')
  }
}

function metadataText(operation: DurableCustodyProofOperationInput, field: string): string {
  return requireText(operation.metadata?.[field], field)
}

function metadataNumber(operation: DurableCustodyProofOperationInput, field: string): number {
  const value = operation.metadata?.[field]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`range consolidation ${field} is invalid`)
  }
  return value as number
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
    throw new Error(`range consolidation ${label} is invalid`)
  }
  return value
}

function compareDecimalStringsDescending(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue > rightValue ? -1 : leftValue < rightValue ? 1 : 0
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))
}

function isValidated(
  value: DurableCustodyProofOperationInput | ValidatedCtfRangeConsolidationOperation,
): value is ValidatedCtfRangeConsolidationOperation {
  return 'operation' in value && 'outputs' in value
}
