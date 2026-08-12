import { isBlsKeyset, pointFromHexAuto, type Proof } from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DURABLE_CUSTODY_ARTIFACT_DEPTH_LIMIT_MAX,
  DURABLE_CUSTODY_ARTIFACT_NODE_LIMIT_MAX,
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import { amountToNumber } from './proofSelection.ts'
import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationKind,
  CtfProofOperationRecord,
  StoredOutputData,
} from './ctfSplit.ts'

const SECP256K1_SCALAR_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const BLS12_381_SCALAR_ORDER = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n

export type CtfProofOperationCompletion =
  | {
      kind: 'ctf-split' | 'ctf-merge'
      resultProofs: Record<string, Proof[]>
      resultProofsDigest: string
    }
  | {
      kind: 'ctf-redeem' | 'regular-split'
      resultProofs: Record<string, Proof[]>
    }

export function createCtfProofOperationCompletion(
  kind: 'ctf-split' | 'ctf-merge',
  resultProofs: Record<string, Proof[]>,
): Extract<CtfProofOperationCompletion, { resultProofsDigest: string }>
export function createCtfProofOperationCompletion(
  kind: 'ctf-redeem' | 'regular-split',
  resultProofs: Record<string, Proof[]>,
): Extract<CtfProofOperationCompletion, { kind: 'ctf-redeem' | 'regular-split' }>
export function createCtfProofOperationCompletion(
  kind: CtfProofOperationKind,
  resultProofs: Record<string, Proof[]>,
): CtfProofOperationCompletion {
  requireProofGroups(
    resultProofs,
    'proof operation completion',
    DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  )
  canonicalAuthorityBytes({ kind, resultProofs })
  switch (kind) {
    case 'ctf-split':
    case 'ctf-merge':
      return { kind, resultProofs, resultProofsDigest: completedProofAuthorityDigest(resultProofs) }
    case 'ctf-redeem':
    case 'regular-split':
      return { kind, resultProofs }
  }
}

export function requireBoundedCtfProofOperationPreparation(
  input: CtfPrepareProofOperationInput,
): CtfPrepareProofOperationInput {
  requireNonEmptyText(input.operationId, 'proof operation id')
  requireNonEmptyText(input.mintUrl, 'proof operation mint URL')
  requireProofArray(
    input.inputs,
    'proof operation preparation inputs',
    DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  )
  if (!input.outputs || typeof input.outputs !== 'object' || Array.isArray(input.outputs)) {
    throw new Error('proof operation preparation outputs must be an object')
  }
  const outputGroups = Object.entries(input.outputs)
  if (outputGroups.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX) {
    throw new Error('proof operation preparation output group limit exceeded')
  }
  let outputCount = 0
  for (const [group, outputs] of outputGroups) {
    requireNonEmptyText(group, 'proof operation preparation output group')
    if (!Array.isArray(outputs)) {
      throw new Error(`proof operation preparation outputs.${group} must be an array`)
    }
    outputCount += outputs.length
    if (outputCount > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX) {
      throw new Error('proof operation preparation blinded output limit exceeded')
    }
  }
  canonicalAuthorityBytes(input)
  return input
}

export function requireSameOperationAuthority(
  stored: Record<string, unknown>,
  requested: Record<string, unknown>,
  operationId: string,
): void {
  if (canonicalAuthorityFingerprint(stored) !== canonicalAuthorityFingerprint(requested)) {
    throw new Error(`proof operation ${operationId} does not match the current request`)
  }
}

export function proofAuthority(proof: Proof): Record<string, unknown> {
  return {
    id: requireNonEmptyText(proof.id, 'proof keyset id'),
    amount: requirePositiveSafeInteger(amountToNumber(proof.amount), 'proof amount'),
    secret: requireNonEmptyText(proof.secret, 'proof secret'),
    C: requireNonEmptyText(proof.C, 'proof signature'),
    dleq: canonicalAuthorityValue(proof.dleq ?? null),
    p2pk_e: proof.p2pk_e ?? null,
    witness: canonicalAuthorityValue(proof.witness ?? null),
  }
}

export function proofGroupAuthority(groups: Record<string, Proof[]>): Record<string, unknown> {
  const bounded = requireProofGroups(
    groups,
    'proof operation input groups',
    DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  )
  return Object.fromEntries(
    Object.keys(bounded)
      .sort(compareCanonicalText)
      .map((group) => [group, bounded[group]!.map(proofAuthority)]),
  )
}

export function requireProofArray(
  value: unknown,
  context: string,
  maximumProofs = DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
): Proof[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty proof array`)
  }
  if (value.length > maximumProofs) {
    throw new Error(
      `${context} ${maximumProofs === DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ? 'result ' : ''}proof limit exceeded`,
    )
  }
  assertBoundedAuthorityGraph(value, context)
  return value.map((proof, index) => {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error(`${context}[${index}] is invalid`)
    }
    proofAuthority(proof as Proof)
    return {
      ...(proof as Proof),
      amount: amountToNumber((proof as Proof).amount) as never,
    }
  })
}

export function requireProofGroups(
  value: unknown,
  context: string,
  maximumProofs = DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
): Record<string, Proof[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) throw new Error(`${context} must not be empty`)
  if (entries.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX) {
    throw new Error(`${context} group limit exceeded`)
  }
  let proofCount = 0
  for (const [group, proofs] of entries) {
    requireNonEmptyText(group, `${context} group`)
    if (!Array.isArray(proofs) || proofs.length === 0) {
      throw new Error(`${context}.${group} must be a non-empty proof array`)
    }
    proofCount += proofs.length
    if (proofCount > maximumProofs) {
      throw new Error(
        `${context} ${maximumProofs === DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ? 'result ' : ''}proof limit exceeded`,
      )
    }
  }
  assertBoundedAuthorityGraph(value, context)
  return Object.fromEntries(
    entries.map(([group, proofs]) => [
      requireNonEmptyText(group, `${context} group`),
      requireProofArray(proofs, `${context}.${group}`, maximumProofs),
    ]),
  )
}

export function requireStringMapping(value: unknown, context: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) throw new Error(`${context} must not be empty`)
  if (entries.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX) {
    throw new Error(`${context} group limit exceeded`)
  }
  assertBoundedAuthorityGraph(value, context)
  return Object.fromEntries(
    entries.map(([key, mapped]) => [
      requireNonEmptyText(key, `${context} key`),
      requireNonEmptyText(mapped, `${context}.${key}`),
    ]),
  )
}

export function sortedStringMapping(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).sort(([left], [right]) => compareCanonicalText(left, right)),
  )
}

export function completedProofAuthorityDigest(resultProofs: Record<string, Proof[]>): string {
  const bounded = requireProofGroups(
    resultProofs,
    'completed result',
    DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  )
  const authority = Object.fromEntries(
    Object.keys(bounded)
      .sort(compareCanonicalText)
      .map((group) => [group, bounded[group]!.map(proofAuthority)]),
  )
  return proofOperationAuthorityDigest(authority)
}

export function proofOperationAuthorityDigest(value: unknown): string {
  return bytesToHex(sha256(canonicalAuthorityBytes(value)))
}

export function canonicalProofOperationMintIdentity(value: unknown): string {
  const text = requireNonEmptyText(value, 'proof operation mint URL')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('proof operation mint URL is invalid')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    /%[0-9a-f]{2}/i.test(url.pathname)
  ) {
    throw new Error('proof operation mint URL is not canonical')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '' ? '' : path}`
}

export function validateSplitStoredOutputAuthority(
  entry: CtfProofOperationRecord,
  outcomeKeysets: Record<string, string>,
  amountSubunits: number,
): void {
  assertBoundedAuthorityGraph(entry, 'CTF split proof operation record')
  canonicalAuthorityBytes(entry)
  const groups = requireStoredOutputGroups(entry.outputs, 'CTF split stored outputs')
  requireExactGroupKeys(groups, Object.keys(outcomeKeysets), 'CTF split stored outputs')
  for (const [collection, outputs] of Object.entries(groups)) {
    validateOutputDescriptors(outputs, outcomeKeysets[collection]!, amountSubunits, collection)
  }
  if (entry.state === 'completed') {
    validateCompletedResultGroups(entry, groups, outcomeKeysets, 'CTF split completed result')
  }
}

export function validateMergeStoredOutputAuthority(
  entry: CtfProofOperationRecord,
  regularKeysetId: string,
  outputAmountSubunits: number,
): void {
  assertBoundedAuthorityGraph(entry, 'CTF merge proof operation record')
  canonicalAuthorityBytes(entry)
  const groups = requireStoredOutputGroups(entry.outputs, 'CTF merge stored outputs')
  requireExactGroupKeys(groups, ['*'], 'CTF merge stored outputs')
  validateOutputDescriptors(groups['*']!, regularKeysetId, outputAmountSubunits, '*')
  if (entry.state === 'completed') {
    validateCompletedResultGroups(
      entry,
      groups,
      { regular: regularKeysetId },
      'CTF merge completed result',
      { regular: '*' },
    )
  }
}

function requireStoredOutputGroups(
  value: unknown,
  context: string,
): Record<string, StoredOutputData[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length > DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX) {
    throw new Error(`${context} group limit exceeded`)
  }
  let outputCount = 0
  for (const [group, outputs] of entries) {
    if (!Array.isArray(outputs) || outputs.length === 0) {
      throw new Error(`${context}.${group} must be non-empty`)
    }
    outputCount += outputs.length
    if (outputCount > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX) {
      throw new Error(`${context} blinded output limit exceeded`)
    }
  }
  return Object.fromEntries(
    entries.map(([group, outputs]) => {
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw new Error(`${context}.${group} must be non-empty`)
      }
      for (const output of outputs) validateStoredOutputShape(output, `${context}.${group}`)
      return [group, outputs as StoredOutputData[]]
    }),
  )
}

function validateStoredOutputShape(value: unknown, context: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} contains invalid output data`)
  }
  const output = value as StoredOutputData
  requirePositiveSafeInteger(output.blindedMessage?.amount, `${context} amount`)
  const keysetId = requireNonEmptyText(output.blindedMessage?.id, `${context} keyset id`)
  requireCanonicalCurvePoint(output.blindedMessage?.B_, keysetId, `${context} blinded message`)
  requireCanonicalBlindingFactor(output.blindingFactor, keysetId, `${context} blinding factor`)
  requireCanonicalByteHex(output.secret, `${context} secret`)
}

function validateOutputDescriptors(
  outputs: StoredOutputData[],
  expectedKeysetId: string,
  expectedAmount: number,
  group: string,
): void {
  const total = outputs.reduce((sum, output) => sum + output.blindedMessage.amount, 0)
  if (
    total !== expectedAmount ||
    outputs.some((output) => output.blindedMessage.id !== expectedKeysetId)
  ) {
    throw new Error(`stored output authority for ${group} does not match request`)
  }
}

function validateCompletedResultGroups(
  entry: CtfProofOperationRecord,
  outputsByGroup: Record<string, StoredOutputData[]>,
  resultKeysets: Record<string, string>,
  context: string,
  outputGroupByResult: Record<string, string> = {},
): void {
  const results = requireProofGroups(
    entry.resultProofs,
    context,
    DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  )
  if (
    typeof entry.resultProofsDigest !== 'string' ||
    entry.resultProofsDigest !== completedProofAuthorityDigest(results)
  ) {
    throw new Error(`${context} authority digest does not match stored proofs`)
  }
  requireExactGroupKeys(results, Object.keys(resultKeysets), context)
  for (const [resultGroup, proofs] of Object.entries(results)) {
    const outputs = outputsByGroup[outputGroupByResult[resultGroup] ?? resultGroup]!
    if (proofs.length !== outputs.length)
      throw new Error(`${context}.${resultGroup} count mismatch`)
    proofs.forEach((proof, index) => {
      const output = outputs[index]!
      if (
        proof.id !== resultKeysets[resultGroup] ||
        amountToNumber(proof.amount) !== output.blindedMessage.amount ||
        proof.secret !== decodeStoredSecret(output.secret, `${context}.${resultGroup} secret`)
      ) {
        throw new Error(`${context}.${resultGroup} does not match stored outputs`)
      }
      validateCompletedProofShape(proof, `${context}.${resultGroup}`)
    })
  }
}

function validateCompletedProofShape(proof: Proof, context: string): void {
  requireCanonicalCurvePoint(proof.C, proof.id, `${context} signature`)
  if (proof.dleq !== undefined) {
    if (!proof.dleq || typeof proof.dleq !== 'object' || Array.isArray(proof.dleq)) {
      throw new Error(`${context} DLEQ is invalid`)
    }
    requireCanonicalScalarHex(proof.dleq.e, `${context} DLEQ e`)
    requireCanonicalScalarHex(proof.dleq.s, `${context} DLEQ s`)
    if (proof.dleq.r !== undefined) {
      requireCanonicalScalarHex(proof.dleq.r, `${context} DLEQ r`)
    }
  }
  if (proof.p2pk_e !== undefined) {
    requireCanonicalCurvePointKind(proof.p2pk_e, 'secp', `${context} P2BK point`)
  }
}

function requireCanonicalCurvePoint(value: unknown, keysetId: string, context: string): string {
  return requireCanonicalCurvePointKind(value, isBlsKeyset(keysetId) ? 'blsG1' : 'secp', context)
}

function requireCanonicalCurvePointKind(
  value: unknown,
  expectedKind: 'blsG1' | 'secp',
  context: string,
): string {
  const encoded = requireNonEmptyText(value, context)
  let point: ReturnType<typeof pointFromHexAuto>
  try {
    point = pointFromHexAuto(encoded)
  } catch {
    throw new Error(`${context} must be a canonical curve point`)
  }
  if (point.kind !== expectedKind || point.pt.toHex(true) !== encoded) {
    throw new Error(`${context} must match the keyset curve and canonical encoding`)
  }
  return encoded
}

function requireCanonicalBlindingFactor(value: unknown, keysetId: string, context: string): string {
  const encoded = requireNonEmptyText(value, context)
  if (!/^[1-9a-f][0-9a-f]{0,63}$/.test(encoded)) {
    throw new Error(`${context} must be canonical bounded nonzero lowercase hex`)
  }
  const scalar = BigInt(`0x${encoded}`)
  const scalarOrder = isBlsKeyset(keysetId) ? BLS12_381_SCALAR_ORDER : SECP256K1_SCALAR_ORDER
  if (scalar >= scalarOrder) {
    throw new Error(`${context} must be below the keyset curve scalar order`)
  }
  return encoded
}

function requireCanonicalScalarHex(value: unknown, context: string): string {
  const encoded = requireNonEmptyText(value, context)
  if (!/^[0-9a-f]{64}$/.test(encoded)) {
    throw new Error(`${context} must be canonical 32-byte lowercase hex`)
  }
  return encoded
}

function requireCanonicalByteHex(value: unknown, context: string): string {
  const encoded = requireNonEmptyText(value, context)
  if (!/^(?:[0-9a-f]{2})+$/.test(encoded)) {
    throw new Error(`${context} must be canonical non-empty byte hex`)
  }
  return encoded
}

function decodeStoredSecret(encoded: string, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(encoded))
  } catch {
    throw new Error(`${context} is not canonical UTF-8`)
  }
}

function requireExactGroupKeys(
  groups: Record<string, unknown>,
  expected: string[],
  context: string,
): void {
  const actualKeys = Object.keys(groups).sort()
  const expectedKeys = [...expected].sort()
  if (canonicalAuthorityFingerprint(actualKeys) !== canonicalAuthorityFingerprint(expectedKeys)) {
    throw new Error(`${context} groups do not match request`)
  }
}

function canonicalAuthorityFingerprint(value: unknown): string {
  return new TextDecoder().decode(canonicalAuthorityBytes(value))
}

function canonicalAuthorityBytes(value: unknown): Uint8Array {
  assertBoundedAuthorityGraph(value, 'proof operation authority')
  return encodeBoundedDurableArtifact(
    canonicalAuthorityValue(value),
    DURABLE_CUSTODY_RECORD_BYTES_MAX,
  )
}

function canonicalAuthorityValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('operation authority contains invalid number')
    return value
  }
  if (typeof value === 'bigint') return { bigint: value.toString(10) }
  if (value instanceof Uint8Array) return { bytes: bytesToHex(value) }
  if (Array.isArray(value)) return value.map(canonicalAuthorityValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, child]) => [key, canonicalAuthorityValue(child)]),
    )
  }
  throw new Error('operation authority contains unsupported value')
}

function requireNonEmptyText(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX
  ) {
    if (typeof value === 'string' && value.length > 0) {
      throw new Error(`${context} string limit exceeded`)
    }
    throw new Error(`${context} must be a non-empty string`)
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive safe integer`)
  }
  return value as number
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertBoundedAuthorityGraph(value: unknown, context: string): void {
  const stack: Array<{ value: unknown; depth: number; exiting?: boolean }> = [{ value, depth: 0 }]
  const ancestors = new WeakSet<object>()
  const encoder = new TextEncoder()
  let nodes = 0
  let estimatedBytes = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.exiting) {
      ancestors.delete(current.value as object)
      continue
    }
    nodes += 1
    if (
      nodes > DURABLE_CUSTODY_ARTIFACT_NODE_LIMIT_MAX ||
      current.depth > DURABLE_CUSTODY_ARTIFACT_DEPTH_LIMIT_MAX
    ) {
      throw new Error(`${context} structure limit exceeded`)
    }
    const item = current.value
    if (item === null) {
      estimatedBytes += 4
    } else if (item === undefined) {
      estimatedBytes += 5
    } else if (typeof item === 'boolean') {
      estimatedBytes += item ? 4 : 5
    } else if (typeof item === 'string') {
      const bytes = encoder.encode(item).length
      if (bytes > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX) {
        throw new Error(`${context} string limit exceeded`)
      }
      estimatedBytes += encoder.encode(JSON.stringify(item)).length
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`${context} contains invalid number`)
      estimatedBytes += String(item).length
    } else if (typeof item === 'bigint') {
      estimatedBytes += item.toString(10).length + 13
    } else if (item instanceof Uint8Array) {
      estimatedBytes += item.byteLength * 2 + 12
    } else if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new Error(`${context} contains a cycle`)
      ancestors.add(item)
      stack.push({ value: item, depth: current.depth, exiting: true })
      estimatedBytes += item.length === 0 ? 2 : item.length + 1
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 })
    } else if (item && typeof item === 'object') {
      if (ancestors.has(item)) throw new Error(`${context} contains a cycle`)
      ancestors.add(item)
      stack.push({ value: item, depth: current.depth, exiting: true })
      const entries = Object.entries(item).filter(([, child]) => child !== undefined)
      estimatedBytes += entries.length === 0 ? 2 : entries.length + 1
      for (const [key, child] of entries) {
        const keyBytes = encoder.encode(key).length
        if (keyBytes > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX) {
          throw new Error(`${context} string limit exceeded`)
        }
        estimatedBytes += encoder.encode(JSON.stringify(key)).length + 1
        stack.push({ value: child, depth: current.depth + 1 })
      }
    } else {
      throw new Error(`${context} contains unsupported value`)
    }
    if (estimatedBytes > DURABLE_CUSTODY_RECORD_BYTES_MAX) {
      throw new Error(`${context} byte limit exceeded`)
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
