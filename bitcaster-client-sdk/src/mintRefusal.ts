/**
 * Cashu mint failures that a client may act on.
 *
 * cdk 0.18.2 commits the inputs and the blind signatures of a CTF convert or a
 * swap in one database transaction (CTF convert: `mint/swap/atomic.rs`
 * `execute_atomic_ctf_convert`; swap: `mint/swap/swap_saga` setup and finalize,
 * with compensation on failure). Each code in this set is returned before that
 * commit, and the same request bytes can never succeed later. A client can
 * therefore release the inputs of a refused request after it observes their
 * state again.
 *
 * - 10001 TokenNotVerified: a proof signature fails against fixed keyset keys.
 * - 11003 BlindedMessageAlreadySigned: a signed output row already exists.
 * - 11005 TransactionUnbalanced: amounts and keyset fees are fixed by the bytes.
 * - 11007 DuplicateInputs and 11008 DuplicateOutputs: duplicate values in the
 *   request, or outputs that the mint already holds.
 * - 11009 MultipleUnits and 11010 UnitMismatch: keyset units are fixed.
 * - 12003 KeysetExpired: a version 2 keyset ID commits to its final expiry.
 * - 13016 and 13017: conditional keyset bindings are fixed.
 * - 13041 ConvertPayoffFeeViolation: conservation over fixed amounts and fees.
 * - 13042 ConvertNotPermitted: an attested condition never returns to pending.
 *
 * Every other code keeps the uncertain path. For example, 11001 can follow the
 * request's own lost commit, 11002 can come from an in-flight copy that later
 * commits, and limit or keyset-activity codes depend on mutable mint state.
 */
export const UNCOMMITTED_FINAL_MINT_REFUSAL_CODES: ReadonlySet<number> = new Set([
  10001, 11003, 11005, 11007, 11008, 11009, 11010, 12003, 13016, 13017, 13041, 13042,
])

/** Refusals that show an output counter range is already signed by this seed. */
export const MINT_OUTPUT_REUSE_REFUSAL_CODES: ReadonlySet<number> = new Set([11003, 11008])

export interface CashuMintRefusal {
  readonly code: number
  readonly detail: string
}

export type CashuMintFailure =
  | ({ readonly kind: 'final-refusal' } & CashuMintRefusal)
  | ({ readonly kind: 'refusal' } & CashuMintRefusal)
  | { readonly kind: 'transient'; readonly retryAfterMs: number | null }

const CAUSE_DEPTH_MAX = 4
const DETAIL_LENGTH_MAX = 256
// A cdk database error can quote a blinded message or a proof Y point.
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{32,}/g

/** Classify one failure of a mint request. Unknown failures are transient. */
export function classifyCashuMintFailure(error: unknown): CashuMintFailure {
  let current: unknown = error
  let retryAfterMs: number | null = null
  for (let depth = 0; depth < CAUSE_DEPTH_MAX && current instanceof Error; depth += 1) {
    const refusal = mintRefusal(current)
    if (refusal !== null) {
      return {
        kind: UNCOMMITTED_FINAL_MINT_REFUSAL_CODES.has(refusal.code) ? 'final-refusal' : 'refusal',
        ...refusal,
      }
    }
    retryAfterMs ??= retryAfter(current)
    current = (current as { cause?: unknown }).cause
  }
  return { kind: 'transient', retryAfterMs }
}

function mintRefusal(error: Error): CashuMintRefusal | null {
  if (error.name !== 'MintOperationError') return null
  const code: unknown = (error as { code?: unknown }).code
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code <= 0) return null
  return { code, detail: boundedDetail(error.message) }
}

function retryAfter(error: Error): number | null {
  const value: unknown = (error as { retryAfterMs?: unknown }).retryAfterMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function boundedDetail(value: string): string {
  return value.replace(LONG_HEX, '…').slice(0, DETAIL_LENGTH_MAX)
}
