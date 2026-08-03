import { DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX } from './durableCustody.ts'

const DURABLE_SEED_DERIVED_COUNTER_MAX = 2_147_483_647

export function isCanonicalModernNut02KeysetId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:01|02)[0-9a-f]{64}$/.test(value)
}

export function isDurableSeedDerivedCounter(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= DURABLE_SEED_DERIVED_COUNTER_MAX
  )
}

export function isDurableSeedDerivedCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
  )
}

export function fitsDurableSeedDerivedCounterRange(start: number, count: number): boolean {
  const lastCounter = start + count - 1
  return Number.isSafeInteger(lastCounter) && lastCounter <= DURABLE_SEED_DERIVED_COUNTER_MAX
}

export function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
