/**
 * Cashu mint failures that a range-order client may act on.
 *
 * Two refusals let a client settle a persisted request, as ordinary Cashu
 * wallets do after a restore scan or a proof-state check:
 *
 * - 11003 and 11008 (outputs already signed): another client with the same
 *   seed signed these outputs. The client advances its counters past the
 *   mint's signed range, checks the inputs again, and releases them when all
 *   are unspent.
 * - 11001 (token already spent): the client checks the inputs again, retires
 *   the spent ones, and releases the rest.
 *
 * cdk 0.18.2 commits the inputs and the blind signatures of one request
 * together (CTF convert: `mint/swap/atomic.rs` `execute_atomic_ctf_convert`;
 * swap: `mint/swap/swap_saga` setup and finalize, with compensation). The
 * client sends one copy at a time under the wallet profile lock and never
 * resends released bytes. Every other code keeps the uncertain path.
 */
export const MINT_OUTPUT_REUSE_REFUSAL_CODES: ReadonlySet<number> = new Set([11003, 11008])
export const MINT_SPENT_INPUT_REFUSAL_CODE = 11001

export interface CashuMintRefusal {
  readonly code: number
  readonly detail: string
}

export type CashuMintFailure =
  | ({ readonly kind: 'refusal' } & CashuMintRefusal)
  | { readonly kind: 'transient'; readonly retryAfterMs: number | null }

/** A refusal that, with a fresh NUT-07 reading, can settle a persisted request. */
export type CtfRangeSettlingRefusal = 'outputs-signed' | 'inputs-spent'

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
    if (refusal !== null) return { kind: 'refusal', ...refusal }
    retryAfterMs ??= retryAfter(current)
    current = (current as { cause?: unknown }).cause
  }
  return { kind: 'transient', retryAfterMs }
}

export function settlingMintRefusal(failure: CashuMintFailure): CtfRangeSettlingRefusal | null {
  switch (failure.kind) {
    case 'transient':
      return null
    case 'refusal':
      if (MINT_OUTPUT_REUSE_REFUSAL_CODES.has(failure.code)) return 'outputs-signed'
      return failure.code === MINT_SPENT_INPUT_REFUSAL_CODE ? 'inputs-spent' : null
    default:
      return assertNever(failure)
  }
}

export type CtfRangeRequestSettlement =
  | { readonly kind: 'replay' }
  | { readonly kind: 'restore' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'release'; readonly spentInputIndexes: readonly number[] }

/**
 * Decide how a client settles one persisted mint request from a fresh NUT-07
 * reading of every input, taken under the wallet profile lock.
 *
 * - A pending or unknown input waits.
 * - All spent inputs need the exact NUT-09 restore: an earlier copy can have
 *   committed.
 * - Without a settling refusal, the client replays the exact request. A mixed
 *   reading replays too, so that the mint answers with its spent-input code.
 * - After an outputs-signed refusal, unspent inputs are released.
 * - After an inputs-spent refusal, the spent inputs are retired and the rest
 *   released. All unspent inputs contradict that answer and wait.
 */
export function decideCtfRangeRequestSettlement(input: {
  readonly refusal: CtfRangeSettlingRefusal | null
  readonly inputStates: readonly unknown[]
}): CtfRangeRequestSettlement {
  if (!Array.isArray(input.inputStates) || input.inputStates.length === 0) {
    throw new Error('CTF range request input states are missing')
  }
  const states = input.inputStates
  if (states.some((state) => state !== 'SPENT' && state !== 'UNSPENT')) return { kind: 'wait' }
  const spentInputIndexes = states.flatMap((state, index) => (state === 'SPENT' ? [index] : []))
  if (spentInputIndexes.length === states.length) return { kind: 'restore' }
  switch (input.refusal) {
    case null:
      return { kind: 'replay' }
    case 'outputs-signed':
      return { kind: 'release', spentInputIndexes }
    case 'inputs-spent':
      return spentInputIndexes.length === 0
        ? { kind: 'wait' }
        : { kind: 'release', spentInputIndexes }
    default:
      return assertNever(input.refusal)
  }
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

function assertNever(value: never): never {
  throw new Error(`unhandled mint refusal variant: ${String(value)}`)
}
