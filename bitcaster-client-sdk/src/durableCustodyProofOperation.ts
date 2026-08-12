// Generic proof-operation authority re-authored from 7e1385c; protocol-bound
// variants and catalogue/migration concerns are intentionally outside this API.
import { OutputData, type OutputDataLike, type Proof } from '@cashu/cashu-ts'
import {
  createDurableProofOperationFacts,
  encodeBoundedDurableArtifact,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  decodeCanonicalMintOrigin,
  type DurableCustodySemanticKind,
  type DurableProofOperationFacts,
  type DurableProofOperationKeysetFactsInput,
} from './durableCustody.ts'
import { amountToNumber } from './proofSelection.ts'

export type DurableCustodyProofOperationKind =
  | DurableCustodySemanticKind
  | 'ctf-consolidation'
  | 'proof-consolidation'
  | 'ctf-condition-registration'
  | 'ctf-range-authorization'
  | 'ctf-range-refund'
  | 'regular-split'
  | 'proof-split'
  | 'wallet-mint'
  | 'wallet-receive'
  | 'wallet-melt'

export interface DurableCustodyMintKeys {
  id: string
  unit: string
  keys: Readonly<Record<string, string>>
  final_expiry?: number
}

export interface DurableCustodyProofOperationInput {
  operationId: string
  kind: DurableCustodyProofOperationKind
  mintUrl: string
  inputs: readonly {
    id?: string
    amount: unknown
    secret: string
    C: string
    dleq?: unknown
    p2pk_e?: string
    witness?: unknown
    conditionId?: string
    outcomeCollection?: string
  }[]
  outputs: Readonly<
    Record<
      string,
      readonly {
        blindedMessage: { amount: unknown; id: string; B_: string }
        blindingFactor: string
        secret: string
        ephemeralE?: string
      }[]
    >
  >
  metadata?: Readonly<Record<string, unknown>>
}

export type DurableCustodyPlannedOutput =
  DurableCustodyProofOperationInput['outputs'][string][number]

export function serializeDurableCustodyProofInput(
  proof: Proof,
): DurableCustodyProofOperationInput['inputs'][number] {
  return Object.fromEntries(
    Object.entries({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      secret: proof.secret,
      C: proof.C,
      dleq: structuredClone(proof.dleq),
      p2pk_e: proof.p2pk_e,
      witness: structuredClone(proof.witness),
    }).filter(([, value]) => value !== undefined),
  ) as DurableCustodyProofOperationInput['inputs'][number]
}

export function serializeDurableCustodyOutput(output: OutputDataLike): DurableCustodyPlannedOutput {
  const serialized = OutputData.serialize(output)
  const secret = new TextDecoder('utf-8', { fatal: true }).decode(output.secret)
  return {
    blindedMessage: {
      amount: serialized.blindedMessage.amount,
      id: serialized.blindedMessage.id,
      B_: serialized.blindedMessage.B_,
    },
    blindingFactor: serialized.blindingFactor,
    secret,
    ...(serialized.ephemeralE === undefined ? {} : { ephemeralE: serialized.ephemeralE }),
  }
}

export function deserializeDurableCustodyOutput(output: DurableCustodyPlannedOutput): OutputData {
  const rebuilt = OutputData.createSingleData(
    amountToNumber(output.blindedMessage.amount),
    output.blindedMessage.id,
    output.secret,
    BigInt(output.blindingFactor),
  )
  if (rebuilt.blindedMessage.B_ !== output.blindedMessage.B_) {
    throw new Error('custody blinded output does not match its exact private material')
  }
  return new OutputData(
    rebuilt.blindedMessage,
    rebuilt.blindingFactor,
    rebuilt.secret,
    output.ephemeralE,
  )
}

export type DurableCustodyMintKeyResolver = (
  mintUrl: string,
  keysetIds: readonly string[],
) => Promise<ReadonlyMap<string, DurableCustodyMintKeys>>

export interface ResolveDurableCustodyProofOperationFactsInput {
  operation: DurableCustodyProofOperationInput
  resolveMintKeys: DurableCustodyMintKeyResolver
  requireDleq: boolean
}

export function decodeDurableCustodyProofOperationInput(
  value: unknown,
): DurableCustodyProofOperationInput {
  if (!isRecord(value)) throw new Error('custody proof operation is invalid')
  exactKeys(value, ['operationId', 'kind', 'mintUrl', 'inputs', 'outputs', 'metadata'], true)
  requireText(value.operationId, 'operation id')
  durableCustodyProofOperationSemanticKind(value.kind as DurableCustodyProofOperationKind)
  decodeCanonicalMintOrigin(value.mintUrl)
  if (!Array.isArray(value.inputs) || !isRecord(value.outputs)) {
    throw new Error('custody proof operation artifacts are invalid')
  }
  if (value.inputs.length > 256) {
    throw new Error('custody proof operation input limit exceeded')
  }
  value.inputs.forEach((proof) => {
    if (!isRecord(proof)) throw new Error('custody input proof is invalid')
    exactKeys(
      proof,
      [
        'id',
        'amount',
        'secret',
        'C',
        'dleq',
        'p2pk_e',
        'witness',
        'conditionId',
        'outcomeCollection',
      ],
      true,
    )
    if (proof.id !== undefined) requireText(proof.id, 'input keyset id')
    amountToNumber(proof.amount)
    requireText(proof.secret, 'input proof secret')
    requireText(proof.C, 'input proof signature')
    optionalText(proof.p2pk_e, 'input proof p2pk value')
    optionalText(proof.conditionId, 'input condition id')
    optionalText(proof.outcomeCollection, 'input outcome collection')
    if (proof.dleq !== undefined) decodeDleq(proof.dleq)
    if (proof.witness !== undefined) decodeWitness(proof.witness)
  })
  let outputCount = 0
  for (const [label, outputs] of Object.entries(value.outputs)) {
    requireSafeLabel(label)
    if (!Array.isArray(outputs)) throw new Error('custody output group is invalid')
    outputCount += outputs.length
    outputs.forEach((output) => {
      if (!isRecord(output)) throw new Error('custody blinded output is invalid')
      exactKeys(output, ['blindedMessage', 'blindingFactor', 'secret', 'ephemeralE'], true)
      if (!isRecord(output.blindedMessage)) {
        throw new Error('custody blinded message is invalid')
      }
      exactKeys(output.blindedMessage, ['amount', 'id', 'B_'])
      amountToNumber(output.blindedMessage.amount)
      requireText(output.blindedMessage.id, 'output keyset id')
      requireText(output.blindedMessage.B_, 'blinded message')
      requireText(output.blindingFactor, 'blinding factor')
      requireText(output.secret, 'output secret')
      optionalText(output.ephemeralE, 'output ephemeral value')
    })
  }
  if (outputCount > 256 || Object.keys(value.outputs).length > 16) {
    throw new Error('custody proof operation output limit exceeded')
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new Error('custody proof operation metadata is invalid')
  }
  if (value.metadata !== undefined) {
    if (Object.keys(value.metadata).length > 16) {
      throw new Error('custody proof operation metadata field limit exceeded')
    }
    encodeBoundedDurableArtifact(value.metadata, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)
  }
  return structuredClone(value) as unknown as DurableCustodyProofOperationInput
}

export async function resolveDurableCustodyProofOperationFacts(
  input: ResolveDurableCustodyProofOperationFactsInput,
): Promise<DurableProofOperationFacts> {
  const operation = decodeDurableCustodyProofOperationInput(input.operation)
  const unit = operation.metadata?.unit
  requireText(unit, 'metadata unit')
  const usage = keysetUsage(operation)
  if (usage.size === 0) throw new Error('custody operation has no keysets')
  const mintKeys = await input.resolveMintKeys(operation.mintUrl, [...usage.keys()])
  const keysets: DurableProofOperationKeysetFactsInput[] = [...usage].map(
    ([keysetId, directions]) => {
      const keys = mintKeys.get(keysetId)
      if (
        keys === undefined ||
        keys.id !== keysetId ||
        keys.unit !== unit ||
        Object.keys(keys.keys).length === 0
      ) {
        throw new Error('custody mint keyset unit or identity is invalid')
      }
      return {
        keysetId,
        unit,
        curve: inferCurve(keys.keys),
        publicKeys: keys.keys,
        keysetExpiryMs:
          keys.final_expiry === undefined ? null : secondsToMilliseconds(keys.final_expiry),
        requireDleq: input.requireDleq,
        usedByInputs: directions.inputs,
        usedByOutputs: directions.outputs,
      }
    },
  )
  if (mintKeys.size !== usage.size) {
    throw new Error('custody mint key resolver returned foreign keysets')
  }
  return createDurableProofOperationFacts({
    unit,
    binding: {
      kind: 'wallet',
      activityId: operation.operationId,
      stage: durableCustodyProofOperationStage(operation.kind),
    },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: Object.values(operation.outputs).some((group) => group.length > 0),
    inputKeysetRequirement: operation.kind === 'wallet-mint' ? 'none' : 'required',
    keysets,
  })
}

export function durableCustodyProofOperationSemanticKind(
  kind: DurableCustodyProofOperationKind,
): DurableCustodySemanticKind {
  switch (kind) {
    case 'conditional-keyset-swap':
    case 'ctf-range-refund':
    case 'ctf-split':
    case 'ctf-merge':
    case 'ctf-redeem':
    case 'generic-receive':
    case 'generic-send':
    case 'wallet-send':
    case 'ctf-range-regular-source':
    case 'ctf-range-conditional-source':
    case 'ctf-range-collateral-convert':
      return kind
    case 'ctf-consolidation':
      return 'ctf-merge'
    case 'proof-consolidation':
      return 'proof-consolidation'
    case 'ctf-range-authorization':
      return 'conditional-keyset-swap'
    case 'ctf-condition-registration':
    case 'regular-split':
    case 'proof-split':
    case 'wallet-melt':
      return 'generic-send'
    case 'wallet-mint':
    case 'wallet-receive':
      return 'generic-receive'
    default:
      throw new Error('custody proof operation kind is invalid')
  }
}

export function durableCustodyProofOperationStage(
  kind: DurableCustodyProofOperationKind,
): DurableProofOperationFacts['binding']['stage'] {
  return stageForSemantic(durableCustodyProofOperationSemanticKind(kind))
}

function stageForSemantic(
  kind: DurableCustodySemanticKind,
): DurableProofOperationFacts['binding']['stage'] {
  switch (kind) {
    case 'ctf-range-refund':
      return 'ctf-range-refund'
    case 'generic-receive':
      return 'receive'
    case 'ctf-split':
    case 'ctf-merge':
    case 'proof-consolidation':
    case 'ctf-redeem':
      return kind
    case 'conditional-keyset-swap':
    case 'generic-send':
    case 'wallet-send':
      return 'send'
    case 'ctf-range-regular-source':
    case 'ctf-range-conditional-source':
    case 'ctf-range-collateral-convert':
      return 'capability-preparation'
  }
}

function keysetUsage(
  operation: DurableCustodyProofOperationInput,
): Map<string, { inputs: boolean; outputs: boolean }> {
  const usage = new Map<string, { inputs: boolean; outputs: boolean }>()
  const mark = (id: string, field: 'inputs' | 'outputs') => {
    const current = usage.get(id) ?? { inputs: false, outputs: false }
    current[field] = true
    usage.set(id, current)
  }
  for (const proof of operation.inputs) {
    if (!proof.id) throw new Error('custody input proof has no keyset id')
    mark(proof.id, 'inputs')
  }
  for (const outputs of Object.values(operation.outputs)) {
    outputs.forEach((output) => mark(output.blindedMessage.id, 'outputs'))
  }
  return usage
}

function inferCurve(keys: Readonly<Record<string, string>>): 'secp256k1' | 'bls12-381' {
  return Object.values(keys).every((key) => /^(02|03)[0-9a-fA-F]{64}$/.test(key))
    ? 'secp256k1'
    : 'bls12-381'
}

function secondsToMilliseconds(value: number): number {
  const result = value * 1_000
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('custody keyset expiry is invalid')
  }
  return result
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): void {
  const allowed = new Set(keys)
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    (!optional && Object.keys(value).length !== keys.length)
  ) {
    throw new Error('custody proof operation contains foreign fields')
  }
}

function decodeDleq(value: unknown): void {
  if (!isRecord(value)) throw new Error('custody proof DLEQ is invalid')
  exactKeys(value, ['e', 's', 'r'], true)
  requireText(value.e, 'proof DLEQ e')
  requireText(value.s, 'proof DLEQ s')
  if (value.r !== undefined && value.r !== null) {
    requireText(value.r, 'proof DLEQ r')
  }
}

function decodeWitness(value: unknown): void {
  if (typeof value === 'string') {
    requireText(value, 'proof witness')
    return
  }
  if (!isRecord(value)) throw new Error('custody proof witness is invalid')
  exactKeys(value, ['signatures'])
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length > 16 ||
    value.signatures.length === 0
  ) {
    throw new Error('custody proof witness signatures are invalid')
  }
  value.signatures.forEach((signature) => requireText(signature, 'proof witness signature'))
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1_024) {
    throw new Error(`custody proof operation ${label} is invalid`)
  }
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined) requireText(value, label)
}

function requireSafeLabel(label: string): void {
  if (!label || label === '__proto__' || label === 'prototype' || label === 'constructor') {
    throw new Error('custody proof operation output label is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
