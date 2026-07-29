import {
  Amount,
  computeCtfManifestCommitment,
  computeCtfReceiveCommitment,
  hashToCurve,
  parseCtfPayToUnlockCondition,
  type CtfPoolEntry,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
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
} from './durableCtfRangeOperation.ts'

export const SETTLEMENT_CAPABILITY_ARTIFACT_SCHEMA_VERSION = 2 as const
export const SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX = 256 * 1_024
export const SETTLEMENT_CAPABILITY_INPUTS_MAX = 64
export const SETTLEMENT_CAPABILITY_OUTPUTS_MAX = 128
export const SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX = 128

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)
const MAX_I64 = 9_223_372_036_854_775_807n
const MAX_U64 = 18_446_744_073_709_551_615n
const MAX_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const STANDARD_FIELDS = [
  'schemaVersion',
  'authorizationMode',
  'operationId',
  'authorizationId',
  'mintUrl',
  'unit',
  'conditionId',
  'parentCollectionId',
  'offerKeysetId',
  'receiveKeysetId',
  'expiry',
  'inputFeePpkByKeyset',
  'inputProofYs',
  'inputs',
  'outputs',
] as const
const POOL_FIELDS = [
  'schemaVersion',
  'authorizationMode',
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
] as const

export interface SettlementCapabilityInputProof {
  id: string
  amount: string
  secret: string
  C: string
  dleq: { e: string; s: string; r: string }
  p2pkE: string | null
  witness: string | { signatures: string[] } | null
}

export interface SettlementCapabilityOutput {
  amount: string
  id: string
  B_: string
}

export interface SettlementCapabilityPolicy {
  rateN: string
  rateD: string
  minReceive: string
  maxDebit: string
}

interface SettlementCapabilityArtifactCommon {
  schemaVersion: 2
  operationId: string
  authorizationId: string
  mintUrl: string
  unit: 'msat'
  conditionId: string
  parentCollectionId: string
  offerKeysetId: string
  receiveKeysetId: string
  expiry: number
  inputFeePpkByKeyset: Record<string, number>
  inputProofYs: string[]
  inputs: SettlementCapabilityInputProof[]
}

export interface StandardSettlementCapabilityArtifact extends SettlementCapabilityArtifactCommon {
  authorizationMode: 'standard'
  outputs: SettlementCapabilityOutput[]
}

export interface PoolSettlementCapabilityArtifact extends SettlementCapabilityArtifactCommon {
  authorizationMode: 'pool'
  policy: SettlementCapabilityPolicy
  manifest: {
    commitment: string
    entries: CtfPoolEntry[]
  }
}

export type SettlementCapabilityArtifact =
  | StandardSettlementCapabilityArtifact
  | PoolSettlementCapabilityArtifact

export function decodeSettlementCapabilityArtifact(value: unknown): SettlementCapabilityArtifact {
  encodeBoundedDurableArtifact(value, SETTLEMENT_CAPABILITY_ARTIFACT_BYTES_MAX)
  const candidate = requireRecord(value, 'settlement capability value')
  const authorizationMode = requireAuthorizationMode(candidate.authorizationMode)
  const artifact = exactRecord(
    candidate,
    authorizationMode === 'standard' ? STANDARD_FIELDS : POOL_FIELDS,
  )
  validateHeader(artifact)
  validateFeeAuthority(artifact.inputFeePpkByKeyset, artifact.offerKeysetId)
  const inputs = validateInputs(artifact.inputs)
  const authority =
    authorizationMode === 'standard'
      ? {
          outputs: validateStandardOutputs(
            artifact.outputs,
            artifact.offerKeysetId,
            artifact.receiveKeysetId,
          ),
        }
      : {
          policy: validatePolicy(artifact.policy),
          manifest: validateManifest(
            artifact.manifest,
            artifact.offerKeysetId,
            artifact.receiveKeysetId,
          ),
        }
  validateArtifactAuthority(artifact, authorizationMode, inputs, authority)
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

export function createPoolSettlementCapabilityArtifact(
  value: DurableCtfRangeOperation,
): PoolSettlementCapabilityArtifact {
  const operation = decodeDurableCtfRangeOperation(value)
  const artifact = decodeSettlementCapabilityArtifact({
    schemaVersion: SETTLEMENT_CAPABILITY_ARTIFACT_SCHEMA_VERSION,
    authorizationMode: 'pool',
    operationId: operation.operationId,
    authorizationId: operation.authorizationId,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    conditionId: operation.conditionId,
    parentCollectionId: operation.parentCollectionId,
    offerKeysetId: operation.offerKeysetId,
    receiveKeysetId: operation.receiveKeysetId,
    expiry: operation.expiry,
    policy: operation.policy,
    inputFeePpkByKeyset: operation.inputFeePpkByKeyset,
    inputProofYs: operation.inputs.map((proof) =>
      hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    ),
    inputs: operation.inputs.map((proof) => ({
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      dleq: structuredClone(proof.dleq),
      p2pkE: proof.p2pkE,
      witness: structuredClone(proof.witness),
    })),
    manifest: {
      commitment: operation.manifest.commitment,
      entries: operation.manifest.entries.map(({ outputData: _, ...entry }) => entry),
    },
  })
  if (artifact.authorizationMode !== 'pool') {
    throw new Error('durable CTF range operation did not produce a pool capability')
  }
  return artifact
}

function requireAuthorizationMode(value: unknown): 'standard' | 'pool' {
  switch (value) {
    case 'standard':
    case 'pool':
      return value
    default:
      throw new Error('settlement capability authorization mode is invalid')
  }
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
  requireSettlementMintOrigin(value.mintUrl)
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

function requireSettlementMintOrigin(value: unknown): string {
  const mintUrl = decodeCanonicalMintOrigin(value)
  const parsed = new URL(mintUrl)
  if (
    parsed.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error('settlement capability mint URL requires HTTPS outside loopback')
  }
  return mintUrl
}

function validatePolicy(value: unknown): SettlementCapabilityPolicy {
  const policy = exactRecord(value, ['rateN', 'rateD', 'minReceive', 'maxDebit'])
  const rateN = requireUnsignedDecimal(policy.rateN, MAX_U128, 'rate numerator')
  const rateD = requirePositiveDecimal(policy.rateD, MAX_U128, 'rate denominator')
  const minReceive = requirePositiveDecimal(policy.minReceive, MAX_U128, 'minimum receive')
  const maxDebit = requireUnsignedDecimal(policy.maxDebit, MAX_U128, 'maximum debit')
  if (greatestCommonDivisor(BigInt(rateN), BigInt(rateD)) !== 1n) {
    throw new Error('settlement capability rate fraction is not reduced')
  }
  return { rateN, rateD, minReceive, maxDebit }
}

function validateFeeAuthority(value: unknown, offerKeysetId: unknown): void {
  const fees = requireRecord(value, 'input fee authority')
  const keys = Object.keys(fees)
  if (keys.length !== 1 || keys[0] !== offerKeysetId) {
    throw new Error('settlement capability input fee authority is foreign')
  }
  const fee = fees[keys[0]!]
  if (!Number.isSafeInteger(fee) || (fee as number) <= 0) {
    throw new Error('settlement capability input fee is invalid')
  }
}

function validateInputs(value: unknown): SettlementCapabilityInputProof[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SETTLEMENT_CAPABILITY_INPUTS_MAX
  ) {
    throw new Error('settlement capability input count is invalid')
  }
  let total = 0n
  return value.map((item) => {
    const proof = exactRecord(item, ['id', 'amount', 'secret', 'C', 'dleq', 'p2pkE', 'witness'])
    requireKeyset(proof.id, 'proof keyset id')
    total += BigInt(requirePositiveDecimal(proof.amount, MAX_U64, 'proof amount'))
    if (total > MAX_I64) throw new Error('settlement capability input amount exceeds i64')
    requireText(proof.secret, 'proof secret', 16_384)
    requirePoint(proof.C, 'proof signature')
    validateCapabilityDleq(proof.dleq)
    if (proof.p2pkE !== null) requirePoint(proof.p2pkE, 'proof P2PK point')
    validateWitness(proof.witness)
    return structuredClone(proof) as unknown as SettlementCapabilityInputProof
  })
}

function validateStandardOutputs(
  value: unknown,
  offerKeysetId: unknown,
  receiveKeysetId: unknown,
): SettlementCapabilityOutput[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SETTLEMENT_CAPABILITY_OUTPUTS_MAX
  ) {
    throw new Error('settlement capability standard output count is invalid')
  }
  const blindedMessages = new Set<string>()
  return value.map((item) => {
    const output = exactRecord(item, ['amount', 'id', 'B_'])
    const amount = requirePositiveDecimal(output.amount, MAX_U64, 'standard output amount')
    const id = requireKeyset(output.id, 'standard output keyset id')
    const B_ = requirePoint(output.B_, 'standard output blinded message')
    if (id !== receiveKeysetId || id === offerKeysetId || blindedMessages.has(B_)) {
      throw new Error('settlement capability standard outputs are invalid')
    }
    blindedMessages.add(B_)
    return { amount, id, B_ }
  })
}

function validateManifest(
  value: unknown,
  offerKeysetId: unknown,
  receiveKeysetId: unknown,
): { commitment: string; entries: CtfPoolEntry[] } {
  const manifest = exactRecord(value, ['commitment', 'entries'])
  const commitment = requireHash(manifest.commitment, 'manifest commitment')
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < 2 ||
    manifest.entries.length > SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX
  ) {
    throw new Error('settlement capability manifest count is invalid')
  }
  let sawChange = false
  let receiveAmount = 1n
  let changeAmount = 1n
  const blindedMessages = new Set<string>()
  const entries = manifest.entries.map((item, index) => {
    const entry = exactRecord(item, ['index', 'role', 'amount', 'id', 'B_'])
    if (entry.index !== index.toString()) throw invalidManifest()
    const role = requireManifestRole(entry.role)
    const amount = requireUnsignedDecimal(entry.amount, MAX_U64, 'manifest amount')
    const id = requireKeyset(entry.id, 'manifest keyset id')
    const B_ = requirePoint(entry.B_, 'manifest blinded message')
    if (blindedMessages.has(B_)) throw invalidManifest()
    blindedMessages.add(B_)
    if (role === 'receive') {
      if (sawChange || id !== receiveKeysetId || BigInt(amount) !== receiveAmount) {
        throw invalidManifest()
      }
      receiveAmount *= 2n
    } else {
      sawChange = true
      if (id !== offerKeysetId || BigInt(amount) !== changeAmount) throw invalidManifest()
      changeAmount *= 2n
    }
    return { index: index.toString(), role, amount, id, B_ }
  })
  if (!sawChange || entries[0]?.role !== 'receive') throw invalidManifest()
  if (computeCtfManifestCommitment(entries) !== commitment) {
    throw new Error('settlement capability manifest commitment is invalid')
  }
  return { commitment, entries }
}

function validateArtifactAuthority(
  artifact: Record<string, unknown>,
  authorizationMode: 'standard' | 'pool',
  inputs: SettlementCapabilityInputProof[],
  authority:
    | { outputs: SettlementCapabilityOutput[] }
    | {
        policy: SettlementCapabilityPolicy
        manifest: { commitment: string; entries: CtfPoolEntry[] }
      },
): void {
  const proofYs = requirePointArray(artifact.inputProofYs, inputs.length, 'input proof Ys')
  const commitment =
    authorizationMode === 'standard'
      ? computeCtfReceiveCommitment(
          (authority as { outputs: SettlementCapabilityOutput[] }).outputs.map((output) => ({
            ...output,
            amount: Amount.from(output.amount),
          })),
        )
      : (authority as { manifest: { commitment: string } }).manifest.commitment
  const policy =
    authorizationMode === 'pool'
      ? (authority as { policy: SettlementCapabilityPolicy }).policy
      : null
  if (
    policy !== null &&
    BigInt(policy.maxDebit) > inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)
  ) {
    throw new Error('settlement capability maximum debit exceeds fixed inputs')
  }
  const coordinatorPublicKeys = new Set<string>()
  const nonces = new Set<string>()
  if (
    inputs.some((proof, index) => {
      const condition = parseCoordinatorBoundCondition(proof.secret)
      coordinatorPublicKeys.add(condition.coordinatorPublicKey)
      if (nonces.has(condition.nonce)) return true
      nonces.add(condition.nonce)
      return (
        proof.id !== artifact.offerKeysetId ||
        condition.offerKeyset !== artifact.offerKeysetId ||
        condition.data !== commitment ||
        condition.expiry !== BigInt(artifact.expiry as number) ||
        condition.mode.kind !== authorizationMode ||
        !samePolicy(condition.mode.kind === 'pool' ? condition.mode.policy : null, policy) ||
        proofYs[index] !== deriveInputY(proof)
      )
    }) ||
    coordinatorPublicKeys.size !== 1
  ) {
    throw new Error('settlement capability proof authority is inconsistent')
  }
  if (new Set(proofYs).size !== proofYs.length) {
    throw new Error('settlement capability contains duplicate input proofs')
  }
}

function parseCoordinatorBoundCondition(
  secret: string,
): ReturnType<typeof parseCtfPayToUnlockCondition> & { coordinatorPublicKey: string } {
  const parsed = parseCtfPayToUnlockCondition(secret)
  if (parsed.coordinatorPublicKey === undefined) {
    throw new Error('settlement capability coordinator public key is missing')
  }
  return { ...parsed, coordinatorPublicKey: parsed.coordinatorPublicKey }
}

function validateCapabilityDleq(value: unknown): void {
  if (value === null) throw new Error('settlement capability proof DLEQ is required')
  const dleq = exactRecord(value, ['e', 's', 'r'])
  requireScalar(dleq.e, 'proof DLEQ e')
  requireScalar(dleq.s, 'proof DLEQ s')
  requireScalar(dleq.r, 'proof DLEQ r')
}

function validateWitness(value: unknown): void {
  if (value === null) return
  if (typeof value === 'string') {
    requireText(value, 'proof witness', 16_384)
    return
  }
  const witness = exactRecord(value, ['signatures'])
  if (
    !Array.isArray(witness.signatures) ||
    witness.signatures.length < 1 ||
    witness.signatures.length > 16
  ) {
    throw new Error('settlement capability proof witness signatures are invalid')
  }
  witness.signatures.forEach((signature) =>
    requireLowerHex(signature, 128, 'proof witness signature'),
  )
}

function deriveInputY(proof: SettlementCapabilityInputProof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)
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
  return requireLowerHex(value, 64, name)
}

function requireScalar(value: unknown, name: string): string {
  return requireLowerHex(value, 64, name)
}

function requireLowerHex(value: unknown, length: number, name: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requirePoint(value: unknown, name: string): string {
  const point = requireText(value, name)
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(point)) throw new Error(`${name} is invalid`)
  try {
    if (secp256k1.Point.fromHex(point).toHex(true) !== point) throw new Error()
  } catch {
    throw new Error(`${name} is invalid`)
  }
  return point
}

function requireKeyset(value: unknown, name: string): string {
  const keyset = requireText(value, name)
  if (
    canonicalDurableCustodyKeysetIdentity(keyset) !== keyset ||
    !/^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/.test(keyset)
  ) {
    throw new Error(`${name} is not canonical`)
  }
  return keyset
}

function requirePositiveDecimal(value: unknown, maximum: bigint, name: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  if (BigInt(value) > maximum) throw new Error(`${name} exceeds its integer range`)
  return value
}

function requireUnsignedDecimal(value: unknown, maximum: bigint, name: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  if (BigInt(value) > maximum) throw new Error(`${name} exceeds its integer range`)
  return value
}

function requirePointArray(value: unknown, exactLength: number, name: string): string[] {
  if (!Array.isArray(value) || value.length !== exactLength) {
    throw new Error(`${name} are invalid`)
  }
  return value.map((item) => requirePoint(item, 'input proof Y'))
}

function requireManifestRole(value: unknown): 'receive' | 'change' {
  switch (value) {
    case 'receive':
    case 'change':
      return value
    default:
      throw invalidManifest()
  }
}

function samePolicy(
  actual: { rateN: bigint; rateD: bigint; minReceive: bigint; maxDebit: bigint } | null,
  expected: SettlementCapabilityPolicy | null,
): boolean {
  return (
    (actual === null && expected === null) ||
    (actual !== null &&
      expected !== null &&
      actual.rateN.toString() === expected.rateN &&
      actual.rateD.toString() === expected.rateD &&
      actual.minReceive.toString() === expected.minReceive &&
      actual.maxDebit.toString() === expected.maxDebit)
  )
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function invalidManifest(): Error {
  return new Error('settlement capability manifest is invalid')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
