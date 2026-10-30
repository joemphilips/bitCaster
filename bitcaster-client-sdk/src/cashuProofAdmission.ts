import {
  hasValidDleq,
  normalizeProofAmounts,
  type HasKeysetKeys,
  type ProofLike,
} from '@cashu/cashu-ts'

/** Legacy IDs must be classified before their first characters are read as a version. */
export function isLegacyCashuKeysetId(value: string): boolean {
  return value.length === 12 && /^[A-Za-z0-9_-]+$/.test(value)
}

/** Require a resolved full ID supported by the stable secp256k1 wallet. */
export function requireSupportedCashuKeysetId(keysetId: unknown): asserts keysetId is string {
  if (typeof keysetId !== 'string') throw new Error('Cashu proof keyset ID is missing')
  if (isLegacyCashuKeysetId(keysetId)) return
  if (/^(00[0-9a-f]{14}|01[0-9a-f]{64})$/.test(keysetId)) return
  throw new Error('Cashu proof requires a supported resolved secp256k1 keyset ID')
}

/** Verify the complete batch synchronously before a caller can mutate custody state. */
export function requireValidCashuProofs(
  proofs: readonly ProofLike[],
  getKeyset: (id: string) => HasKeysetKeys,
): void {
  // Preflight the whole batch before key lookup or curve work. Never mutate caller values.
  for (const proof of proofs) requireSupportedCashuKeysetId(proof.id)
  const normalized = normalizeProofAmounts([...proofs])
  for (const proof of normalized) {
    const keyset = getKeyset(proof.id)
    if (keyset?.id !== proof.id)
      throw new Error('Cashu proof keyset does not match its resolved ID')
    if (!hasValidDleq(proof, keyset, { require: true })) {
      throw new Error('Cashu proof has invalid or missing DLEQ')
    }
  }
}
