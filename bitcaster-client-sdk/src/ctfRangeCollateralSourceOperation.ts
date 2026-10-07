import {
  OutputData,
  splitAmount,
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
import { amountToNumber, computeInputFeeSubunitsForProofs, sumProofs } from './proofSelection.ts'
import {
  assertCanonicalNut02V2KeysetId,
  assertDurableSeedDerivedOutputPlanMatchesOutputs,
  matchDurableSeedDerivedProofsToPlan,
  reconstructDurableSeedDerivedOutputs,
  reserveAndConstructLabeledDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from './durableSeedDerivedOutputs.ts'
import {
  ctfRangePlannedOutputDerivationLocators,
  type CtfRangeSourceKeepDerivationLocator,
} from './ctfRangeSourceOperation.ts'

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const MIXED_SOURCE_ENDPOINT = 'POST /v1/ctf/convert'
const MIXED_SOURCE_METADATA_KEYS = [
  'amount',
  'collateralInputCount',
  'collateralKeysetId',
  'collateralPlan',
  'conditionId',
  'endpoint',
  'fees',
  'offeredCollection',
  'offeredInputCount',
  'offeredKeysetId',
  'offeredPlan',
  'parentCollectionId',
  'purpose',
  'rangeOperationId',
  'sourceMode',
  'unit',
] as const
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
type MixedSourcePlan = Extract<CtfRangeCapabilitySourcePlan, { kind: 'mixed-source-ctf-convert' }>

export interface CtfRangeCollateralSourceTransport {
  postConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>
}

export interface CtfRangeCollateralSourceResult {
  readonly authorization: readonly Proof[]
  readonly complement: readonly Proof[]
  readonly collateralChange: readonly Proof[]
}

export interface CtfRangeMixedSourceResult {
  readonly authorization: readonly Proof[]
  readonly offeredChange: readonly Proof[]
  readonly collateralChange: readonly Proof[]
}

export interface CtfRangeMixedSourceChangeLocators {
  readonly offeredChange: readonly CtfRangeSourceKeepDerivationLocator[]
  readonly collateralChange: readonly CtfRangeSourceKeepDerivationLocator[]
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

/** Build one exact mixed held-conditional and regular-collateral conversion. */
export async function prepareCtfRangeMixedSourceOperation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly plan: MixedSourcePlan
}): Promise<DurableCustodyProofOperationInput> {
  const preparation = input.preparation
  const { offered, collateral } = mixedKeysets(preparation)
  const authorization = prepareCtfRangeOrderAuthorization({
    seed: input.seed,
    ...withoutRequest(preparation),
  }).authorizationOutputs
  assertAmounts(authorization, input.plan.authorizationAmounts, 'authorization')
  const serializedInputs = [
    ...input.plan.offeredInputs.map(serializeDurableCustodyProofInput),
    ...input.plan.collateralInputs.map(serializeDurableCustodyProofInput),
  ]
  decodeDurableCustodyProofOperationInput({
    operationId: preparation.sourceOperationId,
    kind: 'ctf-range-conditional-source',
    mintUrl: preparation.mintUrl,
    inputs: serializedInputs,
    outputs: {},
  })
  assertMixedPlanAuthority(preparation, input.plan, authorization, offered, collateral)
  const [offeredChange, collateralChange] = await reserveOutputGroups({
    seed: input.seed,
    counterSource: input.counterSource,
    groups: [
      {
        label: 'offered-change',
        keyset: offered,
        amounts: input.plan.offeredChangeAmounts,
      },
      {
        label: 'collateral-change',
        keyset: collateral,
        amounts: input.plan.collateralChangeAmounts,
      },
    ],
  })
  const operation: DurableCustodyProofOperationInput = {
    operationId: preparation.sourceOperationId,
    kind: 'ctf-range-conditional-source',
    mintUrl: preparation.mintUrl,
    inputs: serializedInputs,
    outputs: {
      authorization: authorization.map(serializeDurableCustodyOutput),
      'offered-change': offeredChange.outputs.map(serializeDurableCustodyOutput),
      'collateral-change': collateralChange.outputs.map(serializeDurableCustodyOutput),
    },
    metadata: {
      purpose: SOURCE_PURPOSE,
      sourceMode: 'mixed-source-ctf-convert',
      rangeOperationId: preparation.operationId,
      conditionId: preparation.conditionId,
      parentCollectionId: ROOT_PARENT_COLLECTION_ID,
      unit: 'msat',
      endpoint: MIXED_SOURCE_ENDPOINT,
      amount: sumAmounts(input.plan.authorizationAmounts),
      fees: input.plan.inputFee,
      offeredCollection: offered.outcomeCollection,
      offeredKeysetId: offered.id,
      collateralKeysetId: collateral.id,
      offeredInputCount: input.plan.offeredInputs.length,
      collateralInputCount: input.plan.collateralInputs.length,
      offeredPlan: offeredChange.plan,
      collateralPlan: collateralChange.plan,
    },
  }
  validateCtfRangeMixedSourceOperation(operation, preparation)
  return operation
}

export function validateCtfRangeMixedSourceOperation(
  value: unknown,
  preparation: PersistedCtfRangeOrderPreparation,
): DurableCustodyProofOperationInput {
  const operation = decodeDurableCustodyProofOperationInput(value)
  const metadata = operation.metadata ?? {}
  if (
    operation.kind !== 'ctf-range-conditional-source' ||
    Object.keys(metadata).sort().join('\0') !== [...MIXED_SOURCE_METADATA_KEYS].sort().join('\0') ||
    metadata.purpose !== SOURCE_PURPOSE ||
    metadata.sourceMode !== 'mixed-source-ctf-convert' ||
    metadata.endpoint !== MIXED_SOURCE_ENDPOINT ||
    metadata.parentCollectionId !== ROOT_PARENT_COLLECTION_ID ||
    metadata.unit !== 'msat' ||
    Object.keys(operation.outputs).sort().join('\0') !==
      'authorization\0collateral-change\0offered-change'
  ) {
    throw new Error('persisted mixed range source operation is invalid')
  }

  const amount = positiveInteger(metadata.amount, 'amount')
  const fees = nonnegativeInteger(metadata.fees, 'fee')
  const offeredKeysetId = text(metadata.offeredKeysetId, 'offered keyset')
  const collateralKeysetId = text(metadata.collateralKeysetId, 'collateral keyset')
  const offeredInputCount = positiveInteger(metadata.offeredInputCount, 'offered input count')
  const collateralInputCount = positiveInteger(
    metadata.collateralInputCount,
    'collateral input count',
  )
  const offeredInputs = inputProofs(operation, 0, offeredInputCount)
  const collateralInputs = inputProofs(operation, offeredInputCount, collateralInputCount)
  const authorization = outputs(operation, 'authorization')
  const offeredChange = outputs(operation, 'offered-change')
  const collateralChange = outputs(operation, 'collateral-change')
  const offeredPlan = metadata.offeredPlan
  const collateralPlan = metadata.collateralPlan
  assertOutputPlan(offeredPlan, offeredChange, offeredKeysetId, 'offered change')
  assertOutputPlan(collateralPlan, collateralChange, collateralKeysetId, 'collateral change')
  const offeredKeyset = conditionalKeyset(preparation.offerKeyset, 'offered')
  const collateralKeyset = regularKeyset(preparation.receiveKeyset)
  if (
    offeredKeysetId === collateralKeysetId ||
    operation.inputs.length !== offeredInputCount + collateralInputCount ||
    operation.inputs.length > 256 ||
    operation.inputs.some(({ amount }) => amountToNumber(amount) <= 0) ||
    offeredInputs.some(({ id }) => id !== offeredKeysetId) ||
    collateralInputs.some(({ id }) => id !== collateralKeysetId) ||
    hasDuplicateInputSecrets(operation.inputs) ||
    authorization.length === 0 ||
    text(metadata.offeredCollection, 'offered collection') !== offeredKeyset.outcomeCollection ||
    offeredChange.some((output) => output.blindedMessage.id !== offeredKeysetId) ||
    collateralChange.some((output) => output.blindedMessage.id !== collateralKeysetId) ||
    authorization.some((output) => output.blindedMessage.id !== offeredKeysetId) ||
    outputAmount(authorization) !== amount ||
    sumProofs(offeredInputs) < amount ||
    sumProofs(collateralInputs) < fees ||
    computeInputFeeSubunitsForProofs(operation.inputs, {
      [offeredKeysetId]: offeredKeyset.inputFeePpk,
      [collateralKeysetId]: collateralKeyset.inputFeePpk,
    }) !== fees ||
    outputAmount(offeredChange) !== sumProofs(offeredInputs) - amount ||
    outputAmount(collateralChange) !== sumProofs(collateralInputs) - fees ||
    !amountsMatchSplit(offeredChange, sumProofs(offeredInputs) - amount, offeredKeyset.keys) ||
    !amountsMatchSplit(
      collateralChange,
      sumProofs(collateralInputs) - fees,
      collateralKeyset.keys,
    ) ||
    inputAmount(operation) !==
      amount + fees + outputAmount(offeredChange) + outputAmount(collateralChange)
  ) {
    throw new Error('persisted mixed range source value authority is invalid')
  }
  assertMixedPreparation(operation, preparation)
  return operation
}

/** Complete the exact persisted mixed conversion without deriving new outputs. */
export async function completeCtfRangeMixedSourceOperation(input: {
  readonly operation: DurableCustodyProofOperationInput
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly transport: CtfRangeCollateralSourceTransport
}): Promise<CtfRangeMixedSourceResult> {
  const operation = validateCtfRangeMixedSourceOperation(input.operation, input.preparation)
  const metadata = operation.metadata!
  const offered = conditionalKeyset(input.preparation.offerKeyset, 'offered')
  const collateral = regularKeyset(input.preparation.receiveKeyset)
  const groups = {
    authorization: outputs(operation, 'authorization'),
    offeredChange: reconstructOutputGroup({
      seed: input.seed,
      keyset: offered,
      outputs: outputs(operation, 'offered-change'),
      plan: metadata.offeredPlan,
    }),
    collateralChange: reconstructOutputGroup({
      seed: input.seed,
      keyset: collateral,
      outputs: outputs(operation, 'collateral-change'),
      plan: metadata.collateralPlan,
    }),
  }
  const offeredCollection = text(metadata.offeredCollection, 'offered collection')
  const offeredProofs = inputProofs(operation, 0, metadata.offeredInputCount as number)
  const collateralProofs = inputProofs(
    operation,
    metadata.offeredInputCount as number,
    metadata.collateralInputCount as number,
  )
  const offeredOutputs = [...groups.authorization, ...groups.offeredChange]
  const collateralOutputs = [...groups.collateralChange]
  const response = await input.transport.postConvert({
    condition_id: text(metadata.conditionId, 'condition'),
    parent_collection_id: text(metadata.parentCollectionId, 'parent collection'),
    inputs: {
      [offeredCollection]: offeredProofs.map(toProof),
      '*': collateralProofs.map(toProof),
    },
    outputs: {
      [offeredCollection]: wireOutputs(offeredOutputs),
      ...(collateralOutputs.length === 0 ? {} : { '*': wireOutputs(collateralOutputs) }),
    },
  })
  const expectedSignatureKeys = [
    offeredCollection,
    ...(collateralOutputs.length === 0 ? [] : ['*']),
  ]
  assertSignatureGroupsExact(response.signatures, expectedSignatureKeys)
  const offeredSignatures = response.signatures[offeredCollection]!
  return {
    authorization: completeGroup(
      'authorization',
      groups.authorization,
      offeredSignatures.slice(0, groups.authorization.length),
      mintKeys(offered),
      null,
    ),
    offeredChange: completeGroup(
      'offered-change',
      groups.offeredChange,
      offeredSignatures.slice(groups.authorization.length),
      mintKeys(offered),
      metadata.offeredPlan,
    ),
    collateralChange: completeGroup(
      'collateral-change',
      groups.collateralChange,
      response.signatures['*'],
      mintKeys(collateral),
      metadata.collateralPlan,
    ),
  }
}

export function ctfRangeMixedSourceChangeDerivationLocators(
  operationValue: DurableCustodyProofOperationInput,
  preparation: PersistedCtfRangeOrderPreparation,
  change: {
    readonly offeredChange: readonly Proof[]
    readonly collateralChange: readonly Proof[]
  },
): CtfRangeMixedSourceChangeLocators {
  const operation = validateCtfRangeMixedSourceOperation(operationValue, preparation)
  return {
    offeredChange: derivationLocators(
      change.offeredChange,
      operation.metadata!.offeredPlan,
      'offered change',
    ),
    collateralChange: derivationLocators(
      change.collateralChange,
      operation.metadata!.collateralPlan,
      'collateral change',
    ),
  }
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

function assertMixedPreparation(
  operation: DurableCustodyProofOperationInput,
  preparation: PersistedCtfRangeOrderPreparation,
): void {
  const metadata = operation.metadata!
  const { offered, collateral } = mixedKeysets(preparation)
  if (
    operation.operationId !== preparation.sourceOperationId ||
    operation.mintUrl !== preparation.mintUrl ||
    metadata.rangeOperationId !== preparation.operationId ||
    metadata.conditionId !== preparation.conditionId ||
    metadata.offeredCollection !== offered.outcomeCollection ||
    metadata.offeredKeysetId !== offered.id ||
    metadata.collateralKeysetId !== collateral.id ||
    operation.inputs.length > preparation.maxInputs
  ) {
    throw new Error('persisted mixed range source preparation is foreign or stale')
  }
}

function mixedKeysets(preparation: PersistedCtfRangeOrderPreparation): {
  readonly offered: ReturnType<typeof conditionalKeyset>
  readonly collateral: ReturnType<typeof regularKeyset>
} {
  if (preparation.side !== 'Sell') {
    throw new Error('mixed range source is only valid for a conditional sell')
  }
  const offered = conditionalKeyset(preparation.offerKeyset, 'offered')
  const collateral = regularKeyset(preparation.receiveKeyset)
  try {
    assertCanonicalNut02V2KeysetId(offered.id, 'mixed range offered keyset id')
    assertCanonicalNut02V2KeysetId(collateral.id, 'mixed range collateral keyset id')
  } catch {
    throw new Error('mixed range source keyset identity is invalid')
  }
  if (
    offered.id === collateral.id ||
    offered.conditionId !== preparation.conditionId ||
    offered.canonicalMintUrl !== preparation.mintUrl ||
    collateral.canonicalMintUrl !== preparation.mintUrl ||
    offered.unit !== 'msat' ||
    collateral.unit !== 'msat' ||
    offered.active !== true ||
    collateral.active !== true ||
    !Number.isSafeInteger(offered.inputFeePpk) ||
    offered.inputFeePpk <= 0 ||
    !Number.isSafeInteger(collateral.inputFeePpk) ||
    collateral.inputFeePpk <= 0 ||
    !Number.isSafeInteger(preparation.maxInputs) ||
    preparation.maxInputs < 1
  ) {
    throw new Error('mixed range source keysets are foreign or inactive')
  }
  return { offered, collateral }
}

function assertMixedPlanAuthority(
  preparation: PersistedCtfRangeOrderPreparation,
  plan: MixedSourcePlan,
  authorization: readonly OutputData[],
  offered: ReturnType<typeof conditionalKeyset>,
  collateral: ReturnType<typeof regularKeyset>,
): void {
  const offeredInputs = plan.offeredInputs
  const collateralInputs = plan.collateralInputs
  const amount = outputAmount(authorization)
  const inputCount = offeredInputs.length + collateralInputs.length
  if (
    offeredInputs.length < 1 ||
    collateralInputs.length < 1 ||
    inputCount > preparation.maxInputs ||
    inputCount > 256 ||
    offeredInputs.some(
      (proof) =>
        proof.id !== offered.id ||
        amountToNumber(proof.amount) <= 0 ||
        typeof proof.secret !== 'string' ||
        proof.secret.length === 0 ||
        typeof proof.C !== 'string' ||
        proof.C.length === 0,
    ) ||
    collateralInputs.some(
      (proof) =>
        proof.id !== collateral.id ||
        amountToNumber(proof.amount) <= 0 ||
        typeof proof.secret !== 'string' ||
        proof.secret.length === 0 ||
        typeof proof.C !== 'string' ||
        proof.C.length === 0,
    ) ||
    hasDuplicateInputSecrets([...offeredInputs, ...collateralInputs])
  ) {
    throw new Error('mixed range source input authority is invalid')
  }

  const fees = computeInputFeeSubunitsForProofs([...offeredInputs, ...collateralInputs], {
    [offered.id]: offered.inputFeePpk,
    [collateral.id]: collateral.inputFeePpk,
  })
  const offeredFace = sumProofs(offeredInputs)
  const collateralFace = sumProofs(collateralInputs)
  const offeredChange = offeredFace - amount
  const collateralChange = collateralFace - fees
  if (
    plan.inputFee !== fees ||
    offeredFace < amount ||
    collateralFace < fees ||
    !amountsEqual(plan.offeredChangeAmounts, splitPositiveAmount(offeredChange, offered.keys)) ||
    !amountsEqual(
      plan.collateralChangeAmounts,
      splitPositiveAmount(collateralChange, collateral.keys),
    ) ||
    !Number.isSafeInteger(
      authorization.length + plan.offeredChangeAmounts.length + plan.collateralChangeAmounts.length,
    ) ||
    authorization.length + plan.offeredChangeAmounts.length + plan.collateralChangeAmounts.length >
      256
  ) {
    throw new Error('mixed range source fee or output plan authority is invalid')
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

function derivationLocators(
  proofs: readonly Proof[],
  planValue: unknown,
  label: string,
): readonly CtfRangeSourceKeepDerivationLocator[] {
  return ctfRangePlannedOutputDerivationLocators(planValue, proofs, `mixed range source ${label}`)
}

function amountsMatchSplit(
  values: readonly OutputData[],
  amount: number,
  keys: Readonly<Record<string, string>>,
): boolean {
  const expected = amount === 0 ? [] : splitAmount(BigInt(amount), { ...keys }).map(amountToNumber)
  return (
    values.length === expected.length &&
    values.every((value, index) => amountToNumber(value.blindedMessage.amount) === expected[index])
  )
}

function splitPositiveAmount(amount: number, keys: Readonly<Record<string, string>>): number[] {
  return amount === 0 ? [] : splitAmount(BigInt(amount), { ...keys }).map(amountToNumber)
}

function amountsEqual(left: readonly number[], right: readonly number[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every(
      (amount, index) => Number.isSafeInteger(amount) && amount > 0 && amount === right[index],
    )
  )
}

function inputProofs(
  operation: DurableCustodyProofOperationInput,
  start: number,
  count: number,
): Proof[] {
  return operation.inputs.slice(start, start + count).map(toProof)
}

function hasDuplicateInputSecrets<T extends { readonly secret: string }>(
  inputs: readonly T[],
): boolean {
  const secrets = new Set<string>()
  for (const proof of inputs) {
    if (secrets.has(proof.secret)) return true
    secrets.add(proof.secret)
  }
  return false
}

function assertSignatureGroupsExact(
  signatures: CtfConvertResponse['signatures'],
  expected: readonly string[],
): void {
  const actual = Object.keys(signatures).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('mint returned foreign mixed range source signatures')
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
