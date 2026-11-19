import { classifyExactInputStates, type ExactInputStates } from './exactInputStates.ts'

export const CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX = 256

const FAILURE_MESSAGE_LENGTH_MAX = 1_024

export type CtfRangeSourceJournalKind = 'authorization-source' | 'consolidation'
export type CtfRangeSourceJournalState = 'prepared' | 'completed' | 'failed'

export type CtfRangeSourceRecoveryPendingReason =
  /**
   * Every input is SPENT or UNSPENT, and both occur. A range order coordinator
   * replays the exact request once, so that the mint answers with a code.
   */
  | 'mixed-input-states'
  | 'pending-input-state'
  | 'unknown-input-state'
  /** The reading does not hold each exact input Y once. It is not evidence. */
  | 'input-state-mismatch'

export type CtfRangeSourceRecoveryDecision =
  | { readonly kind: 'reuse-completed' }
  | { readonly kind: 'replay-exact-persisted-operation' }
  | { readonly kind: 'restore-exact-persisted-outputs' }
  | {
      readonly kind: 'remain-pending'
      readonly reason: CtfRangeSourceRecoveryPendingReason
    }
  | {
      readonly kind: 'fail'
      readonly reason: string
    }

export interface CtfRangeSourceRecoveryInput {
  readonly journalKind: CtfRangeSourceJournalKind
  readonly journalState: CtfRangeSourceJournalState
  /** The exact inputs of the persisted operation. */
  readonly inputs: readonly { readonly id: string; readonly secret: string }[]
  /** One NUT-07 reading of those inputs. It is classified by Y, not by position. */
  readonly inputStates: unknown
  readonly now: number
  readonly authorizationExpiry?: number | null
  readonly failureReason?: string | null
}

/**
 * Classifies recovery without performing persistence or transport effects.
 * Adapters must execute only the returned exact-operation decision and commit
 * its resulting journal/proof transition atomically.
 */
export function classifyCtfRangeSourceRecovery(
  input: CtfRangeSourceRecoveryInput,
): CtfRangeSourceRecoveryDecision {
  const journalKind = requireJournalKind(input.journalKind)
  const journalState = requireJournalState(input.journalState)
  requireTimestamp(input.now, 'recovery observation time')
  requireExpiry(journalKind, input.authorizationExpiry)
  requireInputBound(input.inputs)

  switch (journalState) {
    case 'completed': {
      requireAbsentFailureReason(input.failureReason)
      return { kind: 'reuse-completed' }
    }
    case 'failed':
      return {
        kind: 'fail',
        reason: requireFailureReason(input.failureReason),
      }
    case 'prepared': {
      requireAbsentFailureReason(input.failureReason)
      if (input.inputs.length < 1) {
        throw new Error('CTF range source recovery input count is invalid')
      }
      return classifyPrepared(classifyExactInputStates(input.inputs, input.inputStates))
    }
  }
}

function classifyPrepared(states: ExactInputStates): CtfRangeSourceRecoveryDecision {
  switch (states.kind) {
    case 'spent':
      return { kind: 'restore-exact-persisted-outputs' }
    case 'unspent':
      return { kind: 'replay-exact-persisted-operation' }
    case 'mixed':
      return { kind: 'remain-pending', reason: 'mixed-input-states' }
    case 'pending':
      return { kind: 'remain-pending', reason: 'pending-input-state' }
    case 'unknown-state':
      return { kind: 'remain-pending', reason: 'unknown-input-state' }
    case 'mismatch':
      return { kind: 'remain-pending', reason: 'input-state-mismatch' }
    default:
      return assertNever(states)
  }
}

function requireJournalKind(value: unknown): CtfRangeSourceJournalKind {
  switch (value) {
    case 'authorization-source':
    case 'consolidation':
      return value
    default:
      throw new Error('CTF range source journal kind is invalid')
  }
}

function requireJournalState(value: unknown): CtfRangeSourceJournalState {
  switch (value) {
    case 'prepared':
    case 'completed':
    case 'failed':
      return value
    default:
      throw new Error('CTF range source journal state is invalid')
  }
}

function requireInputBound(values: readonly unknown[]): void {
  if (!Array.isArray(values) || values.length > CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX) {
    throw new Error('CTF range source recovery input count is invalid')
  }
}

function requireExpiry(
  journalKind: CtfRangeSourceJournalKind,
  value: number | null | undefined,
): void {
  if (journalKind === 'consolidation') {
    if (value !== undefined && value !== null) {
      throw new Error('CTF range consolidation must not carry authorization expiry')
    }
    return
  }
  if (value !== undefined && value !== null) {
    requireTimestamp(value, 'authorization expiry')
  }
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CTF range source ${label} is invalid`)
  }
  return value
}

function requireFailureReason(value: string | null | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > FAILURE_MESSAGE_LENGTH_MAX ||
    value !== value.trim()
  ) {
    throw new Error('CTF range source failure reason is invalid')
  }
  return value
}

function requireAbsentFailureReason(value: string | null | undefined): void {
  if (value !== undefined && value !== null) {
    throw new Error('non-failed CTF range source journal carries a failure reason')
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled exact input state class: ${JSON.stringify(value)}`)
}
