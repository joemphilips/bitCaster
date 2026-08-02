import { splitAmount, type Proof } from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DURABLE_ARTIFACT_BYTES_LIMIT_MAX,
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import { proofAuthority } from './ctfProofOperationAuthority.ts'
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  subtractProofs,
  sumProofs,
  takeProofsForLock,
} from './proofSelection.ts'
import type { CtfRangeCapabilitySourceKeyset } from './ctfRangeCapabilitySourcePlan.ts'

export const CTF_RANGE_BATCH_INPUT_LIMIT_MAX = 64
export const CTF_RANGE_BATCH_POOL_ENTRY_LIMIT_MAX = 128

interface CtfRangeCapabilityBatchChildBase {
  readonly route: string
  readonly price: string
  readonly amount: string
  readonly clientOrderId: string
  readonly authorizationAmounts: readonly string[]
  readonly poolEntryCount: number
}

export type CtfRangeCapabilityBatchChild = CtfRangeCapabilityBatchChildBase &
  (
    | {
        readonly side: 'Buy'
        readonly offeredAsset: 'collateral'
        readonly offeredKeyset: CtfRangeCapabilitySourceKeyset
      }
    | {
        readonly side: 'Sell'
        readonly offeredAsset: 'conditional'
        readonly offeredKeyset: CtfRangeCapabilitySourceKeyset
        readonly complementKeyset: CtfRangeCapabilitySourceKeyset
      }
  )

export interface CtfRangeCapabilityBatchLimits {
  readonly maxInputs: number
  readonly maxOutputs: number
  readonly maxRequestBytes: number
  readonly maxPoolEntries: number
}

export interface CtfRangeCapabilityOutputAllocation {
  readonly outputIndex: number
  readonly role: 'authorization' | 'complement' | 'change'
  readonly keysetId: string
  readonly amount: number
  readonly clientOrderId: string | null
}

export interface CtfRangeCapabilityParentMeasureInput {
  readonly kind: 'same-keyset-swap' | 'collateral-ctf-convert'
  readonly sourceKeysetId: string
  readonly sourceKeyset: CtfRangeCapabilitySourceKeyset
  readonly children: readonly CtfRangeCapabilityBatchChild[]
  readonly inputs: readonly Proof[]
  readonly inputFee: number
  readonly outputs: readonly CtfRangeCapabilityOutputAllocation[]
}

export interface CtfRangeCapabilityBatchParent extends CtfRangeCapabilityParentMeasureInput {
  readonly requestBytes: number
  /** Binds the planning authority. The request codec must create its own exact request digest. */
  readonly parentDigest: string
}

export interface CtfRangeCapabilitySourcePartition {
  readonly sourceKind: CtfRangeCapabilityBatchParent['kind']
  readonly sourceKeysetId: string
  readonly childIds: readonly string[]
}

export interface CtfRangeCapabilityBatchPlan {
  readonly canonicalChildIds: readonly string[]
  readonly parents: readonly CtfRangeCapabilityBatchParent[]
  readonly omissions: readonly CtfRangeCapabilityBatchOmission[]
  readonly sourcePartitions: readonly CtfRangeCapabilitySourcePartition[]
  readonly mintMutationCount: number
  readonly packingDigest: string
}

export type CtfRangeCapabilityBatchOmission =
  | {
      readonly clientOrderId: string
      readonly reason: Exclude<
        CtfRangeCapabilityBatchOmissionReason,
        'preferred source consolidation required'
      >
    }
  | {
      readonly clientOrderId: string
      readonly reason: 'preferred source consolidation required'
      readonly sourceKeysetId: string
      readonly selectedInputCount: number
      readonly inputLimit: number
    }

export interface CtfRangeCapabilityBatchPlanInput {
  readonly children: readonly CtfRangeCapabilityBatchChild[]
  readonly collateralKeyset: CtfRangeCapabilitySourceKeyset
  readonly collateralProofs: readonly Proof[]
  readonly conditionalProofs: readonly Proof[]
  readonly limits: CtfRangeCapabilityBatchLimits
  /**
   * Measure the exact candidate with the parent request codec.
   * The trusted SDK codec must not mutate the readonly candidate.
   * The codec must serialize and check the final request again before persistence or mint I/O.
   */
  readonly measureExactParentRequestBytes: (
    candidate: CtfRangeCapabilityParentMeasureInput,
  ) => number
}

type ParentProbe =
  | { readonly kind: 'fit'; readonly candidate: ParentCandidate }
  | {
      readonly kind: 'rejected'
      readonly reason: 'input limit'
      readonly selectedInputCount: number
    }
  | {
      readonly kind: 'rejected'
      readonly reason: Exclude<ParentRejectReason, 'input limit'>
    }

type ParentCandidate = CtfRangeCapabilityParentMeasureInput & { readonly requestBytes: number }

export type CtfRangeCapabilityBatchOmissionReason =
  | 'source inventory'
  | 'input limit'
  | 'output limit'
  | 'request byte limit'
  | 'pool entry limit'
  | 'preferred source consolidation required'

type ParentRejectReason = Exclude<
  CtfRangeCapabilityBatchOmissionReason,
  'pool entry limit' | 'preferred source consolidation required'
>

export function planCtfRangeCapabilityBatches(
  input: CtfRangeCapabilityBatchPlanInput,
): CtfRangeCapabilityBatchPlan {
  const limits = validateLimits(input.limits)
  const children = canonicalChildren(input.children, input.collateralKeyset)
  const eligible = children.filter((child) => child.poolEntryCount <= limits.maxPoolEntries)
  const poolOmissions: CtfRangeCapabilityBatchOmission[] = children
    .filter((child) => child.poolEntryCount > limits.maxPoolEntries)
    .map(({ clientOrderId }) => ({ clientOrderId, reason: 'pool entry limit' }))
  assertUniqueProofs([...input.collateralProofs, ...input.conditionalProofs])
  const conditional = canonicalProofs(input.conditionalProofs, 'conditional')
  const collateral = canonicalProofs(input.collateralProofs, 'collateral')
  assertProofPartitions(collateral, conditional, input.collateralKeyset.id)
  const reused = planConditionalParents(
    eligible,
    conditional,
    limits,
    input.measureExactParentRequestBytes,
  )
  const collateralPlan = planCollateralParents(
    reused.remaining,
    collateral,
    input.collateralKeyset,
    limits,
    input.measureExactParentRequestBytes,
  )
  const childIndex = new Map(children.map((child, index) => [child.clientOrderId, index]))
  const parents = [...reused.parents, ...collateralPlan.parents].sort(
    (left, right) => parentIndex(left, childIndex) - parentIndex(right, childIndex),
  )
  const omissions = canonicalOmissions(children, [
    ...poolOmissions,
    ...collateralPlan.omissions.map((omission) =>
      omission.reason === 'source inventory'
        ? (reused.preferredFragmentation.get(omission.clientOrderId) ?? omission)
        : omission,
    ),
  ])
  assertCompletePartition(children, parents, omissions)
  return completedPlan(children, parents, omissions, limits)
}

function planConditionalParents(
  children: readonly CtfRangeCapabilityBatchChild[],
  proofs: readonly Proof[],
  limits: CtfRangeCapabilityBatchLimits,
  measure: CtfRangeCapabilityBatchPlanInput['measureExactParentRequestBytes'],
): {
  parents: CtfRangeCapabilityBatchParent[]
  remaining: CtfRangeCapabilityBatchChild[]
  preferredFragmentation: Map<string, CtfRangeCapabilityBatchOmission>
} {
  const groups = conditionalChildGroups(children)
  const parents: CtfRangeCapabilityBatchParent[] = []
  const reused = new Set<string>()
  const preferredFragmentation = new Map<string, CtfRangeCapabilityBatchOmission>()
  for (const group of groups) {
    const source = proofs.filter(({ id }) => id === group.keyset.id)
    const probe = probeParent(
      'same-keyset-swap',
      group.children,
      source,
      group.keyset,
      limits,
      measure,
    )
    if (probe.kind === 'fit') {
      parents.push(materializeParent(probe.candidate))
      group.children.forEach((child) => reused.add(child.clientOrderId))
      continue
    }
    if (probe.reason === 'input limit') {
      for (const child of group.children) {
        preferredFragmentation.set(child.clientOrderId, {
          clientOrderId: child.clientOrderId,
          reason: 'preferred source consolidation required',
          sourceKeysetId: group.keyset.id,
          selectedInputCount: probe.selectedInputCount,
          inputLimit: limits.maxInputs,
        })
      }
    }
  }
  return {
    parents,
    remaining: children.filter(({ clientOrderId }) => !reused.has(clientOrderId)),
    preferredFragmentation,
  }
}

function planCollateralParents(
  children: readonly CtfRangeCapabilityBatchChild[],
  proofs: readonly Proof[],
  keyset: CtfRangeCapabilitySourceKeyset,
  limits: CtfRangeCapabilityBatchLimits,
  measure: CtfRangeCapabilityBatchPlanInput['measureExactParentRequestBytes'],
): {
  parents: CtfRangeCapabilityBatchParent[]
  omissions: CtfRangeCapabilityBatchOmission[]
} {
  if (children.length === 0) return { parents: [], omissions: [] }
  const packed = packGreedy(children, proofs, keyset, 'collateral-ctf-convert', limits, measure)
  return {
    parents: packed.parents,
    omissions: packed.unplanned.map(({ child, reason }) => ({
      clientOrderId: child.clientOrderId,
      reason,
    })),
  }
}

function packGreedy(
  children: readonly CtfRangeCapabilityBatchChild[],
  proofs: readonly Proof[],
  keyset: CtfRangeCapabilitySourceKeyset,
  kind: CtfRangeCapabilityBatchParent['kind'],
  limits: CtfRangeCapabilityBatchLimits,
  measure: CtfRangeCapabilityBatchPlanInput['measureExactParentRequestBytes'],
): {
  parents: CtfRangeCapabilityBatchParent[]
  unplanned: Array<{ child: CtfRangeCapabilityBatchChild; reason: ParentRejectReason }>
} {
  const parents: CtfRangeCapabilityBatchParent[] = []
  const unplanned: Array<{ child: CtfRangeCapabilityBatchChild; reason: ParentRejectReason }> = []
  let available = [...proofs]
  let pending: CtfRangeCapabilityBatchChild[] = []
  let pendingCandidate: ParentCandidate | null = null
  for (const child of children) {
    const probe = probeParent(kind, [...pending, child], available, keyset, limits, measure)
    if (probe.kind === 'fit') {
      pending.push(child)
      pendingCandidate = probe.candidate
      continue
    }
    if (pendingCandidate !== null) {
      const parent = materializeParent(pendingCandidate)
      parents.push(parent)
      available = subtractProofs(available, parent.inputs)
    }
    const single = probeParent(kind, [child], available, keyset, limits, measure)
    if (single.kind === 'fit') {
      pending = [child]
      pendingCandidate = single.candidate
    } else {
      pending = []
      pendingCandidate = null
      unplanned.push({ child, reason: single.reason })
    }
  }
  if (pendingCandidate !== null) parents.push(materializeParent(pendingCandidate))
  return { parents, unplanned }
}

function probeParent(
  kind: CtfRangeCapabilityBatchParent['kind'],
  children: readonly CtfRangeCapabilityBatchChild[],
  candidates: readonly Proof[],
  keyset: CtfRangeCapabilitySourceKeyset,
  limits: CtfRangeCapabilityBatchLimits,
  measure: CtfRangeCapabilityBatchPlanInput['measureExactParentRequestBytes'],
): ParentProbe {
  const target = sumChildAuthorizationAmounts(children)
  const inputs = takeProofsForLock(candidates, target, { [keyset.id]: keyset.inputFeePpk })
  if (inputs === null) return { kind: 'rejected', reason: 'source inventory' }
  if (inputs.length > limits.maxInputs) {
    return { kind: 'rejected', reason: 'input limit', selectedInputCount: inputs.length }
  }
  const inputFee = computeInputFeeSatsForProofs(inputs, { [keyset.id]: keyset.inputFeePpk })
  const change = checkedSubtract(sumProofs(inputs), target + inputFee, 'parent change')
  const outputs = parentOutputs(kind, children, keyset, change)
  if (outputs.length > limits.maxOutputs) return { kind: 'rejected', reason: 'output limit' }
  const candidate = {
    kind,
    sourceKeysetId: keyset.id,
    sourceKeyset: keyset,
    children,
    inputs,
    inputFee,
    outputs,
  }
  const requestBytes = positiveLimit(measure(candidate), 'measured request byte')
  if (requestBytes > limits.maxRequestBytes) {
    return { kind: 'rejected', reason: 'request byte limit' }
  }
  return { kind: 'fit', candidate: { ...candidate, requestBytes } }
}

function materializeParent(candidate: ParentCandidate): CtfRangeCapabilityBatchParent {
  return {
    ...candidate,
    parentDigest: digestParent(candidate, candidate.requestBytes),
  }
}

function parentOutputs(
  kind: CtfRangeCapabilityBatchParent['kind'],
  children: readonly CtfRangeCapabilityBatchChild[],
  sourceKeyset: CtfRangeCapabilitySourceKeyset,
  change: number,
): CtfRangeCapabilityOutputAllocation[] {
  const rows: Array<Omit<CtfRangeCapabilityOutputAllocation, 'outputIndex'>> = []
  for (const child of children) {
    for (const amount of decodeAuthorizationAmounts(child)) {
      rows.push({
        role: 'authorization',
        keysetId: child.offeredKeyset.id,
        amount,
        clientOrderId: child.clientOrderId,
      })
    }
    if (kind === 'collateral-ctf-convert' && child.offeredAsset === 'conditional') {
      for (const amount of splitExact(
        sumAmounts(decodeAuthorizationAmounts(child)),
        child.complementKeyset,
      )) {
        rows.push({
          role: 'complement',
          keysetId: child.complementKeyset.id,
          amount,
          clientOrderId: child.clientOrderId,
        })
      }
    }
  }
  for (const amount of splitPositive(change, sourceKeyset)) {
    rows.push({ role: 'change', keysetId: sourceKeyset.id, amount, clientOrderId: null })
  }
  return rows.map((row, outputIndex) => ({ outputIndex, ...row }))
}

function canonicalChildren(
  values: readonly CtfRangeCapabilityBatchChild[],
  collateralKeyset: CtfRangeCapabilitySourceKeyset,
): CtfRangeCapabilityBatchChild[] {
  assertKeyset(collateralKeyset, 'collateral')
  const ids = new Set<string>()
  const keysets = new Map<string, string>([
    [collateralKeyset.id, keysetAuthority(collateralKeyset)],
  ])
  const children = values.map((child) => validateChild(child, collateralKeyset))
  for (const child of children) {
    if (ids.has(child.clientOrderId))
      throw new Error('CTF range batch has a duplicate client order id')
    ids.add(child.clientOrderId)
    registerKeyset(keysets, child.offeredKeyset)
    if (child.offeredAsset === 'conditional') registerKeyset(keysets, child.complementKeyset)
  }
  return children.sort(compareChildren)
}

function validateChild(
  child: CtfRangeCapabilityBatchChild,
  collateralKeyset: CtfRangeCapabilitySourceKeyset,
): CtfRangeCapabilityBatchChild {
  const route = requiredText(child.route, 'route')
  const clientOrderId = requiredText(child.clientOrderId, 'client order id')
  const price = positiveDecimal(child.price, 'price')
  const amount = positiveDecimal(child.amount, 'amount')
  const poolEntryCount = positiveLimit(child.poolEntryCount, 'pool entry')
  if (child.side === 'Buy' && child.offeredAsset !== 'collateral') {
    throw new Error('CTF range Buy child must offer collateral')
  }
  if (child.side === 'Sell' && child.offeredAsset !== 'conditional') {
    throw new Error('CTF range Sell child must offer a conditional asset')
  }
  if (child.side !== 'Buy' && child.side !== 'Sell') {
    throw new Error('CTF range child side is invalid')
  }
  assertKeyset(child.offeredKeyset, 'offered')
  if (child.offeredAsset === 'collateral' && child.offeredKeyset.id !== collateralKeyset.id) {
    throw new Error('CTF range collateral child uses a foreign keyset')
  }
  if (child.offeredAsset === 'conditional') {
    assertKeyset(child.complementKeyset, 'complement')
    if (child.offeredKeyset.id === collateralKeyset.id) {
      throw new Error('CTF range conditional child uses the collateral keyset')
    }
  }
  decodeAuthorizationAmounts(child)
  return structuredClone({ ...child, route, clientOrderId, price, amount, poolEntryCount })
}

function conditionalChildGroups(children: readonly CtfRangeCapabilityBatchChild[]): Array<{
  keyset: CtfRangeCapabilitySourceKeyset
  children: CtfRangeCapabilityBatchChild[]
}> {
  const groups = new Map<
    string,
    { keyset: CtfRangeCapabilitySourceKeyset; children: CtfRangeCapabilityBatchChild[] }
  >()
  for (const child of children) {
    if (child.offeredAsset !== 'conditional') continue
    const group = groups.get(child.offeredKeyset.id)
    if (group === undefined)
      groups.set(child.offeredKeyset.id, { keyset: child.offeredKeyset, children: [child] })
    else group.children.push(child)
  }
  return [...groups.values()]
}

function canonicalProofs(values: readonly Proof[], label: string): Proof[] {
  return [...values]
    .sort(
      (left, right) =>
        amountToNumber(right.amount) - amountToNumber(left.amount) ||
        compareText(left.id, right.id) ||
        compareText(left.secret, right.secret) ||
        compareText(left.C, right.C),
    )
    .map((proof) => {
      if (
        amountToNumber(proof.amount) <= 0 ||
        proof.id.length === 0 ||
        proof.secret.length === 0 ||
        proof.C.length === 0
      ) {
        throw new Error(`CTF range ${label} proof is invalid`)
      }
      return structuredClone(proof)
    })
}

function assertUniqueProofs(proofs: readonly Proof[]): void {
  const secrets = new Set<string>()
  for (const proof of proofs) {
    if (secrets.has(proof.secret)) {
      throw new Error('CTF range batch contains a duplicate proof')
    }
    secrets.add(proof.secret)
  }
}

function assertProofPartitions(
  collateral: readonly Proof[],
  conditional: readonly Proof[],
  collateralKeysetId: string,
): void {
  if (collateral.some(({ id }) => id !== collateralKeysetId)) {
    throw new Error('CTF range collateral inventory contains a foreign proof')
  }
  if (conditional.some(({ id }) => id === collateralKeysetId)) {
    throw new Error('CTF range conditional inventory contains a collateral proof')
  }
}

function registerKeyset(
  authority: Map<string, string>,
  keyset: CtfRangeCapabilitySourceKeyset,
): void {
  const value = keysetAuthority(keyset)
  const existing = authority.get(keyset.id)
  if (existing !== undefined && existing !== value) {
    throw new Error(`CTF range keyset ${keyset.id} has conflicting authority`)
  }
  authority.set(keyset.id, value)
}

function keysetAuthority(keyset: CtfRangeCapabilitySourceKeyset): string {
  return canonicalJson({ inputFeePpk: keyset.inputFeePpk, keys: keyset.keys })
}

function validateLimits(value: CtfRangeCapabilityBatchLimits): CtfRangeCapabilityBatchLimits {
  return {
    maxInputs: boundedLimit(value.maxInputs, CTF_RANGE_BATCH_INPUT_LIMIT_MAX, 'input'),
    maxOutputs: Math.min(
      positiveLimit(value.maxOutputs, 'output'),
      DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
    ),
    maxRequestBytes: Math.min(
      positiveLimit(value.maxRequestBytes, 'request byte'),
      DURABLE_ARTIFACT_BYTES_LIMIT_MAX,
    ),
    maxPoolEntries: boundedLimit(
      value.maxPoolEntries,
      CTF_RANGE_BATCH_POOL_ENTRY_LIMIT_MAX,
      'pool entry',
    ),
  }
}

function completedPlan(
  children: readonly CtfRangeCapabilityBatchChild[],
  parents: readonly CtfRangeCapabilityBatchParent[],
  omissions: readonly CtfRangeCapabilityBatchOmission[],
  limits: CtfRangeCapabilityBatchLimits,
): CtfRangeCapabilityBatchPlan {
  const sourcePartitions = parents.map((parent) => ({
    sourceKind: parent.kind,
    sourceKeysetId: parent.sourceKeysetId,
    childIds: parent.children.map(({ clientOrderId }) => clientOrderId),
  }))
  const packingDigest = digestValue({
    limits,
    canonicalChildIds: children.map(({ clientOrderId }) => clientOrderId),
    parents: parents.map(({ parentDigest }) => parentDigest),
    omissions,
  })
  return immutableClone({
    canonicalChildIds: children.map(({ clientOrderId }) => clientOrderId),
    parents,
    omissions,
    sourcePartitions,
    mintMutationCount: parents.length,
    packingDigest,
  })
}

function digestParent(value: CtfRangeCapabilityParentMeasureInput, requestBytes: number): string {
  return digestValue({
    kind: value.kind,
    sourceKeysetId: value.sourceKeysetId,
    sourceKeyset: value.sourceKeyset,
    children: value.children.map(normalizedChildAuthority),
    inputs: value.inputs.map(proofAuthority),
    inputFee: value.inputFee,
    outputs: value.outputs,
    requestBytes,
  })
}

function normalizedChildAuthority(child: CtfRangeCapabilityBatchChild): unknown {
  return {
    route: child.route,
    side: child.side,
    price: child.price,
    amount: child.amount,
    clientOrderId: child.clientOrderId,
    authorizationAmounts: child.authorizationAmounts,
    poolEntryCount: child.poolEntryCount,
    offeredAsset: child.offeredAsset,
    offeredKeyset: normalizedKeyset(child.offeredKeyset),
    ...(child.offeredAsset === 'conditional'
      ? { complementKeyset: normalizedKeyset(child.complementKeyset) }
      : {}),
  }
}

function normalizedKeyset(keyset: CtfRangeCapabilitySourceKeyset): unknown {
  return { id: keyset.id, inputFeePpk: keyset.inputFeePpk, keys: { ...keyset.keys } }
}

function digestValue(value: unknown): string {
  const domain = new TextEncoder().encode('bitcaster/ctf-range-capability-batch-plan/v1\0')
  const encoded = encodeBoundedDurableArtifact(value, DURABLE_ARTIFACT_BYTES_LIMIT_MAX)
  const joined = new Uint8Array(domain.length + encoded.length)
  joined.set(domain)
  joined.set(encoded, domain.length)
  return bytesToHex(sha256(joined))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function decodeAuthorizationAmounts(child: CtfRangeCapabilityBatchChild): number[] {
  if (child.authorizationAmounts.length === 0)
    throw new Error('CTF range child has no authorization output')
  return child.authorizationAmounts.map((raw) => {
    const amount = positiveSafeAmount(raw, 'authorization amount')
    if (child.offeredKeyset.keys[String(amount)] === undefined) {
      throw new Error('CTF range child authorization amount is unsupported by its keyset')
    }
    return amount
  })
}

function sumChildAuthorizationAmounts(children: readonly CtfRangeCapabilityBatchChild[]): number {
  return sumAmounts(children.flatMap(decodeAuthorizationAmounts))
}

function splitExact(amount: number, keyset: CtfRangeCapabilitySourceKeyset): number[] {
  const result = splitAmount(BigInt(amount), { ...keyset.keys }).map(amountToNumber)
  if (result.length === 0 || sumAmounts(result) !== amount) {
    throw new Error('CTF range batch amount is unsupported by its keyset')
  }
  return result
}

function splitPositive(amount: number, keyset: CtfRangeCapabilitySourceKeyset): number[] {
  return amount === 0 ? [] : splitExact(amount, keyset)
}

function sumAmounts(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) throw new Error('CTF range batch amount overflow')
  }
  return total
}

function compareChildren(
  left: CtfRangeCapabilityBatchChild,
  right: CtfRangeCapabilityBatchChild,
): number {
  return (
    compareText(left.route, right.route) ||
    compareText(left.side, right.side) ||
    compareDecimal(left.price, right.price) ||
    compareDecimal(left.amount, right.amount) ||
    compareText(left.clientOrderId, right.clientOrderId)
  )
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDecimal(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function assertCompletePartition(
  children: readonly CtfRangeCapabilityBatchChild[],
  parents: readonly CtfRangeCapabilityBatchParent[],
  omissions: readonly CtfRangeCapabilityBatchOmission[],
): void {
  const actual = parents.flatMap(({ children: rows }) =>
    rows.map(({ clientOrderId }) => clientOrderId),
  )
  actual.push(...omissions.map(({ clientOrderId }) => clientOrderId))
  const expected = children.map(({ clientOrderId }) => clientOrderId).sort()
  const observed = [...actual].sort()
  if (
    observed.length !== expected.length ||
    observed.some((clientOrderId, index) => clientOrderId !== expected[index])
  ) {
    throw new Error('CTF range batch child partition is incomplete')
  }
}

function canonicalOmissions(
  children: readonly CtfRangeCapabilityBatchChild[],
  omissions: readonly CtfRangeCapabilityBatchOmission[],
): CtfRangeCapabilityBatchOmission[] {
  const byId = new Map(omissions.map((omission) => [omission.clientOrderId, omission]))
  return children.flatMap((child) => {
    const omission = byId.get(child.clientOrderId)
    return omission === undefined ? [] : [omission]
  })
}

function parentIndex(
  parent: CtfRangeCapabilityBatchParent,
  index: ReadonlyMap<string, number>,
): number {
  return Math.min(...parent.children.map(({ clientOrderId }) => index.get(clientOrderId)!))
}

function assertKeyset(value: CtfRangeCapabilitySourceKeyset, label: string): void {
  if (
    requiredText(value.id, `${label} keyset id`).length === 0 ||
    !Number.isSafeInteger(value.inputFeePpk) ||
    value.inputFeePpk <= 0 ||
    Object.keys(value.keys).length === 0
  ) {
    throw new Error(`CTF range ${label} keyset is invalid`)
  }
}

function boundedLimit(value: number, maximum: number, label: string): number {
  const limit = positiveLimit(value, label)
  if (limit > maximum) throw new Error(`CTF range ${label} limit exceeds the client bound`)
  return limit
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`CTF range ${label} limit is invalid`)
  return value
}

function positiveDecimal(value: string, label: string): string {
  const amount = positiveSafeAmount(value, label)
  return String(amount)
}

function positiveSafeAmount(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`CTF range ${label} is invalid`)
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) throw new Error(`CTF range ${label} is invalid`)
  return amount
}

function requiredText(value: string, label: string): string {
  const text = value.trim()
  if (text.length === 0 || text.length > 512) throw new Error(`CTF range ${label} is invalid`)
  return text
}

function checkedSubtract(left: number, right: number, label: string): number {
  const value = left - right
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`CTF range ${label} is invalid`)
  return value
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
