import type { CtfRangeCapabilitySourcePlan } from './ctfRangeCapabilitySourcePlan.ts'
import type { CtfRangeSourceMode } from './ctfRangeSourceOperation.ts'
import type { CtfRangeOrderAuthorizationPlan } from './ctfRangeOrderAuthorization.ts'
import type { DurableCtfRangeAsset } from './durableCtfRangeOperation.ts'

const MAX_FEE_SUBUNITS = (1n << 64n) - 1n
const MAX_ASSET_IDENTITY_BYTES = 1_024
const FEE_CONSENT_MISMATCH = 'CTF range fee consent does not match the current preparation plan'

export interface CtfRangeOrderFeeFacts {
  /** Settlement fee charged against the authorization's settlement asset. */
  readonly settlementInputFeeSubunits: string
  /** Fee charged against the explicitly selected source-preparation asset. */
  readonly sourcePreparationFeeSubunits: string
  /** Fee charged against the explicitly selected consolidation asset. */
  readonly consolidationFeeSubunits: string
  readonly settlementAsset: DurableCtfRangeAsset
  readonly sourcePreparationAsset: DurableCtfRangeAsset
  readonly consolidationAsset: DurableCtfRangeAsset
  readonly sourceMode: CtfRangeSourceMode
}

export function decodeCtfRangeOrderFeeFacts(value: unknown): CtfRangeOrderFeeFacts {
  const facts = requireFeeFacts(value, 'CTF range fee consent')
  const record = value as Record<string, unknown>
  const fields = [
    'settlementInputFeeSubunits',
    'sourcePreparationFeeSubunits',
    'consolidationFeeSubunits',
    'settlementAsset',
    'sourcePreparationAsset',
    'consolidationAsset',
    'sourceMode',
  ]
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    throw new Error('CTF range fee consent has invalid fields')
  }
  return facts
}

/**
 * Composes exact fee facts from the shared source plan and authorization.
 * The consolidation cost is supplied separately because consolidation is a
 * distinct operation. Reserved settlement fee headroom is not included.
 */
export function composeCtfRangeOrderFeeFacts(input: {
  readonly authorizationPlan: Pick<
    CtfRangeOrderAuthorizationPlan,
    'participantFeeAllocationUpperBound'
  >
  readonly sourcePlan: CtfRangeCapabilitySourcePlan
  readonly sourceMode: CtfRangeSourceMode
  readonly consolidationFeeSubunits: string
  readonly settlementAsset: DurableCtfRangeAsset
  readonly sourcePreparationAsset: DurableCtfRangeAsset
  readonly consolidationAsset: DurableCtfRangeAsset
}): CtfRangeOrderFeeFacts {
  const sourceMode = requireSourceMode(input.sourceMode)
  return {
    settlementInputFeeSubunits: requireFee(
      input.authorizationPlan.participantFeeAllocationUpperBound,
      'settlement input fee',
    ),
    sourcePreparationFeeSubunits: sourcePreparationFee(input.sourcePlan, sourceMode),
    consolidationFeeSubunits: requireFee(input.consolidationFeeSubunits, 'consolidation fee'),
    settlementAsset: requireAsset(input.settlementAsset, 'settlement asset'),
    sourcePreparationAsset: requireSourcePreparationAsset(
      input.sourcePreparationAsset,
      sourceMode,
      'source preparation asset',
    ),
    consolidationAsset: requireAsset(input.consolidationAsset, 'consolidation asset'),
    sourceMode,
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
    !sameAsset(consented.sourcePreparationAsset, current.sourcePreparationAsset) ||
    !sameAsset(consented.consolidationAsset, current.consolidationAsset) ||
    consented.sourceMode !== current.sourceMode ||
    consented.settlementInputFeeSubunits !== current.settlementInputFeeSubunits ||
    consented.sourcePreparationFeeSubunits !== current.sourcePreparationFeeSubunits ||
    totalConsolidation > MAX_FEE_SUBUNITS ||
    totalConsolidation !== BigInt(consented.consolidationFeeSubunits)
  ) {
    throw new Error(FEE_CONSENT_MISMATCH)
  }
}

function sourcePreparationFee(
  plan: CtfRangeCapabilitySourcePlan,
  sourceMode: CtfRangeSourceMode,
): string {
  switch (plan.kind) {
    case 'same-keyset-swap': {
      switch (sourceMode) {
        case 'wallet-send':
        case 'conditional-keyset-swap':
          return requireSafeIntegerFee(plan.inputFee, 'source preparation fee')
        case 'mixed-source-ctf-convert':
        case 'ctf-range-collateral-convert':
          throw new Error('CTF range source mode does not match its source plan')
        default:
          return assertNever(sourceMode)
      }
    }
    case 'mixed-source-ctf-convert': {
      switch (sourceMode) {
        case 'mixed-source-ctf-convert':
          return requireSafeIntegerFee(plan.inputFee, 'source preparation fee')
        case 'wallet-send':
        case 'conditional-keyset-swap':
        case 'ctf-range-collateral-convert':
          throw new Error('CTF range source mode does not match its source plan')
        default:
          return assertNever(sourceMode)
      }
    }
    case 'collateral-ctf-convert': {
      switch (sourceMode) {
        case 'ctf-range-collateral-convert':
          return requireSafeIntegerFee(plan.inputFee, 'source preparation fee')
        case 'wallet-send':
        case 'conditional-keyset-swap':
        case 'mixed-source-ctf-convert':
          throw new Error('CTF range source mode does not match its source plan')
        default:
          return assertNever(sourceMode)
      }
    }
    case 'consolidation-required':
    case 'source-unavailable':
      throw new Error('CTF range source plan is not ready')
    default:
      return assertNever(plan)
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

function requireSafeIntegerFee(value: unknown, label: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return String(value)
}

function requireSourceMode(value: unknown): CtfRangeSourceMode {
  switch (value) {
    case 'wallet-send':
    case 'conditional-keyset-swap':
    case 'mixed-source-ctf-convert':
    case 'ctf-range-collateral-convert':
      return value
    default:
      throw new Error('source mode is invalid')
  }
}

function requireFeeFacts(value: unknown, label: string): CtfRangeOrderFeeFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  const record = value as Record<string, unknown>
  const sourceMode = requireSourceMode(record.sourceMode)
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
    sourcePreparationAsset: requireSourcePreparationAsset(
      record.sourcePreparationAsset,
      sourceMode,
      `${label} source preparation asset`,
    ),
    consolidationAsset: requireAsset(record.consolidationAsset, `${label} consolidation asset`),
    sourceMode,
  }
}

function requireSourcePreparationAsset(
  value: unknown,
  sourceMode: CtfRangeSourceMode,
  label: string,
): DurableCtfRangeAsset {
  const asset = requireAsset(value, label)
  const requiredKind = sourceModeAssetKind(sourceMode)
  if (asset.kind !== requiredKind) {
    throw new Error(`${label} does not match its source mode`)
  }
  return asset
}

function sourceModeAssetKind(sourceMode: CtfRangeSourceMode): DurableCtfRangeAsset['kind'] {
  switch (sourceMode) {
    case 'wallet-send':
    case 'mixed-source-ctf-convert':
    case 'ctf-range-collateral-convert':
      return 'regular'
    case 'conditional-keyset-swap':
      return 'conditional'
    default:
      return assertNever(sourceMode)
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
  throw new Error(`unsupported CTF range fee variant: ${String(value)}`)
}
