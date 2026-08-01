import { Keyset, isBlsKeyset, verifyProofsForReceive, type Proof } from '@cashu/cashu-ts'
import {
  assertDurableCustodyArtifactMatchesReference,
  canonicalDurableCustodyKeysetIdentity,
  createDurableProofOperationFacts,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyTransaction,
  type DurableProofOperationFacts,
} from './durableCustody.ts'
import {
  createDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
  type DurableCustodyProofMaterialRecord,
} from './durableCustodyProofMaterial.ts'
import {
  decodeDurableCustodyProofOperationInput,
  durableCustodyProofOperationStage,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { amountToNumber } from './proofSelection.ts'

export interface DurableCustodyMintKeysetAuthority {
  readonly canonicalMintUrl: string
  readonly id: string
  readonly unit: string
  readonly keys: Readonly<Record<string, string>>
  readonly inputFeePpk: number
  readonly finalExpiry: number | null
  readonly identity:
    | { readonly kind: 'regular' }
    | {
        readonly kind: 'conditional'
        readonly conditionId: string
        readonly outcomeCollection: string
        readonly outcomeCollectionId: string
      }
}

export interface DurableCustodyMintOperationAuthority {
  readonly schemaVersion: 1
  readonly operation: DurableCustodyProofOperationInput
  readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
}

export interface DurableCustodyVerifiedMintProof {
  readonly group: string
  readonly proof: Proof
  readonly material: DurableCustodyProofMaterialRecord
  readonly keysetFingerprint: string
  readonly dleqState: 'not-present' | 'verified'
}

const verifiedMintResultBrand: unique symbol = Symbol('verified custody mint result')

export interface DurableCustodyVerifiedMintResult {
  readonly [verifiedMintResultBrand]: true
  readonly exactResult: DurableCustodyExactArtifact
  readonly resultFingerprint: string
  readonly selectedSuccessorProofIds: readonly string[]
  readonly proofs: readonly DurableCustodyVerifiedMintProof[]
}

export function prepareDurableCustodyMintOperationAuthority(input: {
  readonly operation: DurableCustodyProofOperationInput
  readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
}): {
  readonly authority: DurableCustodyMintOperationAuthority
  readonly exactAuthority: DurableCustodyExactArtifact
  readonly exactRequest: DurableCustodyExactArtifact
  readonly exactOutput: DurableCustodyExactArtifact
  readonly facts: DurableProofOperationFacts
} {
  const authority = decodeDurableCustodyMintOperationAuthority({ schemaVersion: 1, ...input })
  return {
    authority,
    exactAuthority: prepareDurableCustodyExactArtifact(authority),
    exactRequest: prepareDurableCustodyExactArtifact(authority.operation),
    exactOutput: prepareDurableCustodyExactArtifact(authority.operation.outputs),
    facts: factsForAuthority(authority),
  }
}

export function prepareDurableCustodyVerifiedMintResult(input: {
  readonly record: DurableCustodyRecord
  readonly exactAuthority: DurableCustodyExactArtifact
  readonly result: Readonly<Record<string, readonly Proof[]>>
}): DurableCustodyVerifiedMintResult {
  const authority = assertDurableCustodyMintOperationAuthority(input.record, input.exactAuthority)
  const proofs = verifyAndMapMintProofs(input.record, authority, input.result)
  const exactResult = prepareDurableCustodyExactArtifact(canonicalResult(input.result))
  return {
    [verifiedMintResultBrand]: true,
    exactResult,
    resultFingerprint: exactResult.fingerprint,
    selectedSuccessorProofIds: proofs.map(({ material }) => material.proofId),
    proofs,
  }
}

export function assertDurableCustodyMintOperationAuthority(
  record: DurableCustodyRecord,
  exactAuthority: DurableCustodyExactArtifact,
): DurableCustodyMintOperationAuthority {
  assertDurableCustodyArtifactMatchesReference(
    record.operation.privateMaterial.exactPrivateMaterial,
    exactAuthority,
  )
  const authority = decodeDurableCustodyMintOperationAuthority(exactAuthority.artifact)
  assertMintOperationRecord(record, authority)
  return authority
}

export function stageDurableCustodyPreparedMintResult(input: {
  readonly transaction: DurableCustodyTransaction
  readonly record: DurableCustodyRecord
  readonly prepared: DurableCustodyVerifiedMintResult
  readonly authorization: DurableCustodyOwnerAuthorization
}): void {
  if (
    input.prepared[verifiedMintResultBrand] !== true ||
    input.prepared.exactResult.fingerprint !== input.prepared.resultFingerprint ||
    input.prepared.selectedSuccessorProofIds.length !== input.prepared.proofs.length
  ) {
    throw new Error('custody mint prepared result is inconsistent')
  }
  input.transaction.stageVerifiedResult({
    operationId: input.record.operation.operationId,
    expectedRevision: input.record.revision,
    authorization: input.authorization,
    outputPlanFingerprint: input.record.operation.outputPlan.outputPlanFingerprint,
    resultHandle: `mint-result:${input.prepared.resultFingerprint}`,
    resultFingerprint: input.prepared.resultFingerprint,
    exactResult: input.prepared.exactResult,
    selectedSuccessorProofIds: input.prepared.selectedSuccessorProofIds,
  })
}

export function readDurableCustodyVerifiedMintResult(input: {
  readonly record: DurableCustodyRecord
  readonly exactAuthority: DurableCustodyExactArtifact
  readonly exactResult: DurableCustodyExactArtifact
}): DurableCustodyVerifiedMintResult {
  const reference = input.record.operation.result.exactResult
  if (reference === null) throw new Error('custody mint result authority is absent')
  assertDurableCustodyArtifactMatchesReference(reference, input.exactResult)
  const result = decodeResult(input.exactResult.artifact)
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record: input.record,
    exactAuthority: input.exactAuthority,
    result,
  })
  const selected = input.record.operation.proofStorage.lineage.selectedSuccessorProofIds
  if (
    input.record.operation.result.resultFingerprint !== prepared.resultFingerprint ||
    selected === null ||
    JSON.stringify(selected) !== JSON.stringify(prepared.selectedSuccessorProofIds)
  ) {
    throw new Error('custody mint staged result authority is foreign')
  }
  return prepared
}

export function decodeDurableCustodyMintOperationAuthority(
  value: unknown,
): DurableCustodyMintOperationAuthority {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.keysets)) {
    throw new Error('custody mint operation authority is invalid')
  }
  exactKeys(value, ['schemaVersion', 'operation', 'keysets'])
  const operation = canonicalMintOperation(decodeDurableCustodyProofOperationInput(value.operation))
  assertSupportedOperation(operation)
  const keysets = value.keysets.map(decodeKeyset)
  assertExactKeysetAuthority(operation, keysets)
  return { schemaVersion: 1, operation, keysets }
}

function verifyAndMapMintProofs(
  record: DurableCustodyRecord,
  authority: DurableCustodyMintOperationAuthority,
  result: Readonly<Record<string, readonly Proof[]>>,
): DurableCustodyVerifiedMintProof[] {
  assertExactGroups(authority.operation.outputs, result)
  const keysets = new Map(authority.keysets.map((keyset) => [keyset.id, keyset]))
  const mapped = Object.entries(authority.operation.outputs).flatMap(([group, outputs]) => {
    const proofs = result[group]!
    if (proofs.length !== outputs.length) throw new Error('custody mint proof count is invalid')
    return outputs.map((output, index) =>
      mapMintProof(record, authority, group, output, proofs[index]!, keysets),
    )
  })
  verifyProofsForReceive(
    mapped.map(({ proof }) => proof),
    (id) => keysets.get(id)!,
    { requireDleq: true },
  )
  const byId = new Map(mapped.map((proof) => [proof.material.proofId, proof]))
  if (byId.size !== mapped.length) throw new Error('custody mint result proof set is duplicated')
  return record.operation.proofStorage.lineage.successorProofIds.map((proofId) => {
    const proof = byId.get(proofId)
    if (proof === undefined) throw new Error('custody mint result proof set is incomplete')
    return proof
  })
}

function mapMintProof(
  record: DurableCustodyRecord,
  authority: DurableCustodyMintOperationAuthority,
  group: string,
  output: DurableCustodyProofOperationInput['outputs'][string][number],
  proofValue: Proof,
  keysets: ReadonlyMap<string, DurableCustodyMintKeysetAuthority>,
): DurableCustodyVerifiedMintProof {
  const proof = deserializeDurableCustodyProofArtifact(
    serializeDurableCustodyProofArtifact(proofValue),
  )
  const expectedAmount = amountToNumber(output.blindedMessage.amount)
  const expectedR = scalarHex(output.blindingFactor)
  if (
    proof.id !== output.blindedMessage.id ||
    amountToNumber(proof.amount) !== expectedAmount ||
    proof.secret !== output.secret ||
    (proof.p2pk_e ?? null) !== (output.ephemeralE ?? null) ||
    proof.witness !== undefined ||
    (!isBlsKeyset(proof.id) && proof.dleq?.r !== expectedR)
  ) {
    throw new Error('custody mint proof differs from its persisted output')
  }
  const material = createDurableCustodyProofMaterialRecord({
    scopeId: record.scope.scopeId,
    normalizedMint: authority.operation.mintUrl,
    unit: operationUnit(authority.operation),
    proof: {
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      dleq: proof.dleq ?? null,
      p2pkE: proof.p2pk_e ?? null,
      witness: proof.witness ?? null,
    },
  })
  const keyset = keysets.get(proof.id)
  const binding = record.operation.verification.keysetBindings.find(
    ({ keysetId }) => canonicalDurableCustodyKeysetIdentity(keysetId) === material.keysetId,
  )
  if (keyset === undefined || binding === undefined || binding.curve !== material.curve) {
    throw new Error('custody mint result keyset authority is absent')
  }
  return {
    group,
    proof,
    material,
    keysetFingerprint: binding.keysetFingerprint,
    dleqState: material.dleqPresence === 'present' ? 'verified' : 'not-present',
  }
}

function factsForAuthority(
  authority: DurableCustodyMintOperationAuthority,
): DurableProofOperationFacts {
  const operation = authority.operation
  const inputIds = new Set(operation.inputs.map(({ id }) => id!))
  const outputIds = new Set(
    Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  )
  return createDurableProofOperationFacts({
    unit: operationUnit(operation),
    binding: {
      kind: 'wallet',
      activityId: operation.operationId,
      stage: durableCustodyProofOperationStage(operation.kind),
    },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: outputIds.size > 0,
    inputKeysetRequirement: 'required',
    keysets: authority.keysets.map((keyset) => ({
      keysetId: keyset.id,
      unit: keyset.unit,
      curve: isBlsKeyset(keyset.id) ? 'bls12-381' : 'secp256k1',
      publicKeys: keyset.keys,
      keysetExpiryMs: expiryMilliseconds(keyset.finalExpiry),
      requireDleq: true,
      usedByInputs: inputIds.has(keyset.id),
      usedByOutputs: outputIds.has(keyset.id),
    })),
  })
}

function decodeKeyset(value: unknown): DurableCustodyMintKeysetAuthority {
  if (!isRecord(value) || !isRecord(value.keys)) throw new Error('custody mint keyset is invalid')
  exactKeys(value, [
    'canonicalMintUrl',
    'id',
    'unit',
    'keys',
    'inputFeePpk',
    'finalExpiry',
    'identity',
  ])
  const identity = decodeKeysetIdentity(value.identity)
  const keyset = {
    canonicalMintUrl: text(value.canonicalMintUrl, 'mint URL'),
    id: text(value.id, 'keyset id'),
    unit: text(value.unit, 'keyset unit'),
    keys: Object.fromEntries(
      Object.entries(value.keys).map(([amount, key]) => [amount, text(key, 'mint key')]),
    ),
    inputFeePpk: safeInteger(value.inputFeePpk, 'input fee'),
    finalExpiry: value.finalExpiry === null ? null : safeInteger(value.finalExpiry, 'final expiry'),
    identity,
  }
  const mintKeys = {
    id: keyset.id,
    unit: keyset.unit,
    keys: keyset.keys,
    input_fee_ppk: keyset.inputFeePpk,
    ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
  }
  const verified =
    identity.kind === 'regular'
      ? Keyset.verifyKeysetId(mintKeys)
      : Keyset.verifyConditionalKeysetId(mintKeys, {
          conditionId: identity.conditionId,
          outcomeCollection: identity.outcomeCollection,
          outcomeCollectionId: identity.outcomeCollectionId,
        })
  if (!verified) throw new Error('custody mint keyset identity is invalid')
  return keyset
}

function decodeKeysetIdentity(value: unknown): DurableCustodyMintKeysetAuthority['identity'] {
  if (!isRecord(value)) throw new Error('custody mint keyset identity is invalid')
  if (value.kind === 'regular') {
    exactKeys(value, ['kind'])
    return { kind: 'regular' }
  }
  if (value.kind !== 'conditional') {
    throw new Error('custody mint keyset identity is invalid')
  }
  exactKeys(value, ['kind', 'conditionId', 'outcomeCollection', 'outcomeCollectionId'])
  return {
    kind: 'conditional',
    conditionId: text(value.conditionId, 'condition id'),
    outcomeCollection: text(value.outcomeCollection, 'outcome collection'),
    outcomeCollectionId: text(value.outcomeCollectionId, 'outcome collection id'),
  }
}

function assertExactKeysetAuthority(
  operation: DurableCustodyProofOperationInput,
  keysets: readonly DurableCustodyMintKeysetAuthority[],
): void {
  const used = new Set([
    ...operation.inputs.map(({ id }) => id!),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ])
  const byId = new Map(keysets.map((keyset) => [keyset.id, keyset]))
  if (used.size !== keysets.length || byId.size !== keysets.length) {
    throw new Error('custody mint keyset authority is incomplete')
  }
  for (const id of used) {
    const keyset = byId.get(id)
    if (keyset === undefined || keyset.canonicalMintUrl !== operation.mintUrl) {
      throw new Error('custody mint keyset authority is foreign')
    }
  }
}

function assertMintOperationRecord(
  record: DurableCustodyRecord,
  authority: DurableCustodyMintOperationAuthority,
): void {
  const facts = factsForAuthority(authority)
  const expectedRequest = prepareDurableCustodyExactArtifact(authority.operation)
  const expectedOutput = prepareDurableCustodyExactArtifact(authority.operation.outputs)
  const { outputPlanFingerprint: _, ...verification } = record.operation.verification
  if (
    record.operation.retainedOperationKey !== authority.operation.operationId ||
    JSON.stringify(record.operation.binding) !== JSON.stringify(facts.binding) ||
    record.operation.exactRequest.body.fingerprint !== expectedRequest.fingerprint ||
    record.operation.outputPlan.exactOutput.fingerprint !== expectedOutput.fingerprint ||
    JSON.stringify(verification) !== JSON.stringify(facts.verification)
  ) {
    throw new Error('custody mint operation record authority is foreign')
  }
}

function canonicalResult(result: Readonly<Record<string, readonly Proof[]>>) {
  return Object.fromEntries(
    Object.entries(result).map(([group, proofs]) => [
      group,
      proofs.map(serializeDurableCustodyProofArtifact),
    ]),
  )
}

function decodeResult(value: unknown): Record<string, Proof[]> {
  if (!isRecord(value)) throw new Error('custody mint result is invalid')
  return Object.fromEntries(
    Object.entries(value).map(([group, proofs]) => {
      if (!Array.isArray(proofs)) throw new Error('custody mint result group is invalid')
      return [group, proofs.map(deserializeDurableCustodyProofArtifact)]
    }),
  )
}

function assertExactGroups(
  expected: Readonly<Record<string, readonly unknown[]>>,
  actual: Readonly<Record<string, readonly unknown[]>>,
): void {
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(Object.keys(actual).sort())) {
    throw new Error('custody mint result groups are foreign')
  }
}

function assertSupportedOperation(operation: DurableCustodyProofOperationInput): void {
  if (
    (operation.kind !== 'wallet-send' &&
      operation.kind !== 'wallet-receive' &&
      operation.kind !== 'conditional-keyset-swap' &&
      operation.kind !== 'ctf-split' &&
      operation.kind !== 'ctf-range-refund') ||
    operation.inputs.length === 0 ||
    Object.values(operation.outputs).every((outputs) => outputs.length === 0)
  ) {
    throw new Error('custody mint result operation kind is unsupported')
  }
}

function canonicalMintOperation(
  operation: DurableCustodyProofOperationInput,
): DurableCustodyProofOperationInput {
  return {
    ...operation,
    inputs: operation.inputs.map((proof) =>
      omitUndefined({
        id: proof.id,
        amount: amountToNumber(proof.amount),
        secret: proof.secret,
        C: proof.C,
        dleq: structuredClone(proof.dleq),
        p2pk_e: proof.p2pk_e,
        witness: structuredClone(proof.witness),
        conditionId: proof.conditionId,
        outcomeCollection: proof.outcomeCollection,
      }),
    ) as unknown as DurableCustodyProofOperationInput['inputs'],
    outputs: Object.fromEntries(
      Object.entries(operation.outputs).map(([group, outputs]) => [
        group,
        outputs.map((output) => ({
          ...output,
          blindedMessage: {
            ...output.blindedMessage,
            amount: amountToNumber(output.blindedMessage.amount),
          },
        })),
      ]),
    ),
  }
}

function operationUnit(operation: DurableCustodyProofOperationInput): 'sat' | 'msat' {
  const unit = operation.metadata?.unit
  if (unit !== 'sat' && unit !== 'msat') throw new Error('custody mint operation unit is invalid')
  return unit
}

function expiryMilliseconds(value: number | null): number | null {
  if (value === null) return null
  const milliseconds = value * 1_000
  if (!Number.isSafeInteger(milliseconds)) throw new Error('custody keyset expiry is invalid')
  return milliseconds
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`custody ${label} is invalid`)
  }
  return value
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`custody ${label} is invalid`)
  }
  return value as number
}

function scalarHex(value: string): string {
  let scalar: bigint
  try {
    scalar = BigInt(value)
  } catch {
    throw new Error('custody mint output blinding factor is invalid')
  }
  if (scalar < 0n || scalar >= 1n << 256n) {
    throw new Error('custody mint output blinding factor is invalid')
  }
  return scalar.toString(16).padStart(64, '0')
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error('custody mint authority fields are invalid')
  }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
