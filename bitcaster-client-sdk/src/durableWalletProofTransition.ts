import { amountToNumber } from './proofSelection.ts'

export const DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY =
  'durableWalletProofTransition'

export type DurableWalletProofInputSource = 'wallet' | 'external'

export type DurableWalletProofResultDisposition =
  | {
      kind: 'wallet'
      asset: 'regular' | 'conditional'
      reservedBy: string | null
    }
  | { kind: 'operation' }

export interface DurableWalletProofTransition {
  schemaVersion: 1
  inputSource: DurableWalletProofInputSource
  resultGroups: Readonly<Record<string, DurableWalletProofResultDisposition>>
  passthroughResultGroups: Readonly<
    Record<string, readonly DurableWalletProofIdentity[]>
  >
  resultCardinality: Readonly<Record<string, 'exact' | 'prefix'>>
}

export interface DurableWalletProofIdentity {
  id: string
  amount: number
  secret: string
  C: string
}

export interface DurableWalletPlannedOutput {
  secret: string
  blindedMessage: { id: string; amount: unknown }
}

export interface DurableWalletResultProof {
  id?: string
  amount: unknown
  secret: string
  C: string
}

/** Builds the exact native-wallet delta policy persisted with one mint request. */
export function createDurableWalletProofTransition(input: {
  inputSource: DurableWalletProofInputSource
  plannedOutputLabels: readonly string[]
  resultGroups: Readonly<Record<string, DurableWalletProofResultDisposition>>
  passthroughResultGroups?: Readonly<
    Record<string, readonly DurableWalletResultProof[]>
  >
  resultCardinality?: Readonly<Record<string, 'exact' | 'prefix'>>
}): DurableWalletProofTransition {
  const policy: DurableWalletProofTransition = {
    schemaVersion: 1,
    inputSource: input.inputSource,
    resultGroups: structuredClone(input.resultGroups),
    passthroughResultGroups: normalizePassthroughResultGroups(
      input.passthroughResultGroups ?? {},
    ),
    resultCardinality: Object.fromEntries(
      input.plannedOutputLabels.map((label) => [
        label,
        input.resultCardinality?.[label] ?? 'exact',
      ]),
    ),
  }
  assertDurableWalletProofTransition(policy, input.plannedOutputLabels)
  return policy
}

/** Adds the shared policy without allowing a caller to overwrite one in metadata. */
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

/** Reads and validates the exact persisted policy against the planned outputs. */
export function requireDurableWalletProofTransition(
  metadata: Readonly<Record<string, unknown>>,
  plannedOutputLabels: readonly string[],
): DurableWalletProofTransition {
  const value = metadata[DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY]
  assertDurableWalletProofTransition(value, plannedOutputLabels)
  return structuredClone(value)
}

/** A mint result must contain every planned group and no unplanned group. */
export function assertDurableWalletProofResultGroups(
  policy: DurableWalletProofTransition,
  resultLabels: readonly string[],
): void {
  assertSameLabels(Object.keys(policy.resultGroups), resultLabels)
}

/** Exact passthrough proofs that must appear unchanged in mint result groups. */
export function durableWalletPassthroughProofs(
  policy: DurableWalletProofTransition,
): DurableWalletProofIdentity[] {
  return Object.values(policy.passthroughResultGroups).flatMap((proofs) =>
    structuredClone(proofs),
  )
}

/** Validates each mint result against blinded outputs plus exact passthroughs. */
export function assertDurableWalletProofResultMatchesPlan(
  policy: DurableWalletProofTransition,
  outputs: Readonly<Record<string, readonly DurableWalletPlannedOutput[]>>,
  results: Readonly<Record<string, readonly DurableWalletResultProof[]>>,
): void {
  assertDurableWalletProofResultGroups(policy, Object.keys(results))
  const expectedSecrets = new Set<string>()
  const actualSecrets = new Set<string>()
  for (const label of Object.keys(policy.resultGroups)) {
    assertResultGroupMatchesPlan(
      outputs[label] ?? [],
      policy.passthroughResultGroups[label] ?? [],
      results[label] ?? [],
      policy.resultCardinality[label]!,
      expectedSecrets,
      actualSecrets,
    )
  }
}

function assertDurableWalletProofTransition(
  value: unknown,
  plannedOutputLabels: readonly string[],
): asserts value is DurableWalletProofTransition {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('wallet proof transition metadata is invalid')
  }
  switch (value.inputSource) {
    case 'wallet':
    case 'external':
      break
    default:
      throw new Error('wallet proof transition input source is invalid')
  }
  if (!isRecord(value.resultGroups)) {
    throw new Error('wallet proof transition result groups are invalid')
  }
  if (!isRecord(value.passthroughResultGroups)) {
    throw new Error('wallet proof passthrough groups are invalid')
  }
  if (!isRecord(value.resultCardinality)) {
    throw new Error('wallet proof result cardinality is invalid')
  }
  if (
    Object.keys(value).length !== 5 ||
    Object.keys(value).some(
      (key) =>
        key !== 'schemaVersion' &&
        key !== 'inputSource' &&
        key !== 'resultGroups' &&
        key !== 'passthroughResultGroups' &&
        key !== 'resultCardinality',
    )
  ) {
    throw new Error('wallet proof transition contains foreign fields')
  }
  for (const [label, disposition] of Object.entries(value.resultGroups)) {
    assertLabel(label)
    assertResultDisposition(disposition)
  }
  assertSameLabels(Object.keys(value.resultGroups), plannedOutputLabels)
  assertResultCardinality(value.resultCardinality, plannedOutputLabels)
  assertPassthroughResultGroups(
    value.resultGroups,
    value.passthroughResultGroups,
  )
  assertPrefixHasNoPassthrough(
    value.resultCardinality,
    value.passthroughResultGroups,
  )
}

function assertResultCardinality(
  cardinality: Record<string, unknown>,
  plannedOutputLabels: readonly string[],
): void {
  assertSameLabels(Object.keys(cardinality), plannedOutputLabels)
  for (const value of Object.values(cardinality)) {
    if (value !== 'exact' && value !== 'prefix') {
      throw new Error('wallet proof result cardinality is invalid')
    }
  }
}

function assertPrefixHasNoPassthrough(
  cardinality: Record<string, unknown>,
  passthroughs: Record<string, unknown>,
): void {
  for (const [label, value] of Object.entries(cardinality)) {
    if (
      value === 'prefix' &&
      Array.isArray(passthroughs[label]) &&
      passthroughs[label].length > 0
    ) {
      throw new Error('prefix proof result cannot contain passthrough proofs')
    }
  }
}

function assertPassthroughResultGroups(
  resultGroups: Record<string, unknown>,
  passthroughResultGroups: Record<string, unknown>,
): void {
  const secrets = new Set<string>()
  for (const [label, values] of Object.entries(passthroughResultGroups)) {
    assertLabel(label)
    if (!resultGroups[label] || !Array.isArray(values)) {
      throw new Error('wallet proof passthrough group is not planned')
    }
    values.forEach((value) => {
      assertProofIdentity(value)
      if (secrets.has(value.secret)) {
        throw new Error('wallet proof passthrough contains duplicate proofs')
      }
      secrets.add(value.secret)
    })
  }
}

function normalizePassthroughResultGroups(
  groups: Readonly<Record<string, readonly DurableWalletResultProof[]>>,
): Record<string, DurableWalletProofIdentity[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, proofs]) => [
      label,
      proofs.map(normalizeProofIdentity),
    ]),
  )
}

function normalizeProofIdentity(
  proof: DurableWalletResultProof,
): DurableWalletProofIdentity {
  if (!proof.id) throw new Error('wallet proof passthrough keyset is invalid')
  const normalized = {
    id: proof.id,
    amount: amountToNumber(proof.amount),
    secret: proof.secret,
    C: proof.C,
  }
  assertProofIdentity(normalized)
  return normalized
}

function assertProofIdentity(
  value: unknown,
): asserts value is DurableWalletProofIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !Number.isSafeInteger(value.amount) ||
    (value.amount as number) <= 0 ||
    typeof value.secret !== 'string' ||
    value.secret.length === 0 ||
    typeof value.C !== 'string' ||
    value.C.length === 0
  ) {
    throw new Error('wallet proof passthrough identity is invalid')
  }
}

function assertResultGroupMatchesPlan(
  outputs: readonly DurableWalletPlannedOutput[],
  passthroughs: readonly DurableWalletProofIdentity[],
  results: readonly DurableWalletResultProof[],
  cardinality: 'exact' | 'prefix',
  expectedSecrets: Set<string>,
  actualSecrets: Set<string>,
): void {
  if (cardinality === 'prefix') {
    assertPrefixResultGroup(outputs, results, expectedSecrets, actualSecrets)
    return
  }
  if (results.length !== outputs.length + passthroughs.length) {
    throw new Error('wallet proof result count does not match its exact plan')
  }
  const bySecret = new Map(results.map((proof) => [proof.secret, proof]))
  if (bySecret.size !== results.length) {
    throw new Error('wallet proof result contains duplicate proofs')
  }
  outputs.forEach((output) =>
    assertPlannedOutputResult(
      output,
      bySecret,
      false,
      expectedSecrets,
      actualSecrets,
    ),
  )
  passthroughs.forEach((proof) =>
    assertPassthroughResult(proof, bySecret, expectedSecrets, actualSecrets),
  )
}

function assertPrefixResultGroup(
  outputs: readonly DurableWalletPlannedOutput[],
  results: readonly DurableWalletResultProof[],
  expectedSecrets: Set<string>,
  actualSecrets: Set<string>,
): void {
  if (results.length > outputs.length) {
    throw new Error('wallet proof result exceeds its planned prefix')
  }
  const bySecret = new Map(results.map((proof) => [proof.secret, proof]))
  if (bySecret.size !== results.length) {
    throw new Error('wallet proof result contains duplicate proofs')
  }
  for (let index = 0; index < results.length; index += 1) {
    const output = outputs[index]!
    if (results[index]!.secret !== output.secret) {
      throw new Error(
        'wallet proof result prefix does not match its exact plan',
      )
    }
    assertPlannedOutputResult(
      output,
      bySecret,
      true,
      expectedSecrets,
      actualSecrets,
    )
  }
}

function assertPlannedOutputResult(
  output: DurableWalletPlannedOutput,
  results: ReadonlyMap<string, DurableWalletResultProof>,
  allowBlankAmount: boolean,
  expectedSecrets: Set<string>,
  actualSecrets: Set<string>,
): void {
  const proof = results.get(output.secret)
  if (
    !proof ||
    proof.id !== output.blindedMessage.id ||
    ((!allowBlankAmount ||
      amountToNumber(output.blindedMessage.amount) !== 0) &&
      amountToNumber(proof.amount) !==
        amountToNumber(output.blindedMessage.amount))
  ) {
    throw new Error('wallet proof result does not match a planned output')
  }
  assertUniqueResultSecret(output.secret, expectedSecrets, actualSecrets)
}

function assertPassthroughResult(
  expected: DurableWalletProofIdentity,
  results: ReadonlyMap<string, DurableWalletResultProof>,
  expectedSecrets: Set<string>,
  actualSecrets: Set<string>,
): void {
  const proof = results.get(expected.secret)
  if (
    !proof ||
    proof.id !== expected.id ||
    proof.C !== expected.C ||
    amountToNumber(proof.amount) !== expected.amount
  ) {
    throw new Error('wallet proof passthrough result is not exact')
  }
  assertUniqueResultSecret(expected.secret, expectedSecrets, actualSecrets)
}

function assertUniqueResultSecret(
  secret: string,
  expectedSecrets: Set<string>,
  actualSecrets: Set<string>,
): void {
  if (expectedSecrets.has(secret) || actualSecrets.has(secret)) {
    throw new Error('wallet proof plan reuses a proof secret')
  }
  expectedSecrets.add(secret)
  actualSecrets.add(secret)
}

function assertResultDisposition(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('wallet proof result disposition is invalid')
  }
  switch (value.kind) {
    case 'operation':
      if (Object.keys(value).length !== 1) {
        throw new Error('operation-only proof result has foreign fields')
      }
      return
    case 'wallet':
      if (
        Object.keys(value).length !== 3 ||
        (value.asset !== 'regular' && value.asset !== 'conditional') ||
        (value.reservedBy !== null &&
          (typeof value.reservedBy !== 'string' ||
            value.reservedBy.length === 0))
      ) {
        throw new Error('wallet proof result reservation is invalid')
      }
      return
    default:
      throw new Error('wallet proof result disposition is invalid')
  }
}

function assertSameLabels(
  expectedLabels: readonly string[],
  actualLabels: readonly string[],
): void {
  const expected = normalizedLabels(expectedLabels)
  const actual = normalizedLabels(actualLabels)
  if (
    expected.length !== actual.length ||
    expected.some((label, index) => label !== actual[index])
  ) {
    throw new Error('wallet proof transition result labels are invalid')
  }
}

function normalizedLabels(labels: readonly string[]): string[] {
  const normalized = labels.map((label) => {
    assertLabel(label)
    return label
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('wallet proof transition contains duplicate result labels')
  }
  return normalized.sort()
}

function assertLabel(label: string): void {
  if (
    label.length === 0 ||
    label === '__proto__' ||
    label === 'constructor' ||
    label === 'prototype'
  ) {
    throw new Error('wallet proof transition result label is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
