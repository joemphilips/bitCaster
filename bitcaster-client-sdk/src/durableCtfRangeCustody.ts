import type { ProofState } from '@cashu/cashu-ts'
import {
  assertDurableCtfRangeCustodyAuthority,
  requireDurableCtfRangeOperationFromCustody,
  type DurableCtfRangeAsset,
  type DurableCtfRangeCustodyBinding,
  type DurableCtfRangeOperation,
  type DurableCtfRangeRecoveredResult,
} from './durableCtfRangeOperation.ts'
import {
  assertDurableCustodyArtifactMatchesReference,
  assertDurableCustodyImmutableAuthorityMatches,
  canonicalDurableCustodyKeysetIdentity,
  createDurableCustodyArtifactReference,
  decodeDurableCustodyRecord,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  type DurableCustodyArtifactReference,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from './durableCustody.ts'
import {
  createDurableCustodyProofMaterialRecord,
  type DurableCustodyProofMaterial,
  type DurableCustodyProofMaterialRecord,
} from './durableCustodyProofMaterial.ts'

export interface DurableCtfRangeStagedResultAuthority {
  readonly record: DurableCustodyRecord
  readonly resultHandle: string
  readonly resultFingerprint: string
  readonly outputPlanFingerprint: string
  readonly exactResult: DurableCustodyArtifactReference
  readonly selectedSuccessorProofIds: readonly string[]
}

export interface NormalizedDurableCtfRangeSuccessorProof {
  readonly proof: DurableCustodyProofMaterial
  readonly material: DurableCustodyProofMaterialRecord
  readonly keysetFingerprint: string
  readonly dleqState: 'not-present' | 'verified'
  readonly classification: {
    readonly conditionId: string | null
    readonly outcomeSetId: string | null
  }
}

export function assertDurableCtfRangeExactBinding(
  binding: DurableCtfRangeCustodyBinding,
): DurableCtfRangeOperation {
  const operation = requireDurableCtfRangeOperationFromCustody(binding.operation)
  assertDurableCtfRangeCustodyAuthority(binding.record, operation)
  assertDurableCustodyArtifactMatchesReference(
    binding.record.operation.exactRequest.body,
    binding.artifacts.requestBody,
  )
  assertDurableCustodyArtifactMatchesReference(
    binding.record.operation.outputPlan.exactOutput,
    binding.artifacts.output,
  )
  assertDurableCustodyArtifactMatchesReference(
    binding.record.operation.privateMaterial.exactPrivateMaterial,
    binding.artifacts.privateMaterial,
  )
  return operation
}

export function assertDurableCtfRangeExactCommittedBinding(
  existing: DurableCustodyRecord,
  expected: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
): void {
  assertDurableCtfRangeCustodyAuthority(existing, operation)
  assertDurableCustodyImmutableAuthorityMatches(existing, expected)
}

export function assertDurableCtfRangeInputsUnspent(states: readonly ProofState[]): void {
  for (const { state } of states) {
    switch (state) {
      case 'UNSPENT':
        break
      case 'PENDING':
      case 'SPENT':
        throw new Error('CTF range pre-admission NUT-07 state is not UNSPENT')
      default:
        assertNever(state)
    }
  }
}

export function createDurableCtfRangeStagedResultAuthority(input: {
  readonly record: DurableCustodyRecord
  readonly exactResult: DurableCustodyExactArtifact
  readonly resultHandle: string
  readonly resultFingerprint: string
  readonly selectedSuccessorProofIds: readonly string[]
}): DurableCtfRangeStagedResultAuthority {
  const record = decodeDurableCustodyRecord(input.record)
  const exactResult = createDurableCustodyArtifactReference(
    `artifact:${record.operation.operationId}:result`,
    input.exactResult,
  )
  if (
    input.resultHandle.length === 0 ||
    input.resultFingerprint !== exactResult.fingerprint ||
    !isExactProofSubset(
      input.selectedSuccessorProofIds,
      record.operation.proofStorage.lineage.successorProofIds,
    )
  ) {
    throw new Error('CTF range staged result authority is invalid')
  }
  return {
    record,
    resultHandle: input.resultHandle,
    resultFingerprint: input.resultFingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    exactResult,
    selectedSuccessorProofIds: [...input.selectedSuccessorProofIds],
  }
}

export function matchDurableCtfRangeExactStagedResult(
  currentValue: DurableCustodyRecord,
  expected: DurableCtfRangeStagedResultAuthority,
): DurableCustodyArtifactReference | null {
  const current = decodeDurableCustodyRecord(currentValue)
  assertDurableCustodyImmutableAuthorityMatches(current, expected.record)
  switch (current.operation.result.state) {
    case 'none':
      return null
    case 'verified-staged':
    case 'applied':
      break
    default:
      return assertNever(current.operation.result.state)
  }
  const result = current.operation.result
  const selected = current.operation.proofStorage.lineage.selectedSuccessorProofIds
  if (
    result.resultHandle !== expected.resultHandle ||
    result.resultFingerprint !== expected.resultFingerprint ||
    result.outputPlanFingerprint !== expected.outputPlanFingerprint ||
    result.exactResult === null ||
    !sameArtifactReference(result.exactResult, expected.exactResult) ||
    !sameTextArray(selected, expected.selectedSuccessorProofIds)
  ) {
    throw new Error('CTF range staged result authority is foreign')
  }
  return { ...result.exactResult }
}

export function requireDurableCtfRangeStagedResultAuthority(
  recordValue: DurableCustodyRecord,
): DurableCtfRangeStagedResultAuthority {
  const record = decodeDurableCustodyRecord(recordValue)
  switch (record.operation.result.state) {
    case 'verified-staged':
    case 'applied':
      break
    case 'none':
      throw new Error('CTF range staged result authority is absent')
    default:
      return assertNever(record.operation.result.state)
  }
  const result = record.operation.result
  const selectedSuccessorProofIds = record.operation.proofStorage.lineage.selectedSuccessorProofIds
  if (
    result.resultHandle === null ||
    result.resultFingerprint === null ||
    result.outputPlanFingerprint === null ||
    result.exactResult === null ||
    selectedSuccessorProofIds === null
  ) {
    throw new Error('CTF range staged result authority is incomplete')
  }
  return {
    record,
    resultHandle: result.resultHandle,
    resultFingerprint: result.resultFingerprint,
    outputPlanFingerprint: result.outputPlanFingerprint,
    exactResult: { ...result.exactResult },
    selectedSuccessorProofIds: [...selectedSuccessorProofIds],
  }
}

export function mapDurableCtfRangeSuccessorProofs<T>(
  input: {
    readonly record: DurableCustodyRecord
    readonly operation: DurableCtfRangeOperation
    readonly result: DurableCtfRangeRecoveredResult
  },
  mapProof: (proof: NormalizedDurableCtfRangeSuccessorProof) => T,
): T[] {
  const suppliedProofCount = input.result.receive.length + input.result.change.length
  if (
    suppliedProofCount > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ||
    suppliedProofCount !==
      input.record.operation.proofStorage.lineage.selectedSuccessorProofIds?.length
  ) {
    throw new Error('CTF range successor proof count is invalid')
  }
  const record = decodeDurableCustodyRecord(input.record)
  const operation = assertDurableCtfRangeCustodyAuthority(record, input.operation)
  const selected = requireSelectedSuccessors(record)
  if (
    input.result.operationId !== operation.operationId ||
    input.result.authorizationId !== operation.authorizationId
  ) {
    throw new Error('CTF range successor authority is foreign')
  }
  const bindings = outputVerificationBindings(record)
  const byId = new Map<string, NormalizedDurableCtfRangeSuccessorProof>()
  for (const [proofs, asset] of [
    [input.result.receive, operation.receiveAsset],
    [input.result.change, operation.offerAsset],
  ] as const) {
    for (const proof of proofs) {
      const normalized = normalizeSuccessorProof(record, proof, asset, bindings)
      if (byId.has(normalized.material.proofId)) {
        throw new Error('CTF range successor proof is duplicated')
      }
      byId.set(normalized.material.proofId, normalized)
    }
  }
  if (byId.size !== selected.length) {
    throw new Error('CTF range successor proof set is incomplete')
  }
  const ordered = selected.map((proofId) => {
    if (!byId.has(proofId)) throw new Error('CTF range successor proof is foreign')
    return byId.get(proofId)!
  })
  return ordered.map(mapProof)
}

function normalizeSuccessorProof(
  record: DurableCustodyRecord,
  proof: DurableCtfRangeRecoveredResult['receive'][number],
  asset: DurableCtfRangeAsset,
  bindings: ReadonlyMap<
    string,
    DurableCustodyRecord['operation']['verification']['keysetBindings'][number]
  >,
): NormalizedDurableCtfRangeSuccessorProof {
  const normalizedProof: DurableCustodyProofMaterial = {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    p2pkE: proof.p2pk_e ?? null,
    witness: proof.witness ?? null,
  }
  const material = createDurableCustodyProofMaterialRecord({
    scopeId: record.scope.scopeId,
    normalizedMint: record.operation.custodyContext.normalizedMint,
    unit: 'msat',
    proof: normalizedProof,
  })
  const binding = bindings.get(canonicalDurableCustodyKeysetIdentity(proof.id))
  if (
    binding === undefined ||
    material.curve !== binding.curve ||
    (binding.requireDleq && material.dleqPresence !== 'present')
  ) {
    throw new Error('CTF range successor proof verification authority is foreign')
  }
  return {
    proof: normalizedProof,
    material,
    keysetFingerprint: binding.keysetFingerprint,
    dleqState: dleqState(material.dleqPresence),
    classification: classifyAsset(asset),
  }
}

function outputVerificationBindings(
  record: DurableCustodyRecord,
): ReadonlyMap<
  string,
  DurableCustodyRecord['operation']['verification']['keysetBindings'][number]
> {
  const expectedIds = new Set(
    record.operation.verification.outputKeysets.map(({ keysetId }) =>
      canonicalDurableCustodyKeysetIdentity(keysetId),
    ),
  )
  const bindings = new Map<
    string,
    DurableCustodyRecord['operation']['verification']['keysetBindings'][number]
  >()
  for (const binding of record.operation.verification.keysetBindings) {
    const id = canonicalDurableCustodyKeysetIdentity(binding.keysetId)
    if (!expectedIds.has(id)) continue
    if (bindings.has(id)) {
      throw new Error('CTF range output keyset authority is ambiguous')
    }
    bindings.set(id, binding)
  }
  if (bindings.size !== expectedIds.size) {
    throw new Error('CTF range output keyset authority is incomplete')
  }
  return bindings
}

function requireSelectedSuccessors(record: DurableCustodyRecord): readonly string[] {
  switch (record.operation.result.state) {
    case 'verified-staged':
      break
    case 'applied':
      throw new Error('CTF range successor rows are already applied')
    case 'none':
      throw new Error('CTF range successor authority is not staged')
    default:
      return assertNever(record.operation.result.state)
  }
  const selected = record.operation.proofStorage.lineage.selectedSuccessorProofIds
  if (selected === null) throw new Error('CTF range successor authority is absent')
  return selected
}

function dleqState(
  value: DurableCustodyProofMaterialRecord['dleqPresence'],
): 'verified' | 'not-present' {
  switch (value) {
    case 'present':
      return 'verified'
    case 'not-present':
      return 'not-present'
    default:
      return assertNever(value)
  }
}

function classifyAsset(asset: DurableCtfRangeAsset): {
  readonly conditionId: string | null
  readonly outcomeSetId: string | null
} {
  switch (asset.kind) {
    case 'regular':
      return { conditionId: null, outcomeSetId: null }
    case 'conditional':
      return { conditionId: asset.conditionId, outcomeSetId: asset.outcomeCollection }
    default:
      return assertNever(asset)
  }
}

function isExactProofSubset(selected: readonly string[], candidates: readonly string[]): boolean {
  if (selected.length === 0 || new Set(selected).size !== selected.length) return false
  const candidateSet = new Set(candidates)
  return selected.every((proofId) => candidateSet.has(proofId))
}

function sameArtifactReference(
  left: DurableCustodyArtifactReference,
  right: DurableCustodyArtifactReference,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.encoding === right.encoding &&
    left.fingerprint === right.fingerprint &&
    left.byteLength === right.byteLength
  )
}

function sameTextArray(left: readonly string[] | null, right: readonly string[]): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function assertNever(value: never): never {
  throw new Error(`unhandled durable CTF range custody value: ${String(value)}`)
}
