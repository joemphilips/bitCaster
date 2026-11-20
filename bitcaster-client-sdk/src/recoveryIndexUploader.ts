import {
  planRecoveryIndexRetryDelayMs,
  type RecoveryIndexSync,
  type RecoveryIndexUploadOutcome,
  type RecoveryIndexUploadRetryReason,
} from './recoveryIndexSync.ts'

/**
 * The upload runtime of one seed, for every client: the browser, the daemon,
 * and the CLI (ADR-051 "Upload", ADR-034 "Client upload"). A funded operation
 * never waits for it: the client asks for an upload after a local commit, and
 * the local counter cursors are the retry queue. Requests during an upload
 * coalesce into one more upload. The only timer is a wait that the SDK asks
 * for: the retry after a failure, or the end of the minimum write interval of
 * one key. It never reads the index on a timer otherwise.
 */

export type RecoveryIndexUploaderStatus =
  | { readonly kind: 'starting' }
  /** The engine acknowledged an index that lists every local keyset. */
  | { readonly kind: 'current' }
  /**
   * An upload waits. Trading continues. During the backoff after a failure,
   * the reason stays the reason of that failure.
   */
  | {
      readonly kind: 'pending'
      readonly reason: RecoveryIndexUploadRetryReason | 'local-failure'
    }
  /** A persistent error. The client writes nothing until a later read changes the document. */
  | {
      readonly kind: 'blocked'
      readonly reason: 'undecodable' | 'unsupported-version' | 'over-cap'
    }

export interface RecoveryIndexUploaderOptions {
  readonly sync: RecoveryIndexSync
  readonly nowMs: () => number
  /** A uniform sample in [0, 1) for the retry jitter. */
  readonly random?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
  /** Run one upload under the seed lock of the client, for example a lock across browser tabs. */
  readonly withSeedLock?: <T>(work: () => Promise<T>) => Promise<T>
  /** Runs after each upload that leaves the index current. Its failure is ignored. */
  readonly afterCurrent?: () => Promise<void>
}

export class RecoveryIndexUploader {
  readonly #options: RecoveryIndexUploaderOptions
  readonly #listeners = new Set<() => void>()
  #status: RecoveryIndexUploaderStatus = { kind: 'starting' }
  #uploading: Promise<void> | null = null
  #uploadRequested = false
  #retryTimer: unknown = undefined
  #localFailureStreak = 0
  #stopped = false

  constructor(options: RecoveryIndexUploaderOptions) {
    this.#options = options
  }

  get status(): RecoveryIndexUploaderStatus {
    return this.#status
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Ask for an upload of the pending keysets. The caller never awaits it, so
   * a funded operation continues while the engine is unreachable.
   */
  requestUpload(): void {
    if (this.#stopped) return
    if (this.#uploading !== null) {
      this.#uploadRequested = true
      return
    }
    const running = this.#runUploads()
    this.#uploading = running
    void running.finally(() => {
      if (this.#uploading === running) this.#uploading = null
    })
  }

  /** Wait until no upload runs, for a test, a status read, or a gate. */
  async settled(): Promise<void> {
    while (this.#uploading !== null) await this.#uploading
  }

  /**
   * Upload once now, for a gate that needs the outcome, such as a seed
   * handoff. A local failure rejects and changes no status.
   */
  async uploadOnce(): Promise<RecoveryIndexUploadOutcome> {
    const outcome = await this.#withSeedLock(() => this.#options.sync.upload())
    this.#apply(outcome)
    return outcome
  }

  stop(): void {
    this.#stopped = true
    this.#clearRetry()
    this.#listeners.clear()
  }

  async #runUploads(): Promise<void> {
    do {
      this.#uploadRequested = false
      this.#clearRetry()
      let outcome: RecoveryIndexUploadOutcome | null
      try {
        outcome = await this.#withSeedLock(() => this.#options.sync.upload())
        this.#localFailureStreak = 0
      } catch {
        // A local read failed. The next event or the retry below tries again.
        outcome = null
      }
      if (this.#stopped) return
      this.#apply(outcome)
      if (outcome?.status === 'written' || outcome?.status === 'current') {
        await this.#options.afterCurrent?.().catch(() => undefined)
      }
    } while (this.#uploadRequested && !this.#stopped)
  }

  #apply(outcome: RecoveryIndexUploadOutcome | null): void {
    if (this.#stopped) return
    if (outcome === null) {
      this.#localFailureStreak += 1
      this.#setStatus({ kind: 'pending', reason: 'local-failure' })
      this.#scheduleRetry(
        this.#options.nowMs() +
          planRecoveryIndexRetryDelayMs({
            streak: this.#localFailureStreak,
            minimumDelayMs: 0,
            random: this.#options.random ?? Math.random,
          }),
      )
      return
    }
    switch (outcome.status) {
      case 'current':
      case 'written':
        this.#setStatus({ kind: 'current' })
        return
      case 'retry':
        this.#setStatus({ kind: 'pending', reason: this.#pendingReason(outcome.reason) })
        this.#scheduleRetry(outcome.retryAtMs)
        return
      case 'blocked':
        this.#setStatus({ kind: 'blocked', reason: outcome.reason })
        return
      default:
        assertNever(outcome)
    }
  }

  /**
   * A backoff or a write-interval wait is not a failure of its own. While an
   * earlier failure is pending, keep its reason, so that the state names it.
   */
  #pendingReason(
    reason: RecoveryIndexUploadRetryReason,
  ): RecoveryIndexUploadRetryReason | 'local-failure' {
    if (reason !== 'backoff' && reason !== 'write-interval') return reason
    return this.#status.kind === 'pending' ? this.#status.reason : reason
  }

  /** The one timer: a wait that the SDK asks for (a retry or the write interval). */
  #scheduleRetry(atMs: number): void {
    this.#clearRetry()
    const setTimer =
      this.#options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#retryTimer = setTimer(
      () => {
        this.#retryTimer = undefined
        this.requestUpload()
      },
      Math.max(0, atMs - this.#options.nowMs()),
    )
  }

  #clearRetry(): void {
    if (this.#retryTimer === undefined) return
    const clearTimer =
      this.#options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    clearTimer(this.#retryTimer)
    this.#retryTimer = undefined
  }

  /** Keep the status object while the status is the same, so that a snapshot stays stable. */
  #setStatus(status: RecoveryIndexUploaderStatus): void {
    const current = this.#status
    const unchanged =
      status.kind === current.kind &&
      (!('reason' in status) || ('reason' in current && status.reason === current.reason))
    if (unchanged) return
    this.#status = status
    for (const listener of this.#listeners) listener()
  }

  #withSeedLock<T>(work: () => Promise<T>): Promise<T> {
    return this.#options.withSeedLock === undefined ? work() : this.#options.withSeedLock(work)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled recovery index upload value: ${JSON.stringify(value)}`)
}
