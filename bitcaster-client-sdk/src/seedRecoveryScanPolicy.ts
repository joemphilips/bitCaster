import { DURABLE_SEED_DERIVED_COUNTER_MAX } from './durableSeedDerivedPolicy.ts'

export const SEED_RECOVERY_DEFAULT_GAP_LIMIT = 300
// The gap can span the derivation space. Transport batch limits stay separate.
export const SEED_RECOVERY_MAX_GAP_LIMIT = DURABLE_SEED_DERIVED_COUNTER_MAX + 1

export type SeedRecoveryScanPolicy = Readonly<
  | { version: 1; scope: 'regular-msat'; gapLimit: number }
  | { version: 1; scope: 'condition'; conditionId: string; gapLimit: number }
>

/** Select one recovery scope. This policy does not enumerate mint keysets. */
export function createSeedRecoveryScanPolicy(
  input: {
    readonly conditionId?: string
    readonly gapLimit?: number
  } = {},
): SeedRecoveryScanPolicy {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'conditionId' && key !== 'gapLimit')
  ) {
    throw new Error('seed recovery scan options are invalid')
  }
  const conditionId = input.conditionId
  const requestedGapLimit = input.gapLimit
  const gapLimit =
    requestedGapLimit === undefined ? SEED_RECOVERY_DEFAULT_GAP_LIMIT : requestedGapLimit
  return validateSeedRecoveryScanPolicy(
    conditionId === undefined
      ? { version: 1, scope: 'regular-msat', gapLimit }
      : { version: 1, scope: 'condition', conditionId, gapLimit },
  )
}

/** Decode an exact persisted policy. Missing policy never means a legacy scope. */
export function validateSeedRecoveryScanPolicy(value: unknown): SeedRecoveryScanPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('seed recovery scan policy is invalid')
  }
  const record = value as Record<string, unknown>
  const version = record.version
  const scope = record.scope
  const gapLimit = record.gapLimit
  const keys =
    scope === 'condition'
      ? ['version', 'scope', 'conditionId', 'gapLimit']
      : ['version', 'scope', 'gapLimit']
  if (
    version !== 1 ||
    (scope !== 'regular-msat' && scope !== 'condition') ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    typeof gapLimit !== 'number' ||
    !Number.isSafeInteger(gapLimit) ||
    gapLimit < 1 ||
    gapLimit > SEED_RECOVERY_MAX_GAP_LIMIT
  ) {
    throw new Error('seed recovery scan policy is invalid')
  }
  if (scope === 'regular-msat') return Object.freeze({ version: 1, scope, gapLimit })
  const conditionId = record.conditionId
  if (typeof conditionId !== 'string' || !/^[0-9a-f]{64}$/.test(conditionId)) {
    throw new Error('seed recovery condition id is invalid')
  }
  return Object.freeze({ version: 1, scope, conditionId, gapLimit })
}
