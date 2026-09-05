import type { BoundedProofConsolidationPlan } from './boundedProofConsolidation.ts'
import type { CtfRangeOrderAuthorizationPlan } from './ctfRangeOrderAuthorization.ts'
import type { DurableCtfRangeAsset } from './durableCtfRangeOperation.ts'

const MAX_FEE_SUBUNITS = (1n << 64n) - 1n
const MAX_ASSET_IDENTITY_BYTES = 1_024
const FEE_CONSENT_MISMATCH = 'CTF range fee consent does not match the current preparation plan'

export interface CtfRangeOrderFeeFacts {
  /** Settlement fee charged against the authorization's settlement asset. */
  readonly settlementInputFeeSubunits: string
  /** Source and consolidation fees charged against the preparation asset. */
  readonly sourcePreparationFeeSubunits: string
  readonly consolidationFeeSubunits: string
  readonly settlementAsset: DurableCtfRangeAsset
  readonly preparationAsset: DurableCtfRangeAsset
}

/**
 * Composes exact fee facts from the existing authorization and source plans.
 * `reservedFeeHeadroom` is intentionally not part of the result.
 */
export function composeCtfRangeOrderFeeFacts(input: {
  readonly authorizationPlan: Pick<
    CtfRangeOrderAuthorizationPlan,
    'participantFeeAllocationUpperBound'
  >
  readonly sourcePlan: BoundedProofConsolidationPlan
  readonly settlementAsset: DurableCtfRangeAsset
  readonly preparationAsset: DurableCtfRangeAsset
}): CtfRangeOrderFeeFacts {
  if (input.sourcePlan.kind !== 'ready') {
    throw new Error('CTF range source plan is not ready')
  }
  return {
    settlementInputFeeSubunits: requireFee(
      input.authorizationPlan.participantFeeAllocationUpperBound,
      'settlement input fee',
    ),
    sourcePreparationFeeSubunits: requireFee(input.sourcePlan.sourceFee, 'source preparation fee'),
    consolidationFeeSubunits: requireFee(input.sourcePlan.consolidationFee, 'consolidation fee'),
    settlementAsset: requireAsset(input.settlementAsset, 'settlement asset'),
    preparationAsset: requireAsset(input.preparationAsset, 'preparation asset'),
  }
}

/**
 * Requires the current plan to preserve every consented fee fact.
 * `current.consolidationFeeSubunits` is the remaining planned fee. The paid
 * amount is added before it is compared with the consented total.
 */
export function assertCtfRangeOrderFeeConsent(input: {
  readonly consented: CtfRangeOrderFeeFacts
  readonly current: CtfRangeOrderFeeFacts
  readonly paidConsolidationFeeSubunits: string
}): void {
  const consented = requireFeeFacts(input.consented, 'consented fee facts')
  const current = requireFeeFacts(input.current, 'current fee facts')
  const paidConsolidationFeeSubunits = requireFee(
    input.paidConsolidationFeeSubunits,
    'paid consolidation fee',
  )
  const totalConsolidation =
    BigInt(paidConsolidationFeeSubunits) + BigInt(current.consolidationFeeSubunits)

  if (
    !sameAsset(consented.settlementAsset, current.settlementAsset) ||
    !sameAsset(consented.preparationAsset, current.preparationAsset) ||
    consented.settlementInputFeeSubunits !== current.settlementInputFeeSubunits ||
    consented.sourcePreparationFeeSubunits !== current.sourcePreparationFeeSubunits ||
    totalConsolidation > MAX_FEE_SUBUNITS ||
    totalConsolidation !== BigInt(consented.consolidationFeeSubunits)
  ) {
    throw new Error(FEE_CONSENT_MISMATCH)
  }
}

function requireFee(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 20) {
    throw new Error(`${label} is invalid`)
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_FEE_SUBUNITS) throw new Error(`${label} is invalid`)
  return parsed.toString()
}

function requireFeeFacts(value: unknown, label: string): CtfRangeOrderFeeFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  const record = value as Record<string, unknown>
  return {
    settlementInputFeeSubunits: requireFee(
      record.settlementInputFeeSubunits,
      `${label} settlement input fee`,
    ),
    sourcePreparationFeeSubunits: requireFee(
      record.sourcePreparationFeeSubunits,
      `${label} source preparation fee`,
    ),
    consolidationFeeSubunits: requireFee(
      record.consolidationFeeSubunits,
      `${label} consolidation fee`,
    ),
    settlementAsset: requireAsset(record.settlementAsset, `${label} settlement asset`),
    preparationAsset: requireAsset(record.preparationAsset, `${label} preparation asset`),
  }
}

function requireAsset(value: unknown, label: string): DurableCtfRangeAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  const record = value as Record<string, unknown>
  if (record.unit !== 'msat') throw new Error(`${label} is invalid`)
  switch (record.kind) {
    case 'regular':
      return { kind: 'regular', unit: 'msat' }
    case 'conditional':
      if (!boundedIdentity(record.conditionId) || !boundedIdentity(record.outcomeCollection)) {
        throw new Error(`${label} is invalid`)
      }
      return {
        kind: 'conditional',
        unit: 'msat',
        conditionId: record.conditionId,
        outcomeCollection: record.outcomeCollection,
      }
    default:
      throw new Error(`${label} is invalid`)
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_ASSET_IDENTITY_BYTES
  )
}

function sameAsset(left: DurableCtfRangeAsset, right: DurableCtfRangeAsset): boolean {
  if (left.kind !== right.kind || left.unit !== right.unit) return false
  switch (left.kind) {
    case 'regular':
      return right.kind === 'regular'
    case 'conditional':
      return (
        right.kind === 'conditional' &&
        left.conditionId === right.conditionId &&
        left.outcomeCollection === right.outcomeCollection
      )
    default:
      return assertNever(left)
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported CTF range asset kind: ${String(value)}`)
}
