import { complementOutcomeSetId, parseOutcomeSetId } from './outcomeSets.ts'
import { amountToNumber } from './proofSelection.ts'

export type CtfDefaultKeysetCreation = 'none' | 'one-vs-rest' | 'all'

export interface CtfRegistrationFeeSettings {
  defaultKeysetCreation: CtfDefaultKeysetCreation
  registrationFees: CtfRegistrationFeeSetting[]
}

export interface CtfRegistrationFeeSetting {
  unit: string
  registrationFeeBase: number
  registrationFeePerKeyset: number
}

export interface AmountBearing {
  amount: unknown
}

export function parseCtfSettingsFromMintInfo(
  info: Record<string, unknown>,
): CtfRegistrationFeeSettings {
  const nuts = info.nuts as Record<string, unknown> | undefined
  if (!nuts) throw new Error('mint info missing nuts')
  const ctf = nuts.CTF
  if (ctf == null || typeof ctf !== 'object') {
    throw new Error('mint info missing CTF settings')
  }
  const raw = ctf as Record<string, unknown>

  const defaultKeysetCreation = raw.default_keyset_creation
  if (
    defaultKeysetCreation !== 'none' &&
    defaultKeysetCreation !== 'one-vs-rest' &&
    defaultKeysetCreation !== 'all'
  ) {
    throw new Error(
      `Unsupported mint CTF default_keyset_creation: ${String(defaultKeysetCreation)}`,
    )
  }

  const feesRaw = raw.registration_fees
  if (!Array.isArray(feesRaw)) {
    throw new Error('mint CTF registration_fees is missing or invalid')
  }

  const seenUnits = new Set<string>()
  const registrationFees: CtfRegistrationFeeSetting[] = feesRaw.map(
    (entry, i) => {
      if (entry == null || typeof entry !== 'object') {
        throw new Error(`mint CTF registration_fees[${i}] is invalid`)
      }
      const feeRaw = entry as Record<string, unknown>
      if (typeof feeRaw.unit !== 'string' || feeRaw.unit.length === 0) {
        throw new Error(`mint CTF registration_fees[${i}] is missing unit`)
      }
      if (seenUnits.has(feeRaw.unit)) {
        throw new Error(
          `mint CTF registration_fees[${i}] has duplicate unit '${feeRaw.unit}'`,
        )
      }
      seenUnits.add(feeRaw.unit)
      const registrationFeeBase = toNonNegativeInteger(
        feeRaw.registration_fee_base,
        'registration_fee_base',
      )
      const registrationFeePerKeyset = toNonNegativeInteger(
        feeRaw.registration_fee_per_keyset,
        'registration_fee_per_keyset',
      )
      return { unit: feeRaw.unit, registrationFeeBase, registrationFeePerKeyset }
    },
  )

  return { defaultKeysetCreation, registrationFees }
}

export function registrationFeeForPolicy(
  outcomes: readonly string[],
  settings: CtfRegistrationFeeSettings,
  collateralUnit: string,
): number {
  const feeSetting = settings.registrationFees.find(
    (candidate) => candidate.unit === collateralUnit,
  )
  if (!feeSetting) {
    throw new Error(`Active mint does not support CTF collateral unit '${collateralUnit}'.`)
  }
  const numKeysets =
    settings.defaultKeysetCreation === 'all'
      ? Math.max(0, 2 ** outcomes.length - 2)
      : requiredMarketCreationOutcomeCollections(outcomes).length
  const fee =
    feeSetting.registrationFeeBase +
    feeSetting.registrationFeePerKeyset * numKeysets
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

function toNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' || typeof value === 'bigint'
        ? Number(value)
        : undefined
  if (parsed == null || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`mint CTF ${fieldName} is missing or invalid`)
  }
  return parsed
}
