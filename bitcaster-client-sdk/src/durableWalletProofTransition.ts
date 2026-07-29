// Re-authored from the persistence-neutral wallet transition at 7e1385c.
import { amountToNumber } from './proofSelection.ts'
import {
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'

export const DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY = 'durableWalletProofTransition'

export type DurableWalletProofInputSource = 'wallet' | 'external'
export type DurableWalletProofResultDisposition =
  | {
      kind: 'wallet'
      asset: 'regular' | 'conditional'
      reservedBy: string | null
    }
  | { kind: 'operation' }

export interface DurableWalletProofIdentity {
  id: string
  amount: number
  secret: string
  C: string
  dleq?: unknown
  p2pk_e?: string
  witness?: unknown
}

export interface DurableWalletProofTransition {
  schemaVersion: 1
  inputSource: DurableWalletProofInputSource
  resultGroups: Readonly<Record<string, DurableWalletProofResultDisposition>>
  passthroughResultGroups: Readonly<Record<string, readonly DurableWalletProofIdentity[]>>
  resultCardinality: Readonly<Record<string, DurableWalletResultCardinality>>
}

export type DurableWalletResultCardinality = 'exact' | 'prefix' | 'subset'

export interface DurableWalletPlannedOutput {
  secret: string
  blindedMessage: { id: string; amount: unknown }
}

export interface DurableWalletResultProof {
  id?: string
  amount: unknown
  secret: string
  C: string
  dleq?: unknown
  p2pk_e?: string
  witness?: unknown
}

export function createDurableWalletProofTransition(input: {
  inputSource: DurableWalletProofInputSource
  plannedOutputLabels: readonly string[]
  resultGroups: Readonly<Record<string, DurableWalletProofResultDisposition>>
  passthroughResultGroups?: Readonly<Record<string, readonly DurableWalletResultProof[]>>
  resultCardinality?: Readonly<Record<string, DurableWalletResultCardinality>>
}): DurableWalletProofTransition {
  if (
    input.plannedOutputLabels.length === 0 ||
    input.plannedOutputLabels.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX
  ) {
    throw new Error('wallet proof transition group limit exceeded')
  }
  const passthroughCount = Object.values(input.passthroughResultGroups ?? {}).reduce(
    (total, proofs) => total + proofs.length,
    0,
  )
  if (passthroughCount > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX) {
    throw new Error('wallet proof transition passthrough limit exceeded')
  }
  const value: DurableWalletProofTransition = {
    schemaVersion: 1,
    inputSource: input.inputSource,
    resultGroups: structuredClone(input.resultGroups),
    passthroughResultGroups: Object.fromEntries(
      Object.entries(input.passthroughResultGroups ?? {}).map(([label, proofs]) => [
        label,
        proofs.map(normalizeProof),
      ]),
    ),
    resultCardinality: Object.fromEntries(
      input.plannedOutputLabels.map((label) => [
        label,
        input.resultCardinality?.[label] ?? 'exact',
      ]),
    ),
  }
  assertTransition(value, input.plannedOutputLabels)
  return value
}

export function addDurableWalletProofTransitionMetadata(
  metadata: Readonly<Record<string, unknown>>,
  policy: DurableWalletProofTransition,
): Record<string, unknown> {
  if (metadata[DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY] !== undefined) {
    throw new Error('wallet proof transition metadata is already defined')
  }
  return {
    ...structuredClone(metadata),
    [DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY]: structuredClone(policy),
  }
}

export function requireDurableWalletProofTransition(
  metadata: Readonly<Record<string, unknown>>,
  labels: readonly string[],
): DurableWalletProofTransition {
  const value = metadata[DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY]
  assertTransition(value, labels)
  return structuredClone(value)
}

export function assertDurableWalletProofResultGroups(
  policy: DurableWalletProofTransition,
  labels: readonly string[],
): void {
  assertSameLabels(Object.keys(policy.resultGroups), labels)
}

export function durableWalletPassthroughProofs(
  policy: DurableWalletProofTransition,
): DurableWalletProofIdentity[] {
  return Object.values(policy.passthroughResultGroups).flatMap((proofs) => structuredClone(proofs))
}

export function assertDurableWalletProofResultMatchesPlan(
  policy: DurableWalletProofTransition,
  outputs: Readonly<Record<string, readonly DurableWalletPlannedOutput[]>>,
  results: Readonly<Record<string, readonly DurableWalletResultProof[]>>,
): void {
  const resultCount = Object.values(results).reduce((total, proofs) => total + proofs.length, 0)
  if (resultCount > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX) {
    throw new Error('wallet proof transition result limit exceeded')
  }
  assertDurableWalletProofResultGroups(policy, Object.keys(results))
  const seen = new Set<string>()
  for (const label of Object.keys(policy.resultGroups)) {
    const planned = outputs[label] ?? []
    const passthrough = policy.passthroughResultGroups[label] ?? []
    const actual = results[label] ?? []
    const cardinality = policy.resultCardinality[label]
    if (cardinality === 'prefix') {
      if (passthrough.length > 0 || actual.length > planned.length) {
        throw new Error('wallet proof result exceeds its planned prefix')
      }
      actual.forEach((proof, index) => assertPlannedProof(planned[index]!, proof, seen))
      continue
    }
    if (cardinality === 'subset') {
      assertSubsetProofs(planned, passthrough, actual, seen)
      continue
    }
    if (actual.length !== planned.length + passthrough.length) {
      throw new Error('wallet proof result count does not match its exact plan')
    }
    const bySecret = new Map(actual.map((proof) => [proof.secret, proof]))
    if (bySecret.size !== actual.length) {
      throw new Error('wallet proof result contains duplicate proofs')
    }
    planned.forEach((output) => {
      const proof = bySecret.get(output.secret)
      if (!proof) throw new Error('wallet proof result does not match a planned output')
      assertPlannedProof(output, proof, seen)
    })
    passthrough.forEach((expected) => {
      const proof = bySecret.get(expected.secret)
      if (!proof || canonicalJson(normalizeProof(proof)) !== canonicalJson(expected)) {
        throw new Error('wallet proof passthrough result is not exact')
      }
      assertUnique(expected.secret, seen)
    })
  }
}

function assertSubsetProofs(
  planned: readonly DurableWalletPlannedOutput[],
  passthrough: readonly DurableWalletProofIdentity[],
  actual: readonly DurableWalletResultProof[],
  seen: Set<string>,
): void {
  if (passthrough.length > 0 || actual.length > planned.length) {
    throw new Error('wallet proof result exceeds its planned subset')
  }
  const bySecret = new Map(planned.map((output) => [output.secret, output]))
  if (bySecret.size !== planned.length) {
    throw new Error('wallet proof plan reuses a proof secret')
  }
  actual.forEach((proof) => {
    const output = bySecret.get(proof.secret)
    if (!output) throw new Error('wallet proof result is outside its planned subset')
    assertPlannedProof(output, proof, seen)
  })
}

function assertPlannedProof(
  output: DurableWalletPlannedOutput,
  proof: DurableWalletResultProof,
  seen: Set<string>,
): void {
  if (
    proof.secret !== output.secret ||
    proof.id !== output.blindedMessage.id ||
    amountToNumber(proof.amount) !== amountToNumber(output.blindedMessage.amount)
  ) {
    throw new Error('wallet proof result does not match a planned output')
  }
  assertUnique(output.secret, seen)
}

function assertUnique(secret: string, seen: Set<string>): void {
  if (seen.has(secret)) throw new Error('wallet proof plan reuses a proof secret')
  seen.add(secret)
}

function normalizeProof(proof: DurableWalletResultProof): DurableWalletProofIdentity {
  encodeBoundedDurableArtifact(proof, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)
  if (!proof.id) throw new Error('wallet proof passthrough keyset is invalid')
  const value: DurableWalletProofIdentity = {
    id: proof.id,
    amount: amountToNumber(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.p2pk_e === undefined ? {} : { p2pk_e: proof.p2pk_e }),
    ...(proof.witness === undefined ? {} : { witness: structuredClone(proof.witness) }),
  }
  assertProof(value)
  return value
}

function assertTransition(
  value: unknown,
  labels: readonly string[],
): asserts value is DurableWalletProofTransition {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('wallet proof transition metadata is invalid')
  }
  if (labels.length === 0 || labels.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX) {
    throw new Error('wallet proof transition group limit exceeded')
  }
  assertExactKeys(value, [
    'schemaVersion',
    'inputSource',
    'resultGroups',
    'passthroughResultGroups',
    'resultCardinality',
  ])
  if (value.inputSource !== 'wallet' && value.inputSource !== 'external') {
    throw new Error('wallet proof transition input source is invalid')
  }
  if (
    !isRecord(value.resultGroups) ||
    !isRecord(value.passthroughResultGroups) ||
    !isRecord(value.resultCardinality)
  ) {
    throw new Error('wallet proof transition groups are invalid')
  }
  assertSameLabels(Object.keys(value.resultGroups), labels)
  assertSameLabels(Object.keys(value.resultCardinality), labels)
  for (const [label, disposition] of Object.entries(value.resultGroups)) {
    assertLabel(label)
    if (!isRecord(disposition)) {
      throw new Error('wallet proof result disposition is invalid')
    }
    if (disposition.kind === 'operation') {
      assertExactKeys(disposition, ['kind'])
    } else if (disposition.kind === 'wallet') {
      assertExactKeys(disposition, ['kind', 'asset', 'reservedBy'])
      if (
        (disposition.asset !== 'regular' && disposition.asset !== 'conditional') ||
        (disposition.reservedBy !== null &&
          (typeof disposition.reservedBy !== 'string' || disposition.reservedBy.length === 0))
      ) {
        throw new Error('wallet proof result reservation is invalid')
      }
    } else {
      throw new Error('wallet proof result disposition is invalid')
    }
  }
  for (const [label, proofs] of Object.entries(value.passthroughResultGroups)) {
    assertLabel(label)
    if (!(label in value.resultGroups) || !Array.isArray(proofs)) {
      throw new Error('wallet proof passthrough group is not planned')
    }
    proofs.forEach(assertProof)
  }
  if (
    Object.values(value.passthroughResultGroups).reduce<number>(
      (total, proofs) => total + (Array.isArray(proofs) ? proofs.length : 0),
      0,
    ) > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX
  ) {
    throw new Error('wallet proof transition passthrough limit exceeded')
  }
  for (const [label, cardinality] of Object.entries(value.resultCardinality)) {
    if (cardinality !== 'exact' && cardinality !== 'prefix' && cardinality !== 'subset') {
      throw new Error('wallet proof result cardinality is invalid')
    }
    if (
      cardinality !== 'exact' &&
      Array.isArray(value.passthroughResultGroups[label]) &&
      value.passthroughResultGroups[label].length > 0
    ) {
      throw new Error('non-exact proof result cannot contain passthrough proofs')
    }
  }
}

function assertProof(value: unknown): asserts value is DurableWalletProofIdentity {
  if (!isRecord(value)) throw new Error('wallet proof passthrough identity is invalid')
  assertExactKeys(value, ['id', 'amount', 'secret', 'C', 'dleq', 'p2pk_e', 'witness'], true)
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !Number.isSafeInteger(value.amount) ||
    (value.amount as number) <= 0 ||
    typeof value.secret !== 'string' ||
    value.secret.length === 0 ||
    typeof value.C !== 'string' ||
    value.C.length === 0 ||
    (value.p2pk_e !== undefined && typeof value.p2pk_e !== 'string')
  ) {
    throw new Error('wallet proof passthrough identity is invalid')
  }
}

function assertSameLabels(expected: readonly string[], actual: readonly string[]): void {
  const left = expected.map(validateLabel).sort()
  const right = actual.map(validateLabel).sort()
  if (left.length !== right.length || left.some((label, i) => label !== right[i])) {
    throw new Error('wallet proof transition result labels are invalid')
  }
}

function validateLabel(label: string): string {
  assertLabel(label)
  return label
}

function assertLabel(label: string): void {
  if (!label || label === '__proto__' || label === 'constructor' || label === 'prototype') {
    throw new Error('wallet proof transition result label is invalid')
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): void {
  const allowed = new Set(keys)
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    (!optional && Object.keys(value).length !== keys.length)
  ) {
    throw new Error('wallet proof transition contains foreign fields')
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
