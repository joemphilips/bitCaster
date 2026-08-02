import {
  Amount,
  OutputData,
  isBlsKeyset,
  splitAmount,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapRequest,
  type SwapResponse,
} from '@cashu/cashu-ts'
import {
  encodeBoundedDurableArtifact,
  prepareDurableCustodyExactArtifact,
  readPreparedDurableCustodyArtifactBytes,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  type DurableCustodyExactArtifact,
} from './durableCustody.ts'
import {
  decodeDurableCustodyProofOperationInput,
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  serializeDurableCustodyProofInput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import {
  prepareCtfRangeOrderAuthorization,
  type ActiveCtfRangeMintKeyset,
} from './ctfRangeOrderPreparation.ts'
import { planCtfRangeOrderAuthorization } from './ctfRangeOrderAuthorization.ts'
import type { PersistedCtfRangeOrderPreparation } from './ctfRangeOrderProtocol.ts'
import type {
  CtfRangeCapabilityBatchParent,
  CtfRangeCapabilityParentMeasureInput,
  CtfRangeCapabilityOutputAllocation,
} from './ctfRangeCapabilityBatchPlan.ts'
import { CTF_RANGE_BATCH_INPUT_LIMIT_MAX } from './ctfRangeCapabilityBatchPlan.ts'
import { prepareMintInputProofs } from './mintInputProof.ts'
import { amountToNumber, computeInputFeeSatsForProofs, sumProofs } from './proofSelection.ts'

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const PARENT_PURPOSE = 'ctf-range-capability-parent'
const NUT03_WIRE_GROUP = 'outputs'
const authorizationAmountCache = new WeakMap<object, string[]>()

export interface CtfRangeCapabilityParentAllocation {
  readonly schemaVersion: 1
  readonly parentOperationId: string
  readonly parentDigest: string
  readonly requestFingerprint: string
  readonly outputIndex: number
  readonly wireGroup: string
  readonly wireIndex: number
  readonly role: 'authorization' | 'complement' | 'change'
  readonly keysetId: string
  readonly amount: number
  readonly childOperationId: string | null
  readonly clientOrderId: string | null
  readonly originClientOrderId: string | null
}

export interface CtfRangeCapabilityParentChild {
  readonly clientOrderId: string
  readonly rangeOperationId: string
  readonly sourceOperationId: string
  readonly authorizationOutputIndexes: readonly number[]
}

export interface PreparedCtfRangeCapabilityParentOperation {
  readonly parent: CtfRangeCapabilityBatchParent
  readonly operation: DurableCustodyProofOperationInput
  readonly requestKind: CtfRangeCapabilityBatchParent['kind']
  readonly method: 'POST'
  readonly path: '/v1/swap' | '/v1/ctf/convert'
  readonly idempotencyKey: string
  readonly exactRequest: DurableCustodyExactArtifact
  readonly exactAllocations: DurableCustodyExactArtifact
  readonly allocations: readonly CtfRangeCapabilityParentAllocation[]
  readonly children: readonly CtfRangeCapabilityParentChild[]
}

export interface UnverifiedCtfRangeCapabilityParentResult {
  readonly result: { readonly successors: readonly Proof[] }
  readonly allocations: readonly CtfRangeCapabilityParentAllocation[]
}

export function createCtfRangeCapabilityParentRequestMeasurer(input: {
  readonly preparations: readonly PersistedCtfRangeOrderPreparation[]
}): (candidate: CtfRangeCapabilityParentMeasureInput) => number {
  const preparations = preparationMap(input.preparations)
  return (candidate) => {
    const context = validateParentContext(candidate, preparations)
    const allocations = wireAllocations('measure', candidate, context, '0'.repeat(64))
    const request = wireRequest(
      candidate,
      allocations,
      placeholderOutputs(candidate.outputs),
      context.conditionId,
    )
    return encodeBoundedDurableArtifact(request, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX).length
  }
}

export function prepareCtfRangeCapabilityParentOperation(input: {
  readonly parentOperationId: string
  readonly parent: CtfRangeCapabilityBatchParent
  readonly preparations: readonly PersistedCtfRangeOrderPreparation[]
  readonly seed: Uint8Array
}): PreparedCtfRangeCapabilityParentOperation {
  const parentOperationId = requiredText(input.parentOperationId, 'parent operation id')
  const preparations = preparationMap(input.preparations)
  const context = validateParentContext(input.parent, preparations)
  const outputs = materializeOutputs(input.parent, context, input.seed)
  const provisional = wireAllocations(parentOperationId, input.parent, context, '0'.repeat(64))
  const request = wireRequest(input.parent, provisional, outputs, context.conditionId)
  const exactRequest = prepareDurableCustodyExactArtifact(request)
  const requestBytes = readPreparedDurableCustodyArtifactBytes(exactRequest).length
  if (requestBytes !== input.parent.requestBytes) {
    throw new Error('CTF range parent request size changed after planning')
  }
  const allocations = wireAllocations(
    parentOperationId,
    input.parent,
    context,
    exactRequest.fingerprint,
  )
  const children = childBindings(input.parent, context, allocations)
  const canonical = canonicalParent(input.parent)
  const exactAllocations = prepareAllocationAuthority(
    parentOperationId,
    canonical,
    allocations,
    children,
  )
  return finalizePreparedParentOperation({
    parentOperationId,
    parent: input.parent,
    canonical,
    context,
    outputs,
    exactRequest,
    exactAllocations,
    requestBytes,
    allocations,
    children,
    preparations: input.preparations,
  })
}

function finalizePreparedParentOperation(input: {
  parentOperationId: string
  parent: CtfRangeCapabilityBatchParent
  canonical: CtfRangeCapabilityBatchParent
  context: ParentContext
  outputs: readonly OutputData[]
  exactRequest: DurableCustodyExactArtifact
  exactAllocations: DurableCustodyExactArtifact
  requestBytes: number
  allocations: readonly CtfRangeCapabilityParentAllocation[]
  children: readonly CtfRangeCapabilityParentChild[]
  preparations: readonly PersistedCtfRangeOrderPreparation[]
}): PreparedCtfRangeCapabilityParentOperation {
  const operation = parentOperation({
    parentOperationId: input.parentOperationId,
    parent: input.parent,
    context: input.context,
    outputs: input.outputs,
    exactRequest: input.exactRequest,
    exactAllocations: input.exactAllocations,
    requestBytes: input.requestBytes,
  })
  const prepared = {
    parent: input.canonical,
    operation,
    requestKind: input.parent.kind,
    method: 'POST' as const,
    path: parentPath(input.parent.kind),
    idempotencyKey: input.parentOperationId,
    exactRequest: input.exactRequest,
    exactAllocations: input.exactAllocations,
    allocations: input.allocations,
    children: input.children,
  }
  return validateCtfRangeCapabilityParentOperation(prepared, input.preparations)
}

export function validateCtfRangeCapabilityParentOperation(
  value: PreparedCtfRangeCapabilityParentOperation,
  preparationValues: readonly PersistedCtfRangeOrderPreparation[],
): PreparedCtfRangeCapabilityParentOperation {
  const operation = decodeDurableCustodyProofOperationInput(value.operation)
  const preparations = preparationMap(preparationValues)
  const metadata = parentMetadata(operation)
  assertParentMetadataAuthority(value.parent, metadata)
  const allocations = decodeAllocations(value.allocations, operation.operationId)
  const context = validateParentContext(value.parent, preparations)
  const children = childBindings(value.parent, context, allocations)
  if (
    allocations.some(
      (row) =>
        row.parentDigest !== metadata.parentDigest ||
        row.requestFingerprint !== metadata.requestFingerprint,
    )
  ) {
    throw new Error('CTF range parent allocation authority is foreign')
  }
  if (metadata.childCount !== value.parent.children.length) {
    throw new Error('CTF range parent child count is invalid')
  }
  const exactRequest = reprepareExactArtifact(
    value.exactRequest,
    metadata.requestFingerprint,
    'request',
  )
  const exactAllocations = reprepareExactArtifact(
    value.exactAllocations,
    metadata.allocationFingerprint,
    'allocation',
  )
  const expectedAllocations = prepareAllocationAuthority(
    operation.operationId,
    value.parent,
    allocations,
    children,
  )
  if (exactAllocations.fingerprint !== expectedAllocations.fingerprint) {
    throw new Error('CTF range parent allocation artifact changed')
  }
  const outputs = operation.outputs.successors!.map(deserializeDurableCustodyOutput)
  const expectedRequest = wireRequest(value.parent, allocations, outputs, context.conditionId)
  const expectedArtifact = prepareDurableCustodyExactArtifact(expectedRequest)
  if (
    expectedArtifact.fingerprint !== exactRequest.fingerprint ||
    readPreparedDurableCustodyArtifactBytes(exactRequest).length !== metadata.requestBytes
  ) {
    throw new Error('CTF range parent request differs from persisted outputs')
  }
  assertEnvelope(value, operation, value.parent, context, allocations)
  return detachedPrepared(value, operation, allocations, exactRequest, exactAllocations)
}

export function readCtfRangeCapabilityParentReplay(
  input: PreparedCtfRangeCapabilityParentOperation,
): {
  readonly method: 'POST'
  readonly path: '/v1/swap' | '/v1/ctf/convert'
  readonly idempotencyKey: string
  readonly body: Uint8Array
} {
  const metadata = parentMetadata(input.operation)
  if (
    input.requestKind !== metadata.sourceMode ||
    input.path !== parentPath(metadata.sourceMode) ||
    input.idempotencyKey !== input.operation.operationId
  ) {
    throw new Error('CTF range parent replay envelope is invalid')
  }
  const exactRequest = reprepareExactArtifact(
    input.exactRequest,
    metadata.requestFingerprint,
    'request',
  )
  return {
    method: 'POST',
    path: parentPath(metadata.sourceMode),
    idempotencyKey: input.operation.operationId,
    body: readPreparedDurableCustodyArtifactBytes(exactRequest),
  }
}

/** Maps the mint response. The caller must pass the result through the durable mint-result gate. */
export function mapCtfRangeCapabilityParentResponseToUnverifiedResult(input: {
  readonly prepared: PreparedCtfRangeCapabilityParentOperation
  readonly preparations: readonly PersistedCtfRangeOrderPreparation[]
  readonly response: SwapResponse | CtfConvertResponse
}): UnverifiedCtfRangeCapabilityParentResult {
  const prepared = validateCtfRangeCapabilityParentOperation(input.prepared, input.preparations)
  const outputs = prepared.operation.outputs.successors!.map(deserializeDurableCustodyOutput)
  const signatures = responseSignatures(prepared, input.response)
  const keysets = exactKeysets(input.preparations)
  const proofs = outputs.map((output, outputIndex) => {
    const allocation = prepared.allocations[outputIndex]!
    const signature = signatures[outputIndex]!
    assertSignature(signature, output, allocation)
    const keyset = keysets.get(allocation.keysetId)
    if (keyset === undefined) throw new Error('CTF range parent output keyset is absent')
    return normalizeProof(output.toProof(signature, keyset))
  })
  return Object.freeze({
    result: Object.freeze({ successors: Object.freeze(proofs) }),
    allocations: prepared.allocations,
  })
}

function parentOperation(input: {
  parentOperationId: string
  parent: CtfRangeCapabilityBatchParent
  context: ParentContext
  outputs: readonly OutputData[]
  exactRequest: DurableCustodyExactArtifact
  exactAllocations: DurableCustodyExactArtifact
  requestBytes: number
}): DurableCustodyProofOperationInput {
  const kind =
    input.parent.kind === 'same-keyset-swap'
      ? 'ctf-range-conditional-source'
      : 'ctf-range-collateral-convert'
  return decodeDurableCustodyProofOperationInput({
    operationId: input.parentOperationId,
    kind,
    mintUrl: input.context.mintUrl,
    inputs: input.parent.inputs.map(serializeDurableCustodyProofInput),
    outputs: { successors: input.outputs.map(serializeDurableCustodyOutput) },
    metadata: {
      purpose: PARENT_PURPOSE,
      sourceMode: input.parent.kind,
      unit: 'msat',
      conditionId: input.context.conditionId,
      sourceKeysetId: input.parent.sourceKeysetId,
      parentDigest: input.parent.parentDigest,
      requestFingerprint: input.exactRequest.fingerprint,
      allocationFingerprint: input.exactAllocations.fingerprint,
      requestBytes: input.requestBytes,
      inputFee: input.parent.inputFee,
      childCount: input.parent.children.length,
    },
  })
}

function prepareAllocationAuthority(
  parentOperationId: string,
  parent: CtfRangeCapabilityBatchParent,
  allocations: readonly CtfRangeCapabilityParentAllocation[],
  children: readonly CtfRangeCapabilityParentChild[],
): DurableCustodyExactArtifact {
  return prepareDurableCustodyExactArtifact({
    schemaVersion: 1,
    parentOperationId,
    parent: {
      ...parent,
      inputs: parent.inputs.map(serializeDurableCustodyProofInput),
    },
    allocations,
    children,
  })
}

function canonicalParent(parent: CtfRangeCapabilityBatchParent): CtfRangeCapabilityBatchParent {
  const value = {
    ...parent,
    inputs: parent.inputs.map(toWireProof),
  }
  return JSON.parse(JSON.stringify(value)) as CtfRangeCapabilityBatchParent
}

interface ParentContext {
  readonly mintUrl: string
  readonly conditionId: string
  readonly preparations: ReadonlyMap<string, PersistedCtfRangeOrderPreparation>
}

function validateParentContext(
  parent: CtfRangeCapabilityParentMeasureInput,
  preparations: ReadonlyMap<string, PersistedCtfRangeOrderPreparation>,
): ParentContext {
  if (parent.children.length === 0) throw new Error('CTF range parent has no children')
  const selected = parent.children.map((child) => {
    const preparation = preparations.get(child.clientOrderId)
    if (preparation === undefined) throw new Error('CTF range parent child preparation is absent')
    assertChildAuthority(child, preparation, parent)
    return preparation
  })
  const first = selected[0]!
  if (
    selected.some(
      (item) => item.mintUrl !== first.mintUrl || item.conditionId !== first.conditionId,
    )
  ) {
    throw new Error('CTF range parent mixes mint or condition authority')
  }
  const context = { mintUrl: first.mintUrl, conditionId: first.conditionId, preparations }
  assertParentAllocations(parent, context)
  return context
}

function assertParentAllocations(
  parent: CtfRangeCapabilityParentMeasureInput,
  context: ParentContext,
): void {
  if (
    parent.inputs.length === 0 ||
    parent.inputs.length > CTF_RANGE_BATCH_INPUT_LIMIT_MAX ||
    parent.sourceKeysetId !== parent.sourceKeyset.id ||
    parent.inputs.some(({ id }) => id !== parent.sourceKeysetId) ||
    parent.outputs.length === 0 ||
    parent.outputs.some(({ outputIndex }, index) => outputIndex !== index)
  ) {
    throw new Error('CTF range parent input or output authority is invalid')
  }
  const childIds = new Set(parent.children.map(({ clientOrderId }) => clientOrderId))
  if (
    parent.outputs.some((row) => row.clientOrderId !== null && !childIds.has(row.clientOrderId))
  ) {
    throw new Error('CTF range parent output child is foreign')
  }
  const allocations = indexChildAllocations(parent.outputs)
  for (const child of parent.children) {
    assertChildAllocations(
      parent,
      child.clientOrderId,
      allocations.get(child.clientOrderId),
      context,
    )
  }
  assertChangeAllocations(parent)
  const source = sourceKeyset(parent, context)
  const fee = computeInputFeeSatsForProofs(parent.inputs, { [source.id]: source.inputFeePpk })
  const authorization = parent.outputs
    .filter(({ role }) => role === 'authorization')
    .reduce((sum, { amount }) => checkedAdd(sum, amount), 0)
  const change = parent.outputs
    .filter(({ role }) => role === 'change')
    .reduce((sum, { amount }) => checkedAdd(sum, amount), 0)
  if (fee !== parent.inputFee || sumProofs(parent.inputs) !== authorization + fee + change) {
    throw new Error('CTF range parent value authority is invalid')
  }
}

function assertChildAllocations(
  parent: CtfRangeCapabilityParentMeasureInput,
  clientOrderId: string,
  rows: ChildAllocationRows | undefined,
  context: ParentContext,
): void {
  const preparation = context.preparations.get(clientOrderId)!
  const authorization = rows?.authorization ?? []
  if (
    !sameNumbers(
      authorization.map(({ amount }) => amount),
      authorizationAmounts(preparation).map(Number),
    ) ||
    authorization.some(({ keysetId }) => keysetId !== preparation.offerKeyset.id)
  ) {
    throw new Error('CTF range parent authorization allocation is invalid')
  }
  const complement = rows?.complement ?? []
  const expectedComplement =
    parent.kind === 'collateral-ctf-convert' && preparation.side === 'Sell'
      ? splitAmounts(
          authorization.reduce((sum, { amount }) => checkedAdd(sum, amount), 0),
          preparation.complementKeyset,
        )
      : []
  if (
    !sameNumbers(
      complement.map(({ amount }) => amount),
      expectedComplement,
    ) ||
    complement.some(({ keysetId }) => keysetId !== preparation.complementKeyset.id)
  ) {
    throw new Error('CTF range parent complement allocation is invalid')
  }
}

interface ChildAllocationRows {
  readonly authorization: CtfRangeCapabilityOutputAllocation[]
  readonly complement: CtfRangeCapabilityOutputAllocation[]
}

function indexChildAllocations(
  rows: readonly CtfRangeCapabilityOutputAllocation[],
): ReadonlyMap<string, ChildAllocationRows> {
  const result = new Map<string, ChildAllocationRows>()
  for (const row of rows) {
    if (row.clientOrderId === null || row.role === 'change') continue
    let group = result.get(row.clientOrderId)
    if (group === undefined) {
      group = { authorization: [], complement: [] }
      result.set(row.clientOrderId, group)
    }
    group[row.role].push(row)
  }
  return result
}

function assertChangeAllocations(parent: CtfRangeCapabilityParentMeasureInput): void {
  if (
    parent.outputs.some(
      (row) =>
        (row.role === 'change' &&
          (row.clientOrderId !== null || row.keysetId !== parent.sourceKeysetId)) ||
        (row.role !== 'change' && row.clientOrderId === null),
    )
  ) {
    throw new Error('CTF range parent output ownership is invalid')
  }
}

function sourceKeyset(parent: CtfRangeCapabilityParentMeasureInput, context: ParentContext) {
  const candidates = [...context.preparations.values()].flatMap((preparation) => [
    preparation.offerKeyset,
    preparation.receiveKeyset,
  ])
  const keyset = candidates.find(({ id }) => id === parent.sourceKeysetId)
  if (keyset === undefined) throw new Error('CTF range parent source keyset is absent')
  assertKeysetAuthority(parent.sourceKeyset, keyset, 'source')
  return keyset
}

function splitAmounts(amount: number, keyset: ActiveCtfRangeMintKeyset): number[] {
  return splitAmount(BigInt(amount), { ...keyset.keys }).map(amountToNumber)
}

function assertChildAuthority(
  child: CtfRangeCapabilityParentMeasureInput['children'][number],
  preparation: PersistedCtfRangeOrderPreparation,
  parent: CtfRangeCapabilityParentMeasureInput,
): void {
  const amounts = authorizationAmounts(preparation)
  if (
    preparation.request.clientOrderId !== child.clientOrderId ||
    preparation.request.marketId !== child.route ||
    preparation.side !== child.side ||
    String(preparation.priceNumerator) !== child.price ||
    String(preparation.amountSubunits) !== child.amount ||
    preparation.offerKeyset.id !== child.offeredKeyset.id ||
    !sameStrings(amounts, child.authorizationAmounts)
  ) {
    throw new Error('CTF range parent child authority is foreign')
  }
  assertKeysetAuthority(child.offeredKeyset, preparation.offerKeyset, 'offered')
  if (child.side === 'Sell') {
    assertKeysetAuthority(child.complementKeyset, preparation.complementKeyset, 'complement')
  }
  if (parent.kind === 'same-keyset-swap') {
    if (child.side !== 'Sell' || preparation.offerKeyset.id !== parent.sourceKeysetId) {
      throw new Error('CTF range same-keyset parent child is invalid')
    }
    return
  }
  const collateralId =
    child.side === 'Buy' ? preparation.offerKeyset.id : preparation.receiveKeyset.id
  if (collateralId !== parent.sourceKeysetId) {
    throw new Error('CTF range collateral parent child is invalid')
  }
}

function materializeOutputs(
  parent: CtfRangeCapabilityBatchParent,
  context: ParentContext,
  seed: Uint8Array,
): OutputData[] {
  const authorization = new Map<string, OutputData[]>()
  for (const child of parent.children) {
    const preparation = context.preparations.get(child.clientOrderId)!
    authorization.set(
      child.clientOrderId,
      prepareCtfRangeOrderAuthorization({ seed, ...withoutRequest(preparation) })
        .authorizationOutputs,
    )
  }
  const random = randomOutputGroups(parent.outputs, context)
  const cursors = new Map<string, number>()
  return parent.outputs.map((allocation) => takeOutput(allocation, authorization, random, cursors))
}

function randomOutputGroups(
  allocations: readonly CtfRangeCapabilityOutputAllocation[],
  context: ParentContext,
): ReadonlyMap<string, OutputData[]> {
  const groups = new Map<string, CtfRangeCapabilityOutputAllocation[]>()
  for (const row of allocations) {
    if (row.role === 'authorization') continue
    const key = `${row.role}\0${row.clientOrderId ?? ''}\0${row.keysetId}`
    const values = groups.get(key)
    if (values === undefined) groups.set(key, [row])
    else values.push(row)
  }
  return new Map(
    [...groups].map(([key, rows]) => {
      const keyset = keysetForAllocation(rows[0]!, context)
      const amounts = rows.map(({ amount }) => Amount.from(amount))
      const total = rows.reduce((sum, { amount }) => sum + amount, 0)
      return [key, OutputData.createRandomData(Amount.from(total), mintKeys(keyset), amounts)]
    }),
  )
}

function takeOutput(
  allocation: CtfRangeCapabilityOutputAllocation,
  authorization: ReadonlyMap<string, OutputData[]>,
  random: ReadonlyMap<string, OutputData[]>,
  cursors: Map<string, number>,
): OutputData {
  const key =
    allocation.role === 'authorization'
      ? `authorization\0${allocation.clientOrderId}`
      : `${allocation.role}\0${allocation.clientOrderId ?? ''}\0${allocation.keysetId}`
  const values =
    allocation.role === 'authorization'
      ? authorization.get(allocation.clientOrderId!)
      : random.get(key)
  const index = cursors.get(key) ?? 0
  const output = values?.[index]
  if (
    output === undefined ||
    output.blindedMessage.id !== allocation.keysetId ||
    amountToNumber(output.blindedMessage.amount) !== allocation.amount
  ) {
    throw new Error('CTF range parent exact output allocation changed')
  }
  cursors.set(key, index + 1)
  return output
}

function wireAllocations(
  parentOperationId: string,
  parent: CtfRangeCapabilityParentMeasureInput,
  context: ParentContext,
  requestFingerprint: string,
): CtfRangeCapabilityParentAllocation[] {
  const cursors = new Map<string, number>()
  return parent.outputs.map((row) => {
    const wireGroup = wireGroupForAllocation(parent.kind, row, context)
    const wireIndex = cursors.get(wireGroup) ?? 0
    cursors.set(wireGroup, wireIndex + 1)
    const origin = row.clientOrderId
    const preparation = origin === null ? null : context.preparations.get(origin)!
    return {
      schemaVersion: 1,
      parentOperationId,
      parentDigest:
        'parentDigest' in parent && typeof parent.parentDigest === 'string'
          ? parent.parentDigest
          : '0'.repeat(64),
      requestFingerprint,
      outputIndex: row.outputIndex,
      wireGroup,
      wireIndex,
      role: row.role,
      keysetId: row.keysetId,
      amount: row.amount,
      childOperationId: row.role === 'authorization' ? preparation!.operationId : null,
      clientOrderId: row.role === 'authorization' ? origin : null,
      originClientOrderId: row.role === 'change' ? null : origin,
    }
  })
}

function wireGroupForAllocation(
  kind: CtfRangeCapabilityParentMeasureInput['kind'],
  row: CtfRangeCapabilityOutputAllocation,
  context: ParentContext,
): string {
  if (kind === 'same-keyset-swap') return NUT03_WIRE_GROUP
  if (row.role === 'change') return '*'
  const preparation = context.preparations.get(row.clientOrderId!)!
  if (row.role === 'complement') return preparation.complementKeyset.outcomeCollection
  return preparation.side === 'Buy' ? '*' : conditionalCollection(preparation.offerKeyset)
}

function wireRequest(
  parent: CtfRangeCapabilityParentMeasureInput,
  allocations: readonly Pick<CtfRangeCapabilityParentAllocation, 'outputIndex' | 'wireGroup'>[],
  outputs: readonly OutputData[] | readonly SerializedBlindedMessage[],
  conditionId: string,
): SwapRequest | CtfConvertRequest {
  const messages = outputs.map(toWireOutput)
  const inputs = prepareMintInputProofs(parent.inputs)
  if (parent.kind === 'same-keyset-swap') return { inputs, outputs: messages }
  const grouped = new Map<string, SerializedBlindedMessage[]>()
  allocations.forEach((row) => {
    const values = grouped.get(row.wireGroup)
    if (values === undefined) grouped.set(row.wireGroup, [messages[row.outputIndex]!])
    else values.push(messages[row.outputIndex]!)
  })
  return {
    condition_id: requiredText(conditionId, 'parent condition'),
    parent_collection_id: ROOT_PARENT_COLLECTION_ID,
    inputs: { '*': inputs },
    outputs: Object.fromEntries([...grouped].sort(([left], [right]) => compareText(left, right))),
  }
}

function placeholderOutputs(
  allocations: readonly CtfRangeCapabilityOutputAllocation[],
): SerializedBlindedMessage[] {
  return allocations.map(({ amount, keysetId }) => ({
    amount: amount as never,
    id: keysetId,
    B_: isBlsKeyset(keysetId) ? '8'.repeat(96) : `02${'0'.repeat(64)}`,
  }))
}

function childBindings(
  parent: CtfRangeCapabilityBatchParent,
  context: ParentContext,
  allocations: readonly CtfRangeCapabilityParentAllocation[],
): CtfRangeCapabilityParentChild[] {
  return parent.children.map(({ clientOrderId }) => {
    const preparation = context.preparations.get(clientOrderId)!
    return {
      clientOrderId,
      rangeOperationId: preparation.operationId,
      sourceOperationId: preparation.sourceOperationId,
      authorizationOutputIndexes: allocations
        .filter((row) => row.clientOrderId === clientOrderId && row.role === 'authorization')
        .map(({ outputIndex }) => outputIndex),
    }
  })
}

function responseSignatures(
  prepared: PreparedCtfRangeCapabilityParentOperation,
  response: SwapResponse | CtfConvertResponse,
): SerializedBlindedSignature[] {
  if (prepared.requestKind === 'same-keyset-swap') {
    if (!('signatures' in response) || !Array.isArray(response.signatures)) {
      throw new Error('CTF range parent swap response is invalid')
    }
    if (response.signatures.length !== prepared.allocations.length) {
      throw new Error('CTF range parent swap signature count is invalid')
    }
    return [...response.signatures]
  }
  if (!('signatures' in response) || Array.isArray(response.signatures)) {
    throw new Error('CTF range parent convert response is invalid')
  }
  const signatures = response.signatures as Record<string, SerializedBlindedSignature[]>
  assertExactResponseGroups(prepared.allocations, signatures)
  return prepared.allocations.map((row) => signatures[row.wireGroup]![row.wireIndex]!)
}

function assertExactResponseGroups(
  allocations: readonly CtfRangeCapabilityParentAllocation[],
  signatures: Readonly<Record<string, readonly SerializedBlindedSignature[]>>,
): void {
  const counts = new Map<string, number>()
  allocations.forEach((row) => counts.set(row.wireGroup, (counts.get(row.wireGroup) ?? 0) + 1))
  const expected = [...counts.keys()].sort(compareText)
  const actual = Object.keys(signatures).sort(compareText)
  if (!sameStrings(expected, actual))
    throw new Error('CTF range parent response groups are invalid')
  for (const [group, count] of counts) {
    if (signatures[group]?.length !== count) {
      throw new Error('CTF range parent response signature count is invalid')
    }
  }
}

function assertSignature(
  signature: SerializedBlindedSignature,
  output: OutputData,
  allocation: CtfRangeCapabilityParentAllocation,
): void {
  if (
    signature.id !== allocation.keysetId ||
    amountToNumber(signature.amount) !== allocation.amount ||
    output.blindedMessage.id !== allocation.keysetId ||
    amountToNumber(output.blindedMessage.amount) !== allocation.amount
  ) {
    throw new Error('CTF range parent mint signature is foreign')
  }
}

function exactKeysets(
  values: readonly PersistedCtfRangeOrderPreparation[],
): ReadonlyMap<string, MintKeys> {
  const map = new Map<string, MintKeys>()
  for (const preparation of values) {
    for (const keyset of [
      preparation.offerKeyset,
      preparation.receiveKeyset,
      preparation.complementKeyset,
    ]) {
      const candidate = mintKeys(keyset)
      const existing = map.get(keyset.id)
      if (
        existing !== undefined &&
        prepareDurableCustodyExactArtifact(existing).fingerprint !==
          prepareDurableCustodyExactArtifact(candidate).fingerprint
      ) {
        throw new Error('CTF range parent keyset authority conflicts')
      }
      map.set(keyset.id, candidate)
    }
  }
  return map
}

function keysetForAllocation(
  row: CtfRangeCapabilityOutputAllocation,
  context: ParentContext,
): ActiveCtfRangeMintKeyset {
  const preparation =
    row.clientOrderId === null ? null : context.preparations.get(row.clientOrderId)!
  const candidates =
    preparation === null
      ? [...context.preparations.values()].flatMap((item) => [item.offerKeyset, item.receiveKeyset])
      : [preparation.offerKeyset, preparation.receiveKeyset, preparation.complementKeyset]
  const keyset = candidates.find(({ id }) => id === row.keysetId)
  if (keyset === undefined) throw new Error('CTF range parent output keyset authority is absent')
  return keyset
}

function parentMetadata(operation: DurableCustodyProofOperationInput) {
  const metadata = operation.metadata ?? {}
  if (
    metadata.purpose !== PARENT_PURPOSE ||
    metadata.unit !== 'msat' ||
    (metadata.sourceMode !== 'same-keyset-swap' && metadata.sourceMode !== 'collateral-ctf-convert')
  ) {
    throw new Error('CTF range parent operation metadata is invalid')
  }
  const sourceMode: CtfRangeCapabilityBatchParent['kind'] = metadata.sourceMode
  return {
    sourceMode,
    conditionId: requiredText(metadata.conditionId, 'condition id'),
    sourceKeysetId: requiredText(metadata.sourceKeysetId, 'source keyset id'),
    parentDigest: digest(metadata.parentDigest, 'parent digest'),
    requestFingerprint: digest(metadata.requestFingerprint, 'request fingerprint'),
    allocationFingerprint: digest(metadata.allocationFingerprint, 'allocation fingerprint'),
    requestBytes: positiveInteger(metadata.requestBytes, 'request bytes'),
    inputFee: positiveInteger(metadata.inputFee, 'input fee'),
    childCount: positiveInteger(metadata.childCount, 'child count'),
  }
}

function assertParentMetadataAuthority(
  parent: CtfRangeCapabilityBatchParent,
  metadata: ReturnType<typeof parentMetadata>,
): void {
  if (
    metadata.sourceMode !== parent.kind ||
    metadata.sourceKeysetId !== parent.sourceKeysetId ||
    metadata.inputFee !== parent.inputFee ||
    metadata.requestBytes !== parent.requestBytes ||
    metadata.parentDigest !== parent.parentDigest ||
    metadata.childCount !== parent.children.length
  ) {
    throw new Error('CTF range parent metadata authority is foreign')
  }
}

function assertEnvelope(
  value: PreparedCtfRangeCapabilityParentOperation,
  operation: DurableCustodyProofOperationInput,
  parent: CtfRangeCapabilityBatchParent,
  context: ParentContext,
  allocations: readonly CtfRangeCapabilityParentAllocation[],
): void {
  const expectedChildren = childBindings(parent, context, allocations)
  const expectedKind =
    parent.kind === 'same-keyset-swap'
      ? 'ctf-range-conditional-source'
      : 'ctf-range-collateral-convert'
  if (
    value.method !== 'POST' ||
    value.path !== parentPath(parent.kind) ||
    value.idempotencyKey !== operation.operationId ||
    value.requestKind !== parent.kind ||
    operation.kind !== expectedKind ||
    operation.mintUrl !== context.mintUrl ||
    operation.metadata?.conditionId !== context.conditionId ||
    prepareDurableCustodyExactArtifact(value.children).fingerprint !==
      prepareDurableCustodyExactArtifact(expectedChildren).fingerprint ||
    allocations.length !== operation.outputs.successors?.length
  ) {
    throw new Error('CTF range parent envelope is invalid')
  }
}

function decodeAllocations(
  values: readonly CtfRangeCapabilityParentAllocation[],
  parentOperationId: string,
): CtfRangeCapabilityParentAllocation[] {
  if (values.length === 0 || values.length > 256) {
    throw new Error('CTF range parent allocations are invalid')
  }
  return values.map((row, index) => {
    if (
      row.schemaVersion !== 1 ||
      row.parentOperationId !== parentOperationId ||
      row.outputIndex !== index ||
      !Number.isSafeInteger(row.wireIndex) ||
      row.wireIndex < 0 ||
      !Number.isSafeInteger(row.amount) ||
      row.amount <= 0 ||
      !['authorization', 'complement', 'change'].includes(row.role)
    ) {
      throw new Error('CTF range parent allocation row is invalid')
    }
    digest(row.parentDigest, 'allocation parent digest')
    digest(row.requestFingerprint, 'allocation request fingerprint')
    requiredText(row.wireGroup, 'allocation wire group')
    requiredText(row.keysetId, 'allocation keyset')
    return structuredClone(row)
  })
}

function reprepareExactArtifact(
  artifact: DurableCustodyExactArtifact,
  fingerprint: string,
  label: string,
): DurableCustodyExactArtifact {
  if (artifact.encoding !== 'canonical-json' || artifact.fingerprint !== fingerprint) {
    throw new Error(`CTF range parent ${label} changed`)
  }
  const rebuilt = prepareDurableCustodyExactArtifact(artifact.artifact)
  if (rebuilt.fingerprint !== fingerprint) throw new Error(`CTF range parent ${label} changed`)
  return rebuilt
}

function detachedPrepared(
  value: PreparedCtfRangeCapabilityParentOperation,
  operation: DurableCustodyProofOperationInput,
  allocations: readonly CtfRangeCapabilityParentAllocation[],
  exactRequest: DurableCustodyExactArtifact,
  exactAllocations: DurableCustodyExactArtifact,
): PreparedCtfRangeCapabilityParentOperation {
  return Object.freeze({
    ...value,
    parent: structuredClone(value.parent),
    operation,
    exactRequest,
    exactAllocations,
    allocations: Object.freeze(allocations.map((row) => Object.freeze(row))),
    children: Object.freeze(value.children.map((row) => Object.freeze(structuredClone(row)))),
  })
}

function preparationMap(values: readonly PersistedCtfRangeOrderPreparation[]) {
  const map = new Map<string, PersistedCtfRangeOrderPreparation>()
  for (const value of values) {
    const id = value.request.clientOrderId
    if (map.has(id)) throw new Error('CTF range parent preparation is duplicated')
    map.set(id, value)
  }
  return map
}

function authorizationAmounts(preparation: PersistedCtfRangeOrderPreparation): string[] {
  const cached = authorizationAmountCache.get(preparation)
  if (cached !== undefined) return cached
  const amounts = planCtfRangeOrderAuthorization({
    side: preparation.side,
    priceNumerator: preparation.priceNumerator,
    amountSubunits: preparation.amountSubunits,
    divisibility: preparation.divisibility,
    inputFeePpk: preparation.offerKeyset.inputFeePpk,
    offerKeysetKeys: preparation.offerKeyset.keys,
    maxPoolEntries: preparation.maxPoolEntries,
    maxInputs: preparation.maxInputs,
  }).authorizationAmounts
  authorizationAmountCache.set(preparation, amounts)
  return amounts
}

function withoutRequest(preparation: PersistedCtfRangeOrderPreparation) {
  const { version: _, request: _request, ...input } = preparation
  return input
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

function conditionalCollection(keyset: ActiveCtfRangeMintKeyset): string {
  const value = (keyset as { outcomeCollection?: unknown }).outcomeCollection
  return requiredText(value, 'conditional collection')
}

function toWireOutput(value: OutputData | SerializedBlindedMessage): SerializedBlindedMessage {
  const output = 'blindedMessage' in value ? value.blindedMessage : value
  return { ...output, amount: amountToNumber(output.amount) as never }
}

function toWireProof(value: Proof): Proof {
  return { ...structuredClone(value), amount: amountToNumber(value.amount) as never }
}

function assertKeysetAuthority(
  actual: {
    readonly id: string
    readonly inputFeePpk: number
    readonly keys: Readonly<Record<string, string>>
  },
  expected: {
    readonly id: string
    readonly inputFeePpk: number
    readonly keys: Readonly<Record<string, string>>
  },
  label: string,
): void {
  if (
    actual.id !== expected.id ||
    actual.inputFeePpk !== expected.inputFeePpk ||
    !sameKeyMaps(actual.keys, expected.keys)
  ) {
    throw new Error(`CTF range parent ${label} keyset authority is foreign`)
  }
}

function sameKeyMaps(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort(compareText)
  const rightKeys = Object.keys(right).sort(compareText)
  return sameStrings(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key])
}

function normalizeProof(proof: Proof): Proof {
  return { ...proof, amount: amountToNumber(proof.amount) as never }
}

function parentPath(kind: CtfRangeCapabilityBatchParent['kind']) {
  return kind === 'same-keyset-swap' ? ('/v1/swap' as const) : ('/v1/ctf/convert' as const)
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`CTF range parent ${label} is invalid`)
  }
  return value
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CTF range parent ${label} is invalid`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`CTF range parent ${label} is invalid`)
  }
  return value as number
}

function checkedAdd(left: number, right: number): number {
  const value = left + amountToNumber(right)
  if (!Number.isSafeInteger(value)) throw new Error('CTF range parent amount overflow')
  return value
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
