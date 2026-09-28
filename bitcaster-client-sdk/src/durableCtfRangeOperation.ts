import {
  Amount,
  Keyset,
  OutputData,
  buildCtfRangeRecoveryQuery,
  classifyCtfSettlementRecovery,
  computeCtfManifestCommitment,
  deriveConditionalKeysetId,
  deriveCtfRangeRecoverySelection,
  deriveSecretAndBlindingFactor,
  hashToCurve,
  parseCtfPayToUnlockCondition,
  parseCtfSelectionBitmap,
  recoverCtfRangeProofs,
  selectCtfManifestOutputs,
  signPayToUnlockRefund,
  verifyProofsForReceive,
  type CtfPoolEntry,
  type CtfRangeManifestMaterial,
  type HasKeysetKeys,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SerializedOutputData,
  type SwapRequest,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/curves/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
  assertDurableCustodyArtifactMatchesReference,
  canonicalDurableCustodyKeysetIdentity,
  decodeCanonicalMintOrigin,
  decodeDurableCustodyRecord,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyKeysetFingerprint,
  deriveDurableCustodyProofId,
  encodeBoundedDurableArtifact,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
  type DurableProofOperationFacts,
} from './durableCustody.ts'
import { amountToNumber } from './proofSelection.ts'
import {
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { createDurableCustodyProofOperation } from './durableCustodyProofOperationRecord.ts'
import {
  addDurableWalletProofTransitionMetadata,
  assertDurableWalletProofResultMatchesPlan,
  createDurableWalletProofTransition,
} from './durableWalletProofTransition.ts'
import { classifyExactTokenImportKeysets } from './tokenImportValidation.ts'
import type {
  ClassifiedExactTokenImportKeyset,
  TokenImportKeysetActivity,
  TokenImportKeysetLookup,
  TokenImportKeysetSource,
} from './tokenImportValidation.ts'
import type { DurableWalletProofDerivationLocator } from './durableWalletProofDerivationLocator.ts'
import { assertCanonicalNut02V2KeysetId } from './durableSeedDerivedPolicy.ts'

export const DURABLE_CTF_RANGE_OPERATION_SCHEMA_VERSION = 3 as const
export const DURABLE_CTF_RANGE_OPERATION_METADATA_KEY = 'durableCtfRangeOperation'
export const DURABLE_CTF_RANGE_RESULT_BYTES_MAX = 256 * 1_024
export const CTF_RANGE_PRODUCT_UNIT = 'msat' as const
const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const DURABLE_CTF_RANGE_TEXT_BYTES_MAX = 1_024
const MAX_U64 = 18_446_744_073_709_551_615n

export function deriveRootCtfOutcomeCollectionId(input: {
  conditionId: string
  outcomeCollection: string
}): string {
  const conditionId = hexToBytes(requireHash(input.conditionId, 'condition id'))
  const outcomeCollection = new TextEncoder().encode(
    requireBoundedText(input.outcomeCollection, 'outcome collection'),
  )
  const tagHash = sha256(new TextEncoder().encode('Cashu_outcome_collection_id'))
  const message = concatenateBytes(tagHash, tagHash, conditionId, outcomeCollection)
  return hashToCurve(sha256(message)).toHex(true).slice(2)
}

export type DurableCtfRangeAsset =
  | { kind: 'regular'; unit: 'msat' }
  | {
      kind: 'conditional'
      unit: 'msat'
      conditionId: string
      outcomeCollection: string
    }

export interface DurableCtfRangeProof {
  id: string
  amount: string
  secret: string
  C: string
  dleq: unknown | null
  p2pkE: string | null
  witness: unknown | null
}

export interface DurableCtfRangeManifestEntry extends CtfPoolEntry {
  outputData: SerializedOutputData
}

export interface DurableCtfRangeKeysetAuthority {
  keysetId: string
  unit: 'msat'
  source: TokenImportKeysetSource
  activity: TokenImportKeysetActivity
  inputFeePpk: number
  finalExpiry: number | null
  conditionId: string | null
  outcomeCollection: string | null
  outcomeCollectionId: string | null
  denominationPublicKeys: Readonly<Record<string, string>> | null
  registeredAt: number | null
}

export interface DurableCtfRangeMintKeyset {
  canonicalMintUrl: string
  id: string
  unit: 'msat'
  keys: Readonly<Record<string, string>>
  inputFeePpk: number
  finalExpiry: number | null
}

export interface DurableCtfRangeExpiryObservation {
  canonicalMintUrl: string
  freshness: 'fresh' | 'stale'
  observedAt: number
  maxExpirySeconds: number
  conditionKeysetIds: readonly string[]
  conditionalKeysets: readonly {
    keysetId: string
    conditionId: string
    unit: unknown
    inputFeePpk: unknown
    finalExpiry?: unknown
    outcomeCollectionId: unknown
    outcomeCollection: unknown
    registeredAt: unknown
    keys: unknown
  }[]
}

export interface DurableCtfRangeExpiryAuthority {
  canonicalMintUrl: string
  observedAt: number
  maxExpirySeconds: number
  effectiveExpiryCeiling: number
  conditionKeysetIds: string[]
  conditionalKeysets: {
    keysetId: string
    conditionId: string
    finalExpiry: number | null
  }[]
}

export interface DurableCtfRangeOperation {
  schemaVersion: 3
  operationId: string
  sourceOperationId: string
  authorizationId: string
  mintUrl: string
  unit: 'msat'
  conditionId: string
  parentCollectionId: string
  coordinatorPublicKey: string
  offerKeysetId: string
  receiveKeysetId: string
  offerAsset: DurableCtfRangeAsset
  receiveAsset: DurableCtfRangeAsset
  keysetAuthority: {
    offer: DurableCtfRangeKeysetAuthority
    receive: DurableCtfRangeKeysetAuthority
  }
  expiryAuthority: DurableCtfRangeExpiryAuthority
  expiry: number
  policy: {
    rateN: string
    rateD: string
    minReceive: string
    maxDebit: string
  }
  refundKey: { privateKey: string; publicKey: string }
  inputFeePpkByKeyset: Readonly<Record<string, number>>
  inputs: DurableCtfRangeProof[]
  manifest: {
    commitment: string
    entries: DurableCtfRangeManifestEntry[]
  }
}

export interface CreateDurableCtfRangeOperationInput extends Omit<
  DurableCtfRangeOperation,
  | 'schemaVersion'
  | 'inputs'
  | 'manifest'
  | 'offerAsset'
  | 'receiveAsset'
  | 'keysetAuthority'
  | 'expiryAuthority'
> {
  inputs: readonly Proof[]
  manifest: CtfRangeManifestMaterial
  keysetLookup: TokenImportKeysetLookup
  expiryObservation: DurableCtfRangeExpiryObservation
  allowInsecureLoopbackHttp: boolean
}

export interface DurableCtfRangeSignature {
  id: string
  amount: string
  C_: string
  dleq: null | { e: string; s: string }
}

export interface DurableCtfRangeResultEnvelope {
  schemaVersion: 1
  operationId: string
  authorizationId: string
  requestDigest: string
  selection: string
  signatures: DurableCtfRangeSignature[]
}

export interface DurableCtfRangeRecoveredResult {
  operationId: string
  authorizationId: string
  selection: string
  receive: Proof[]
  change: Proof[]
}

export type DurableCtfRangeVerifiedResultSource = 'engine' | 'mint-recovery'

export function classifyDurableCtfRangeVerifiedResultArtifact(
  exactResult: DurableCustodyExactArtifact,
): DurableCtfRangeVerifiedResultSource {
  const value = exactResult.artifact
  if (!isRecord(value)) throw new Error('CTF range verified result artifact is invalid')
  switch (value.schemaVersion) {
    case 1:
      exactKeys(value, ['schemaVersion', 'envelope', 'proofs'])
      return 'engine'
    case 2:
      exactKeys(value, ['schemaVersion', 'source', 'selection', 'allManifestRecovery', 'proofs'])
      if (value.source !== 'mint-recovery') {
        throw new Error('CTF range verified result recovery source is invalid')
      }
      return 'mint-recovery'
    default:
      throw new Error('CTF range verified result artifact schema is invalid')
  }
}

export function deriveDurableCtfRangeSettledFaceAmount(
  operationInput: DurableCtfRangeOperation,
  result: DurableCtfRangeRecoveredResult,
): number {
  const operation = decodeDurableCtfRangeOperation(operationInput)
  if (
    result.operationId !== operation.operationId ||
    result.authorizationId !== operation.authorizationId
  ) {
    throw new Error('CTF range settled amount authority is foreign')
  }
  let amount: bigint
  if (operation.receiveAsset.kind === 'conditional') {
    amount = sumProofAmounts(result.receive)
  } else if (operation.offerAsset.kind === 'conditional') {
    amount = sumProofAmounts(operation.inputs) - sumProofAmounts(result.change)
  } else {
    throw new Error('CTF range operation has no conditional settlement leg')
  }
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('CTF range settled face amount is invalid')
  }
  return Number(amount)
}

export type DurableCtfRangeRecoveryDecision =
  | { kind: 'confirmed'; result: DurableCtfRangeRecoveredResult }
  | { kind: 'waiting' }
  | { kind: 'refundable' }
  | { kind: 'reconciling' }

export type DurableCtfRangeVerifiedResultPreparation =
  | {
      kind: 'confirmed'
      result: DurableCtfRangeRecoveredResult
      exactResult: DurableCustodyExactArtifact
      resultHandle: string
      resultFingerprint: string
      selectedSuccessorProofIds: string[]
    }
  | { kind: 'reconciling' }

export type DurableCtfRangeKeysetResolver = (
  canonicalMintUrl: string,
  keysetId: string,
) => HasKeysetKeys | undefined

export interface DurableCtfRangeRecoveryObservation {
  selection: string | null
  inputStates: ProofState[]
  queriedOutputs: SerializedBlindedMessage[]
  restoredOutputs: SerializedBlindedMessage[]
  signatures: SerializedBlindedSignature[]
  queryCompleted: boolean
  now: number
}

export interface DurableCtfRangeAllManifestRecovery {
  queriedOutputs: SerializedBlindedMessage[]
  restoredOutputs: SerializedBlindedMessage[]
  signatures: SerializedBlindedSignature[]
  queryCompleted: boolean
}

export interface DurableCtfRangeFeeBounds {
  weightPpk: bigint
  minimumFee: bigint
  maximumFee: bigint
}

export interface DurableCtfRangeCustodyBinding {
  record: DurableCustodyRecord
  operation: DurableCustodyProofOperationInput
  artifacts: {
    requestBody: DurableCustodyExactArtifact
    output: DurableCustodyExactArtifact
    privateMaterial: DurableCustodyExactArtifact
  }
}

export function createDurableCtfRangeOperation(
  input: CreateDurableCtfRangeOperationInput,
): DurableCtfRangeOperation {
  const expiryAuthority = createRangeExpiryAuthority(input)
  const keysetAuthority = classifyRangeKeysetAuthority(input)
  const {
    keysetLookup: _,
    expiryObservation: __,
    allowInsecureLoopbackHttp: ___,
    ...persistedInput
  } = input
  const operation: DurableCtfRangeOperation = {
    ...persistedInput,
    offerAsset: assetFromKeysetAuthority(keysetAuthority.offer),
    receiveAsset: assetFromKeysetAuthority(keysetAuthority.receive),
    keysetAuthority,
    expiryAuthority,
    schemaVersion: DURABLE_CTF_RANGE_OPERATION_SCHEMA_VERSION,
    inputs: input.inputs.map(serializeProof),
    manifest: {
      commitment: input.manifest.commitment,
      entries: input.manifest.entries.map(({ entry, outputData }) => ({
        ...entry,
        outputData: OutputData.serialize(outputData),
      })),
    },
  }
  return decodeDurableCtfRangeOperation(operation)
}

export function decodeDurableCtfRangeOperation(value: unknown): DurableCtfRangeOperation {
  const operation = requireRangeOperationShape(value)
  validateRangeIdentity(operation)
  validateRangeAssets(operation)
  validateRangeExpiryAuthority(operation)
  validateRangeManifest(operation)
  validateRangeInputs(operation)
  validateRangePolicyAuthority(operation)
  validateInputFeeAuthority(operation)
  deriveDurableCtfRangeFeeBounds(operation)
  encodeBoundedDurableArtifact(operation, 16 * 1_024 * 1_024)
  return structuredClone(operation)
}

export function toDurableCtfRangeProofOperationInput(
  value: DurableCtfRangeOperation,
): DurableCustodyProofOperationInput {
  return rangeProofOperationInput(decodeDurableCtfRangeOperation(value))
}

function rangeProofOperationInput(
  operation: DurableCtfRangeOperation,
): DurableCustodyProofOperationInput {
  const outputs = manifestOutputGroups(operation)
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['receive', 'change'],
    resultGroups: {
      receive: walletDisposition(operation.receiveAsset),
      change: walletDisposition(operation.offerAsset),
    },
    resultCardinality: { receive: 'subset', change: 'subset' },
  })
  return {
    operationId: operation.operationId,
    kind: 'ctf-range-authorization',
    mintUrl: operation.mintUrl,
    inputs: operation.inputs.map(toCustodyProof),
    outputs,
    metadata: addDurableWalletProofTransitionMetadata(
      {
        unit: operation.unit,
        [DURABLE_CTF_RANGE_OPERATION_METADATA_KEY]: operation,
      },
      policy,
    ),
  }
}

export function createDurableCtfRangeCustodyBinding(input: {
  scope: DurableCustodyScope
  operation: DurableCtfRangeOperation
  facts: DurableProofOperationFacts
  mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>
  inventoryAccountId: string | null
  parentReservationId?: string
  boundary: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    idempotencyKey: string
    requestBody: unknown
  }
}): DurableCtfRangeCustodyBinding {
  const operation = toDurableCtfRangeProofOperationInput(input.operation)
  assertRangeCustodyScopeAuthority(input.scope, input.operation)
  assertRangeKeysetVerificationAuthority(input.operation, input.facts)
  assertRangeMintKeysetAuthority(input.operation, input.mintKeysets, input.facts)
  assertRangeInputProofsCryptographicallyValid(input.operation, input.mintKeysets)
  const artifacts = {
    requestBody: exactArtifact(input.boundary.requestBody),
    output: exactArtifact(operation.outputs),
    privateMaterial: exactArtifact(input.operation),
  }
  const record = createDurableCustodyProofOperation({
    scope: input.scope,
    operation,
    facts: input.facts,
    inventoryAccountId: input.inventoryAccountId,
    parentReservationId: input.parentReservationId,
    exactBoundary: { ...input.boundary, ...artifacts },
  })
  return { record, operation, artifacts }
}

function assertRangeCustodyScopeAuthority(
  scope: DurableCustodyScope,
  operation: DurableCtfRangeOperation,
): void {
  if (scope.scopeKind === 'wallet') return
  const conditionalAssets = new Map<
    string,
    Extract<DurableCtfRangeAsset, { kind: 'conditional' }>
  >()
  for (const asset of [operation.offerAsset, operation.receiveAsset]) {
    if (asset.kind === 'conditional') {
      conditionalAssets.set(`${asset.conditionId}\0${asset.outcomeCollection}`, asset)
    }
  }
  if (conditionalAssets.size !== 1) {
    throw new Error('CTF range condition-inventory scope conditional asset is ambiguous')
  }
  const asset = conditionalAssets.values().next().value!
  if (scope.conditionId !== asset.conditionId) {
    throw new Error('CTF range condition-inventory scope does not match the conditional asset')
  }
}

export function requireDurableCtfRangeOperationFromCustody(
  value: DurableCustodyProofOperationInput,
): DurableCtfRangeOperation {
  const embedded = value.metadata?.[DURABLE_CTF_RANGE_OPERATION_METADATA_KEY]
  const operation = decodeDurableCtfRangeOperation(embedded)
  const expected = rangeProofOperationInput(operation)
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error('custody operation does not contain the exact persisted CTF range operation')
  }
  return operation
}

export function deriveDurableCtfRangeFeeBounds(
  value: DurableCtfRangeOperation,
): DurableCtfRangeFeeBounds {
  let weightPpk = 0n
  for (const proof of value.inputs) {
    const ppk = value.inputFeePpkByKeyset[proof.id]
    if (!Number.isSafeInteger(ppk) || ppk <= 0) {
      throw new Error(`CTF range input keyset ${proof.id} must have a positive input fee`)
    }
    weightPpk += BigInt(ppk)
  }
  return {
    weightPpk,
    minimumFee: weightPpk / 1_000n,
    maximumFee: (weightPpk + 999n) / 1_000n,
  }
}

export function createDurableCtfRangeResultEnvelope(input: {
  operation: DurableCtfRangeOperation
  requestDigest: string
  selection: string
  signatures: readonly SerializedBlindedSignature[]
}): DurableCtfRangeResultEnvelope {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  selectCtfManifestOutputs(serializedManifest(operation), input.selection)
  const envelope: DurableCtfRangeResultEnvelope = {
    schemaVersion: 1,
    operationId: operation.operationId,
    authorizationId: operation.authorizationId,
    requestDigest: requireHash(input.requestDigest, 'request digest'),
    selection: input.selection,
    signatures: input.signatures.map(serializeSignature),
  }
  return decodeDurableCtfRangeResultEnvelope(envelope)
}

export function decodeDurableCtfRangeResultEnvelope(value: unknown): DurableCtfRangeResultEnvelope {
  encodeBoundedDurableArtifact(value, DURABLE_CTF_RANGE_RESULT_BYTES_MAX)
  if (!isRecord(value)) throw new Error('CTF range result envelope is invalid')
  exactKeys(value, [
    'schemaVersion',
    'operationId',
    'authorizationId',
    'requestDigest',
    'selection',
    'signatures',
  ])
  if (value.schemaVersion !== 1) throw new Error('CTF range result schema is unsupported')
  requireBoundedText(value.operationId, 'operation id')
  requireBoundedText(value.authorizationId, 'authorization id')
  requireHash(value.requestDigest, 'request digest')
  requireSelection(value.selection)
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
  ) {
    throw new Error('CTF range signature limit exceeded')
  }
  value.signatures.forEach(decodeSignature)
  return structuredClone(value) as unknown as DurableCtfRangeResultEnvelope
}

export function decodeDurableCtfRangeResultEnvelopeBytes(
  value: Uint8Array,
): DurableCtfRangeResultEnvelope {
  if (value.byteLength > DURABLE_CTF_RANGE_RESULT_BYTES_MAX) {
    throw new Error('CTF range result envelope byte limit exceeded')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
  } catch (error) {
    throw new Error('CTF range result envelope encoding is invalid', { cause: error })
  }
  return decodeDurableCtfRangeResultEnvelope(decoded)
}

export function recoverDurableCtfRangeResult(
  operationValue: DurableCtfRangeOperation,
  envelopeValue: DurableCtfRangeResultEnvelope,
  record: DurableCustodyRecord,
  resolveKeyset: DurableCtfRangeKeysetResolver,
): DurableCtfRangeRecoveredResult {
  const operation = decodeDurableCtfRangeOperation(operationValue)
  const envelope = decodeDurableCtfRangeResultEnvelope(envelopeValue)
  assertDurableCtfRangeCustodyAuthority(record, operation)
  return recoverEngineVerifiedRangeResult(operation, envelope, record, resolveKeyset)
}

function recoverEngineVerifiedRangeResult(
  operation: DurableCtfRangeOperation,
  envelope: DurableCtfRangeResultEnvelope,
  record: DurableCustodyRecord,
  resolveKeyset: DurableCtfRangeKeysetResolver,
): DurableCtfRangeRecoveredResult {
  requireEnvelopeIdentity(operation, envelope)
  const material = manifestMaterial(operation)
  const selectedOutputs = selectCtfManifestOutputs(
    serializedManifest(operation),
    envelope.selection,
  )
  const envelopeSignatures = envelope.signatures.map(deserializeSignature)
  requireRangeSignatureAuthority(record, selectedOutputs, envelopeSignatures)
  const boundResolver = createBoundRangeKeysetResolver(record, operation, resolveKeyset)
  const proofs = recoverCtfRangeProofs(material, selectedOutputs, envelopeSignatures, boundResolver)
  const result = groupRecoveredProofs(operation, envelope.selection, selectedOutputs, proofs)
  assertRangeOwnerPolicy(operation, envelope.selection)
  return result
}

function recoverMintVerifiedRangeResult(
  operation: DurableCtfRangeOperation,
  expectedSelection: string,
  recoveryValue: DurableCtfRangeAllManifestRecovery,
  record: DurableCustodyRecord,
  resolveKeyset: DurableCtfRangeKeysetResolver,
): DurableCtfRangeRecoveredResult {
  const recovery = normalizeAllManifestRecovery(recoveryValue)
  if (!recovery.queryCompleted) throw new Error('complete all-manifest recovery is required')
  const material = manifestMaterial(operation)
  assertExactAllManifestQuery(material, recovery.queriedOutputs)
  const selection = deriveCtfRangeRecoverySelection(material, recovery.restoredOutputs)
  if (selection !== expectedSelection) {
    throw new Error('CTF range result selection is not complete')
  }
  const boundResolver = createBoundRangeKeysetResolver(record, operation, resolveKeyset)
  requireRangeSignatureAuthority(record, recovery.restoredOutputs, recovery.signatures)
  const proofs = recoverCtfRangeProofs(
    material,
    recovery.restoredOutputs,
    recovery.signatures,
    boundResolver,
  )
  const result = groupRecoveredProofs(operation, selection, recovery.restoredOutputs, proofs)
  assertRangeOwnerPolicy(operation, selection)
  return result
}

export function stageDurableCtfRangeVerifiedResult(input: {
  transaction: DurableCustodyTransaction
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  envelope: DurableCtfRangeResultEnvelope
  authorization: DurableCustodyOwnerAuthorization
  resolveKeyset: DurableCtfRangeKeysetResolver
}): DurableCtfRangeRecoveryDecision {
  const prepared = prepareDurableCtfRangeVerifiedResult(input)
  if (prepared.kind !== 'confirmed') return prepared
  input.transaction.stageVerifiedResult({
    operationId: input.record.operation.operationId,
    expectedRevision: input.record.revision,
    authorization: input.authorization,
    outputPlanFingerprint: input.record.operation.outputPlan.outputPlanFingerprint,
    resultHandle: prepared.resultHandle,
    resultFingerprint: prepared.resultFingerprint,
    exactResult: prepared.exactResult,
    selectedSuccessorProofIds: prepared.selectedSuccessorProofIds,
  })
  return { kind: 'confirmed', result: prepared.result }
}

export function prepareDurableCtfRangeVerifiedResult(input: {
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  envelope: DurableCtfRangeResultEnvelope
  resolveKeyset: DurableCtfRangeKeysetResolver
}): DurableCtfRangeVerifiedResultPreparation {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  const custody = rangeProofOperationInput(operation)
  assertDurableCtfRangeCustodyAuthority(input.record, operation)
  try {
    const envelope = decodeDurableCtfRangeResultEnvelope(input.envelope)
    const result = recoverEngineVerifiedRangeResult(
      operation,
      envelope,
      input.record,
      input.resolveKeyset,
    )
    const exactResult = exactArtifact({
      schemaVersion: 1,
      envelope,
      proofs: {
        receive: result.receive.map(serializeProof),
        change: result.change.map(serializeProof),
      },
    })
    return verifiedResultPreparation(input.record, custody, result, exactResult)
  } catch {
    return { kind: 'reconciling' }
  }
}

export function prepareDurableCtfRangeRecoveredResult(input: {
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  observation: DurableCtfRangeRecoveryObservation
  resolveKeyset: DurableCtfRangeKeysetResolver
}): DurableCtfRangeVerifiedResultPreparation {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  const custody = rangeProofOperationInput(operation)
  assertDurableCtfRangeCustodyAuthority(input.record, operation)
  try {
    const observation = normalizeRecoveryObservation(input.observation)
    const decision = classifyDurableCtfRangeRecovery({
      record: input.record,
      operation,
      observation,
      resolveKeyset: input.resolveKeyset,
    })
    if (decision.kind !== 'confirmed') return { kind: 'reconciling' }
    const exactResult = exactArtifact({
      schemaVersion: 2,
      source: 'mint-recovery',
      selection: decision.result.selection,
      allManifestRecovery: serializeAllManifestRecovery(observation),
      proofs: {
        receive: decision.result.receive.map(serializeProof),
        change: decision.result.change.map(serializeProof),
      },
    })
    return verifiedResultPreparation(input.record, custody, decision.result, exactResult)
  } catch {
    return { kind: 'reconciling' }
  }
}

function verifiedResultPreparation(
  record: DurableCustodyRecord,
  custody: DurableCustodyProofOperationInput,
  result: DurableCtfRangeRecoveredResult,
  exactResult: DurableCustodyExactArtifact,
): Extract<DurableCtfRangeVerifiedResultPreparation, { kind: 'confirmed' }> {
  return {
    kind: 'confirmed',
    result,
    exactResult,
    resultHandle: `ctf-range-result:${exactResult.fingerprint}`,
    resultFingerprint: exactResult.fingerprint,
    selectedSuccessorProofIds: selectedRangeSuccessorProofIds(record, custody, result),
  }
}

export function recoverDurableCtfRangeVerifiedResultArtifact(input: {
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  exactResult: DurableCustodyExactArtifact
  resolveKeyset: DurableCtfRangeKeysetResolver
}): DurableCtfRangeRecoveredResult {
  const record = decodeDurableCustodyRecord(input.record)
  const operation = decodeDurableCtfRangeOperation(input.operation)
  assertDurableCtfRangeCustodyAuthority(record, operation)
  const resultAuthority = record.operation.result
  if (
    (resultAuthority.state !== 'verified-staged' && resultAuthority.state !== 'applied') ||
    resultAuthority.exactResult === null
  ) {
    throw new Error('CTF range verified result is unavailable')
  }
  assertDurableCustodyArtifactMatchesReference(resultAuthority.exactResult, input.exactResult)
  const value = input.exactResult.artifact
  if (!isRecord(value)) throw new Error('CTF range verified result artifact is invalid')
  if (!isRecord(value.proofs)) {
    throw new Error('CTF range verified result artifact schema is invalid')
  }
  exactKeys(value.proofs, ['receive', 'change'])
  if (!Array.isArray(value.proofs.receive) || !Array.isArray(value.proofs.change)) {
    throw new Error('CTF range verified result proofs are invalid')
  }
  value.proofs.receive.forEach(decodeProof)
  value.proofs.change.forEach(decodeProof)
  let recovered: DurableCtfRangeRecoveredResult
  switch (classifyDurableCtfRangeVerifiedResultArtifact(input.exactResult)) {
    case 'engine':
      recovered = recoverEngineVerifiedRangeResult(
        operation,
        decodeDurableCtfRangeResultEnvelope(value.envelope),
        record,
        input.resolveKeyset,
      )
      break
    case 'mint-recovery':
      recovered = recoverMintVerifiedRangeResult(
        operation,
        requireBoundedText(value.selection, 'verified recovery selection'),
        normalizeAllManifestRecovery(
          value.allManifestRecovery as DurableCtfRangeAllManifestRecovery,
        ),
        record,
        input.resolveKeyset,
      )
      break
  }
  if (
    canonicalJson({
      receive: recovered.receive.map(serializeProof),
      change: recovered.change.map(serializeProof),
    }) !== canonicalJson(value.proofs)
  ) {
    throw new Error('CTF range verified result proofs are foreign')
  }
  return recovered
}

export function buildDurableCtfRangeRecoveryQuery(
  value: DurableCtfRangeOperation,
  selection: string | null,
) {
  const operation = decodeDurableCtfRangeOperation(value)
  return buildCtfRangeRecoveryQuery(
    manifestMaterial(operation),
    selection === null ? undefined : selection,
  )
}

export function classifyDurableCtfRangeRecovery(input: {
  operation: DurableCtfRangeOperation
  record: DurableCustodyRecord
  observation: DurableCtfRangeRecoveryObservation
  resolveKeyset: DurableCtfRangeKeysetResolver
}): DurableCtfRangeRecoveryDecision {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  assertDurableCtfRangeCustodyAuthority(input.record, operation)
  let observation: DurableCtfRangeRecoveryObservation
  try {
    observation = normalizeRecoveryObservation(input.observation)
  } catch {
    return { kind: 'reconciling' }
  }
  const material = manifestMaterial(operation)
  const query = buildCtfRangeRecoveryQuery(material)
  const expectedInputYs = operation.inputs.map(deriveInputY)
  let classification: ReturnType<typeof classifyCtfSettlementRecovery>
  try {
    classification = classifyCtfSettlementRecovery({
      inputStates: observation.inputStates,
      expectedInputYs,
      outputRecovery: {
        query,
        restoredOutputBs: observation.restoredOutputs.map(({ B_ }) => B_),
        queryCompleted: observation.queryCompleted,
      },
      now: observation.now,
      expiry: operation.expiry,
    })
  } catch {
    return { kind: 'reconciling' }
  }
  if (classification !== 'confirmed') return { kind: classification }
  try {
    const recovery: DurableCtfRangeAllManifestRecovery = observation
    assertExactAllManifestQuery(material, recovery.queriedOutputs)
    const selection = deriveCtfRangeRecoverySelection(material, recovery.restoredOutputs)
    if (observation.selection !== null && observation.selection !== selection) {
      return { kind: 'reconciling' }
    }
    const boundResolver = createBoundRangeKeysetResolver(
      input.record,
      operation,
      input.resolveKeyset,
    )
    requireRangeSignatureAuthority(input.record, recovery.restoredOutputs, recovery.signatures)
    const proofs = recoverCtfRangeProofs(
      material,
      recovery.restoredOutputs,
      recovery.signatures,
      boundResolver,
    )
    assertRangeOwnerPolicy(operation, selection)
    return {
      kind: 'confirmed',
      result: groupRecoveredProofs(operation, selection, recovery.restoredOutputs, proofs),
    }
  } catch {
    return { kind: 'reconciling' }
  }
}

export function createDurableCtfRangeRefundOperation(input: {
  operationId: string
  source: DurableCtfRangeOperation
  refundKeysetId: string
  resolveKeysetAsset: (id: string) => DurableCtfRangeAsset | undefined
  outputs: readonly SerializedOutputData[]
}): { operation: DurableCustodyProofOperationInput; request: SwapRequest } {
  const source = decodeDurableCtfRangeOperation(input.source)
  const refundAsset = input.resolveKeysetAsset(input.refundKeysetId)
  if (refundAsset === undefined) throw new Error('CTF range refund keyset is unclassified')
  assertSameAsset(source.offerAsset, refundAsset)
  const outputData = input.outputs.map((output) => OutputData.deserialize(output))
  assertRefundOutputs(source, input.refundKeysetId, outputData)
  const request = signPayToUnlockRefund(
    {
      inputs: source.inputs.map(deserializeProof),
      outputs: outputData.map(({ blindedMessage }) => blindedMessage),
    },
    source.refundKey.privateKey,
  )
  return {
    request,
    operation: refundProofOperation(input.operationId, source, refundAsset, outputData, request),
  }
}

export function deriveDurableCtfRangeRefundOperationId(rangeOperationId: string): string {
  const operationId = requireBoundedText(rangeOperationId, 'range operation id')
  const domain = new TextEncoder().encode('bitcaster/ctf-range-refund/v1\0')
  const identity = new TextEncoder().encode(operationId)
  return `ctf-range-refund:${bytesToHex(sha256(concatenateBytes(domain, identity)))}`
}

export function createDeterministicDurableCtfRangeRefundOutputs(input: {
  seed: Uint8Array
  source: DurableCtfRangeOperation
  refundOperationId: string
  amount: string | bigint | number
  keyset: { id: string; keys: Readonly<Record<string, string>> }
}): SerializedOutputData[] {
  return createDeterministicDurableCtfRangeRefundOutputsWithLocators(input).map(
    ({ output }) => output,
  )
}

/** Match each verified refund proof to its SDK-derived deterministic locator. */
export function matchDeterministicDurableCtfRangeRefundProofLocators(input: {
  readonly outputs: readonly DeterministicDurableCtfRangeRefundOutput[]
  readonly proofs: readonly Proof[]
}): readonly Extract<DurableWalletProofDerivationLocator, { kind: 'ctf-range-refund' }>[] {
  if (input.outputs.length === 0 || input.outputs.length !== input.proofs.length) {
    throw new Error('CTF range refund proof locator count is invalid')
  }
  const locatorsBySecret = new Map<string, DeterministicDurableCtfRangeRefundOutput['locator']>()
  for (const { output, locator } of input.outputs) {
    const secret = new TextDecoder().decode(OutputData.deserialize(output).secret)
    if (locatorsBySecret.has(secret))
      throw new Error('CTF range refund output secret is duplicated')
    locatorsBySecret.set(secret, locator)
  }
  const observed = new Set<string>()
  return input.proofs.map((proof) => {
    const locator = locatorsBySecret.get(proof.secret)
    if (locator === undefined || observed.has(proof.secret)) {
      throw new Error('CTF range refund proof is outside the deterministic output plan')
    }
    observed.add(proof.secret)
    return locator
  })
}

export interface DeterministicDurableCtfRangeRefundOutput {
  readonly output: SerializedOutputData
  readonly locator: Extract<DurableWalletProofDerivationLocator, { kind: 'ctf-range-refund' }>
}

export function createDeterministicDurableCtfRangeRefundOutputsWithLocators(input: {
  seed: Uint8Array
  source: DurableCtfRangeOperation
  refundOperationId: string
  amount: string | bigint | number
  keyset: { id: string; keys: Readonly<Record<string, string>> }
}): readonly DeterministicDurableCtfRangeRefundOutput[] {
  const source = decodeDurableCtfRangeOperation(input.source)
  const refundOperationId = requireBoundedText(input.refundOperationId, 'refund operation id')
  if (refundOperationId !== deriveDurableCtfRangeRefundOperationId(source.operationId)) {
    throw new Error('CTF range refund operation identity is foreign')
  }
  if (!(input.seed instanceof Uint8Array) || input.seed.length < 32 || input.seed.length > 64) {
    throw new Error('CTF range refund seed is invalid')
  }
  const identity = new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      rangeOperationId: source.operationId,
      authorizationId: source.authorizationId,
      refundOperationId,
      refundKeysetId: input.keyset.id,
    }),
  )
  const domain = new TextEncoder().encode('bitcaster/ctf-range-refund-output/v1\0')
  const outputSeed = hmac(sha256, input.seed, concatenateBytes(domain, identity))
  for (let attempt = 0; attempt < 128; attempt += 1) {
    let outputs: OutputData[]
    try {
      outputs = OutputData.createDeterministicData(
        Amount.from(input.amount),
        outputSeed,
        attempt * 256,
        input.keyset,
      )
    } catch {
      // Invalid scalar derivations are rare. The next disjoint counter page is deterministic.
      continue
    }
    return createRefundOutputLocators(
      outputs,
      outputSeed,
      input.keyset.id,
      attempt,
      source.operationId,
      source.authorizationId,
      refundOperationId,
    )
  }
  throw new Error('CTF range refund output derivation failed')
}

function createRefundOutputLocators(
  outputs: readonly OutputData[],
  outputSeed: Uint8Array,
  keysetId: string,
  attempt: number,
  rangeOperationId: string,
  authorizationId: string,
  refundOperationId: string,
): readonly DeterministicDurableCtfRangeRefundOutput[] {
  if (outputs.length === 0 || outputs.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX) {
    throw new Error('CTF range refund output limit is invalid')
  }
  return outputs.map((output, outputIndex) => {
    const counter = attempt * 256 + outputIndex
    const secret = bytesToHex(deriveSecretAndBlindingFactor(outputSeed, keysetId, counter).secret)
    if (new TextDecoder().decode(output.secret) !== secret) {
      throw new Error('CTF range refund output secret is invalid')
    }
    return Object.freeze({
      output: OutputData.serialize(output),
      locator: Object.freeze({
        schemaVersion: 1 as const,
        kind: 'ctf-range-refund' as const,
        rangeOperationId,
        authorizationId,
        refundOperationId,
        counter,
      }),
    })
  })
}

export function deriveDurableCtfRangeRefundRequestFingerprint(request: SwapRequest): string {
  const canonical = canonicalJson({
    inputs: request.inputs.map((proof) => ({
      id: proof.id,
      amount: amountToNumber(proof.amount).toString(),
      secret: proof.secret,
      C: proof.C,
      dleq: structuredClone(proof.dleq ?? null),
      p2pkE: proof.p2pk_e ?? null,
      witness: structuredClone(proof.witness ?? null),
    })),
    outputs: request.outputs.map((output) => ({
      id: output.id,
      amount: output.amount.toString(),
      B_: output.B_,
    })),
  })
  const domain = new TextEncoder().encode('bitcaster/ctf-range-refund-request/v1\0')
  return bytesToHex(sha256(concatenateBytes(domain, new TextEncoder().encode(canonical))))
}

function requireRangeOperationShape(value: unknown): DurableCtfRangeOperation {
  if (!isRecord(value)) throw new Error('durable CTF range operation is invalid')
  exactKeys(value, [
    'schemaVersion',
    'operationId',
    'sourceOperationId',
    'authorizationId',
    'mintUrl',
    'unit',
    'conditionId',
    'parentCollectionId',
    'coordinatorPublicKey',
    'offerKeysetId',
    'receiveKeysetId',
    'offerAsset',
    'receiveAsset',
    'keysetAuthority',
    'expiryAuthority',
    'expiry',
    'policy',
    'refundKey',
    'inputFeePpkByKeyset',
    'inputs',
    'manifest',
  ])
  if (value.schemaVersion !== DURABLE_CTF_RANGE_OPERATION_SCHEMA_VERSION) {
    throw new Error('durable CTF range schema is unsupported')
  }
  return value as unknown as DurableCtfRangeOperation
}

function validateRangeIdentity(value: DurableCtfRangeOperation): void {
  requireBoundedText(value.operationId, 'operation id')
  requireBoundedText(value.sourceOperationId, 'source operation id')
  requireBoundedText(value.authorizationId, 'authorization id')
  decodeCanonicalMintOrigin(value.mintUrl)
  if (value.unit !== CTF_RANGE_PRODUCT_UNIT) throw new Error('CTF range unit must be msat')
  requireHash(value.conditionId, 'condition id')
  if (value.parentCollectionId !== ROOT_PARENT_COLLECTION_ID) {
    throw new Error('nested CTF range conditions are unsupported')
  }
  requireXOnlyPublicKey(value.coordinatorPublicKey, 'CTF range coordinator public key')
  assertCanonicalNut02V2KeysetId(value.offerKeysetId, 'CTF range offer keyset id')
  assertCanonicalNut02V2KeysetId(value.receiveKeysetId, 'CTF range receive keyset id')
  if (!Number.isSafeInteger(value.expiry) || value.expiry < 0) {
    throw new Error('CTF range expiry is invalid')
  }
  decodePolicy(value.policy)
  decodeRefundKey(value.refundKey)
}

function validateRangeAssets(value: DurableCtfRangeOperation): void {
  decodeAsset(value.offerAsset, value.conditionId)
  decodeAsset(value.receiveAsset, value.conditionId)
  if (!isRecord(value.keysetAuthority)) {
    throw new Error('CTF range keyset authority is invalid')
  }
  exactKeys(value.keysetAuthority, ['offer', 'receive'])
  const offer = decodeRangeKeysetAuthority(
    value.keysetAuthority.offer,
    value.offerKeysetId,
    value.conditionId,
  )
  const receive = decodeRangeKeysetAuthority(
    value.keysetAuthority.receive,
    value.receiveKeysetId,
    value.conditionId,
  )
  if (
    canonicalJson(value.offerAsset) !== canonicalJson(assetFromKeysetAuthority(offer)) ||
    canonicalJson(value.receiveAsset) !== canonicalJson(assetFromKeysetAuthority(receive))
  ) {
    throw new Error('CTF range asset does not match its keyset authority')
  }
  if (canonicalJson(value.offerAsset) === canonicalJson(value.receiveAsset)) {
    throw new Error('CTF range offer and receive assets must differ')
  }
}

function createRangeExpiryAuthority(
  input: CreateDurableCtfRangeOperationInput,
): DurableCtfRangeExpiryAuthority {
  const observation = input.expiryObservation
  if (observation.freshness !== 'fresh') {
    throw new Error('CTF range condition expiry observation is stale')
  }
  const canonicalMintUrl = decodeCanonicalMintOrigin(observation.canonicalMintUrl)
  if (canonicalMintUrl !== input.mintUrl) {
    throw new Error('CTF range condition expiry observation is from a foreign mint')
  }
  const observedAt = requirePositiveSafeInteger(
    observation.observedAt,
    'condition expiry observation time',
  )
  const maxExpirySeconds = requirePositiveSafeInteger(
    observation.maxExpirySeconds,
    'condition maximum expiry',
  )
  const conditionKeysetIds = canonicalConditionKeysetIds(observation.conditionKeysetIds)
  verifyFreshConditionExpiryKeysets(observation.conditionalKeysets, input.conditionId)
  const conditionalKeysets = canonicalConditionExpiryKeysets(
    observation.conditionalKeysets.map(({ keysetId, conditionId, finalExpiry }) => ({
      keysetId,
      conditionId,
      ...(finalExpiry === undefined ? {} : { finalExpiry }),
    })),
    input.conditionId,
  )
  assertCompleteConditionExpiryObservation(conditionKeysetIds, conditionalKeysets)
  const effectiveExpiryCeiling = deriveConditionExpiryCeiling(
    observedAt,
    maxExpirySeconds,
    conditionalKeysets,
  )
  return {
    canonicalMintUrl,
    observedAt,
    maxExpirySeconds,
    effectiveExpiryCeiling,
    conditionKeysetIds,
    conditionalKeysets,
  }
}

function verifyFreshConditionExpiryKeysets(
  value: DurableCtfRangeExpiryObservation['conditionalKeysets'],
  conditionId: string,
): void {
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error('CTF range condition expiry keyset is invalid')
    exactKeysWithOptional(
      entry,
      [
        'keysetId',
        'conditionId',
        'unit',
        'inputFeePpk',
        'outcomeCollectionId',
        'outcomeCollection',
        'registeredAt',
        'keys',
      ],
      ['finalExpiry'],
    )
    const keysetId = requireConditionalKeysetId(entry.keysetId, 'condition expiry keyset id')
    if (
      requireHash(entry.conditionId, 'condition expiry condition') !== conditionId ||
      entry.unit !== CTF_RANGE_PRODUCT_UNIT
    ) {
      throw new Error('CTF range condition expiry keyset is foreign')
    }
    const inputFeePpk = requirePositiveSafeInteger(entry.inputFeePpk, 'condition keyset input fee')
    const finalExpiry = optionalPositiveSafeInteger(
      entry.finalExpiry,
      'condition keyset final expiry',
    )
    const outcomeCollectionId = requireHash(
      entry.outcomeCollectionId,
      'condition keyset outcome collection id',
    )
    const outcomeCollection = requireBoundedText(
      entry.outcomeCollection,
      'condition keyset outcome collection',
    )
    requireNonnegativeSafeInteger(entry.registeredAt, 'condition keyset registration')
    if (
      deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection }) !== outcomeCollectionId
    ) {
      throw new Error('CTF range condition expiry outcome collection is inconsistent')
    }
    const keys = requireRangeKeysetPublicKeys(entry.keys)
    if (
      deriveConditionalKeysetId({
        keys,
        input_fee_ppk: inputFeePpk,
        ...(finalExpiry === null ? {} : { final_expiry: finalExpiry }),
        unit: CTF_RANGE_PRODUCT_UNIT,
        conditionId,
        outcomeCollectionId,
      }) !== keysetId
    ) {
      throw new Error('CTF range condition expiry keyset identity is inconsistent')
    }
  }
}

function validateRangeExpiryAuthority(value: DurableCtfRangeOperation): void {
  const authority = decodeRangeExpiryAuthority(
    value.expiryAuthority,
    value.mintUrl,
    value.conditionId,
  )
  if (value.expiry <= authority.observedAt || value.expiry >= authority.effectiveExpiryCeiling) {
    throw new Error('CTF range expiry must precede the effective condition keyset ceiling')
  }
  const observed = new Map(
    authority.conditionalKeysets.map((keyset) => [keyset.keysetId, keyset.finalExpiry]),
  )
  for (const selected of [value.keysetAuthority.offer, value.keysetAuthority.receive]) {
    if (
      selected.source === 'conditional' &&
      (!observed.has(selected.keysetId) || observed.get(selected.keysetId) !== selected.finalExpiry)
    ) {
      throw new Error('CTF range selected keyset expiry differs from condition authority')
    }
  }
}

function decodeRangeExpiryAuthority(
  value: unknown,
  mintUrl: string,
  conditionId: string,
): DurableCtfRangeExpiryAuthority {
  if (!isRecord(value)) throw new Error('CTF range expiry authority is invalid')
  exactKeys(value, [
    'canonicalMintUrl',
    'observedAt',
    'maxExpirySeconds',
    'effectiveExpiryCeiling',
    'conditionKeysetIds',
    'conditionalKeysets',
  ])
  if (decodeCanonicalMintOrigin(value.canonicalMintUrl) !== mintUrl) {
    throw new Error('CTF range persisted expiry authority is from a foreign mint')
  }
  const observedAt = requirePositiveSafeInteger(value.observedAt, 'persisted observation time')
  const maxExpirySeconds = requirePositiveSafeInteger(
    value.maxExpirySeconds,
    'persisted maximum expiry',
  )
  const conditionKeysetIds = canonicalConditionKeysetIds(value.conditionKeysetIds)
  if (canonicalJson(conditionKeysetIds) !== canonicalJson(value.conditionKeysetIds)) {
    throw new Error('CTF range persisted condition keysets are not canonical')
  }
  const conditionalKeysets = canonicalConditionExpiryKeysets(value.conditionalKeysets, conditionId)
  if (canonicalJson(conditionalKeysets) !== canonicalJson(value.conditionalKeysets)) {
    throw new Error('CTF range persisted condition expiry keysets are not canonical')
  }
  assertCompleteConditionExpiryObservation(conditionKeysetIds, conditionalKeysets)
  const effectiveExpiryCeiling = deriveConditionExpiryCeiling(
    observedAt,
    maxExpirySeconds,
    conditionalKeysets,
  )
  if (value.effectiveExpiryCeiling !== effectiveExpiryCeiling) {
    throw new Error('CTF range persisted effective expiry ceiling is inconsistent')
  }
  return value as unknown as DurableCtfRangeExpiryAuthority
}

function canonicalConditionKeysetIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
  ) {
    throw new Error('CTF range condition keyset count is invalid')
  }
  const ids = value.map((id) => requireConditionalKeysetId(id, 'condition keyset id'))
  if (new Set(ids).size !== ids.length) {
    throw new Error('CTF range condition keysets contain a duplicate')
  }
  return [...ids].sort(compareCanonicalText)
}

function canonicalConditionExpiryKeysets(
  value: unknown,
  conditionId: string,
): DurableCtfRangeExpiryAuthority['conditionalKeysets'] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
  ) {
    throw new Error('CTF range condition expiry keyset count is invalid')
  }
  const keysets = value.map((entry) => {
    if (!isRecord(entry)) throw new Error('CTF range condition expiry keyset is invalid')
    exactKeysWithOptional(entry, ['keysetId', 'conditionId'], ['finalExpiry'])
    const keysetId = requireConditionalKeysetId(entry.keysetId, 'condition expiry keyset id')
    if (requireHash(entry.conditionId, 'condition expiry condition') !== conditionId) {
      throw new Error('CTF range condition expiry keyset is foreign')
    }
    return {
      keysetId,
      conditionId,
      finalExpiry: optionalPositiveSafeInteger(entry.finalExpiry, 'condition keyset final expiry'),
    }
  })
  if (new Set(keysets.map(({ keysetId }) => keysetId)).size !== keysets.length) {
    throw new Error('CTF range condition expiry keysets contain a duplicate')
  }
  return keysets.sort((left, right) => compareCanonicalText(left.keysetId, right.keysetId))
}

function assertCompleteConditionExpiryObservation(
  conditionKeysetIds: readonly string[],
  conditionalKeysets: DurableCtfRangeExpiryAuthority['conditionalKeysets'],
): void {
  if (
    conditionKeysetIds.length !== conditionalKeysets.length ||
    conditionKeysetIds.some((keysetId, index) => keysetId !== conditionalKeysets[index]?.keysetId)
  ) {
    throw new Error('complete CTF range condition keyset expiry authority is required')
  }
}

function deriveConditionExpiryCeiling(
  observedAt: number,
  maxExpirySeconds: number,
  keysets: DurableCtfRangeExpiryAuthority['conditionalKeysets'],
): number {
  const fallback = observedAt + maxExpirySeconds
  if (!Number.isSafeInteger(fallback)) {
    throw new Error('CTF range condition expiry ceiling exceeds the safe integer range')
  }
  const explicit = keysets
    .flatMap(({ finalExpiry }) => (finalExpiry === null ? [] : [finalExpiry]))
    .sort((left, right) => left - right)
  const earliestExplicit = explicit[0]
  return earliestExplicit === undefined ? fallback : Math.min(earliestExplicit, fallback)
}

function validateRangeManifest(value: DurableCtfRangeOperation): void {
  if (
    !isRecord(value.manifest) ||
    !Array.isArray(value.manifest.entries) ||
    value.manifest.entries.length < 2 ||
    value.manifest.entries.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
  ) {
    throw new Error('CTF range manifest entry limit is invalid')
  }
  const entries = value.manifest.entries.map(decodeManifestEntry)
  if (computeCtfManifestCommitment(entries) !== value.manifest.commitment) {
    throw new Error('CTF range manifest commitment is invalid')
  }
  if (
    entries.some(
      (entry) =>
        (entry.role === 'receive' && entry.id !== value.receiveKeysetId) ||
        (entry.role === 'change' && entry.id !== value.offerKeysetId),
    )
  ) {
    throw new Error('CTF range manifest role keyset is invalid')
  }
}

function validateRangeInputs(value: DurableCtfRangeOperation): void {
  if (
    !Array.isArray(value.inputs) ||
    value.inputs.length === 0 ||
    value.inputs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    new Set(value.inputs.map(({ secret }) => secret)).size !== value.inputs.length
  ) {
    throw new Error('CTF range input proof limit or uniqueness is invalid')
  }
  value.inputs.forEach((proof) => {
    decodeProof(proof)
    const condition = parseCtfPayToUnlockCondition(proof.secret)
    if (
      proof.id !== value.offerKeysetId ||
      condition.offerKeyset !== value.offerKeysetId ||
      condition.data !== value.manifest.commitment ||
      condition.expiry !== BigInt(value.expiry) ||
      condition.refund !== value.refundKey.publicKey ||
      condition.coordinatorPublicKey !== value.coordinatorPublicKey ||
      condition.mode.kind !== 'pool' ||
      canonicalPolicy(condition.mode.policy) !== canonicalJson(value.policy)
    ) {
      throw new Error('CTF range input authority does not match its manifest')
    }
  })
}

function validateInputFeeAuthority(value: DurableCtfRangeOperation): void {
  if (!isRecord(value.inputFeePpkByKeyset)) {
    throw new Error('CTF range input fee authority is invalid')
  }
  const used = [...new Set(value.inputs.map(({ id }) => id))].sort()
  const supplied = Object.keys(value.inputFeePpkByKeyset).sort()
  if (
    used.length !== supplied.length ||
    used.some((keysetId, index) => keysetId !== supplied[index]) ||
    value.inputFeePpkByKeyset[value.offerKeysetId] !== value.keysetAuthority.offer.inputFeePpk
  ) {
    throw new Error('CTF range input fee authority does not match the mint keyset')
  }
}

function validateRangePolicyAuthority(value: DurableCtfRangeOperation): void {
  const inputTotal = value.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)
  if (BigInt(value.policy.maxDebit) > inputTotal) {
    throw new Error('CTF range maximum debit exceeds its exact input authority')
  }
}

function decodeManifestEntry(value: unknown): CtfPoolEntry {
  if (!isRecord(value)) throw new Error('CTF range manifest entry is invalid')
  exactKeys(value, ['index', 'role', 'amount', 'id', 'B_', 'outputData'])
  if (!isRecord(value.outputData) || !isRecord(value.outputData.blindedMessage)) {
    throw new Error('CTF range output data is invalid')
  }
  const id = requireCtfRangeV2KeysetId(value.id, 'manifest keyset id')
  const output = OutputData.deserialize(value.outputData as unknown as SerializedOutputData)
  if (
    output.blindedMessage.amount.toString() !== value.amount ||
    output.blindedMessage.id !== value.id ||
    output.blindedMessage.B_ !== value.B_
  ) {
    throw new Error('CTF range manifest output material is inconsistent')
  }
  return {
    index: requireText(value.index, 'manifest index'),
    role: requireRole(value.role),
    amount: requireUnsigned(value.amount, 'manifest amount', false),
    id,
    B_: requireText(value.B_, 'manifest blinded message'),
  }
}

function decodeProof(value: unknown): asserts value is DurableCtfRangeProof {
  if (!isRecord(value)) throw new Error('CTF range proof is invalid')
  exactKeys(value, ['id', 'amount', 'secret', 'C', 'dleq', 'p2pkE', 'witness'])
  requireCtfRangeV2KeysetId(value.id, 'proof keyset id')
  requireUnsigned(value.amount, 'proof amount', false)
  requireText(value.secret, 'proof secret')
  requireText(value.C, 'proof signature')
  if (value.dleq !== null) decodeProofDleq(value.dleq)
  if (value.p2pkE !== null) requireText(value.p2pkE, 'proof p2pk value')
  if (value.witness !== null) decodeProofWitness(value.witness)
}

function decodeProofDleq(value: unknown): void {
  if (!isRecord(value)) throw new Error('CTF range proof DLEQ is invalid')
  const keys = Object.keys(value)
  if (
    keys.some((key) => key !== 'e' && key !== 's' && key !== 'r') ||
    !keys.includes('e') ||
    !keys.includes('s')
  ) {
    throw new Error('CTF range proof DLEQ is invalid')
  }
  requireText(value.e, 'proof DLEQ e')
  requireText(value.s, 'proof DLEQ s')
  if (value.r !== undefined) requireText(value.r, 'proof DLEQ r')
}

function decodeProofWitness(value: unknown): void {
  if (typeof value === 'string') {
    requireText(value, 'proof witness')
    return
  }
  if (!isRecord(value)) throw new Error('CTF range proof witness is invalid')
  exactKeys(value, ['signatures'])
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length === 0 ||
    value.signatures.length > 16
  ) {
    throw new Error('CTF range proof witness is invalid')
  }
  value.signatures.forEach((signature) => requireText(signature, 'proof witness signature'))
}

function decodePolicy(value: unknown): void {
  if (!isRecord(value)) throw new Error('CTF range policy is invalid')
  exactKeys(value, ['rateN', 'rateD', 'minReceive', 'maxDebit'])
  requireUnsigned(value.rateN, 'rate numerator', false)
  requireUnsigned(value.rateD, 'rate denominator', false)
  requireUnsigned(value.minReceive, 'minimum receive', true)
  requireUnsigned(value.maxDebit, 'maximum debit', false)
}

function decodeRefundKey(value: unknown): void {
  if (!isRecord(value)) throw new Error('CTF range refund key is invalid')
  exactKeys(value, ['privateKey', 'publicKey'])
  if (
    typeof value.privateKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.privateKey) ||
    typeof value.publicKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.publicKey)
  ) {
    throw new Error('CTF range refund key is invalid')
  }
  const derived = bytesToXOnlyPublicKey(value.privateKey)
  if (derived !== value.publicKey) throw new Error('CTF range refund key pair is inconsistent')
}

function decodeAsset(value: unknown, conditionId: string): asserts value is DurableCtfRangeAsset {
  if (!isRecord(value)) throw new Error('CTF range asset is invalid')
  if (value.kind === 'regular') {
    exactKeys(value, ['kind', 'unit'])
  } else if (value.kind === 'conditional') {
    exactKeys(value, ['kind', 'unit', 'conditionId', 'outcomeCollection'])
    if (value.conditionId !== conditionId) throw new Error('CTF range asset condition is foreign')
    requireBoundedText(value.outcomeCollection, 'outcome collection')
  } else {
    throw new Error('CTF range asset kind is invalid')
  }
  if (value.unit !== CTF_RANGE_PRODUCT_UNIT) throw new Error('CTF range asset unit must be msat')
}

function classifyRangeKeysetAuthority(
  input: CreateDurableCtfRangeOperationInput,
): DurableCtfRangeOperation['keysetAuthority'] {
  if (input.offerKeysetId === input.receiveKeysetId) {
    throw new Error('CTF range offer and receive keysets must differ')
  }
  const [offer, receive] = classifyExactTokenImportKeysets({
    lookup: input.keysetLookup,
    canonicalMintUrl: input.mintUrl,
    keysetIds: [input.offerKeysetId, input.receiveKeysetId],
    unit: CTF_RANGE_PRODUCT_UNIT,
    maxCandidates: DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
    allowInsecureLoopbackHttp: input.allowInsecureLoopbackHttp,
  })
  return {
    offer: rangeKeysetAuthority(offer!, 'offer', input.conditionId, input.expiryObservation),
    receive: rangeKeysetAuthority(receive!, 'receive', input.conditionId, input.expiryObservation),
  }
}

function rangeKeysetAuthority(
  value: ClassifiedExactTokenImportKeyset,
  role: 'offer' | 'receive',
  conditionId: string,
  observation: DurableCtfRangeExpiryObservation,
): DurableCtfRangeKeysetAuthority {
  if (value.activity !== 'active') throw new Error(`CTF range ${role} keyset is inactive`)
  const inputFeePpk = requirePositiveSafeInteger(
    value.inputFeePpk,
    `CTF range ${role} keyset input fee`,
  )
  const finalExpiry = optionalPositiveSafeInteger(
    value.finalExpiry,
    `CTF range ${role} keyset final expiry`,
  )
  if (value.source === 'regular') {
    if (
      value.conditionId !== undefined ||
      value.outcomeCollection !== undefined ||
      value.outcomeCollectionId !== undefined
    ) {
      throw new Error('CTF range regular keyset has conditional metadata')
    }
    return {
      keysetId: value.keysetId,
      unit: CTF_RANGE_PRODUCT_UNIT,
      source: value.source,
      activity: value.activity,
      inputFeePpk,
      finalExpiry,
      conditionId: null,
      outcomeCollection: null,
      outcomeCollectionId: null,
      denominationPublicKeys: null,
      registeredAt: null,
    }
  }
  if (requireHash(value.conditionId, 'conditional keyset condition') !== conditionId) {
    throw new Error('CTF range conditional keyset condition is foreign')
  }
  const outcomeCollection = requireBoundedText(
    value.outcomeCollection,
    'conditional keyset outcome collection',
  )
  const outcomeCollectionId = requireHash(
    value.outcomeCollectionId,
    'conditional keyset outcome collection id',
  )
  if (
    deriveRootCtfOutcomeCollectionId({
      conditionId,
      outcomeCollection,
    }) !== outcomeCollectionId
  ) {
    throw new Error('CTF range conditional keyset outcome collection id is inconsistent')
  }
  const matching = observation.conditionalKeysets.filter(
    (entry) => entry.keysetId === value.keysetId,
  )
  if (matching.length !== 1)
    throw new Error('CTF range conditional keyset observation is incomplete')
  const observed = matching[0]!
  if (
    observed.conditionId !== conditionId ||
    observed.outcomeCollection !== outcomeCollection ||
    observed.outcomeCollectionId !== outcomeCollectionId ||
    observed.inputFeePpk !== inputFeePpk ||
    optionalPositiveSafeInteger(observed.finalExpiry, 'observed conditional keyset expiry') !==
      finalExpiry
  )
    throw new Error('CTF range conditional keyset observation is foreign')
  return {
    keysetId: value.keysetId,
    unit: CTF_RANGE_PRODUCT_UNIT,
    source: value.source,
    activity: value.activity,
    inputFeePpk,
    finalExpiry,
    conditionId,
    outcomeCollection,
    outcomeCollectionId,
    denominationPublicKeys: requireRangeKeysetPublicKeys(observed.keys),
    registeredAt: requireNonnegativeSafeInteger(
      observed.registeredAt,
      'conditional keyset registration',
    ),
  }
}

function decodeRangeKeysetAuthority(
  value: unknown,
  keysetId: string,
  conditionId: string,
): DurableCtfRangeKeysetAuthority {
  if (!isRecord(value)) throw new Error('CTF range persisted keyset authority is invalid')
  exactKeys(value, [
    'keysetId',
    'unit',
    'source',
    'activity',
    'inputFeePpk',
    'finalExpiry',
    'conditionId',
    'outcomeCollection',
    'outcomeCollectionId',
    'denominationPublicKeys',
    'registeredAt',
  ])
  if (value.keysetId !== keysetId || value.unit !== CTF_RANGE_PRODUCT_UNIT) {
    throw new Error('CTF range persisted keyset authority is foreign')
  }
  if (value.source !== 'regular' && value.source !== 'conditional') {
    throw new Error('CTF range persisted keyset source is invalid')
  }
  if (value.activity !== 'active') {
    throw new Error('CTF range persisted keyset was not active when authorized')
  }
  requirePositiveSafeInteger(value.inputFeePpk, 'persisted keyset input fee')
  optionalPositiveSafeInteger(value.finalExpiry, 'persisted keyset final expiry')
  if (value.source === 'regular') {
    if (
      value.conditionId !== null ||
      value.outcomeCollection !== null ||
      value.outcomeCollectionId !== null ||
      value.denominationPublicKeys !== null ||
      value.registeredAt !== null
    ) {
      throw new Error('CTF range regular keyset has conditional metadata')
    }
    return {
      keysetId,
      unit: CTF_RANGE_PRODUCT_UNIT,
      source: 'regular',
      activity: 'active',
      inputFeePpk: requirePositiveSafeInteger(value.inputFeePpk, 'persisted keyset input fee'),
      finalExpiry: optionalPositiveSafeInteger(value.finalExpiry, 'persisted keyset final expiry'),
      conditionId: null,
      outcomeCollection: null,
      outcomeCollectionId: null,
      denominationPublicKeys: null,
      registeredAt: null,
    }
  }
  if (requireHash(value.conditionId, 'persisted keyset condition') !== conditionId) {
    throw new Error('CTF range conditional keyset authority is foreign')
  }
  const outcomeCollection = requireBoundedText(
    value.outcomeCollection,
    'persisted keyset outcome collection',
  )
  const outcomeCollectionId = requireHash(
    value.outcomeCollectionId,
    'persisted keyset outcome collection id',
  )
  if (
    deriveRootCtfOutcomeCollectionId({
      conditionId,
      outcomeCollection,
    }) !== outcomeCollectionId
  ) {
    throw new Error('CTF range persisted conditional keyset authority is inconsistent')
  }
  const keys = requireRangeKeysetPublicKeys(value.denominationPublicKeys)
  const inputFeePpk = requirePositiveSafeInteger(value.inputFeePpk, 'persisted keyset input fee')
  const finalExpiry = optionalPositiveSafeInteger(
    value.finalExpiry,
    'persisted keyset final expiry',
  )
  const registeredAt = requireNonnegativeSafeInteger(
    value.registeredAt,
    'persisted conditional keyset registration',
  )
  if (finalExpiry !== null && finalExpiry <= registeredAt) {
    throw new Error('CTF range conditional keyset expiry precedes registration')
  }
  if (
    deriveConditionalKeysetId({
      keys,
      input_fee_ppk: inputFeePpk,
      ...(finalExpiry === null ? {} : { final_expiry: finalExpiry }),
      unit: CTF_RANGE_PRODUCT_UNIT,
      conditionId,
      outcomeCollectionId,
    }) !== keysetId
  ) {
    throw new Error('CTF range persisted conditional keyset identity is inconsistent')
  }
  return {
    keysetId,
    unit: CTF_RANGE_PRODUCT_UNIT,
    source: 'conditional',
    activity: 'active',
    inputFeePpk,
    finalExpiry,
    conditionId,
    outcomeCollection,
    outcomeCollectionId,
    denominationPublicKeys: keys,
    registeredAt,
  }
}

function assetFromKeysetAuthority(authority: DurableCtfRangeKeysetAuthority): DurableCtfRangeAsset {
  if (authority.source === 'regular') return { kind: 'regular', unit: CTF_RANGE_PRODUCT_UNIT }
  if (authority.conditionId === null || authority.outcomeCollection === null) {
    throw new Error('CTF range conditional keyset authority is incomplete')
  }
  return {
    kind: 'conditional',
    unit: CTF_RANGE_PRODUCT_UNIT,
    conditionId: authority.conditionId,
    outcomeCollection: authority.outcomeCollection,
  }
}

function manifestOutputGroups(operation: DurableCtfRangeOperation) {
  return {
    receive: operation.manifest.entries
      .filter(({ role }) => role === 'receive')
      .map(({ outputData }) => toCustodyOutput(outputData)),
    change: operation.manifest.entries
      .filter(({ role }) => role === 'change')
      .map(({ outputData }) => toCustodyOutput(outputData)),
  }
}

function manifestMaterial(operation: DurableCtfRangeOperation) {
  return operation.manifest.entries.map((value) => ({
    entry: {
      index: value.index,
      role: value.role,
      amount: value.amount,
      id: value.id,
      B_: value.B_,
    },
    outputData: OutputData.deserialize(value.outputData),
  }))
}

function serializedManifest(operation: DurableCtfRangeOperation): CtfPoolEntry[] {
  return operation.manifest.entries.map(({ outputData: _, ...entry }) => entry)
}

function groupRecoveredProofs(
  operation: DurableCtfRangeOperation,
  selection: string,
  restoredOutputs: SerializedBlindedMessage[],
  proofs: Proof[],
): DurableCtfRangeRecoveredResult {
  const indices = parseCtfSelectionBitmap(selection, operation.manifest.entries.length)
  if (indices.length !== proofs.length || restoredOutputs.length !== proofs.length) {
    throw new Error('CTF range result count is invalid')
  }
  const selected = new Set(indices)
  const manifestIndices = new Map(operation.manifest.entries.map(({ B_ }, index) => [B_, index]))
  const ordered = restoredOutputs
    .map(({ B_ }, proofIndex) => {
      const manifestIndex = manifestIndices.get(B_)
      if (manifestIndex === undefined || !selected.has(manifestIndex)) {
        throw new Error('CTF range restored proof is outside the selected manifest')
      }
      return { manifestIndex, proof: proofs[proofIndex]! }
    })
    .sort((left, right) => left.manifestIndex - right.manifestIndex)
  if (new Set(ordered.map(({ manifestIndex }) => manifestIndex)).size !== ordered.length) {
    throw new Error('CTF range restored proof is duplicated')
  }
  const result: DurableCtfRangeRecoveredResult = {
    operationId: operation.operationId,
    authorizationId: operation.authorizationId,
    selection,
    receive: [],
    change: [],
  }
  for (const { manifestIndex, proof } of ordered) {
    result[operation.manifest.entries[manifestIndex]!.role].push(proof)
  }
  const custody = rangeProofOperationInput(operation)
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['receive', 'change'],
    resultGroups: {
      receive: walletDisposition(operation.receiveAsset),
      change: walletDisposition(operation.offerAsset),
    },
    resultCardinality: { receive: 'subset', change: 'subset' },
  })
  assertDurableWalletProofResultMatchesPlan(policy, custody.outputs, {
    receive: result.receive,
    change: result.change,
  })
  return result
}

function assertRefundOutputs(
  operation: DurableCtfRangeOperation,
  refundKeysetId: string,
  outputs: OutputData[],
): void {
  if (outputs.length === 0 || outputs.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX) {
    throw new Error('CTF range refund output limit is invalid')
  }
  if (outputs.some(({ blindedMessage }) => blindedMessage.id !== refundKeysetId)) {
    throw new Error('CTF range refund output keyset is invalid')
  }
  const inputTotal = operation.inputs.reduce((sum, proof) => sum + BigInt(proof.amount), 0n)
  const outputTotal = outputs.reduce(
    (sum, output) => sum + output.blindedMessage.amount.toBigInt(),
    0n,
  )
  if (outputTotal !== inputTotal - deriveDurableCtfRangeFeeBounds(operation).maximumFee) {
    throw new Error('CTF range refund amount does not pay the exact input fee')
  }
}

function refundProofOperation(
  operationId: string,
  source: DurableCtfRangeOperation,
  asset: DurableCtfRangeAsset,
  outputs: OutputData[],
  request: SwapRequest,
): DurableCustodyProofOperationInput {
  requireText(operationId, 'refund operation id')
  const transition = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['refund'],
    resultGroups: { refund: walletDisposition(asset) },
  })
  return {
    operationId,
    kind: 'ctf-range-refund',
    mintUrl: source.mintUrl,
    inputs: request.inputs.map((proof) => toCustodyProof(serializeProof(proof))),
    outputs: { refund: outputs.map(serializeDurableCustodyOutput) },
    metadata: addDurableWalletProofTransitionMetadata(
      { unit: source.unit, predecessorOperationId: source.operationId },
      transition,
    ),
  }
}

function requireEnvelopeIdentity(
  operation: DurableCtfRangeOperation,
  envelope: DurableCtfRangeResultEnvelope,
): void {
  if (
    envelope.operationId !== operation.operationId ||
    envelope.authorizationId !== operation.authorizationId
  ) {
    throw new Error('CTF range result envelope is foreign')
  }
}

function assertRangeKeysetVerificationAuthority(
  operation: DurableCtfRangeOperation,
  facts: DurableProofOperationFacts,
): void {
  if (
    facts.unit !== operation.unit ||
    facts.binding.kind !== 'wallet' ||
    facts.binding.activityId !== operation.operationId ||
    facts.binding.stage !== 'send'
  ) {
    throw new Error('CTF range custody binding authority is foreign')
  }
  const expectedInputs = expectedRangeKeysets(operation.inputs.map(({ id }) => id))
  const expectedOutputs = expectedRangeKeysets(operation.manifest.entries.map(({ id }) => id))
  const inputKeysets = canonicalKeysetUses(
    facts.verification.inputKeysets,
    'CTF range input keyset authority',
  )
  const outputKeysets = canonicalKeysetUses(
    facts.verification.outputKeysets,
    'CTF range output keyset authority',
  )
  assertExactKeysetUses(inputKeysets, expectedInputs, 'CTF range input keyset authority')
  assertExactKeysetUses(outputKeysets, expectedOutputs, 'CTF range output keyset authority')
  const expectedBindings = new Map([...expectedInputs, ...expectedOutputs])
  const bindings = canonicalKeysetBindings(facts.verification.keysetBindings)
  if (bindings.size !== expectedBindings.size) {
    throw new Error('CTF range keyset binding authority is incomplete')
  }
  for (const [keysetId, expectedCurve] of expectedBindings) {
    const binding = bindings.get(keysetId)
    if (
      binding === undefined ||
      binding.curve !== expectedCurve ||
      (binding.curve === 'secp256k1' && !binding.requireDleq)
    ) {
      throw new Error('CTF range verification authority is unsafe: keyset binding')
    }
  }
}

function expectedRangeKeysets(ids: readonly string[]) {
  const expected = new Map<string, 'secp256k1'>()
  for (const id of ids) {
    requireCtfRangeV2KeysetId(id, 'CTF range verification keyset id')
    const canonicalId = canonicalDurableCustodyKeysetIdentity(id)
    const curve = 'secp256k1' as const
    const existing = expected.get(canonicalId)
    if (existing !== undefined && existing !== curve) {
      throw new Error('CTF range keyset curve authority is inconsistent')
    }
    expected.set(canonicalId, curve)
  }
  return expected
}

function canonicalKeysetUses(
  uses: DurableProofOperationFacts['verification']['inputKeysets'],
  error: string,
) {
  const result = new Map<string, 'secp256k1' | 'bls12-381'>()
  for (const use of uses) {
    requireCtfRangeV2KeysetId(use.keysetId, `${error} keyset id`)
    const keysetId = canonicalDurableCustodyKeysetIdentity(use.keysetId)
    if (result.has(keysetId)) throw new Error(`${error} is duplicated`)
    result.set(keysetId, use.curve)
  }
  return result
}

function canonicalKeysetBindings(
  bindings: DurableProofOperationFacts['verification']['keysetBindings'],
) {
  const result = new Map<string, (typeof bindings)[number]>()
  for (const binding of bindings) {
    requireCtfRangeV2KeysetId(binding.keysetId, 'CTF range keyset binding authority keyset id')
    const keysetId = canonicalDurableCustodyKeysetIdentity(binding.keysetId)
    if (result.has(keysetId)) {
      throw new Error('CTF range keyset binding authority is duplicated')
    }
    result.set(keysetId, binding)
  }
  return result
}

function assertExactKeysetUses(
  actual: ReadonlyMap<string, 'secp256k1' | 'bls12-381'>,
  expected: ReadonlyMap<string, 'secp256k1' | 'bls12-381'>,
  error: string,
): void {
  if (
    actual.size !== expected.size ||
    [...expected].some(([keysetId, curve]) => actual.get(keysetId) !== curve)
  ) {
    throw new Error(`${error} is incomplete`)
  }
}

function assertRangeMintKeysetAuthority(
  operation: DurableCtfRangeOperation,
  mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>,
  facts: DurableProofOperationFacts,
): void {
  const authorities = [operation.keysetAuthority.offer, operation.keysetAuthority.receive]
  if (
    mintKeysets.size !== authorities.length ||
    authorities.some((authority) => !mintKeysets.has(authority.keysetId))
  ) {
    throw new Error('CTF range mint keyset authority is incomplete')
  }
  const bindings = new Map(
    facts.verification.keysetBindings.map((binding) => [binding.keysetId, binding]),
  )
  for (const authority of authorities) {
    const resolved = mintKeysets.get(authority.keysetId)!
    verifyRangeKeysetIdentity(operation, authority, resolved)
    const curve = 'secp256k1' as const
    if (
      bindings.get(authority.keysetId)?.keysetFingerprint !==
      deriveDurableCustodyKeysetFingerprint({
        keysetId: authority.keysetId,
        unit: operation.unit,
        curve,
        publicKeys: resolved.keys,
      })
    ) {
      throw new Error('CTF range mint keys differ from custody verification authority')
    }
  }
}

function assertRangeInputProofsCryptographicallyValid(
  operation: DurableCtfRangeOperation,
  mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>,
): void {
  try {
    verifyProofsForReceive(
      operation.inputs.map(deserializeProof),
      (keysetId) => {
        const keyset = mintKeysets.get(keysetId)
        if (keyset === undefined) {
          throw new Error('CTF range input keyset is not pinned')
        }
        return { id: keyset.id, keys: keyset.keys }
      },
      { requireDleq: true },
    )
  } catch (error) {
    throw new Error('CTF range input proof cryptographic verification failed', { cause: error })
  }
}

function verifyRangeKeysetIdentity(
  operation: DurableCtfRangeOperation,
  authority: DurableCtfRangeKeysetAuthority,
  resolved: DurableCtfRangeMintKeyset,
): void {
  if (
    decodeCanonicalMintOrigin(resolved.canonicalMintUrl) !== operation.mintUrl ||
    resolved.id !== authority.keysetId ||
    resolved.unit !== authority.unit ||
    resolved.inputFeePpk !== authority.inputFeePpk ||
    resolved.finalExpiry !== authority.finalExpiry ||
    Object.keys(resolved.keys).length === 0 ||
    (authority.source === 'conditional' &&
      !sameRangeKeysetPublicKeys(authority.denominationPublicKeys, resolved.keys))
  ) {
    throw new Error('CTF range mint keyset metadata is foreign')
  }
  const mintKeys = {
    id: resolved.id,
    unit: resolved.unit,
    keys: { ...resolved.keys },
    input_fee_ppk: resolved.inputFeePpk,
    ...(resolved.finalExpiry === null ? {} : { final_expiry: resolved.finalExpiry }),
  }
  const identityIsValid =
    authority.source === 'regular'
      ? Keyset.verifyKeysetId(mintKeys)
      : Keyset.verifyConditionalKeysetId(mintKeys, {
          conditionId: authority.conditionId!,
          outcomeCollection: authority.outcomeCollection!,
          outcomeCollectionId: authority.outcomeCollectionId!,
        })
  if (!identityIsValid) {
    throw new Error('CTF range mint keyset identity is inconsistent')
  }
}

function sameRangeKeysetPublicKeys(
  expected: Readonly<Record<string, string>> | null,
  actual: Readonly<Record<string, string>>,
): boolean {
  if (expected === null) return false
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    compareCanonicalText(left, right),
  )
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    compareCanonicalText(left, right),
  )
  return (
    expectedEntries.length === actualEntries.length &&
    expectedEntries.every(
      ([amount, publicKey], index) =>
        actualEntries[index]?.[0] === amount && actualEntries[index]?.[1] === publicKey,
    )
  )
}

export function assertDurableCtfRangeCustodyAuthority(
  recordValue: DurableCustodyRecord,
  operationValue: DurableCtfRangeOperation,
): DurableCtfRangeOperation {
  const record = decodeDurableCustodyRecord(recordValue)
  const operation = decodeDurableCtfRangeOperation(operationValue)
  const custody = rangeProofOperationInput(operation)
  assertRangeRecordContext(record, operation)
  assertRangeArtifactAuthority(record, operation, custody)
  assertRangeKeysetVerificationAuthority(operation, {
    unit: operation.unit,
    binding: record.operation.binding,
    horizon: record.operation.horizon,
    verification: record.operation.verification,
  })
  assertRangeProofOperationLinks(record, operation, custody)
  return operation
}

export function assertDurableCtfRangeRefundKeysetAuthority(input: {
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  keyset: DurableCtfRangeMintKeyset
}): DurableCtfRangeMintKeyset {
  const operation = assertDurableCtfRangeCustodyAuthority(input.record, input.operation)
  const record = decodeDurableCustodyRecord(input.record)
  const keyset = input.keyset
  const authority = operation.keysetAuthority.offer
  verifyRangeKeysetIdentity(operation, authority, keyset)
  const bindings = record.operation.verification.keysetBindings.filter(
    ({ keysetId }) => keysetId === authority.keysetId,
  )
  const binding = bindings[0]
  const curve = 'secp256k1' as const
  if (
    bindings.length !== 1 ||
    binding === undefined ||
    binding.curve !== curve ||
    binding.requireDleq !== true ||
    binding.keysetFingerprint !==
      deriveDurableCustodyKeysetFingerprint({
        keysetId: authority.keysetId,
        unit: authority.unit,
        curve,
        publicKeys: keyset.keys,
      })
  ) {
    throw new Error('CTF range refund keyset differs from persisted custody authority')
  }
  return {
    canonicalMintUrl: keyset.canonicalMintUrl,
    id: keyset.id,
    unit: keyset.unit,
    keys: { ...keyset.keys },
    inputFeePpk: keyset.inputFeePpk,
    finalExpiry: keyset.finalExpiry,
  }
}

function assertRangeRecordContext(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
): void {
  if (
    record.operation.retainedOperationKey !== operation.operationId ||
    record.operation.binding.kind !== 'wallet' ||
    record.operation.binding.activityId !== operation.operationId ||
    record.operation.binding.stage !== 'send' ||
    record.operation.semanticKind !== 'conditional-keyset-swap' ||
    record.operation.custodyContext.normalizedMint !== operation.mintUrl ||
    record.operation.custodyContext.unit !== operation.unit
  ) {
    throw new Error('CTF range custody context is foreign')
  }
}

function assertRangeArtifactAuthority(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  custody: DurableCustodyProofOperationInput,
): void {
  const privateFingerprint = deriveDurableCustodyArtifactFingerprint(operation)
  if (
    record.operation.privateMaterial.publicFingerprint !== privateFingerprint ||
    record.operation.privateMaterial.exactPrivateMaterial.fingerprint !== privateFingerprint
  ) {
    throw new Error('CTF range custody record is foreign: private authority')
  }
  const outputFingerprint = deriveDurableCustodyArtifactFingerprint(custody.outputs)
  if (
    record.operation.outputPlan.outputPlanFingerprint !== outputFingerprint ||
    record.operation.outputPlan.exactOutput.fingerprint !== outputFingerprint ||
    record.operation.exactRequest.outputPlanFingerprint !== outputFingerprint ||
    record.operation.verification.outputPlanFingerprint !== outputFingerprint ||
    record.operation.verification.hasOutputs !== true
  ) {
    throw new Error('CTF range output plan authority is foreign')
  }
}

function assertRangeProofOperationLinks(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  custody: DurableCustodyProofOperationInput,
): void {
  const inputProofIds = custody.inputs.map((proof) =>
    deriveRangeCustodyProofId(record.scope.scopeId, operation, proof),
  )
  const reservation = record.operation.reservation.inputs
  const inputUses = canonicalKeysetUses(
    record.operation.verification.inputKeysets,
    'CTF range input keyset authority',
  )
  if (
    reservation.length !== custody.inputs.length ||
    reservation.some((link, index) => {
      const proof = custody.inputs[index]!
      const keysetId = canonicalDurableCustodyKeysetIdentity(proof.id!)
      return (
        link.proofId !== inputProofIds[index] ||
        canonicalDurableCustodyKeysetIdentity(link.keysetId) !== keysetId ||
        inputUses.get(keysetId) !== link.curve
      )
    }) ||
    !sameOrderedStrings(record.operation.exactRequest.inputProofIds, inputProofIds) ||
    !sameOrderedStrings(record.operation.proofStorage.lineage.predecessorProofIds, inputProofIds)
  ) {
    throw new Error('CTF range proof-operation link is foreign')
  }
  const successorProofIds = Object.values(custody.outputs).flatMap((outputs) =>
    outputs.map((output) =>
      deriveDurableCustodyProofId({
        scopeId: record.scope.scopeId,
        normalizedMint: operation.mintUrl,
        unit: operation.unit,
        keysetId: output.blindedMessage.id,
        secret: output.secret,
      }),
    ),
  )
  if (
    record.operation.proofStorage.lineage.successorAdmissionMode !== 'subset' ||
    !sameOrderedStrings(record.operation.proofStorage.lineage.successorProofIds, successorProofIds)
  ) {
    throw new Error('CTF range successor proof authority is foreign')
  }
}

function deriveRangeCustodyProofId(
  scopeId: string,
  operation: DurableCtfRangeOperation,
  proof: DurableCustodyProofOperationInput['inputs'][number],
): string {
  if (proof.id === undefined) throw new Error('CTF range input keyset is missing')
  return deriveDurableCustodyProofId({
    scopeId,
    normalizedMint: operation.mintUrl,
    unit: operation.unit,
    keysetId: proof.id,
    secret: proof.secret,
  })
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function createBoundRangeKeysetResolver(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  resolveKeyset: DurableCtfRangeKeysetResolver,
): (id: string) => HasKeysetKeys | undefined {
  const outputIds = new Set(
    record.operation.verification.outputKeysets.map(({ keysetId }) => keysetId),
  )
  const bindings = new Map(
    record.operation.verification.keysetBindings.map((binding) => [binding.keysetId, binding]),
  )
  const resolved = new Map<string, HasKeysetKeys>()
  return (id) => {
    const cached = resolved.get(id)
    if (cached !== undefined) return cached
    if (!outputIds.has(id)) throw new Error('CTF range recovery keyset is not output-authorized')
    const binding = bindings.get(id)
    const keyset = resolveKeyset(operation.mintUrl, id)
    if (binding === undefined || keyset === undefined || keyset.id !== id) {
      throw new Error('CTF range recovery keyset is unavailable')
    }
    const authority =
      operation.keysetAuthority.offer.keysetId === id
        ? operation.keysetAuthority.offer
        : operation.keysetAuthority.receive
    verifyRangeKeysetIdentity(operation, authority, {
      canonicalMintUrl: operation.mintUrl,
      id: keyset.id,
      unit: operation.unit,
      keys: keyset.keys,
      inputFeePpk: authority.inputFeePpk,
      finalExpiry: authority.finalExpiry,
    })
    requireCtfRangeV2KeysetId(id, 'CTF range recovery keyset id')
    const curve = 'secp256k1' as const
    if (
      binding.curve !== curve ||
      binding.keysetFingerprint !==
        deriveDurableCustodyKeysetFingerprint({
          keysetId: id,
          unit: operation.unit,
          curve,
          publicKeys: keyset.keys,
        })
    ) {
      throw new Error('CTF range recovery keyset does not match persisted authority')
    }
    resolved.set(id, keyset)
    return keyset
  }
}

function requireRangeSignatureAuthority(
  record: DurableCustodyRecord,
  outputs: SerializedBlindedMessage[],
  signatures: SerializedBlindedSignature[],
): void {
  if (outputs.length !== signatures.length) {
    throw new Error('CTF range recovery response length is inconsistent')
  }
  const bindings = new Map(
    record.operation.verification.keysetBindings.map((binding) => [binding.keysetId, binding]),
  )
  outputs.forEach((output, index) => {
    const signature = signatures[index]!
    const binding = bindings.get(output.id)
    if (
      signature.id !== output.id ||
      binding === undefined ||
      (binding.requireDleq && signature.dleq === undefined)
    ) {
      throw new Error('CTF range recovery signature lacks persisted verification authority')
    }
  })
}

function normalizeAllManifestRecovery(
  value: DurableCtfRangeAllManifestRecovery,
  allowEmpty = false,
): DurableCtfRangeAllManifestRecovery {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.queryCompleted !== 'boolean' ||
    !Array.isArray(value.queriedOutputs) ||
    !Array.isArray(value.restoredOutputs) ||
    !Array.isArray(value.signatures) ||
    value.queriedOutputs.length === 0 ||
    value.queriedOutputs.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX ||
    (!allowEmpty && value.restoredOutputs.length === 0) ||
    value.restoredOutputs.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX ||
    value.restoredOutputs.length !== value.signatures.length
  ) {
    throw new Error('CTF range all-manifest recovery is invalid')
  }
  const queriedOutputs = value.queriedOutputs.map((output) => normalizeRestoredOutput(output))
  const restoredOutputs = value.restoredOutputs.map((output) => normalizeRestoredOutput(output))
  const signatures = value.signatures.map((signature) => {
    const normalized = serializeSignature(signature)
    decodeSignature(normalized)
    return deserializeSignature(normalized)
  })
  encodeBoundedDurableArtifact(
    {
      queryCompleted: value.queryCompleted,
      queriedOutputs: queriedOutputs.map(({ id, amount, B_ }) => ({
        id,
        amount: amount.toString(),
        B_,
      })),
      restoredOutputs: restoredOutputs.map(({ id, amount, B_ }) => ({
        id,
        amount: amount.toString(),
        B_,
      })),
      signatures: signatures.map(serializeSignature),
    },
    DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
  )
  return { queriedOutputs, restoredOutputs, signatures, queryCompleted: value.queryCompleted }
}

function normalizeRestoredOutput(value: SerializedBlindedMessage): SerializedBlindedMessage {
  if (!isRecord(value)) throw new Error('CTF range restored output is invalid')
  exactKeys(value, ['id', 'amount', 'B_'])
  const id = requireCtfRangeV2KeysetId(value.id, 'restored output keyset id')
  const amount = Amount.from(value.amount as string | bigint | number | Amount)
  requireUnsigned(amount.toString(), 'restored output amount', false)
  requireLowerHex(value.B_, 66, 'restored blinded message')
  return { id, amount, B_: value.B_ as string }
}

function assertExactAllManifestQuery(
  material: ReturnType<typeof manifestMaterial>,
  queriedOutputs: SerializedBlindedMessage[],
): void {
  const expected = buildCtfRangeRecoveryQuery(material).outputs
  if (
    queriedOutputs.length !== expected.length ||
    queriedOutputs.some(
      (output, index) =>
        output.id !== expected[index]!.id ||
        output.B_ !== expected[index]!.B_ ||
        !output.amount.equals(expected[index]!.amount),
    )
  ) {
    throw new Error('CTF range recovery did not query the exact full manifest')
  }
}

function normalizeRecoveryObservation(
  value: DurableCtfRangeRecoveryObservation,
): DurableCtfRangeRecoveryObservation {
  const recovery = normalizeAllManifestRecovery(
    {
      queriedOutputs: value.queriedOutputs,
      restoredOutputs: value.restoredOutputs,
      signatures: value.signatures,
      queryCompleted: value.queryCompleted,
    },
    true,
  )
  if (value.selection !== null) requireSelection(value.selection)
  if (
    !Array.isArray(value.inputStates) ||
    value.inputStates.length === 0 ||
    value.inputStates.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    !Number.isSafeInteger(value.now) ||
    value.now < 0
  ) {
    throw new Error('CTF range recovery observation is invalid')
  }
  const inputStates = value.inputStates.map((state) => {
    if (!isRecord(state)) throw new Error('CTF range input state is invalid')
    exactKeys(state, ['Y', 'state', 'witness'])
    if (state.state !== 'UNSPENT' && state.state !== 'PENDING' && state.state !== 'SPENT') {
      throw new Error('CTF range input state is invalid')
    }
    if (state.witness !== null) requireBoundedText(state.witness, 'input state witness')
    const Y = requireLowerHexPoint(state.Y, 'input state Y')
    return { Y, state: state.state, witness: state.witness as string | null }
  })
  return { ...recovery, selection: value.selection, inputStates, now: value.now }
}

function serializeAllManifestRecovery(value: DurableCtfRangeAllManifestRecovery) {
  const recovery = normalizeAllManifestRecovery(value)
  return {
    queryCompleted: recovery.queryCompleted,
    queriedOutputs: recovery.queriedOutputs.map(({ id, amount, B_ }) => ({
      id,
      amount: amount.toString(),
      B_,
    })),
    restoredOutputs: recovery.restoredOutputs.map(({ id, amount, B_ }) => ({
      id,
      amount: amount.toString(),
      B_,
    })),
    signatures: recovery.signatures.map(serializeSignature),
  }
}

function assertRangeOwnerPolicy(operation: DurableCtfRangeOperation, selection: string): void {
  const inputTotal = operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)
  const selected = parseCtfSelectionBitmap(selection, operation.manifest.entries.length).map(
    (index) => operation.manifest.entries[index]!,
  )
  const receiveTotal = selected
    .filter(({ role }) => role === 'receive')
    .reduce((total, entry) => total + BigInt(entry.amount), 0n)
  const changeTotal = selected
    .filter(({ role }) => role === 'change')
    .reduce((total, entry) => total + BigInt(entry.amount), 0n)
  const maxDebit = BigInt(operation.policy.maxDebit)
  if (maxDebit > inputTotal || changeTotal > inputTotal) {
    throw new Error('CTF range result exceeds owner debit authority')
  }
  const debitTotal = inputTotal - changeTotal
  if (
    receiveTotal < BigInt(operation.policy.minReceive) ||
    debitTotal > maxDebit ||
    receiveTotal * BigInt(operation.policy.rateD) < debitTotal * BigInt(operation.policy.rateN)
  ) {
    throw new Error('CTF range result violates owner policy')
  }
}

function serializeProof(proof: Proof): DurableCtfRangeProof {
  return {
    id: proof.id,
    amount: Amount.from(proof.amount).toString(),
    secret: proof.secret,
    C: proof.C,
    dleq: structuredClone(proof.dleq ?? null),
    p2pkE: proof.p2pk_e ?? null,
    witness: structuredClone(proof.witness ?? null),
  }
}

function deserializeProof(proof: DurableCtfRangeProof): Proof {
  return {
    id: proof.id,
    amount: Amount.from(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: structuredClone(proof.dleq) as Proof['dleq'] }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null
      ? {}
      : { witness: structuredClone(proof.witness) as Proof['witness'] }),
  }
}

function deriveInputY(proof: DurableCtfRangeProof): string {
  requireCtfRangeV2KeysetId(proof.id, 'CTF range proof keyset id')
  const secret = new TextEncoder().encode(proof.secret)
  return hashToCurve(secret).toHex(true)
}

function toCustodyProof(proof: DurableCtfRangeProof) {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null ? {} : { witness: structuredClone(proof.witness) }),
  }
}

function toCustodyOutput(value: SerializedOutputData) {
  return serializeDurableCustodyOutput(OutputData.deserialize(value))
}

function serializeSignature(value: SerializedBlindedSignature): DurableCtfRangeSignature {
  return {
    id: value.id,
    amount: Amount.from(value.amount).toString(),
    C_: value.C_,
    dleq: value.dleq ? { e: value.dleq.e, s: value.dleq.s } : null,
  }
}

function deserializeSignature(value: DurableCtfRangeSignature): SerializedBlindedSignature {
  return {
    id: value.id,
    amount: Amount.from(value.amount),
    C_: value.C_,
    ...(value.dleq === null ? {} : { dleq: structuredClone(value.dleq) }),
  }
}

function decodeSignature(value: unknown): void {
  if (!isRecord(value)) throw new Error('CTF range signature is invalid')
  exactKeys(value, ['id', 'amount', 'C_', 'dleq'])
  requireCtfRangeV2KeysetId(value.id, 'signature keyset id')
  requireUnsigned(value.amount, 'signature amount', false)
  requireLowerHex(value.C_, 66, 'blind signature')
  if (value.dleq === null) {
    throw new Error('secp256k1 CTF range signature requires DLEQ')
  }
  if (value.dleq !== null) {
    if (!isRecord(value.dleq)) throw new Error('CTF range DLEQ is invalid')
    exactKeys(value.dleq, ['e', 's'])
    requireLowerHex(value.dleq.e, 64, 'DLEQ e')
    requireLowerHex(value.dleq.s, 64, 'DLEQ s')
  }
}

function requireCtfRangeV2KeysetId(value: unknown, field: string): string {
  assertCanonicalNut02V2KeysetId(value, `CTF range ${field}`)
  return value
}

function walletDisposition(asset: DurableCtfRangeAsset) {
  return { kind: 'wallet' as const, asset: asset.kind, reservedBy: null }
}

function assertSameAsset(left: DurableCtfRangeAsset, right: DurableCtfRangeAsset): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error('CTF range refund changes the offered asset class')
  }
}

function bytesToXOnlyPublicKey(privateKey: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), true).slice(1))
}

function exactArtifact(value: unknown): DurableCustodyExactArtifact {
  return {
    encoding: 'canonical-json',
    artifact: structuredClone(value),
    fingerprint: deriveDurableCustodyArtifactFingerprint(value),
  }
}

function selectedRangeSuccessorProofIds(
  record: DurableCustodyRecord,
  custody: DurableCustodyProofOperationInput,
  result: DurableCtfRangeRecoveredResult,
): string[] {
  const selectedSecrets = new Set([...result.receive, ...result.change].map(({ secret }) => secret))
  const candidates = record.operation.proofStorage.lineage.successorProofIds
  const outputs = custody.outputs
  const planned = [...(outputs.receive ?? []), ...(outputs.change ?? [])]
  if (
    planned.length !== candidates.length ||
    selectedSecrets.size !== result.receive.length + result.change.length
  ) {
    throw new Error('CTF range selected proof identity is invalid')
  }
  const selected = candidates.filter((_, index) => selectedSecrets.has(planned[index]!.secret))
  if (selected.length !== selectedSecrets.size) {
    throw new Error('CTF range selected proof is outside the persisted output plan')
  }
  return selected
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalPolicy(value: {
  rateN: bigint
  rateD: bigint
  minReceive: bigint
  maxDebit: bigint
}): string {
  return canonicalJson({
    rateN: value.rateN.toString(),
    rateD: value.rateD.toString(),
    minReceive: value.minReceive.toString(),
    maxDebit: value.maxDebit.toString(),
  })
}

function requireUnsigned(value: unknown, field: string, allowZero: boolean): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    (!allowZero && value === '0') ||
    BigInt(value) > MAX_U64
  ) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requireConditionalKeysetId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^01[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} is invalid`)
  }
  return value as number
}

function requireNonnegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} is invalid`)
  }
  return value as number
}

function optionalPositiveSafeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  return requirePositiveSafeInteger(value, field)
}

function requireRole(value: unknown): 'receive' | 'change' {
  if (value !== 'receive' && value !== 'change') {
    throw new Error('manifest role is invalid')
  }
  return value
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is invalid`)
  return value
}

function requireBoundedText(value: unknown, field: string): string {
  const text = requireText(value, field)
  if (new TextEncoder().encode(text).byteLength > DURABLE_CTF_RANGE_TEXT_BYTES_MAX) {
    throw new Error(`${field} exceeds its byte limit`)
  }
  return text
}

function requireSelection(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX / 4 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error('selection is invalid')
  }
  return value
}

function requireLowerHex(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requireLowerHexPoint(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    (value.length !== 66 && value.length !== 96) ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requireXOnlyPublicKey(value: unknown, field: string): string {
  const publicKey = requireLowerHex(value, 64, field)
  try {
    secp256k1.Point.fromHex(`02${publicKey}`)
  } catch {
    throw new Error(`${field} is invalid`)
  }
  return publicKey
}

function requireRangeKeysetPublicKeys(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > 64) {
    throw new Error('condition keyset public keys are invalid')
  }
  const keys: Record<string, string> = {}
  for (const [amount, publicKey] of Object.entries(value)) {
    requireUnsigned(amount, 'condition keyset denomination', false)
    if (typeof publicKey !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(publicKey)) {
      throw new Error('condition keyset public key is invalid')
    }
    keys[amount] = publicKey
  }
  return keys
}

function sumProofAmounts(
  proofs: readonly { readonly amount: string | { toString(): string } }[],
): bigint {
  return proofs.reduce((total, proof) => total + BigInt(proof.amount.toString()), 0n)
}

function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys)
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error('CTF range value contains foreign or missing fields')
  }
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('CTF range value contains foreign or missing fields')
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
