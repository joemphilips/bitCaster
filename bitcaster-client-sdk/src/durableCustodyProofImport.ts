import {
  assertDurableCustodyArtifactMatchesReference,
  assertDurableCustodyImmutableAuthorityMatches,
  createDurableCustodyArtifactReference,
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodySuccessorAdmissionEvidence,
  type DurableCustodyTransaction,
  type DurableProofOperationKeysetFactsInput,
} from './durableCustody.ts'
import { bindDurableCustodyProofOperation } from './durableCustodyProofOperationRecord.ts'
import {
  createDurableCustodyProofMaterialRecord,
  serializeDurableCustodyProofArtifact,
} from './durableCustodyProofMaterial.ts'
import type { Proof } from '@cashu/cashu-ts'

export type DurableCustodyProofImportKeyset = Omit<
  DurableProofOperationKeysetFactsInput,
  'usedByInputs' | 'usedByOutputs'
>

export interface DurableCustodyProofImportBatchAuthority {
  readonly rootSourceOperationId: string
  readonly proofSetFingerprint: string
  readonly proofCount: number
  readonly pageCount: number
  readonly pageIndex: number
}

export const DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX = 32
export const DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX = 65_536

export interface PreparedDurableCustodyProofImport {
  readonly record: DurableCustodyRecord
  readonly artifacts: {
    readonly requestBody: DurableCustodyExactArtifact
    readonly output: DurableCustodyExactArtifact
    readonly privateMaterial: DurableCustodyExactArtifact
    readonly result: DurableCustodyExactArtifact
  }
  readonly successorProofIds: readonly string[]
}

export interface DurableCustodyProofImportInput {
  readonly scope: DurableCustodyScope
  readonly sourceOperationId: string
  readonly normalizedMint: string
  readonly unit: 'sat' | 'msat'
  readonly inventoryAccountId: string | null
  readonly keysets: readonly DurableCustodyProofImportKeyset[]
  readonly proofs: readonly Proof[]
  readonly inventoryAuthorityFingerprint: string
  readonly batchAuthority?: DurableCustodyProofImportBatchAuthority
}

interface CanonicalImportProof {
  readonly exactProof: ReturnType<typeof serializeDurableCustodyProofArtifact>
  readonly material: ReturnType<typeof createDurableCustodyProofMaterialRecord>
}

/**
 * Builds one exact local admission for proofs produced by an already durable
 * wallet receive. The caller must verify the proof signatures before calling
 * this function. The storage adapter commits the returned operation and proof
 * rows atomically.
 */
export function prepareDurableCustodyProofImport(
  input: DurableCustodyProofImportInput,
): PreparedDurableCustodyProofImport {
  validateImportInput(input)
  const keysets = keysetsById(input.keysets)
  const proofs = input.proofs.map((proof) => canonicalImportProof(input, proof, keysets))
  const successorProofIds = proofs.map(({ material }) => material.proofId)
  const usedKeysets = new Set(proofs.map(({ material }) => material.keysetId))
  if (
    new Set(successorProofIds).size !== successorProofIds.length ||
    usedKeysets.size !== keysets.size
  ) {
    throw new Error('custody proof import authority is incomplete or duplicated')
  }
  const artifacts = createImportArtifacts(input, proofs)
  return {
    record: createImportRecord(input, artifacts, successorProofIds),
    artifacts,
    successorProofIds,
  }
}

function createImportRecord(
  input: DurableCustodyProofImportInput,
  artifacts: PreparedDurableCustodyProofImport['artifacts'],
  successorProofIds: readonly string[],
): DurableCustodyRecord {
  const facts = createDurableProofOperationFacts({
    unit: input.unit,
    binding: { kind: 'wallet', activityId: input.sourceOperationId, stage: 'receive' },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: 'none',
    keysets: input.keysets.map((keyset) => ({
      ...keyset,
      usedByInputs: false,
      usedByOutputs: true,
    })),
  })
  const retainedOperationKey = `completed-proof-import:${input.sourceOperationId}`
  return createDurableCustodyDispatchIntent({
    scope: input.scope,
    retainedOperationKey,
    semanticKind: 'generic-receive',
    facts,
    normalizedMint: input.normalizedMint,
    inventoryAccountId: input.inventoryAccountId,
    reservation: {
      reservationId: `reservation:${retainedOperationKey}`,
      parentReservationId: null,
      inputs: [],
    },
    proofLineage: {
      predecessorProofIds: [],
      successorProofIds,
      successorAdmissionMode: 'exact',
    },
    exactRequest: {
      requestId: `request:${retainedOperationKey}`,
      requestFingerprint: artifacts.requestBody.fingerprint,
      payloadHandle: `request-payload:${retainedOperationKey}`,
      inputProofIds: [],
      outputPlanFingerprint: artifacts.output.fingerprint,
      method: 'POST',
      path: '/internal/custody/completed-proof-import',
      idempotencyKey: input.sourceOperationId,
      body: artifacts.requestBody,
    },
    outputPlan: {
      outputPlanId: `output-plan:${retainedOperationKey}`,
      outputPlanFingerprint: artifacts.output.fingerprint,
      outputMaterialHandle: `output-material:${retainedOperationKey}`,
      exactOutput: artifacts.output,
    },
    privateMaterial: {
      materialHandle: `private-material:${retainedOperationKey}`,
      useId: `private-use:${retainedOperationKey}`,
      publicFingerprint: artifacts.privateMaterial.fingerprint,
      exactPrivateMaterial: artifacts.privateMaterial,
    },
  })
}

function createImportArtifacts(
  input: DurableCustodyProofImportInput,
  proofs: readonly CanonicalImportProof[],
): PreparedDurableCustodyProofImport['artifacts'] {
  return {
    requestBody: prepareDurableCustodyExactArtifact({
      kind: 'completed-proof-import',
      sourceOperationId: input.sourceOperationId,
      normalizedMint: input.normalizedMint,
      unit: input.unit,
      ...(input.batchAuthority === undefined
        ? {}
        : { batchAuthority: structuredClone(input.batchAuthority) }),
    }),
    output: prepareDurableCustodyExactArtifact({
      inventoryAuthorityFingerprint: input.inventoryAuthorityFingerprint,
      proofs: proofs.map(({ material }) => ({
        proofId: material.proofId,
        proofFingerprint: material.proofFingerprint,
      })),
    }),
    privateMaterial: prepareDurableCustodyExactArtifact({ kind: 'no-private-material' }),
    result: prepareDurableCustodyExactArtifact({
      proofs: proofs.map(({ exactProof, material }) => ({
        proofId: material.proofId,
        keysetId: material.keysetId,
        curve: material.curve,
        exactProof,
      })),
    }),
  }
}

export function bindDurableCustodyProofImport(input: {
  readonly transaction: DurableCustodyTransaction
  readonly prepared: PreparedDurableCustodyProofImport
}): DurableCustodyRecord {
  const { transaction, prepared } = input
  bindDurableCustodyProofOperation(transaction, prepared.record, prepared.artifacts)
  return requiredOperation(transaction, prepared.record.operation.operationId)
}

export function stageDurableCustodyProofImport(input: {
  readonly transaction: DurableCustodyTransaction
  readonly prepared: PreparedDurableCustodyProofImport
  readonly authorization: DurableCustodyOwnerAuthorization
}): void {
  const { transaction, prepared, authorization } = input
  const operationId = prepared.record.operation.operationId
  const current = requiredOperation(transaction, operationId)
  assertDurableCustodyImmutableAuthorityMatches(current, prepared.record)
  if (current.operation.result.state !== 'none') {
    assertPreparedResultAuthority(transaction, current, prepared)
    return
  }
  transaction.stageVerifiedResult({
    operationId,
    expectedRevision: current.revision,
    authorization,
    outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
    resultHandle: `proof-import-result:${prepared.artifacts.result.fingerprint}`,
    resultFingerprint: prepared.artifacts.result.fingerprint,
    exactResult: prepared.artifacts.result,
    selectedSuccessorProofIds: prepared.successorProofIds,
  })
}

export function applyDurableCustodyProofImport(input: {
  readonly transaction: DurableCustodyTransaction
  readonly prepared: PreparedDurableCustodyProofImport
  readonly authorization: DurableCustodyOwnerAuthorization
  readonly successorAdmission: DurableCustodySuccessorAdmissionEvidence
  readonly inventoryAuthorityFingerprint: string
}): void {
  const {
    transaction,
    prepared,
    authorization,
    successorAdmission,
    inventoryAuthorityFingerprint,
  } = input
  const operationId = prepared.record.operation.operationId
  const current = requiredOperation(transaction, operationId)
  assertDurableCustodyImmutableAuthorityMatches(current, prepared.record)
  if (current.operation.result.state === 'none') {
    throw new Error('custody proof import result is not staged')
  }
  assertPreparedResultAuthority(transaction, current, prepared)
  assertInventoryAuthority(transaction, current, prepared, inventoryAuthorityFingerprint)
  if (current.operation.result.state === 'applied') {
    assertExactSuccessorAdmission(current, successorAdmission)
    return
  }
  if (current.operation.result.state === 'verified-staged') {
    const resultHandle = current.operation.result.resultHandle
    const resultFingerprint = current.operation.result.resultFingerprint
    if (resultHandle === null || resultFingerprint === null) {
      throw new Error('custody proof import staged result authority is absent')
    }
    transaction.applyVerifiedResult({
      operationId,
      expectedRevision: current.revision,
      authorization,
      outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
      resultHandle,
      resultFingerprint,
      successorAdmission,
    })
  }
}

function assertExactSuccessorAdmission(
  record: DurableCustodyRecord,
  candidate: DurableCustodySuccessorAdmissionEvidence,
): void {
  const expected = record.operation.proofStorage.lineage.successorAdmission
  if (
    expected === null ||
    expected.scopeId !== candidate.scopeId ||
    expected.operationId !== candidate.operationId ||
    expected.admissionId !== candidate.admissionId ||
    expected.proofRows.length !== candidate.proofRows.length ||
    expected.proofRows.some((row, index) => {
      const other = candidate.proofRows[index]
      return (
        other === undefined ||
        row.proofId !== other.proofId ||
        row.expectedRevision !== other.expectedRevision ||
        row.admittedRevision !== other.admittedRevision
      )
    })
  ) {
    throw new Error('custody proof import successor admission is foreign')
  }
}

function validateImportInput(input: {
  readonly sourceOperationId: string
  readonly proofs: readonly Proof[]
  readonly inventoryAuthorityFingerprint: string
  readonly batchAuthority?: DurableCustodyProofImportBatchAuthority
}): void {
  requireText(input.sourceOperationId, 'proof import source operation id')
  if (!/^[0-9a-f]{64}$/.test(input.inventoryAuthorityFingerprint)) {
    throw new Error('custody proof import inventory authority is invalid')
  }
  if (
    input.proofs.length === 0 ||
    input.proofs.length > DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX
  ) {
    throw new Error('custody proof import count is invalid')
  }
  if (input.batchAuthority !== undefined) {
    validateBatchAuthority(input.batchAuthority, input.proofs.length)
  }
}

function validateBatchAuthority(
  authority: DurableCustodyProofImportBatchAuthority,
  currentPageProofCount: number,
): void {
  requireText(authority.rootSourceOperationId, 'proof import root source operation id')
  if (!/^[0-9a-f]{64}$/.test(authority.proofSetFingerprint)) {
    throw new Error('custody proof import batch fingerprint is invalid')
  }
  const expectedPageCount = Math.ceil(
    authority.proofCount / DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  )
  const expectedCurrentPageProofCount = Math.min(
    DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    authority.proofCount - authority.pageIndex * DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  )
  if (
    !Number.isSafeInteger(authority.proofCount) ||
    authority.proofCount < 1 ||
    authority.proofCount > DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX ||
    !Number.isSafeInteger(authority.pageCount) ||
    authority.pageCount !== expectedPageCount ||
    !Number.isSafeInteger(authority.pageIndex) ||
    authority.pageIndex < 0 ||
    authority.pageIndex >= authority.pageCount ||
    currentPageProofCount !== expectedCurrentPageProofCount
  ) {
    throw new Error('custody proof import batch bounds are invalid')
  }
}

function keysetsById(
  keysets: readonly DurableCustodyProofImportKeyset[],
): Map<string, DurableCustodyProofImportKeyset> {
  const result = new Map(keysets.map((keyset) => [keyset.keysetId, keyset]))
  if (result.size !== keysets.length) throw new Error('custody proof import keyset is duplicated')
  return result
}

function canonicalImportProof(
  input: {
    readonly scope: DurableCustodyScope
    readonly normalizedMint: string
    readonly unit: 'sat' | 'msat'
  },
  proof: Proof,
  keysets: ReadonlyMap<string, DurableCustodyProofImportKeyset>,
): CanonicalImportProof {
  const exactProof = serializeDurableCustodyProofArtifact(proof)
  const material = createDurableCustodyProofMaterialRecord({
    scopeId: input.scope.scopeId,
    normalizedMint: input.normalizedMint,
    unit: input.unit,
    proof: exactProof,
  })
  const keyset = keysets.get(material.keysetId)
  if (keyset === undefined || keyset.unit !== input.unit || keyset.curve !== material.curve) {
    throw new Error('custody proof import keyset authority is foreign')
  }
  return { exactProof, material }
}

function assertInventoryAuthority(
  transaction: DurableCustodyTransaction,
  record: DurableCustodyRecord,
  prepared: PreparedDurableCustodyProofImport,
  candidate: string,
): void {
  if (!/^[0-9a-f]{64}$/.test(candidate)) {
    throw new Error('custody proof import candidate authority is invalid')
  }
  const reference = record.operation.outputPlan.exactOutput
  const expected = createDurableCustodyArtifactReference(
    `artifact:${record.operation.operationId}:output`,
    prepared.artifacts.output,
  )
  if (!sameReference(reference, expected)) {
    throw new Error('custody proof import inventory authority is foreign')
  }
  const row = transaction.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (row === null) throw new Error('custody proof import inventory authority is absent')
  assertDurableCustodyArtifactMatchesReference(reference, row.artifact)
  assertDurableCustodyArtifactMatchesReference(expected, row.artifact)
  const artifact = decodeInventoryAuthorityArtifact(row.artifact.artifact)
  if (candidate !== artifact.inventoryAuthorityFingerprint) {
    throw new Error('custody proof import candidate authority is foreign')
  }
}

function decodeInventoryAuthorityArtifact(value: unknown): {
  inventoryAuthorityFingerprint: string
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'inventoryAuthorityFingerprint,proofs'
  ) {
    throw new Error('custody proof import inventory authority is invalid')
  }
  const fingerprint = (value as { inventoryAuthorityFingerprint?: unknown })
    .inventoryAuthorityFingerprint
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('custody proof import inventory authority is invalid')
  }
  return { inventoryAuthorityFingerprint: fingerprint }
}

function assertPreparedResultAuthority(
  transaction: DurableCustodyTransaction,
  record: DurableCustodyRecord,
  prepared: PreparedDurableCustodyProofImport,
): void {
  const operationId = record.operation.operationId
  const result = record.operation.result
  const exactResult = result.exactResult
  const expectedReference = createDurableCustodyArtifactReference(
    `artifact:${operationId}:result`,
    prepared.artifacts.result,
  )
  if (
    result.resultHandle !== importResultHandle(prepared) ||
    result.resultFingerprint !== prepared.artifacts.result.fingerprint ||
    result.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint ||
    exactResult === null ||
    !sameReference(exactResult, expectedReference) ||
    !sameStrings(
      record.operation.proofStorage.lineage.selectedSuccessorProofIds,
      prepared.successorProofIds,
    )
  ) {
    throw new Error('custody proof import result authority is foreign')
  }
  const row = transaction.getArtifact({
    scopeId: record.scope.scopeId,
    operationId,
    expectedOperationRevision: record.revision,
    reference: exactResult,
  })
  if (row === null) throw new Error('custody proof import result artifact is absent')
  assertDurableCustodyArtifactMatchesReference(exactResult, row.artifact)
  assertDurableCustodyArtifactMatchesReference(expectedReference, row.artifact)
}

function importResultHandle(prepared: PreparedDurableCustodyProofImport): string {
  return `proof-import-result:${prepared.artifacts.result.fingerprint}`
}

function requiredOperation(
  transaction: DurableCustodyTransaction,
  operationId: string,
): DurableCustodyRecord {
  const operation = transaction.getOperation(operationId)
  if (operation === null) throw new Error('custody proof import operation is absent')
  return operation
}

function requireText(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} is invalid`)
}

function sameStrings(left: readonly string[] | null, right: readonly string[]): boolean {
  return (
    left !== null && left.length === right.length && left.every((value, i) => value === right[i])
  )
}

function sameReference(
  left: { artifactId: string; encoding: string; fingerprint: string; byteLength: number },
  right: { artifactId: string; encoding: string; fingerprint: string; byteLength: number },
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.encoding === right.encoding &&
    left.fingerprint === right.fingerprint &&
    left.byteLength === right.byteLength
  )
}
