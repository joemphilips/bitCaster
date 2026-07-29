import {
  computeCtfManifestCommitment,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  parseCtfPayToUnlockCondition,
  type CtfPoolEntry,
} from '@cashu/cashu-ts'
import { bytesToHex } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  canonicalDurableCustodyKeysetIdentity,
  decodeCanonicalMintOrigin,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import {
  decodeDurableCtfRangeOperation,
  type DurableCtfRangeOperation,
  type DurableCtfRangeProof,
} from './durableCtfRangeOperation.ts'

export const SETTLEMENT_CAPABILITY_ARTIFACT_SCHEMA_VERSION = 1 as const
export const SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX = 256 * 1_024
export const SETTLEMENT_CAPABILITY_INPUTS_MAX = 64
export const SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX = 128

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const MAX_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

export interface SettlementCapabilityArtifact {
  schemaVersion: 1
  operationId: string
  authorizationId: string
  mintUrl: string
  unit: 'msat'
  conditionId: string
  parentCollectionId: string
  offerKeysetId: string
  receiveKeysetId: string
  expiry: number
  policy: {
    rateN: string
    rateD: string
    minReceive: string
    maxDebit: string
  }
  inputFeePpkByKeyset: Record<string, number>
  inputProofYs: string[]
  inputs: DurableCtfRangeProof[]
  manifest: {
    commitment: string
    entries: CtfPoolEntry[]
  }
}

export function createSettlementCapabilityArtifact(
  value: DurableCtfRangeOperation,
): SettlementCapabilityArtifact {
  const operation = decodeDurableCtfRangeOperation(value)
  return decodeSettlementCapabilityArtifact({
    schemaVersion: SETTLEMENT_CAPABILITY_ARTIFACT_SCHEMA_VERSION,
    operationId: operation.operationId,
    authorizationId: operation.authorizationId,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    conditionId: operation.conditionId,
    parentCollectionId: operation.parentCollectionId,
    offerKeysetId: operation.offerKeysetId,
    receiveKeysetId: operation.receiveKeysetId,
    expiry: operation.expiry,
    policy: structuredClone(operation.policy),
    inputFeePpkByKeyset: { ...operation.inputFeePpkByKeyset },
    inputProofYs: operation.inputs.map(deriveInputY),
    inputs: structuredClone(operation.inputs),
    manifest: {
      commitment: operation.manifest.commitment,
      entries: operation.manifest.entries.map(({ outputData: _, ...entry }) => entry),
    },
  })
}

export function decodeSettlementCapabilityArtifact(value: unknown): SettlementCapabilityArtifact {
  encodeBoundedDurableArtifact(value, SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX)
  const artifact = exactRecord(value, [
    'schemaVersion',
    'operationId',
    'authorizationId',
    'mintUrl',
    'unit',
    'conditionId',
    'parentCollectionId',
    'offerKeysetId',
    'receiveKeysetId',
    'expiry',
    'policy',
    'inputFeePpkByKeyset',
    'inputProofYs',
    'inputs',
    'manifest',
  ])
  validateHeader(artifact)
  validatePolicy(artifact.policy)
  validateFeeAuthority(artifact.inputFeePpkByKeyset, artifact.offerKeysetId)
  const inputs = validateInputs(artifact.inputs)
  const manifest = validateManifest(artifact.manifest)
  validateArtifactAuthority(artifact, inputs, manifest)
  return structuredClone(artifact) as unknown as SettlementCapabilityArtifact
}

export function encodeSettlementCapabilityArtifact(value: unknown): Uint8Array {
  return encodeBoundedDurableArtifact(
    decodeSettlementCapabilityArtifact(value),
    SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX,
  )
}

export function decodeSettlementCapabilityArtifactBytes(
  bytes: Uint8Array,
): SettlementCapabilityArtifact {
  if (bytes.byteLength < 1 || bytes.byteLength > SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX) {
    throw new Error('settlement capability artifact exceeds the byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('settlement capability artifact is not canonical JSON')
  }
  const artifact = decodeSettlementCapabilityArtifact(parsed)
  if (!sameBytes(bytes, encodeSettlementCapabilityArtifact(artifact))) {
    throw new Error('settlement capability artifact bytes are not canonical')
  }
  return artifact
}

export function deriveSettlementCapabilityArtifactDigest(value: unknown): string {
  return bytesToHex(sha256(encodeSettlementCapabilityArtifact(value)))
}

function validateHeader(value: Record<string, unknown>): void {
  if (
    value.schemaVersion !== SETTLEMENT_CAPABILITY_ARTIFACT_SCHEMA_VERSION ||
    value.unit !== 'msat' ||
    value.parentCollectionId !== ROOT_PARENT_COLLECTION_ID
  ) {
    throw new Error('settlement capability artifact header is unsupported')
  }
  requireText(value.operationId, 'operation id')
  requireText(value.authorizationId, 'authorization id')
  decodeCanonicalMintOrigin(value.mintUrl)
  requireHash(value.conditionId, 'condition id')
  requireHash(value.parentCollectionId, 'parent collection id')
  requireKeyset(value.offerKeysetId, 'offer keyset id')
  requireKeyset(value.receiveKeysetId, 'receive keyset id')
  if (value.offerKeysetId === value.receiveKeysetId) {
    throw new Error('settlement capability keysets must be distinct')
  }
  if (!Number.isSafeInteger(value.expiry) || (value.expiry as number) <= 0) {
    throw new Error('settlement capability expiry is invalid')
  }
}

function validatePolicy(value: unknown): void {
  const policy = exactRecord(value, ['rateN', 'rateD', 'minReceive', 'maxDebit'])
  requirePositiveDecimal(policy.rateN, 'rate numerator')
  requirePositiveDecimal(policy.rateD, 'rate denominator')
  requirePositiveDecimal(policy.minReceive, 'minimum receive')
  requirePositiveDecimal(policy.maxDebit, 'maximum debit')
}

function validateFeeAuthority(value: unknown, offerKeysetId: unknown): void {
  const fees = requireRecord(value, 'input fee authority')
  const keys = Object.keys(fees)
  if (keys.length !== 1 || keys[0] !== offerKeysetId) {
    throw new Error('settlement capability input fee authority is foreign')
  }
  const fee = fees[keys[0]]
  if (!Number.isSafeInteger(fee) || (fee as number) <= 0) {
    throw new Error('settlement capability input fee is invalid')
  }
}

function validateInputs(value: unknown): DurableCtfRangeProof[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SETTLEMENT_CAPABILITY_INPUTS_MAX
  ) {
    throw new Error('settlement capability input count is invalid')
  }
  return value.map((item) => {
    const proof = exactRecord(item, ['id', 'amount', 'secret', 'C', 'dleq', 'p2pkE', 'witness'])
    requireKeyset(proof.id, 'proof keyset id')
    requirePositiveDecimal(proof.amount, 'proof amount')
    requireText(proof.secret, 'proof secret', 16_384)
    requireText(proof.C, 'proof signature')
    if (proof.p2pkE !== null) requireText(proof.p2pkE, 'proof P2PK point')
    return structuredClone(proof) as unknown as DurableCtfRangeProof
  })
}

function validateManifest(value: unknown): {
  commitment: string
  entries: CtfPoolEntry[]
} {
  const manifest = exactRecord(value, ['commitment', 'entries'])
  const commitment = requireHash(manifest.commitment, 'manifest commitment')
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < 2 ||
    manifest.entries.length > SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX
  ) {
    throw new Error('settlement capability manifest count is invalid')
  }
  const entries = manifest.entries.map((item) => {
    const entry = exactRecord(item, ['index', 'role', 'amount', 'id', 'B_'])
    return structuredClone(entry) as unknown as CtfPoolEntry
  })
  if (computeCtfManifestCommitment(entries) !== commitment) {
    throw new Error('settlement capability manifest commitment is invalid')
  }
  return { commitment, entries }
}

function validateArtifactAuthority(
  artifact: Record<string, unknown>,
  inputs: DurableCtfRangeProof[],
  manifest: { commitment: string; entries: CtfPoolEntry[] },
): void {
  const policy = artifact.policy as SettlementCapabilityArtifact['policy']
  const proofYs = requireStringArray(artifact.inputProofYs, inputs.length, 'input proof Ys')
  if (
    inputs.some((proof, index) => {
      const condition = parseCtfPayToUnlockCondition(proof.secret)
      return (
        proof.id !== artifact.offerKeysetId ||
        condition.offerKeyset !== artifact.offerKeysetId ||
        condition.data !== manifest.commitment ||
        condition.expiry !== BigInt(artifact.expiry as number) ||
        condition.mode.kind !== 'pool' ||
        condition.mode.policy.rateN.toString() !== policy.rateN ||
        condition.mode.policy.rateD.toString() !== policy.rateD ||
        condition.mode.policy.minReceive.toString() !== policy.minReceive ||
        condition.mode.policy.maxDebit.toString() !== policy.maxDebit ||
        proofYs[index] !== deriveInputY(proof)
      )
    })
  ) {
    throw new Error('settlement capability proof authority is inconsistent')
  }
  if (new Set(proofYs).size !== proofYs.length) {
    throw new Error('settlement capability contains duplicate input proofs')
  }
  const receive = manifest.entries.filter(({ role }) => role === 'receive')
  const change = manifest.entries.filter(({ role }) => role === 'change')
  if (
    receive.some(({ id }) => id !== artifact.receiveKeysetId) ||
    change.some(({ id }) => id !== artifact.offerKeysetId)
  ) {
    throw new Error('settlement capability manifest keysets are inconsistent')
  }
}

function deriveInputY(proof: DurableCtfRangeProof): string {
  const secret = new TextEncoder().encode(proof.secret)
  return isBlsKeyset(proof.id)
    ? hashToCurveBls(secret).toHex(true)
    : hashToCurve(secret).toHex(true)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requireRecord(value, 'settlement capability value')
  const expected = new Set(keys)
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new Error('settlement capability contains foreign or missing fields')
  }
  return record
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireText(value: unknown, name: string, maximum = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireKeyset(value: unknown, name: string): string {
  const keyset = requireText(value, name)
  if (canonicalDurableCustodyKeysetIdentity(keyset) !== keyset) {
    throw new Error(`${name} is not canonical`)
  }
  return keyset
}

function requirePositiveDecimal(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_U128) throw new Error(`${name} exceeds u128`)
  return value
}

function requireStringArray(value: unknown, exactLength: number, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== exactLength ||
    value.some((item) => typeof item !== 'string' || item.length < 1)
  ) {
    throw new Error(`${name} are invalid`)
  }
  return value
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
