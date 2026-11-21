/**
 * The status of the automatic wallet recovery, and the rule that permits an
 * empty holdings display to be final. Every client uses this one rule, so no
 * client shows "No funds" while its recovery is still checking, is pending,
 * or cannot be read.
 *
 * - A result belongs to one wallet activation and one set of mints (its tag).
 *   A result with another tag is stale: a late result of an earlier
 *   activation of the same wallet, of another wallet, or of another mint set
 *   never completes the current one.
 * - The precedence is unavailable, then checking, then pending, then
 *   completed. One stage that is not known to be complete keeps the whole
 *   recovery from completion.
 * - An empty holdings read is final only after a completed recovery with full
 *   coverage, when the read has the same tag and began after that pass.
 *
 * This module does no I/O. The caller supplies the observations.
 */

/** Consecutive failures of one stage that make the recovery unavailable. */
export const WALLET_RECOVERY_PERSISTENT_FAILURES = 3

/** One activation of a wallet profile in one page. Each activation has a new epoch. */
export interface WalletRecoveryActivation {
  readonly scopeId: string
  readonly epoch: number
}

/** The activation and the normalized mint set that a recovery result belongs to. */
export interface WalletRecoveryTag {
  readonly activation: WalletRecoveryActivation
  /** The value of `walletRecoveryMintSetTag`. */
  readonly mintSetTag: string
}

/**
 * Why a recovery stage waits.
 * - `operation`: a wallet operation is in progress or waits for the mint.
 * - `proof-pending`: a proof is PENDING at the mint.
 * - `scan-continues`: a budgeted scan has more work.
 * - `start-limit`: the start limit of the scan denied a start until a time.
 * - `probe-due`: a deferred probe is due at a time.
 * - `backoff`: a stage failed and waits for its retry.
 */
export type WalletRecoveryPendingReason =
  | 'operation'
  | 'proof-pending'
  | 'scan-continues'
  | 'start-limit'
  | 'probe-due'
  | 'backoff'

/** `limited` coverage completes the checks but never permits a final empty display. */
export type WalletRecoveryCoverage = 'full' | 'limited'

/** The observed result of one recovery stage in one pass. */
export type WalletRecoveryStageObservation =
  | { readonly stage: string; readonly state: 'not-run' }
  | {
      readonly stage: string
      readonly state: 'completed'
      readonly coverage: WalletRecoveryCoverage
    }
  | {
      readonly stage: string
      readonly state: 'pending'
      readonly reason: WalletRecoveryPendingReason
      /** The earliest time at which the stage can continue, or null when it is not known. */
      readonly retryAtMs: number | null
    }
  | {
      readonly stage: string
      readonly state: 'failed'
      /** The failures of this stage in a row, including this one. */
      readonly consecutiveFailures: number
      readonly retryAtMs: number | null
    }

/** The stage results of the latest recovery pass of one tag. */
export interface WalletRecoveryObservations {
  readonly tag: WalletRecoveryTag
  /** The sequence number of the pass that these observations describe. */
  readonly passSeq: number
  readonly stages: readonly WalletRecoveryStageObservation[]
}

/**
 * A failure count from a durable recovery record of the current tag. These
 * records outlive one pass and one activation, so a stale observation tag
 * does not hide them.
 */
export interface WalletRecoveryFailureCount {
  readonly source: string
  readonly consecutiveFailures: number
  readonly retryAtMs: number | null
}

export type WalletRecoveryUnavailableReason =
  /** There is no active wallet profile. Retry cannot correct this. */
  | 'profile-unavailable'
  /** The recovery observations could not be read. */
  | 'read-failed'
  /** A stage failed `WALLET_RECOVERY_PERSISTENT_FAILURES` times in a row. */
  | 'recovery-failed'

export type WalletRecoveryStatus =
  | { readonly kind: 'checking'; readonly tag: WalletRecoveryTag }
  | {
      readonly kind: 'pending'
      readonly tag: WalletRecoveryTag
      readonly reason: WalletRecoveryPendingReason
      readonly retryAtMs: number | null
    }
  | {
      readonly kind: 'unavailable'
      readonly tag: WalletRecoveryTag | null
      readonly reason: WalletRecoveryUnavailableReason
      readonly retryable: boolean
    }
  | {
      readonly kind: 'completed'
      readonly tag: WalletRecoveryTag
      readonly passSeq: number
      readonly coverage: WalletRecoveryCoverage
    }

export interface WalletRecoveryClassificationInput {
  /** The tag of the active wallet, or null when no wallet profile is active. */
  readonly current: WalletRecoveryTag | null
  readonly observations: WalletRecoveryObservations | 'read-failed'
  readonly persistentFailures: readonly WalletRecoveryFailureCount[]
}

/** A holdings read (funds, positions, counts) of one tag. */
export type WalletRecoveryHoldingsRead<T> =
  | { readonly kind: 'unhydrated' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ok'
      readonly tag: WalletRecoveryTag
      /** The latest completed pass sequence when the read began. */
      readonly afterPassSeq: number
      readonly value: readonly T[]
    }

/**
 * The tag of a set of normalized mint URLs. The order and duplicates do not
 * change the tag. The caller normalizes each URL with the same rule that keys
 * its durable recovery records.
 */
export function walletRecoveryMintSetTag(normalizedUrls: readonly string[]): string {
  for (const url of normalizedUrls) {
    if (url.trim() === '') throw new Error('a wallet recovery mint URL is empty')
  }
  // JSON keeps a value that contains a separator distinct from two values.
  return JSON.stringify([...new Set(normalizedUrls)].sort())
}

export function sameWalletRecoveryTag(a: WalletRecoveryTag, b: WalletRecoveryTag): boolean {
  return (
    a.activation.scopeId === b.activation.scopeId &&
    a.activation.epoch === b.activation.epoch &&
    a.mintSetTag === b.mintSetTag
  )
}

interface PendingCandidate {
  readonly reason: WalletRecoveryPendingReason
  readonly retryAtMs: number | null
}

export function classifyWalletRecoveryStatus(
  input: WalletRecoveryClassificationInput,
): WalletRecoveryStatus {
  const { current, observations, persistentFailures } = input
  if (current === null) {
    return { kind: 'unavailable', tag: null, reason: 'profile-unavailable', retryable: false }
  }
  if (observations === 'read-failed') {
    return { kind: 'unavailable', tag: current, reason: 'read-failed', retryable: true }
  }
  if (!Number.isSafeInteger(observations.passSeq) || observations.passSeq < 0) {
    throw new Error('a wallet recovery pass sequence is invalid')
  }
  const recoveryFailed: WalletRecoveryStatus = {
    kind: 'unavailable',
    tag: current,
    reason: 'recovery-failed',
    retryable: true,
  }
  const pending: PendingCandidate[] = []
  for (const failure of persistentFailures) {
    const count = failureCount(failure.consecutiveFailures)
    if (count >= WALLET_RECOVERY_PERSISTENT_FAILURES) return recoveryFailed
    if (count > 0) pending.push({ reason: 'backoff', retryAtMs: failure.retryAtMs })
  }
  // A stale result does not count, so its failures do not count either.
  if (!sameWalletRecoveryTag(observations.tag, current)) return { kind: 'checking', tag: current }

  let checking = observations.stages.length === 0
  let coverage: WalletRecoveryCoverage = 'full'
  const stagePending: PendingCandidate[] = []
  for (const observation of observations.stages) {
    switch (observation.state) {
      case 'not-run':
        checking = true
        break
      case 'completed':
        switch (observation.coverage) {
          case 'full':
            break
          case 'limited':
            coverage = 'limited'
            break
          default:
            return assertNever('coverage', observation.coverage, observation.coverage)
        }
        break
      case 'pending':
        stagePending.push({ reason: observation.reason, retryAtMs: observation.retryAtMs })
        break
      case 'failed': {
        const count = failureCount(observation.consecutiveFailures)
        if (count >= WALLET_RECOVERY_PERSISTENT_FAILURES) return recoveryFailed
        stagePending.push({ reason: 'backoff', retryAtMs: observation.retryAtMs })
        break
      }
      default:
        return assertNever('stage state', (observation as { state: unknown }).state, observation)
    }
  }
  if (checking) return { kind: 'checking', tag: current }
  // The stages come first, so an equal retry time keeps the stage order.
  const first = earliestPending([...stagePending, ...pending])
  if (first !== null) return { kind: 'pending', tag: current, ...first }
  return { kind: 'completed', tag: current, passSeq: observations.passSeq, coverage }
}

/**
 * True only when an empty holdings read can show as final: the recovery
 * completed with full coverage, and the read has the same tag and began after
 * that pass completed.
 */
export function walletRecoveryEmptyIsTerminal<T>(
  status: WalletRecoveryStatus,
  read: WalletRecoveryHoldingsRead<T>,
): boolean {
  switch (read.kind) {
    case 'unhydrated':
    case 'failed':
      return false
    case 'ok':
      return (
        status.kind === 'completed' &&
        status.coverage === 'full' &&
        sameWalletRecoveryTag(read.tag, status.tag) &&
        read.afterPassSeq >= status.passSeq &&
        read.value.length === 0
      )
    default:
      return assertNever('holdings read', (read as { kind: unknown }).kind, read)
  }
}

/** The earliest known retry time wins. An unknown time sorts last. */
function earliestPending(candidates: readonly PendingCandidate[]): PendingCandidate | null {
  let first: PendingCandidate | null = null
  for (const candidate of candidates) {
    if (first === null) first = candidate
    else if (
      candidate.retryAtMs !== null &&
      (first.retryAtMs === null || candidate.retryAtMs < first.retryAtMs)
    ) {
      first = candidate
    }
  }
  return first === null ? null : { reason: first.reason, retryAtMs: first.retryAtMs }
}

function failureCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('a wallet recovery failure count is invalid')
  }
  return value
}

function assertNever(name: string, variant: unknown, _value: never): never {
  throw new Error(`unknown wallet recovery ${name}: ${JSON.stringify(variant)}`)
}
