import { OutputData } from '@cashu/cashu-ts'
import {
  fitsDurableSeedDerivedCounterRange,
  isCanonicalModernNut02KeysetId,
  isDurableSeedDerivedCounter,
  isDurableSeedDerivedCount,
  isNonArrayRecord,
} from './durableSeedDerivedPolicy.ts'

const TEXT_DECODER = new TextDecoder()

export interface SeedDerivedProofLineageProof {
  readonly id: string
  readonly secret: string
}

export interface LocateSeedDerivedProofLineageInput {
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly counterStart: number
  readonly counterCount: number
  readonly proofs: readonly SeedDerivedProofLineageProof[]
}

export interface SeedDerivedProofLocator {
  readonly keysetId: string
  readonly counter: number
  readonly secret: string
}

interface ValidatedInput {
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly counterStart: number
  readonly counterCount: number
  readonly proofSecrets: ReadonlySet<string>
}

interface DerivedSecret {
  readonly counter: number
  readonly secret: string
}

export function locateSeedDerivedProofLineage(
  input: LocateSeedDerivedProofLineageInput,
): readonly SeedDerivedProofLocator[] {
  const validated = validateInput(input)
  if (validated === null) throw new Error('seed-derived proof lineage input is invalid')

  const derived = deriveSecrets(validated)
  const countersBySecret = new Map(derived.map(({ secret, counter }) => [secret, counter]))
  if (countersBySecret.size !== derived.length) {
    throw new Error('seed-derived proof lineage derivation is duplicated')
  }
  if ([...validated.proofSecrets].some((secret) => !countersBySecret.has(secret))) {
    throw new Error('proof does not match the exact deterministic counter range')
  }
  return Object.freeze(
    derived.map(({ counter, secret }) =>
      Object.freeze({ keysetId: validated.keysetId, counter, secret }),
    ),
  )
}

function validateInput(input: unknown): ValidatedInput | null {
  if (
    !isNonArrayRecord(input) ||
    !(input.seed instanceof Uint8Array) ||
    input.seed.byteLength !== 64
  ) {
    return null
  }
  if (
    !isCanonicalModernNut02KeysetId(input.keysetId) ||
    !isDurableSeedDerivedCounter(input.counterStart)
  ) {
    return null
  }
  if (
    !isDurableSeedDerivedCount(input.counterCount) ||
    !fitsDurableSeedDerivedCounterRange(input.counterStart, input.counterCount)
  ) {
    return null
  }
  const proofSecrets = validateProofs(input.proofs, input.keysetId, input.counterCount)
  if (proofSecrets === null) return null
  return {
    seed: input.seed.slice(),
    keysetId: input.keysetId,
    counterStart: input.counterStart,
    counterCount: input.counterCount,
    proofSecrets,
  }
}

function validateProofs(
  value: unknown,
  keysetId: string,
  count: number,
): ReadonlySet<string> | null {
  if (!Array.isArray(value) || value.length !== count) return null
  const secrets = new Set<string>()
  for (const proof of value) {
    if (
      !isNonArrayRecord(proof) ||
      proof.id !== keysetId ||
      !isDerivedProofSecret(proof.secret) ||
      secrets.has(proof.secret)
    ) {
      return null
    }
    secrets.add(proof.secret)
  }
  return secrets
}

function deriveSecrets(input: ValidatedInput): readonly DerivedSecret[] {
  try {
    return Array.from({ length: input.counterCount }, (_, offset) => ({
      counter: input.counterStart + offset,
      secret: deriveSecret(input.seed, input.keysetId, input.counterStart + offset),
    }))
  } catch {
    throw new Error('seed-derived proof lineage derivation failed')
  }
}

function deriveSecret(seed: Uint8Array, keysetId: string, counter: number): string {
  return TEXT_DECODER.decode(
    OutputData.createSingleDeterministicData(1, seed, counter, keysetId).secret,
  )
}

function isDerivedProofSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
