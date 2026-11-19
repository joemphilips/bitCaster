import { hashToCurve } from '@cashu/cashu-ts'
import { requireSupportedCashuKeysetId } from './cashuProofAdmission.ts'

/**
 * The class of one NUT-07 reading of the exact inputs of one persisted mint
 * request.
 *
 * `spent`, `unspent`, and `mixed` give one exact state for each input.
 * `pending`, `unknown-state`, and `mismatch` are not settlement evidence. A
 * recovery path must not restore, resubmit, release, or delete funds on them.
 */
export type ExactInputStates =
  | { readonly kind: 'spent' }
  | { readonly kind: 'unspent' }
  /** Every input is SPENT or UNSPENT, and both occur. `states` follows the input order. */
  | { readonly kind: 'mixed'; readonly states: readonly ('SPENT' | 'UNSPENT')[] }
  /** Every state is a NUT-07 value, and at least one input is PENDING. */
  | { readonly kind: 'pending' }
  /** The reading holds each input Y once, but a state is not a NUT-07 value. */
  | { readonly kind: 'unknown-state' }
  /** The reading does not hold each input Y exactly once, or the inputs share a Y. */
  | { readonly kind: 'mismatch' }

type Nut07State = 'UNSPENT' | 'PENDING' | 'SPENT'

const MISMATCH: ExactInputStates = { kind: 'mismatch' }

/**
 * Classify one NUT-07 reading against the exact inputs of one request.
 *
 * The reading must contain each input Y exactly once: no missing, extra, or
 * duplicate Y. The classification uses Y, not response position. An input with
 * an unsupported keyset ID throws.
 */
export function classifyExactInputStates(
  inputs: readonly { readonly id: string; readonly secret: string }[],
  states: unknown,
): ExactInputStates {
  // Derive first, so that an unsupported keyset throws for every reading.
  const expectedYs = inputs.map(deriveInputY)
  if (expectedYs.length === 0 || !Array.isArray(states) || states.length !== expectedYs.length) {
    return MISMATCH
  }
  const observed = new Map<string, unknown>()
  for (const entry of states as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return MISMATCH
    const { Y, state } = entry as { readonly Y?: unknown; readonly state?: unknown }
    if (typeof Y !== 'string' || observed.has(Y)) return MISMATCH
    observed.set(Y, state)
  }
  // Equal counts, distinct observed Ys, distinct expected Ys, and every
  // expected Y observed together prove that the two Y sets are equal.
  if (new Set(expectedYs).size !== expectedYs.length || expectedYs.some((Y) => !observed.has(Y))) {
    return MISMATCH
  }
  const exact = expectedYs.map((Y) => observed.get(Y))
  if (!exact.every(isNut07State)) return { kind: 'unknown-state' }
  if (exact.every((state) => state === 'SPENT')) return { kind: 'spent' }
  if (exact.every((state) => state === 'UNSPENT')) return { kind: 'unspent' }
  if (exact.includes('PENDING')) return { kind: 'pending' }
  return { kind: 'mixed', states: exact as ('SPENT' | 'UNSPENT')[] }
}

/** The NUT-00 secp256k1 Y. Another keyset curve gives a different Y, so it throws. */
function deriveInputY(input: { readonly id: string; readonly secret: string }): string {
  requireSupportedCashuKeysetId(input.id)
  if (typeof input.secret !== 'string') throw new Error('exact input secret is invalid')
  return hashToCurve(new TextEncoder().encode(input.secret)).toHex(true)
}

function isNut07State(value: unknown): value is Nut07State {
  return value === 'UNSPENT' || value === 'PENDING' || value === 'SPENT'
}
