import {
  OutputData,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type CounterSource,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
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
import {
  assertDurableSeedDerivedOutputPlanMatchesOutputs,
  matchDurableSeedDerivedProofsToPlan,
  reconstructDurableSeedDerivedOutputs,
  reserveAndConstructLabeledDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from './durableSeedDerivedOutputs.ts'

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const METADATA_KEYS = [
  'amount',
  'collateralKeysetId',
  'collateralChangePlan',
  'complementCollection',
  'complementKeysetId',
  'complementPlan',
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

export interface CtfRangeCollateralSourceTransport {
  postConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>
}

export interface CtfRangeCollateralSourceResult {
  readonly authorization: readonly Proof[]
  readonly complement: readonly Proof[]
  readonly collateralChange: readonly Proof[]
}

/** Build one exact, persistable CTF conversion without performing mint I/O. */
export async function prepareCtfRangeCollateralSourceOperation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly plan: CollateralPlan
}): Promise<DurableCustodyProofOperationInput> {
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
  const [complementOutputs, collateralChange] = await reserveOutputGroups({
    seed: input.seed,
    counterSource: input.counterSource,
    groups: [
      { label: 'complement', keyset: complement, amounts: input.plan.complementAmounts },
      {
        label: 'collateral-change',
        keyset: collateral,
        amounts: input.plan.collateralChangeAmounts,
      },
    ],
  })
  const operation: DurableCustodyProofOperationInput = {
    operationId: preparation.sourceOperationId,
    kind: 'ctf-range-collateral-convert',
    mintUrl: preparation.mintUrl,
    inputs: input.plan.inputs.map(serializeDurableCustodyProofInput),
    outputs: {
      authorization: authorization.map(serializeDurableCustodyOutput),
      complement: complementOutputs.outputs.map(serializeDurableCustodyOutput),
      'collateral-change': collateralChange.outputs.map(serializeDurableCustodyOutput),
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
      complementPlan: complementOutputs.plan,
      collateralChangePlan: collateralChange.plan,
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
  assertOutputPlan(metadata.complementPlan, complement, complementKeysetId, 'complement')
  assertOutputPlan(metadata.collateralChangePlan, change, collateralKeysetId, 'collateral change')
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

/** Execute one exact persisted collateral conversion without deriving fresh outputs. */
export async function completeCtfRangeCollateralSourceOperation(input: {
  readonly operation: DurableCustodyProofOperationInput
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly transport: CtfRangeCollateralSourceTransport
}): Promise<CtfRangeCollateralSourceResult> {
  const operation = validateCtfRangeCollateralSourceOperation(input.operation, input.preparation)
  const metadata = operation.metadata!
  const groups = {
    authorization: outputs(operation, 'authorization'),
    complement: reconstructOutputGroup({
      seed: input.seed,
      keyset: input.preparation.complementKeyset,
      outputs: outputs(operation, 'complement'),
      plan: metadata.complementPlan,
    }),
    collateralChange: reconstructOutputGroup({
      seed: input.seed,
      keyset: input.preparation.receiveKeyset,
      outputs: outputs(operation, 'collateral-change'),
      plan: metadata.collateralChangePlan,
    }),
  }
  const response = await input.transport.postConvert({
    condition_id: text(metadata.conditionId, 'condition'),
    parent_collection_id: text(metadata.parentCollectionId, 'parent collection'),
    inputs: { '*': operation.inputs.map(toProof) },
    outputs: {
      [text(metadata.offeredCollection, 'offered collection')]: wireOutputs(groups.authorization),
      [text(metadata.complementCollection, 'complement collection')]: wireOutputs(
        groups.complement,
      ),
      ...(groups.collateralChange.length === 0
        ? {}
        : { '*': wireOutputs(groups.collateralChange) }),
    },
  })
  return {
    authorization: completeGroup(
      'authorization',
      groups.authorization,
      response.signatures[text(metadata.offeredCollection, 'offered collection')],
      mintKeys(input.preparation.offerKeyset),
      null,
    ),
    complement: completeGroup(
      'complement',
      groups.complement,
      response.signatures[text(metadata.complementCollection, 'complement collection')],
      mintKeys(input.preparation.complementKeyset),
      metadata.complementPlan,
    ),
    collateralChange: completeGroup(
      'collateral-change',
      groups.collateralChange,
      response.signatures['*'],
      mintKeys(input.preparation.receiveKeyset),
      metadata.collateralChangePlan,
    ),
  }
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

async function reserveOutputGroups(input: {
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly groups: readonly {
    readonly label: string
    readonly keyset: ActiveCtfRangeMintKeyset
    readonly amounts: readonly number[]
  }[]
}): Promise<
  readonly {
    readonly outputs: readonly OutputData[]
    readonly plan: DurableSeedDerivedOutputPlan | null
  }[]
> {
  const active = input.groups.filter(({ amounts }) => amounts.length > 0)
  const reserved = await reserveAndConstructLabeledDurableSeedDerivedOutputs({
    seed: input.seed,
    counterSource: input.counterSource,
    groups: active,
  })
  return input.groups.map((group) => {
    const value = reserved.find(({ label }) => label === group.label)
    return value === undefined
      ? { outputs: [], plan: null }
      : { outputs: value.outputData, plan: value.plan }
  })
}

function reconstructOutputGroup(input: {
  readonly seed: Uint8Array
  readonly keyset: ActiveCtfRangeMintKeyset
  readonly outputs: readonly OutputData[]
  readonly plan: unknown
}): readonly OutputData[] {
  if (input.plan === null) return []
  return reconstructDurableSeedDerivedOutputs({
    seed: input.seed,
    keyset: input.keyset,
    amounts: input.outputs.map(({ blindedMessage }) => amountToNumber(blindedMessage.amount)),
    plan: input.plan,
  }).outputData
}

function assertOutputPlan(
  value: unknown,
  outputs: readonly OutputData[],
  keysetId: string,
  label: string,
): void {
  if (value === null) {
    if (outputs.length !== 0) throw new Error(`persisted collateral range ${label} plan is invalid`)
    return
  }
  try {
    assertDurableSeedDerivedOutputPlanMatchesOutputs({ plan: value, keysetId, outputs })
  } catch {
    throw new Error(`persisted collateral range ${label} plan is invalid`)
  }
}

function completeGroup(
  label: string,
  planned: readonly OutputData[],
  signatures: readonly SerializedBlindedSignature[] | undefined,
  keyset: MintKeys,
  plan: unknown,
): Proof[] {
  if (planned.length === 0) {
    if (signatures !== undefined && signatures.length !== 0) {
      throw new Error(`mint returned unexpected collateral range ${label} signatures`)
    }
    return []
  }
  if (signatures === undefined || signatures.length !== planned.length) {
    throw new Error(`mint returned the wrong collateral range ${label} signature count`)
  }
  const proofs = planned.map((output, index) => {
    const signature = signatures[index]!
    if (
      signature.id !== output.blindedMessage.id ||
      amountToNumber(signature.amount) !== amountToNumber(output.blindedMessage.amount)
    ) {
      throw new Error(`mint returned a foreign collateral range ${label} signature`)
    }
    return normalizeProof(
      output.toProof({ ...signature, amount: output.blindedMessage.amount }, keyset),
    )
  })
  return plan === null ? proofs : [...matchDurableSeedDerivedProofsToPlan({ plan, proofs })]
}

function wireOutputs(values: readonly OutputData[]): SerializedBlindedMessage[] {
  return values.map(({ blindedMessage }) => ({
    ...blindedMessage,
    amount: amountToNumber(blindedMessage.amount),
  })) as unknown as SerializedBlindedMessage[]
}

function toProof(value: DurableCustodyProofOperationInput['inputs'][number]): Proof {
  return {
    id: text(value.id, 'input keyset'),
    amount: amountToNumber(value.amount) as never,
    secret: value.secret,
    C: text(value.C, 'input commitment'),
    ...(value.dleq === undefined ? {} : { dleq: structuredClone(value.dleq) as never }),
    ...(value.p2pk_e === undefined ? {} : { p2pk_e: value.p2pk_e }),
    ...(value.witness === undefined ? {} : { witness: structuredClone(value.witness) as never }),
  }
}

function normalizeProof(proof: Proof): Proof {
  return { ...proof, amount: amountToNumber(proof.amount) as never }
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
