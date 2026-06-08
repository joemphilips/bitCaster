import { complementOutcomeSetId, parseOutcomeSetId } from './outcomeSets.ts'
import { amountToNumber } from './proofSelection.ts'

export type CtfDefaultKeysetCreation = 'none' | 'one-vs-rest' | 'all'

export interface CtfRegistrationFeeSettings {
  defaultKeysetCreation: CtfDefaultKeysetCreation
  registrationFeeBase: number
  registrationFeePerKeyset: number
}

export interface AmountBearing {
  amount: unknown
}

export function registrationFeeForPolicy(
  outcomes: readonly string[],
  settings: CtfRegistrationFeeSettings,
): number {
  const numKeysets =
    settings.defaultKeysetCreation === 'all'
      ? Math.max(0, 2 ** outcomes.length - 2)
      : requiredMarketCreationOutcomeCollections(outcomes).length
  const fee =
    settings.registrationFeeBase +
    settings.registrationFeePerKeyset * numKeysets
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw new Error('Active mint registration fee settings are invalid.')
  }
  return fee
}

export function requiredMarketCreationOutcomeCollections(
  outcomes: readonly string[],
): string[] {
  const universe = [...new Set(outcomes.map((outcome) => outcome.trim()))].filter(
    Boolean,
  )
  const collections = new Map<string, string>()

  for (const outcome of universe) {
    const singleton = normalizePartitionMember(outcome)
    const complement = complementOutcomeSetId(universe, singleton)
    if (singleton) collections.set(normalizePartitionMember(singleton), singleton)
    if (complement) collections.set(normalizePartitionMember(complement), complement)
  }

  return [...collections.values()]
}

export function toWireAmount(amount: unknown): number {
  return amountToNumber(amount)
}

export function toWireAmountBearing<T extends AmountBearing>(
  value: T,
): Omit<T, 'amount'> & { amount: number } {
  return {
    ...value,
    amount: toWireAmount(value.amount),
  }
}

function normalizePartitionMember(member: string): string {
  return parseOutcomeSetId(member).sort().join('|')
}
