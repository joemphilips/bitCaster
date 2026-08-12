import type { DurableWalletVerifiedLosingCtfClassification } from './recoverableWalletStorage.ts'

const VERIFIED_LOSING_CTF_CLASSIFICATIONS = new WeakSet<object>()

/** Internal authority. This module is deliberately absent from package exports. */
export function issueDurableWalletVerifiedLosingCtfClassification(): DurableWalletVerifiedLosingCtfClassification {
  const classification = Object.freeze({ schemaVersion: 1 as const })
  VERIFIED_LOSING_CTF_CLASSIFICATIONS.add(classification)
  return classification
}

export function requireDurableWalletVerifiedLosingCtfClassification(
  value: unknown,
): DurableWalletVerifiedLosingCtfClassification {
  if (
    typeof value !== 'object' ||
    value === null ||
    !VERIFIED_LOSING_CTF_CLASSIFICATIONS.has(value)
  ) {
    throw new Error('CTF terminal evidence is invalid')
  }
  return value as DurableWalletVerifiedLosingCtfClassification
}
