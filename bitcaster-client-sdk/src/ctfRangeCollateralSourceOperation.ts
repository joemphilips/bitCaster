import { Amount, OutputData, type MintKeys } from '@cashu/cashu-ts'
import type { CtfRangeCapabilitySourcePlan } from './ctfRangeCapabilitySourcePlan.ts'
import {
  prepareCtfRangeOrderAuthorization,
  type ActiveCtfRangeMintKeyset,
} from './ctfRangeOrderPreparation.ts'
import type { PersistedCtfRangeOrderPreparation } from './ctfRangeOrderProtocol.ts'
import {
  decodeDurableCustodyProofOperationInput,
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  serializeDurableCustodyProofInput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { amountToNumber } from './proofSelection.ts'

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const METADATA_KEYS = [
  'amount',
  'collateralKeysetId',
  'complementCollection',
  'complementKeysetId',
  'conditionId',
  'fees',
  'offeredCollection',
  'parentCollectionId',
  'purpose',
  'rangeOperationId',
  'sourceMode',
  'unit',
] as const

type CollateralPlan = Extract<CtfRangeCapabilitySourcePlan, { kind: 'collateral-ctf-convert' }>

/** Build one exact, persistable CTF conversion without performing mint I/O. */
export function prepareCtfRangeCollateralSourceOperation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly plan: CollateralPlan
}): DurableCustodyProofOperationInput {
  const preparation = input.preparation
  if (preparation.side !== 'Sell') {
    throw new Error('collateral range source is only valid for a conditional sell')
  }
  const offered = conditionalKeyset(preparation.offerKeyset, 'offered')
  const complement = preparation.complementKeyset
  const collateral = regularKeyset(preparation.receiveKeyset)
  const authorization = prepareCtfRangeOrderAuthorization({
    seed: input.seed,
    ...withoutRequest(preparation),
  }).authorizationOutputs
  assertAmounts(authorization, input.plan.authorizationAmounts, 'authorization')
  const complementOutputs = randomOutputs(input.plan.complementAmounts, complement)
  const collateralChange = randomOutputs(input.plan.collateralChangeAmounts, collateral)
  const operation: DurableCustodyProofOperationInput = {
    operationId: preparation.sourceOperationId,
    kind: 'ctf-range-collateral-convert',
    mintUrl: preparation.mintUrl,
    inputs: input.plan.inputs.map(serializeDurableCustodyProofInput),
    outputs: {
      authorization: authorization.map(serializeDurableCustodyOutput),
      complement: complementOutputs.map(serializeDurableCustodyOutput),
      'collateral-change': collateralChange.map(serializeDurableCustodyOutput),
    },
    metadata: {
      purpose: SOURCE_PURPOSE,
      sourceMode: 'ctf-range-collateral-convert',
      rangeOperationId: preparation.operationId,
      conditionId: preparation.conditionId,
      parentCollectionId: ROOT_PARENT_COLLECTION_ID,
      unit: 'msat',
      amount: sumAmounts(input.plan.authorizationAmounts),
      fees: input.plan.inputFee,
      offeredCollection: offered.outcomeCollection,
      complementCollection: complement.outcomeCollection,
      collateralKeysetId: collateral.id,
      complementKeysetId: complement.id,
    },
  }
  validateCtfRangeCollateralSourceOperation(operation, preparation)
  return operation
}

export function validateCtfRangeCollateralSourceOperation(
  value: unknown,
  preparation?: PersistedCtfRangeOrderPreparation,
): DurableCustodyProofOperationInput {
  const operation = decodeDurableCustodyProofOperationInput(value)
  const metadata = operation.metadata ?? {}
  if (
    operation.kind !== 'ctf-range-collateral-convert' ||
    Object.keys(metadata).sort().join('\0') !== [...METADATA_KEYS].sort().join('\0') ||
    metadata.purpose !== SOURCE_PURPOSE ||
    metadata.sourceMode !== 'ctf-range-collateral-convert' ||
    metadata.parentCollectionId !== ROOT_PARENT_COLLECTION_ID ||
    metadata.unit !== 'msat' ||
    Object.keys(operation.outputs).sort().join('\0') !==
      'authorization\0collateral-change\0complement'
  ) {
    throw new Error('persisted collateral range source operation is invalid')
  }
  const amount = positiveInteger(metadata.amount, 'amount')
  const fees = nonnegativeInteger(metadata.fees, 'fee')
  const collateralKeysetId = text(metadata.collateralKeysetId, 'collateral keyset')
  const complementKeysetId = text(metadata.complementKeysetId, 'complement keyset')
  const authorization = outputs(operation, 'authorization')
  const complement = outputs(operation, 'complement')
  const change = outputs(operation, 'collateral-change')
  if (
    operation.inputs.length === 0 ||
    operation.inputs.some(({ id }) => id !== collateralKeysetId) ||
    authorization.length === 0 ||
    complement.length === 0 ||
    authorization.some((output) => output.blindedMessage.id === collateralKeysetId) ||
    complement.some((output) => output.blindedMessage.id !== complementKeysetId) ||
    change.some((output) => output.blindedMessage.id !== collateralKeysetId) ||
    outputAmount(authorization) !== amount ||
    outputAmount(complement) !== amount ||
    inputAmount(operation) !== amount + fees + outputAmount(change)
  ) {
    throw new Error('persisted collateral range source value authority is invalid')
  }
  if (preparation !== undefined) assertPreparation(operation, preparation)
  return operation
}

function assertPreparation(
  operation: DurableCustodyProofOperationInput,
  preparation: PersistedCtfRangeOrderPreparation,
): void {
  const metadata = operation.metadata!
  const offered = conditionalKeyset(preparation.offerKeyset, 'offered')
  if (
    preparation.side !== 'Sell' ||
    operation.operationId !== preparation.sourceOperationId ||
    operation.mintUrl !== preparation.mintUrl ||
    metadata.rangeOperationId !== preparation.operationId ||
    metadata.conditionId !== preparation.conditionId ||
    metadata.offeredCollection !== offered.outcomeCollection ||
    metadata.complementCollection !== preparation.complementKeyset.outcomeCollection ||
    metadata.collateralKeysetId !== preparation.receiveKeyset.id ||
    metadata.complementKeysetId !== preparation.complementKeyset.id ||
    outputs(operation, 'authorization').some(
      (output) => output.blindedMessage.id !== preparation.offerKeyset.id,
    )
  ) {
    throw new Error('persisted collateral range source preparation is foreign')
  }
}

function randomOutputs(amounts: readonly number[], keyset: ActiveCtfRangeMintKeyset): OutputData[] {
  if (amounts.length === 0) return []
  const outputs = OutputData.createRandomData(Amount.from(sumAmounts(amounts)), mintKeys(keyset))
  assertAmounts(outputs, amounts, 'random')
  return outputs
}

function mintKeys(keyset: ActiveCtfRangeMintKeyset): MintKeys {
  return {
    id: keyset.id,
    unit: keyset.unit,
    keys: { ...keyset.keys },
    input_fee_ppk: keyset.inputFeePpk,
    ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
  }
}

function outputs(operation: DurableCustodyProofOperationInput, label: string) {
  return (operation.outputs[label] ?? []).map(deserializeDurableCustodyOutput)
}

function outputAmount(values: readonly OutputData[]): number {
  return sumAmounts(values.map(({ blindedMessage }) => amountToNumber(blindedMessage.amount)))
}

function inputAmount(operation: DurableCustodyProofOperationInput): number {
  return sumAmounts(operation.inputs.map(({ amount }) => amountToNumber(amount)))
}

function assertAmounts(values: readonly OutputData[], amounts: readonly number[], label: string) {
  const actual = values.map(({ blindedMessage }) => amountToNumber(blindedMessage.amount))
  if (
    actual.length !== amounts.length ||
    actual.some((amount, index) => amount !== amounts[index])
  ) {
    throw new Error(`collateral range ${label} output amounts changed`)
  }
}

function sumAmounts(values: readonly number[]): number {
  return values.reduce((sum, value) => {
    const next = sum + amountToNumber(value)
    if (!Number.isSafeInteger(next)) throw new Error('collateral range source amount overflow')
    return next
  }, 0)
}

function conditionalKeyset(
  keyset: PersistedCtfRangeOrderPreparation['offerKeyset'],
  label: string,
) {
  if (!('conditionId' in keyset) || !('outcomeCollection' in keyset)) {
    throw new Error(`collateral range ${label} keyset is not conditional`)
  }
  return keyset
}

function regularKeyset(keyset: PersistedCtfRangeOrderPreparation['receiveKeyset']) {
  if ('conditionId' in keyset || 'outcomeCollection' in keyset) {
    throw new Error('collateral range receive keyset is not regular')
  }
  return keyset
}

function positiveInteger(value: unknown, label: string): number {
  const decoded = nonnegativeInteger(value, label)
  if (decoded === 0) throw new Error(`collateral range source ${label} is invalid`)
  return decoded
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`collateral range source ${label} is invalid`)
  }
  return value as number
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`collateral range source ${label} is invalid`)
  }
  return value
}

function withoutRequest(preparation: PersistedCtfRangeOrderPreparation) {
  const { version: _, request: _request, ...input } = preparation
  return input
}
