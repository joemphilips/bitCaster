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
import { amountToNumber, computeInputFeeSatsForProofs } from './proofSelection.ts'

const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
declare const VALIDATED_CONSOLIDATION: unique symbol
declare const VALIDATED_EXACT_CONSOLIDATION: unique symbol

export interface ExactProofConsolidationWallet {
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

export interface CtfRangeConsolidationWallet extends ExactProofConsolidationWallet {}

export interface ValidatedExactProofConsolidationOperation {
  readonly operation: DurableCustodyProofOperationInput
  readonly outputs: OutputData[]
  readonly [VALIDATED_EXACT_CONSOLIDATION]: true
}

export interface ValidatedCtfRangeConsolidationOperation {
  readonly operation: DurableCustodyProofOperationInput
  readonly outputs: OutputData[]
  readonly [VALIDATED_CONSOLIDATION]: true
}

export interface ExactProofConsolidationValidation {
  readonly purpose: string
}

export type ExactProofConsolidationReplayFailureDisposition =
  | 'release-exact-unspent-inputs'
  | 'remain-pending'

export function classifyExactProofConsolidationReplayFailure(input: {
  readonly definiteMintRejection: boolean
  readonly inputStates: readonly string[]
}): ExactProofConsolidationReplayFailureDisposition {
  return input.definiteMintRejection &&
    input.inputStates.length > 0 &&
    input.inputStates.every((state) => state === 'UNSPENT')
    ? 'release-exact-unspent-inputs'
    : 'remain-pending'
}

export async function prepareExactProofConsolidationOperation(input: {
  readonly operationId: string
  readonly bindingId: string
  readonly purpose: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly inputKeysetId: string
  readonly outputKeysetId: string
  readonly inputs: readonly Proof[]
  readonly conditional: boolean
  readonly inputFeePpk: number
  readonly plannedRound: ProofConsolidationRound
  readonly wallet: ExactProofConsolidationWallet
}): Promise<DurableCustodyProofOperationInput> {
  if (input.conditional && input.inputKeysetId !== input.outputKeysetId) {
    throw new Error('conditional proof consolidation cannot rotate keysets')
  }
  assertPlannedInputs(input.inputs, input.plannedRound.inputs)
  assertInputKeyset(input.inputs, input.inputKeysetId)
  const fees = computeInputFeeSatsForProofs(input.inputs, {
    [input.inputKeysetId]: input.inputFeePpk,
  })
  if (String(fees) !== input.plannedRound.fee) {
    throw new Error('proof consolidation fee differs from its plan')
  }
  const outputAmount = checkedProofSum(input.inputs) - fees
  if (outputAmount <= 0) throw new Error('proof consolidation fee consumes its inputs')

  const preview = await prepareExactConsolidationPreview(input, outputAmount)
  const outputs = consolidationOutputs(preview, input.conditional)
  assertExactProofs(preview.inputs, input.inputs)
  assertPlannedOutputs(outputs, input.plannedRound.outputs)
  assertOutputKeyset(outputs, input.outputKeysetId)
  assertFreshOutputSecrets(outputs, input.inputs)
  if (outputs.length >= preview.inputs.length) {
    throw new Error('proof consolidation does not reduce the proof count')
  }
  if (!input.conditional && regularPreviewHasRemainder(preview as SwapPreview)) {
    throw new Error('proof consolidation did not consume its exact inputs')
  }
  return {
    operationId: requireText(input.operationId, 'operation id'),
    kind: input.conditional ? 'conditional-keyset-swap' : 'wallet-send',
    mintUrl: requireText(input.mintUrl, 'mint URL'),
    inputs: preview.inputs.map(serializeDurableCustodyProofInput),
    outputs: { consolidated: outputs.map(serializeDurableCustodyOutput) },
    metadata: {
      purpose: requireText(input.purpose, 'purpose'),
      bindingId: requireText(input.bindingId, 'binding id'),
      unit: input.unit,
      amount: outputAmount,
      fees,
      inputKeysetId: requireText(input.inputKeysetId, 'input keyset id'),
      keysetId: requireText(input.outputKeysetId, 'output keyset id'),
    },
  }
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
  const operation = await prepareExactProofConsolidationOperation({
    operationId: input.operationId,
    bindingId: input.rangeOperationId,
    purpose: CONSOLIDATION_PURPOSE,
    mintUrl: input.mintUrl,
    unit: 'msat',
    inputKeysetId: input.keysetId,
    outputKeysetId: input.keysetId,
    inputs: input.inputs,
    conditional: input.conditional,
    inputFeePpk: input.inputFeePpk,
    plannedRound: input.plannedRound,
    wallet: input.wallet,
  })
  return {
    ...operation,
    metadata: {
      ...operation.metadata,
      rangeOperationId: requireText(input.rangeOperationId, 'range operation id'),
    },
  }
}

function prepareExactConsolidationPreview(
  input: Parameters<typeof prepareExactProofConsolidationOperation>[0],
  outputAmount: number,
): Promise<SwapPreview | ConditionalSwapPreview> {
  return input.conditional
    ? input.wallet.prepareConditionalSwap({
        keysetId: input.outputKeysetId,
        inputs: [...input.inputs],
        outputs: [{ label: 'consolidated', kind: 'random', amount: outputAmount }],
      })
    : input.wallet.prepareSwapToSend(
        outputAmount,
        [...input.inputs],
        { includeFees: false, keysetId: input.outputKeysetId },
        { send: { type: 'random' }, keep: { type: 'random' } },
      )
}

export async function completeCtfRangeConsolidationOperation(
  value: DurableCustodyProofOperationInput | ValidatedCtfRangeConsolidationOperation,
  wallet: CtfRangeConsolidationWallet,
): Promise<readonly Proof[]> {
  const validated = validateCtfRangeConsolidationOperation(unwrapOperation(value))
  return completeExactProofConsolidationOperation(validated.operation, wallet, {
    purpose: CONSOLIDATION_PURPOSE,
  })
}

export async function completeExactProofConsolidationOperation(
  value: DurableCustodyProofOperationInput | ValidatedExactProofConsolidationOperation,
  wallet: ExactProofConsolidationWallet,
  expected: ExactProofConsolidationValidation,
): Promise<readonly Proof[]> {
  const validated = validateExactProofConsolidationOperation(unwrapOperation(value), expected)
  const operation = validated.operation
  if (operation.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap({
      keysetId: metadataText(operation, 'keysetId'),
      inputs: operation.inputs as Proof[],
      outputDataByLabel: { consolidated: validated.outputs },
    })
    return validateExactProofConsolidationProofs(validated, result.consolidated, expected)
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
    throw new Error('proof consolidation returned unexpected keep proofs')
  }
  return validateExactProofConsolidationProofs(validated, result.send, expected)
}

export function validateCtfRangeConsolidationProofs(
  value: DurableCustodyProofOperationInput | ValidatedCtfRangeConsolidationOperation,
  proofs: readonly Proof[] | undefined,
): readonly Proof[] {
  const validated = validateCtfRangeConsolidationOperation(unwrapOperation(value))
  return validateExactProofConsolidationProofs(validated.operation, proofs, {
    purpose: CONSOLIDATION_PURPOSE,
  })
}

export function validateExactProofConsolidationProofs(
  value: DurableCustodyProofOperationInput | ValidatedExactProofConsolidationOperation,
  proofs: readonly Proof[] | undefined,
  expected: ExactProofConsolidationValidation,
): readonly Proof[] {
  const validated = validateExactProofConsolidationOperation(unwrapOperation(value), expected)
  if (proofs === undefined || proofs.length !== validated.outputs.length) {
    throw new Error('proof consolidation result is incomplete')
  }
  const expectedOutputs = new Map(
    validated.outputs.map((output) => [new TextDecoder().decode(output.secret), output] as const),
  )
  if (expectedOutputs.size !== validated.outputs.length) {
    throw new Error('proof consolidation outputs contain duplicate secrets')
  }
  const observed = new Set<string>()
  for (const proof of proofs) {
    const output = expectedOutputs.get(proof.secret)
    if (
      output === undefined ||
      observed.has(proof.secret) ||
      proof.id !== output.blindedMessage.id ||
      amountToNumber(proof.amount) !== amountToNumber(output.blindedMessage.amount)
    ) {
      throw new Error('proof consolidation result differs from its exact outputs')
    }
    observed.add(proof.secret)
  }
  if (observed.size !== expectedOutputs.size) {
    throw new Error('proof consolidation result is incomplete')
  }
  return proofs
}

export function validateCtfRangeConsolidationOperation(
  value: DurableCustodyProofOperationInput,
): ValidatedCtfRangeConsolidationOperation {
  const validated = validateExactProofConsolidationOperation(value, {
    purpose: CONSOLIDATION_PURPOSE,
  })
  const operation = validated.operation
  if (operation.metadata?.unit !== 'msat') {
    throw new Error('persisted range consolidation operation is invalid')
  }
  const rangeOperationId = requireText(operation.metadata.rangeOperationId, 'range operation id')
  if (
    rangeOperationId !== metadataText(operation, 'bindingId') ||
    metadataText(operation, 'inputKeysetId') !== metadataText(operation, 'keysetId')
  ) {
    throw new Error('persisted range consolidation operation is invalid')
  }
  return {
    operation,
    outputs: validated.outputs,
  } as ValidatedCtfRangeConsolidationOperation
}

export function validateExactProofConsolidationOperation(
  value: DurableCustodyProofOperationInput,
  expected: ExactProofConsolidationValidation,
): ValidatedExactProofConsolidationOperation {
  const operation = decodeDurableCustodyProofOperationInput(value)
  const purpose = requireText(expected.purpose, 'expected purpose')
  const unit = operation.metadata?.unit
  if (
    (operation.kind !== 'wallet-send' && operation.kind !== 'conditional-keyset-swap') ||
    operation.metadata?.purpose !== purpose ||
    (unit !== 'sat' && unit !== 'msat') ||
    (operation.kind === 'conditional-keyset-swap' && unit !== 'msat') ||
    operation.inputs.length < 2 ||
    operation.inputs.length > 64 ||
    Object.keys(operation.outputs).join('\0') !== 'consolidated'
  ) {
    throw new Error('persisted proof consolidation operation is invalid')
  }
  metadataText(operation, 'bindingId')
  const inputKeysetId = metadataText(operation, 'inputKeysetId')
  const outputKeysetId = metadataText(operation, 'keysetId')
  if (operation.kind === 'conditional-keyset-swap' && inputKeysetId !== outputKeysetId) {
    throw new Error('conditional proof consolidation cannot rotate keysets')
  }
  const amount = positiveMetadataNumber(operation, 'amount')
  const fees = positiveMetadataNumber(operation, 'fees')
  const inputs = operation.inputs as Proof[]
  assertInputKeyset(inputs, inputKeysetId)
  if (checkedProofSum(inputs) - fees !== amount) {
    throw new Error('persisted proof consolidation input value is invalid')
  }
  const outputs = (operation.outputs.consolidated ?? []).map(deserializeDurableCustodyOutput)
  if (outputs.length < 1 || outputs.length >= inputs.length) {
    throw new Error('proof consolidation does not reduce the proof count')
  }
  assertOutputKeyset(outputs, outputKeysetId)
  assertFreshOutputSecrets(outputs, inputs)
  const outputTotal = checkedAmountSum(
    outputs.map(({ blindedMessage }) => amountToNumber(blindedMessage.amount)),
  )
  if (outputTotal !== amount) {
    throw new Error('persisted proof consolidation output value is invalid')
  }
  return { operation, outputs } as ValidatedExactProofConsolidationOperation
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
    throw new Error('proof consolidation inputs differ from its plan')
  }
}

function assertPlannedOutputs(outputs: readonly OutputData[], planned: readonly string[]): void {
  const actual = outputs
    .map(({ blindedMessage }) => String(amountToNumber(blindedMessage.amount)))
    .sort(compareDecimalStringsDescending)
  const expected = [...planned].sort(compareDecimalStringsDescending)
  if (canonical(actual) !== canonical(expected)) {
    throw new Error('proof consolidation outputs differ from its plan')
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
    throw new Error('wallet substituted exact proof consolidation inputs')
  }
}

function assertInputKeyset(inputs: readonly Proof[], inputKeysetId: string): void {
  if (inputs.some(({ id }) => id !== inputKeysetId)) {
    throw new Error('proof consolidation inputs mix keysets')
  }
}

function checkedProofSum(proofs: readonly Proof[]): number {
  return checkedAmountSum(proofs.map(({ amount }) => amountToNumber(amount)))
}

function checkedAmountSum(amounts: readonly number[]): number {
  let total = 0
  for (const amount of amounts) {
    total += amount
    if (!Number.isSafeInteger(total)) {
      throw new Error('proof consolidation amount total exceeds the safe integer bound')
    }
  }
  return total
}

function assertOutputKeyset(outputs: readonly OutputData[], outputKeysetId: string): void {
  if (outputs.some(({ blindedMessage }) => blindedMessage.id !== outputKeysetId)) {
    throw new Error('proof consolidation outputs use an unexpected keyset')
  }
}

function assertFreshOutputSecrets(outputs: readonly OutputData[], inputs: readonly Proof[]): void {
  const inputSecrets = new Set(
    inputs.map(({ secret }) => bytesKey(new TextEncoder().encode(secret))),
  )
  if (inputSecrets.size !== inputs.length) {
    throw new Error('proof consolidation input secrets are not unique')
  }
  const outputSecrets = new Set<string>()
  for (const output of outputs) {
    const secret = bytesKey(output.secret)
    if (inputSecrets.has(secret) || outputSecrets.has(secret)) {
      throw new Error('proof consolidation output secrets are not fresh and unique')
    }
    outputSecrets.add(secret)
  }
}

function bytesKey(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
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

function positiveMetadataNumber(
  operation: DurableCustodyProofOperationInput,
  field: string,
): number {
  const value = metadataNumber(operation, field)
  if (value < 1) throw new Error(`proof consolidation ${field} is invalid`)
  return value
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

function unwrapOperation(
  value:
    | DurableCustodyProofOperationInput
    | ValidatedCtfRangeConsolidationOperation
    | ValidatedExactProofConsolidationOperation,
): DurableCustodyProofOperationInput {
  return 'operation' in value ? value.operation : value
}
