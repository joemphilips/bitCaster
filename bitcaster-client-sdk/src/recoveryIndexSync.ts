import { MINT_OUTPUT_REUSE_REFUSAL_CODES, type CashuMintFailure } from './mintRefusal.ts'
import {
  RecoveryIndexCapacityError,
  RecoveryIndexFormatError,
  mergeRecoveryIndex,
  openRecoveryIndexDocument,
  pendingRecoveryIndexEntries,
  sameRecoveryIndexEntries,
  unlistedRecoveryIndexEntries,
  recoveryIndexEntryKey,
  sealRecoveryIndexDocument,
  type RecoveryIndexEntry,
  type RecoveryIndexFormatErrorReason,
  type RecoveryIndexKeys,
} from './recoveryIndexDocument.ts'
import {
  RecoveryIndexEngineError,
  type RecoveryIndexEngineErrorKind,
  type RecoveryIndexStore,
} from './recoveryIndexEngine.ts'

/**
 * The upload loop and the index reads of one seed (ADR-051 "Upload",
 * ADR-034 "Client upload", ADR-033 "Index read and the keyset re-sync").
 *
 * The client writes only when a local keyset (a keyset with a counter
 * cursor) is pending: the last read document does not list it. The result of
 * an order causes no write. The local cursors are the retry queue, so no
 * outbox exists, and a funded operation never waits for an upload. This
 * class sets no timer: an upload that must wait returns the time of its next
 * attempt, and the caller schedules it. An upload never makes a mint request.
 */

/** Writes after a compare-and-swap conflict, before the retry schedule. */
export const RECOVERY_INDEX_CONFLICT_RETRIES_MAX = 3
/** The client side of the engine's minimum write interval of one key. */
export const RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS = 5_000
/** The ADR-034 retry schedule: a 5-second exponential base, a 1-hour cap, up to 20 % jitter. */
export const RECOVERY_INDEX_RETRY_BASE_MS = 5_000
export const RECOVERY_INDEX_RETRY_MAX_MS = 3_600_000
const RETRY_EXPONENT_MAX = 10

/** The mint refusals after which the client reads the index (ADR-033). */
export const RECOVERY_INDEX_READ_MINT_REFUSAL_CODES: ReadonlySet<number> = new Set([
  11001,
  ...MINT_OUTPUT_REUSE_REFUSAL_CODES,
])

/**
 * The events that read the index (ADR-033 and ADR-039). The client never reads
 * the index on a timer or when a page becomes visible again. A
 * `restore-retry` reads only after the last read found the engine unreachable
 * (ADR-039 "Restore order"); otherwise it returns the known document.
 */
export type RecoveryIndexReadTrigger =
  | 'wallet-open'
  | 'mint-refusal'
  | 'upload-conflict'
  | 'new-keyset'
  | 'seed-handoff'
  | 'restore-retry'

/** The document as of the last read or write. */
export type RecoveryIndexKnownDocument =
  | { readonly status: 'unread' }
  /** No document: no row (version 0) or a tombstone. */
  | { readonly status: 'absent'; readonly version: number }
  | {
      readonly status: 'listed'
      readonly version: number
      readonly entries: readonly RecoveryIndexEntry[]
    }
  /** The client cannot decode the document, so it never writes over it. */
  | {
      readonly status: 'undecodable'
      readonly version: number
      readonly reason: RecoveryIndexFormatErrorReason
    }

export type RecoveryIndexReadOutcome =
  | {
      readonly status: 'read'
      readonly trigger: RecoveryIndexReadTrigger
      readonly document: RecoveryIndexKnownDocument
      /** The listed keysets with no local cursor: the only keysets that the read lets the client scan. */
      readonly scan: readonly RecoveryIndexEntry[]
    }
  | {
      readonly status: 'failed'
      readonly trigger: RecoveryIndexReadTrigger
      readonly error: RecoveryIndexEngineError
    }
  /** A Retry with no unreachable engine before it sends nothing. It lists the known document. */
  | {
      readonly status: 'skipped'
      readonly trigger: 'restore-retry'
      readonly document: RecoveryIndexKnownDocument
      readonly scan: readonly RecoveryIndexEntry[]
    }

export type RecoveryIndexUploadRetryReason =
  | 'backoff'
  | 'write-interval'
  | 'conflict'
  | RecoveryIndexEngineErrorKind

export type RecoveryIndexUploadOutcome =
  /** No keyset is pending. */
  | { readonly status: 'current'; readonly version: number }
  | { readonly status: 'written'; readonly version: number }
  | {
      readonly status: 'retry'
      readonly reason: RecoveryIndexUploadRetryReason
      readonly retryAtMs: number
      readonly limitCode: string | null
    }
  /** A persistent error. The client writes nothing until a later read changes the document. */
  | {
      readonly status: 'blocked'
      readonly reason: 'undecodable' | 'unsupported-version' | 'over-cap'
    }

export function isRecoveryIndexReadMintRefusal(failure: CashuMintFailure): boolean {
  switch (failure.kind) {
    case 'refusal':
      return RECOVERY_INDEX_READ_MINT_REFUSAL_CODES.has(failure.code)
    case 'transient':
      return false
    default:
      return assertNever(failure)
  }
}

/**
 * The listed keysets of the wallet mints that have no local cursor. ADR-033:
 * an index read scans only these. ADR-039: an entry of a mint that is not a
 * wallet mint is not scanned, and it stays in the index.
 */
export function listedRecoveryIndexEntriesWithoutCursor(
  listed: readonly RecoveryIndexEntry[],
  local: readonly RecoveryIndexEntry[],
  walletMints: readonly string[],
): readonly RecoveryIndexEntry[] {
  const mints = new Set(walletMints)
  // A keyset with a local cursor in another form is not scanned again. The
  // upload resolves its form.
  return unlistedRecoveryIndexEntries(listed, local).filter(({ mintUrl }) => mints.has(mintUrl))
}

export function planRecoveryIndexRetryDelayMs(input: {
  /** The failures in a row, including this one. */
  readonly streak: number
  /** For example the engine's `Retry-After`. */
  readonly minimumDelayMs: number
  /** A uniform sample in [0, 1). */
  readonly random: () => number
}): number {
  if (!Number.isSafeInteger(input.streak) || input.streak < 1) {
    throw new Error('recovery index retry streak is invalid')
  }
  if (!Number.isSafeInteger(input.minimumDelayMs) || input.minimumDelayMs < 0) {
    throw new Error('recovery index retry minimum delay is invalid')
  }
  const exponential = Math.min(
    RECOVERY_INDEX_RETRY_MAX_MS,
    RECOVERY_INDEX_RETRY_BASE_MS * 2 ** Math.min(input.streak - 1, RETRY_EXPONENT_MAX),
  )
  const base = Math.max(exponential, input.minimumDelayMs)
  const jitterRoom = Math.min(Math.floor(base / 5), RECOVERY_INDEX_RETRY_MAX_MS - base)
  const sample = input.random()
  if (!(sample >= 0 && sample < 1)) throw new Error('recovery index retry sample is invalid')
  return base + (jitterRoom > 0 ? Math.floor(sample * (jitterRoom + 1)) : 0)
}

export interface RecoveryIndexSyncOptions {
  readonly store: RecoveryIndexStore
  readonly keys: RecoveryIndexKeys
  /** The keysets for which the client has a counter cursor. */
  readonly localEntries: () => Promise<readonly RecoveryIndexEntry[]>
  /**
   * Verify an entry against its keyset id with the mint keys, for a merge
   * conflict. Use the keys that the client already holds: an upload never
   * makes a mint request.
   */
  readonly verifyEntry: (entry: RecoveryIndexEntry) => Promise<boolean>
  /** The canonical URLs of the wallet mints. A read lists only their keysets to scan. */
  readonly walletMints: () => readonly string[]
  readonly nowMs: () => number
  readonly random?: () => number
  readonly randomBytes?: (length: number) => Uint8Array
  readonly minimumWriteIntervalMs?: number
}

/** The recovery index client of one seed and realm. Create one instance for each seed. */
export class RecoveryIndexSync {
  private readonly options: RecoveryIndexSyncOptions
  private known: RecoveryIndexKnownDocument = { status: 'unread' }
  /** The local keysets at the last read or write. A keyset outside it needs a read first. */
  private readKeys = new Set<string>()
  private mustRead = false
  /** The last read failed with a network failure or a server outage. */
  private engineUnreachable = false
  private failureStreak = 0
  private retryAtMs = 0
  private lastWriteAtMs: number | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pendingUpload: Promise<RecoveryIndexUploadOutcome> | null = null

  constructor(options: RecoveryIndexSyncOptions) {
    this.options = options
  }

  get document(): RecoveryIndexKnownDocument {
    return this.known
  }

  /** Read the index on one of the ADR-033 events. A read ignores the upload backoff. */
  read(trigger: RecoveryIndexReadTrigger): Promise<RecoveryIndexReadOutcome> {
    return this.exclusive(async () => {
      const local = await this.options.localEntries()
      if (trigger === 'restore-retry' && !this.engineUnreachable) {
        // Each read is an engine presence observation (ADR-034 "Engine privacy").
        return { status: 'skipped', trigger, document: this.known, scan: this.scanList(local) }
      }
      const error = await this.readNow(local)
      if (error !== null) return { status: 'failed', trigger, error }
      return { status: 'read', trigger, document: this.known, scan: this.scanList(local) }
    })
  }

  private scanList(local: readonly RecoveryIndexEntry[]): readonly RecoveryIndexEntry[] {
    const listed = this.known.status === 'listed' ? this.known.entries : []
    return listedRecoveryIndexEntriesWithoutCursor(listed, local, this.options.walletMints())
  }

  /** Upload the pending keysets. Concurrent calls share one upload. */
  upload(): Promise<RecoveryIndexUploadOutcome> {
    if (this.pendingUpload !== null) return this.pendingUpload
    const upload = this.exclusive(() => this.uploadNow())
    this.pendingUpload = upload
    const clear = () => {
      if (this.pendingUpload === upload) this.pendingUpload = null
    }
    upload.then(clear, clear)
    return upload
  }

  private async uploadNow(): Promise<RecoveryIndexUploadOutcome> {
    const now = this.options.nowMs()
    if (now < this.retryAtMs) return this.retry('backoff', this.retryAtMs, null)
    const interval = this.options.minimumWriteIntervalMs ?? RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS
    const writableAtMs = this.lastWriteAtMs === null ? 0 : this.lastWriteAtMs + interval
    if (now < writableAtMs && this.pending(await this.options.localEntries()).length > 0) {
      return this.retry('write-interval', writableAtMs, null)
    }
    for (let conflicts = 0; ; conflicts += 1) {
      const local = await this.options.localEntries()
      if (this.needsRead(local)) {
        const error = await this.readNow(local)
        if (error !== null) return this.retry(error.kind, this.retryAtMs, error.limitCode)
      }
      const known = this.known
      switch (known.status) {
        case 'undecodable':
          return {
            status: 'blocked',
            reason: known.reason === 'unsupported-version' ? 'unsupported-version' : 'undecodable',
          }
        case 'unread':
          throw new Error('recovery index upload has no read document')
        case 'absent':
        case 'listed':
          break
        default:
          return assertNever(known)
      }
      const listed = known.status === 'listed' ? known.entries : []
      if (pendingRecoveryIndexEntries(local, listed).length === 0) {
        return { status: 'current', version: known.version }
      }
      const outcome = await this.writeMerged(known.version, listed, local)
      if (outcome !== 'conflict') return outcome
      // The read after a 409 is an index read (ADR-034 "Client upload").
      this.mustRead = true
      if (conflicts === RECOVERY_INDEX_CONFLICT_RETRIES_MAX) {
        this.schedule(0)
        return this.retry('conflict', this.retryAtMs, null)
      }
    }
  }

  /** Write the merge of the read document and the local keysets with compare-and-swap. */
  private async writeMerged(
    version: number,
    listed: readonly RecoveryIndexEntry[],
    local: readonly RecoveryIndexEntry[],
  ): Promise<RecoveryIndexUploadOutcome | 'conflict'> {
    // A pending keyset starts the write. The merge takes every local keyset, so
    // that it also resolves a listed entry with a conflicting form (ADR-051 "Merge").
    const merged = await mergeRecoveryIndex({
      stored: listed,
      added: local,
      verifyEntry: this.options.verifyEntry,
    })
    // A form conflict that the check cannot resolve keeps the stored value.
    // The same document again is not a write.
    if (sameRecoveryIndexEntries(merged, listed)) return { status: 'current', version }
    let document: Uint8Array
    try {
      document = sealRecoveryIndexDocument({
        keys: this.options.keys,
        entries: merged,
        writtenVersion: version + 1,
        ...(this.options.randomBytes === undefined
          ? {}
          : { randomBytes: this.options.randomBytes }),
      })
    } catch (error) {
      if (error instanceof RecoveryIndexCapacityError)
        return { status: 'blocked', reason: 'over-cap' }
      throw error
    }
    let result
    try {
      result = await this.options.store.write(document, version)
    } catch (error) {
      const failure = engineError(error)
      this.recordFailure(failure)
      return this.retry(failure.kind, this.retryAtMs, failure.limitCode)
    }
    switch (result.status) {
      case 'written':
        this.succeeded()
        this.known = { status: 'listed', version: result.version, entries: merged }
        this.readKeys = keysOf(local)
        this.lastWriteAtMs = this.options.nowMs()
        return { status: 'written', version: result.version }
      case 'conflict':
        return 'conflict'
      default:
        return assertNever(result)
    }
  }

  /** The local keysets that the known document does not list. */
  private pending(local: readonly RecoveryIndexEntry[]): readonly RecoveryIndexEntry[] {
    return pendingRecoveryIndexEntries(
      local,
      this.known.status === 'listed' ? this.known.entries : [],
    )
  }

  /** Read before a write when nothing was read, after a conflict, or before a new keyset's first upload. */
  private needsRead(local: readonly RecoveryIndexEntry[]): boolean {
    if (this.known.status === 'unread' || this.mustRead) return true
    return this.pending(local).some((entry) => !this.readKeys.has(recoveryIndexEntryKey(entry)))
  }

  /** Read the document. Return the engine error of a failed read, or null. */
  private async readNow(
    local: readonly RecoveryIndexEntry[],
  ): Promise<RecoveryIndexEngineError | null> {
    const knownVersion = this.known.status === 'listed' ? this.known.version : undefined
    let result
    try {
      result = await this.options.store.read(knownVersion === undefined ? {} : { knownVersion })
    } catch (error) {
      const failure = engineError(error)
      this.recordFailure(failure)
      this.engineUnreachable = failure.kind === 'network' || failure.kind === 'unavailable'
      return failure
    }
    this.engineUnreachable = false
    switch (result.status) {
      case 'not-modified':
        if (this.known.status !== 'listed' || this.known.version !== result.version) {
          const failure = new RecoveryIndexEngineError('invalid-response')
          this.recordFailure(failure)
          return failure
        }
        break
      case 'absent':
        this.known = { status: 'absent', version: result.version }
        break
      case 'found':
        this.known = this.decode(result.document, result.version)
        break
      default:
        return assertNever(result)
    }
    this.succeeded()
    this.readKeys = keysOf(local)
    this.mustRead = false
    return null
  }

  private decode(document: Uint8Array, version: number): RecoveryIndexKnownDocument {
    try {
      const entries = openRecoveryIndexDocument({
        keys: this.options.keys,
        document,
        storeVersion: version,
      })
      return { status: 'listed', version, entries }
    } catch (error) {
      if (error instanceof RecoveryIndexFormatError) {
        return { status: 'undecodable', version, reason: error.reason }
      }
      throw error
    }
  }

  private recordFailure(error: RecoveryIndexEngineError): void {
    this.schedule(error.retryAfterMs ?? 0)
  }

  private schedule(minimumDelayMs: number): void {
    this.failureStreak += 1
    this.retryAtMs =
      this.options.nowMs() +
      planRecoveryIndexRetryDelayMs({
        streak: this.failureStreak,
        minimumDelayMs,
        random: this.options.random ?? Math.random,
      })
  }

  /** The first successful engine response resets the backoff. */
  private succeeded(): void {
    this.failureStreak = 0
    this.retryAtMs = 0
  }

  private retry(
    reason: RecoveryIndexUploadRetryReason,
    retryAtMs: number,
    limitCode: string | null,
  ): RecoveryIndexUploadOutcome {
    return { status: 'retry', reason, retryAtMs, limitCode }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }
}

export type RecoveryIndexDeleteOutcome =
  | { readonly status: 'deleted'; readonly version: number }
  /** No document: no row or a tombstone. */
  | { readonly status: 'absent'; readonly version: number }

/**
 * Delete the document of one seed: the CLI command `wallet backup delete`,
 * the only client of the delete route (ADR-034 recovery index amendment). A
 * delete keeps the version in a tombstone. After a compare-and-swap
 * conflict, the client reads the current version and deletes again, at most
 * 3 times in a row. A browser with the same seed writes the index again at
 * its next upload.
 */
export async function deleteRecoveryIndexDocument(
  store: RecoveryIndexStore,
): Promise<RecoveryIndexDeleteOutcome> {
  for (let conflicts = 0; ; conflicts += 1) {
    const read = await store.read()
    switch (read.status) {
      case 'absent':
        return { status: 'absent', version: read.version }
      case 'found':
        break
      case 'not-modified':
        throw new RecoveryIndexEngineError('invalid-response')
      default:
        return assertNever(read)
    }
    const result = await store.remove(read.version)
    switch (result.status) {
      case 'deleted':
      case 'absent':
        return { status: result.status, version: result.version }
      case 'conflict':
        if (conflicts === RECOVERY_INDEX_CONFLICT_RETRIES_MAX) {
          throw new Error('recovery index delete conflicted with other writers')
        }
        break
      default:
        return assertNever(result)
    }
  }
}

function keysOf(entries: readonly RecoveryIndexEntry[]): Set<string> {
  return new Set(entries.map(recoveryIndexEntryKey))
}

function engineError(error: unknown): RecoveryIndexEngineError {
  if (error instanceof RecoveryIndexEngineError) return error
  throw error
}

function assertNever(value: never): never {
  throw new Error(`unhandled recovery index value: ${JSON.stringify(value)}`)
}
