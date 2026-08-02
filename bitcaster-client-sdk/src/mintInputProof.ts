import { parseSecret, type Proof } from '@cashu/cashu-ts'
import { amountToNumber } from './proofSelection.ts'

export interface PrepareMintInputProofOptions {
  readonly keepDleq?: boolean
  readonly keepP2pkE?: boolean
}

/**
 * Creates the canonical proof payload for a mint mutation.
 *
 * This function matches the cashu-ts wallet input policy. It does not mutate the source proof.
 */
export function prepareMintInputProof(
  proof: Proof,
  options: PrepareMintInputProofOptions = {},
): Proof {
  const { dleq, p2pk_e, witness: _witness, ...rest } = structuredClone(proof)
  const witness = normalizedMintWitness(proof)
  return {
    ...rest,
    amount: amountToNumber(proof.amount) as never,
    ...(witness === undefined ? {} : { witness }),
    ...(options.keepDleq && dleq ? { dleq } : {}),
    ...(options.keepP2pkE && p2pk_e ? { p2pk_e } : {}),
  }
}

export function prepareMintInputProofs(
  proofs: readonly Proof[],
  options: PrepareMintInputProofOptions = {},
): Proof[] {
  return proofs.map((proof) => prepareMintInputProof(proof, options))
}

function normalizedMintWitness(proof: Proof): string | undefined {
  if (!proof.witness) return undefined
  try {
    parseSecret(proof.secret)
  } catch {
    return undefined
  }
  return typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness)
}
