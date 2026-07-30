export const CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX = 256

const FAILURE_MESSAGE_LENGTH_MAX = 1_024

export type CtfRangeSourceJournalKind = 'authorization-source' | 'consolidation'
export type CtfRangeSourceJournalState = 'prepared' | 'completed' | 'failed'
export type CtfRangeSourceInputState = 'UNSPENT' | 'PENDING' | 'SPENT'

export type CtfRangeSourceRecoveryPendingReason =
  | 'mixed-input-states'
  | 'pending-input-state'
  | 'unknown-input-state'

export type CtfRangeSourceRecoveryDecision =
  | { readonly kind: 'reuse-completed' }
  | { readonly kind: 'replay-exact-persisted-operation' }
  | { readonly kind: 'restore-exact-persisted-outputs' }
  | { readonly kind: 'release-exact-unspent-inputs' }
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
  readonly inputStates: readonly unknown[]
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
  const now = requireTimestamp(input.now, 'recovery observation time')
  const expiry = requireExpiry(journalKind, input.authorizationExpiry)
  requireObservationBound(input.inputStates)

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
      return classifyPrepared(journalKind, input.inputStates, now, expiry)
    }
  }
}

function classifyPrepared(
  journalKind: CtfRangeSourceJournalKind,
  values: readonly unknown[],
  now: number,
  expiry: number | null,
): CtfRangeSourceRecoveryDecision {
  if (values.length < 1) {
    throw new Error('CTF range source recovery input count is invalid')
  }
  const states = values.map(normalizeObservedInputState)
  if (states.some((state) => state === null)) {
    return { kind: 'remain-pending', reason: 'unknown-input-state' }
  }
  if (states.every((state) => state === 'SPENT')) {
    return { kind: 'restore-exact-persisted-outputs' }
  }
  if (states.every((state) => state === 'UNSPENT')) {
    if (journalKind === 'authorization-source' && expiry !== null && now >= expiry) {
      return { kind: 'release-exact-unspent-inputs' }
    }
    return { kind: 'replay-exact-persisted-operation' }
  }
  if (states.some((state) => state === 'PENDING')) {
    return { kind: 'remain-pending', reason: 'pending-input-state' }
  }
  return { kind: 'remain-pending', reason: 'mixed-input-states' }
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

function normalizeObservedInputState(value: unknown): CtfRangeSourceInputState | null {
  switch (value) {
    case 'UNSPENT':
    case 'PENDING':
    case 'SPENT':
      return value
    default:
      return null
  }
}

function requireObservationBound(values: readonly unknown[]): void {
  if (!Array.isArray(values) || values.length > CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX) {
    throw new Error('CTF range source recovery input count is invalid')
  }
}

function requireExpiry(
  journalKind: CtfRangeSourceJournalKind,
  value: number | null | undefined,
): number | null {
  if (journalKind === 'consolidation') {
    if (value !== undefined && value !== null) {
      throw new Error('CTF range consolidation must not carry authorization expiry')
    }
    return null
  }
  return value === undefined || value === null
    ? null
    : requireTimestamp(value, 'authorization expiry')
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
