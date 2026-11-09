/**
 * The automatic replay halt of range-order recovery (ADR-037 mint refusal
 * settlement). A client stops the automatic replay of one order attempt
 * after repeated identical coded refusals, until the user asks for a retry.
 *
 * A refusal is identical only when the mint refused the same request
 * (source, consolidation, or refund) with the same code. One order journal
 * revision can hold refusals of more than one request: a recovery pass can
 * restore the source and then meet a refused refund. So source refusals do
 * not count toward a later refund refusal. The count is a load control, not
 * funds authority.
 */

/** Identical coded refusals of one request before the automatic replay stops. */
export const CTF_RANGE_RECOVERY_REFUSAL_LIMIT = 5

/** The request of an order attempt that the mint refused. */
export type CtfRangeRefusedRequest = 'source' | 'consolidation' | 'refund'

export interface CtfRangeRecoveryRefusalCount {
  /** The refused request, or null for another mint request of the attempt. */
  readonly request: CtfRangeRefusedRequest | null
  readonly code: number
  /** The bounded mint detail of the latest refusal. */
  readonly detail: string
  readonly count: number
}

/**
 * Count one coded refusal after `previous`. A refusal of another request or
 * with another code starts a new count.
 */
export function countCtfRangeRecoveryRefusal(
  previous: CtfRangeRecoveryRefusalCount | null,
  refusal: {
    readonly request: CtfRangeRefusedRequest | null
    readonly code: number
    readonly detail: string
  },
): { readonly refusal: CtfRangeRecoveryRefusalCount; readonly halted: boolean } {
  const count =
    previous !== null && previous.request === refusal.request && previous.code === refusal.code
      ? previous.count + 1
      : 1
  return {
    refusal: { request: refusal.request, code: refusal.code, detail: refusal.detail, count },
    halted: count >= CTF_RANGE_RECOVERY_REFUSAL_LIMIT,
  }
}

/** Allow one manual retry. The same refusal halts the attempt again at once. */
export function resumeCtfRangeRecoveryRefusalCount(
  refusal: CtfRangeRecoveryRefusalCount,
): CtfRangeRecoveryRefusalCount {
  return { ...refusal, count: Math.min(refusal.count, CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1) }
}

/** Decode a stored refused request. Null names another mint request. */
export function decodeCtfRangeRefusedRequest(value: unknown): CtfRangeRefusedRequest | null {
  switch (value) {
    case null:
      return null
    case 'source':
    case 'consolidation':
    case 'refund':
      return value
    default:
      throw new Error('CTF range refused request is invalid')
  }
}
