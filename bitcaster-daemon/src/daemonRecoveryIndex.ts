import type { DatabaseSync } from 'node:sqlite'
import { CTF_RANGE_ORDER_PREPARATION_PAGE_LIMIT_MAX } from '@bitcaster-market/client-sdk/ctfRangeOrderJournal'
import {
  decodeCtfRangeOrderPreparationFromRecord,
  type PersistedCtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  deriveRecoveryIndexKeys,
  recoveryIndexEntryKey,
  recoveryIndexEntryMatchesKeyset,
  type RecoveryIndexEntry,
} from '@bitcaster-market/client-sdk/recoveryIndexDocument'
import {
  createRecoveryIndexEngineStore,
  type RecoveryIndexRealm,
} from '@bitcaster-market/client-sdk/recoveryIndexEngine'
import { RecoveryIndexSync } from '@bitcaster-market/client-sdk/recoveryIndexSync'
import {
  RecoveryIndexUploader,
  type RecoveryIndexUploaderStatus,
} from '@bitcaster-market/client-sdk/recoveryIndexUploader'
import { canonicalizeMintIdentityUrl } from '@bitcaster-market/client-sdk/tokenImportValidation'
import {
  pageActiveRangePreparations,
  toSdkRangePreparationRecord,
  type RangePreparationPageCursor,
  type RangePreparationRecord,
} from './ctfRangeOrderJournalSqlite.ts'
import {
  createDaemonStateSqliteSession,
  subscribeToDaemonWalletHoldingsCommits,
  type DaemonStateSqliteSession,
} from './stateSqlite.ts'
import { RECOVERY_INDEX_DISABLED, type RecoveryIndexSetting } from './nativeConfig.ts'

/**
 * The daemon writer of the recovery index (ADR-051, ADR-034 amendment of
 * 2026-11-20). The CLI delegates trading to the daemon, so the daemon writes
 * the keysets that the CLI uses. The SDK uploader owns the upload rules. This
 * module supplies the local keysets and the events:
 *
 * - The start of the daemon is the wallet open. The first upload reads the
 *   index and writes the pending keysets.
 * - After each committed custody transaction, the daemon asks for an upload.
 *   The upload makes an engine request only when a local keyset is pending.
 * - The only timer is a wait that the SDK asks for: the retry after a failure,
 *   or the end of the minimum write interval of one key.
 *
 * The daemon does not scan from the index, so it reads the index only for an
 * upload. It never makes a mint request for the index.
 */

/** Each engine request of the writer ends after this time. */
export const DAEMON_RECOVERY_INDEX_REQUEST_TIMEOUT_MS = 30_000

export type DaemonRecoveryIndexStatus =
  | ({ readonly realm: RecoveryIndexRealm } & (
      | { readonly status: 'starting' }
      | { readonly status: 'current' }
      | {
          readonly status: 'pending'
          readonly reason: Extract<RecoveryIndexUploaderStatus, { kind: 'pending' }>['reason']
        }
      | {
          readonly status: 'blocked'
          readonly reason: Extract<RecoveryIndexUploaderStatus, { kind: 'blocked' }>['reason']
        }
    ))
  /** The realm setting is `disabled`, so no writer runs. */
  | { readonly status: typeof RECOVERY_INDEX_DISABLED }

export interface DaemonRecoveryIndexOptions {
  readonly directory: string
  readonly scopeId: string
  /** The 64-byte BIP-39 seed of the profile wallet. */
  readonly walletSeed: Uint8Array
  readonly realm: RecoveryIndexRealm
  readonly engineBaseUrl: string
  /** The configured mint URLs of the daemon. */
  readonly walletMints: readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly nowMs?: () => number
  readonly random?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
  /** Test seam. Production uses the profile-scoped SQLite session. */
  readonly storage?: DaemonStateSqliteSession
  /** Test seam. Production observes the commits of this profile database. */
  readonly subscribeToCommits?: (callback: () => void) => () => void
  /** One line for each change to a persistent error. It never holds a key or a document. */
  readonly log?: (line: string) => void
}

export interface DaemonRecoveryIndex {
  start(): void
  stop(): void
  status(): DaemonRecoveryIndexStatus
  /** Wait until no upload runs. */
  settled(): Promise<void>
}

/**
 * Start the writer of the running daemon. The `disabled` realm setting starts
 * no writer, so the daemon sends no index request. The seed derives the
 * request key of the index, not the application signer, but a daemon with a
 * disconnected signer starts no background engine traffic, so it starts no
 * writer either. Without a writer, the status is unavailable.
 */
export function startDaemonRecoveryIndexWriter(input: {
  readonly setting: RecoveryIndexSetting
  readonly signerEnabled: boolean
  readonly create: (realm: RecoveryIndexRealm) => DaemonRecoveryIndex
}): {
  readonly writer?: DaemonRecoveryIndex
  readonly readStatus?: () => DaemonRecoveryIndexStatus
} {
  if (input.setting === RECOVERY_INDEX_DISABLED) {
    return { readStatus: () => ({ status: RECOVERY_INDEX_DISABLED }) }
  }
  if (!input.signerEnabled) return {}
  const writer = input.create(input.setting)
  writer.start()
  return { writer, readStatus: () => writer.status() }
}

export function createDaemonRecoveryIndex(
  options: DaemonRecoveryIndexOptions,
): DaemonRecoveryIndex {
  const storage = options.storage ?? createDaemonStateSqliteSession(options.directory)
  const nowMs = options.nowMs ?? Date.now
  const log = options.log ?? (() => {})
  const buyReceiveForms = new DaemonBuyReceiveForms({ log })
  const keys = deriveRecoveryIndexKeys(options.walletSeed, options.realm)
  const fetchImpl = options.fetchImpl ?? fetch
  const walletMints = options.walletMints.flatMap((url) => {
    try {
      return [canonicalizeMintIdentityUrl(url)]
    } catch {
      return []
    }
  })
  const sync = new RecoveryIndexSync({
    store: createRecoveryIndexEngineStore({
      engineBaseUrl: options.engineBaseUrl,
      realm: options.realm,
      keys,
      fetchImpl: (input, init) =>
        fetchImpl(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(DAEMON_RECOVERY_INDEX_REQUEST_TIMEOUT_MS),
        }),
      nowMs,
    }),
    keys,
    localEntries: () =>
      storage.read((database) =>
        readDaemonRecoveryIndexLocalEntries(database, options.scopeId, buyReceiveForms),
      ),
    // The daemon uses the mint keys of a stored Buy preparation only to list
    // its receive keyset. It does not check a form conflict with the stored
    // document, so the conflict keeps the stored value (ADR-051 "Merge").
    verifyEntry: async () => {
      throw new Error('the daemon holds no keyset authority for the recovery index')
    },
    walletMints: () => walletMints,
    nowMs,
    ...(options.random === undefined ? {} : { random: options.random }),
  })
  const uploader = new RecoveryIndexUploader({
    sync,
    nowMs,
    ...(options.random === undefined ? {} : { random: options.random }),
    setTimer:
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        // A retry must not keep a stopping daemon alive.
        timer.unref()
        return timer
      }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  })
  let reported = ''
  uploader.subscribe(() => {
    const status = uploader.status
    const line =
      status.kind === 'blocked'
        ? `Recovery index upload stopped: ${status.reason}`
        : status.kind !== 'pending'
          ? ''
          : status.reason === 'unauthenticated'
            ? `Recovery index upload refused: check the recovery index realm ${options.realm}`
            : status.reason === 'local-failure'
              ? 'Recovery index upload waits: the daemon cannot read its local keysets'
              : ''
    if (line !== '' && line !== reported) log(line)
    reported = line
  })
  let unsubscribe: (() => void) | undefined
  let stopped = false
  return {
    start() {
      if (stopped || unsubscribe !== undefined) return
      const subscribe =
        options.subscribeToCommits ??
        ((callback: () => void) =>
          subscribeToDaemonWalletHoldingsCommits(options.directory, callback))
      unsubscribe = subscribe(() => uploader.requestUpload())
      uploader.requestUpload()
    },
    stop() {
      if (stopped) return
      stopped = true
      uploader.stop()
      unsubscribe?.()
      unsubscribe = undefined
    },
    status() {
      return daemonStatus(options.realm, uploader.status)
    },
    settled() {
      return uploader.settled()
    },
  }
}

function daemonStatus(
  realm: RecoveryIndexRealm,
  status: RecoveryIndexUploaderStatus,
): DaemonRecoveryIndexStatus {
  switch (status.kind) {
    case 'starting':
    case 'current':
      return { realm, status: status.kind }
    case 'pending':
      return { realm, status: 'pending', reason: status.reason }
    case 'blocked':
      return { realm, status: 'blocked', reason: status.reason }
    default:
      return assertNever(status)
  }
}

interface CounterKeysetRow {
  readonly normalizedMint: unknown
  readonly unit: unknown
  readonly keysetId: unknown
}

interface ProofFormRow extends CounterKeysetRow {
  readonly conditionId: unknown
  readonly outcomeSetId: unknown
}

/**
 * The local keysets of the daemon (ADR-051 "Upload"): each keyset with a
 * counter cursor, in the form of its index entry. The counter tables do not
 * record the form, so a proof row of that keyset gives it: a regular proof
 * gives the regular form, and a conditional proof gives the condition and its
 * root outcome collection. Any proof row counts, also a spent one. Before the
 * first proof row, an active Buy preparation gives the form of its receive
 * keyset. Thus a position is listed while the daemon has not admitted the
 * outputs of its order. A keyset with neither, for example the receive keyset
 * of a failed order, has no signed output to restore.
 */
export function readDaemonRecoveryIndexLocalEntries(
  database: DatabaseSync,
  scopeId: string,
  buyReceiveForms: DaemonBuyReceiveForms = new DaemonBuyReceiveForms(),
): RecoveryIndexEntry[] {
  const counters = database
    .prepare(
      `SELECT normalized_mint AS normalizedMint, unit, keyset_id AS keysetId
       FROM custody_keyset_counters WHERE scope_id = ?
       UNION
       SELECT normalized_mint AS normalizedMint, unit, keyset_id AS keysetId
       FROM target_keyset_counters WHERE scope_id = ?`,
    )
    .all(scopeId, scopeId) as unknown as CounterKeysetRow[]
  if (counters.length === 0) return []
  const forms = new Map<string, ProofFormRow>()
  // The live proofs of the old store, in one scan of its covering index.
  for (const row of database
    .prepare(
      `SELECT DISTINCT normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
         condition_id AS conditionId, outcome_set_id AS outcomeSetId
       FROM target_wallet_proofs WHERE scope_id = ?`,
    )
    .all(scopeId) as unknown as ProofFormRow[]) {
    addForm(forms, row)
  }
  // The custody store keeps every admitted proof. Read one row of each keyset
  // that the old store does not show, through the unique keyset index.
  const custodyForm = database.prepare(
    `SELECT normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
       condition_id AS conditionId, outcome_set_id AS outcomeSetId
     FROM custody_proofs
     WHERE scope_id = ? AND normalized_mint = ? AND unit = ? AND keyset_id = ?
     LIMIT 1`,
  )
  // Read the preparations only when a counter keyset has no proof row.
  let preparationForms: Map<string, ProofFormRow> | undefined
  const entries = new Map<string, RecoveryIndexEntry>()
  for (const row of counters) {
    const counter = decodeKeysetRow(row)
    let form = forms.get(counter.key)
    if (form === undefined) {
      form = custodyForm.get(scopeId, counter.normalizedMint, counter.unit, counter.keysetId) as
        | ProofFormRow
        | undefined
    }
    if (form === undefined) {
      preparationForms ??= buyReceiveForms.read(database, scopeId)
      form = preparationForms.get(counter.key)
    }
    if (form === undefined) continue
    const entry = indexEntry(form)
    const entryKey = recoveryIndexEntryKey(entry)
    const existing = entries.get(entryKey)
    if (existing !== undefined && !sameForm(existing, entry)) {
      throw new Error('daemon recovery index keyset has two forms')
    }
    entries.set(entryKey, entry)
  }
  return [...entries.values()]
}

type DecodeRangePreparation = (record: RangePreparationRecord) => PersistedCtfRangeOrderPreparation

const UNREADABLE_PREPARATION_LINE =
  'Recovery index skips an order preparation that the daemon cannot read'

/**
 * The receive keyset form of each active Buy preparation, by range operation
 * id. A preparation body does not change, so the writer decodes each body
 * once. Each read keeps only the preparations that are still active. A
 * terminal preparation adds nothing: its outputs are proof rows, or it has no
 * output.
 */
export class DaemonBuyReceiveForms {
  readonly #forms = new Map<string, ProofFormRow | null>()
  readonly #decode: DecodeRangePreparation
  readonly #log: (line: string) => void

  constructor(
    input: {
      /** Test seam. Production uses the order journal decoder. */
      readonly decode?: DecodeRangePreparation
      readonly log?: (line: string) => void
    } = {},
  ) {
    this.#decode =
      input.decode ??
      ((record) => decodeCtfRangeOrderPreparationFromRecord(toSdkRangePreparationRecord(record)))
    this.#log = input.log ?? (() => {})
  }

  /** The range operation ids that the writer keeps. */
  get rangeOperationIds(): string[] {
    return [...this.#forms.keys()]
  }

  /** The forms by counter keyset key, from one read of the active preparations. */
  read(database: DatabaseSync, scopeId: string): Map<string, ProofFormRow> {
    const active = new Set<string>()
    const forms = new Map<string, ProofFormRow>()
    let after: RangePreparationPageCursor | undefined
    do {
      const page = pageActiveRangePreparations(database, {
        scopeId,
        limit: CTF_RANGE_ORDER_PREPARATION_PAGE_LIMIT_MAX,
        ...(after === undefined ? {} : { after }),
      })
      for (const record of page.preparations) {
        active.add(record.rangeOperationId)
        let form = this.#forms.get(record.rangeOperationId)
        if (form === undefined) {
          form = this.#receiveForm(record)
          this.#forms.set(record.rangeOperationId, form)
        }
        if (form !== null) addForm(forms, form)
      }
      after = page.nextCursor ?? undefined
    } while (after !== undefined)
    for (const rangeOperationId of this.#forms.keys()) {
      if (!active.has(rangeOperationId)) this.#forms.delete(rangeOperationId)
    }
    return forms
  }

  /**
   * A Buy keeps the mint conditional keyset that receives its outputs, with
   * the mint keys. The keyset id commits to the condition and the outcome
   * collection (NUT-CTF), so the keys check the form with no mint request. A
   * form that the keys do not derive, or a body that the daemon cannot read,
   * waits for the first proof row: a wrong form is worse than a later entry,
   * and one bad record must not stop the upload of other keysets.
   */
  #receiveForm(record: RangePreparationRecord): ProofFormRow | null {
    switch (record.side) {
      // A Sell receives in a regular keyset. Its offer keyset holds the proofs that it sells.
      case 'Sell':
        return null
      case 'Buy':
        break
      default:
        return assertNever(record.side)
    }
    let keyset: PersistedCtfRangeOrderPreparation['receiveKeyset']
    try {
      keyset = this.#decode(record).receiveKeyset
    } catch {
      // The order journal refuses this record by itself.
      this.#log(UNREADABLE_PREPARATION_LINE)
      return null
    }
    if (
      !('conditionId' in keyset) ||
      !('outcomeCollection' in keyset) ||
      !('outcomeCollectionId' in keyset)
    ) {
      this.#log(UNREADABLE_PREPARATION_LINE)
      return null
    }
    const form: ProofFormRow = {
      normalizedMint: record.normalizedMint,
      unit: record.unit,
      keysetId: keyset.id,
      conditionId: keyset.conditionId,
      outcomeSetId: keyset.outcomeCollection,
    }
    const entry = indexEntry(form)
    return entry.kind === 'conditional' &&
      entry.outcomeCollectionId === keyset.outcomeCollectionId &&
      recoveryIndexEntryMatchesKeyset(entry, keyset)
      ? form
      : null
  }
}

function decodeKeysetRow(row: CounterKeysetRow): {
  readonly normalizedMint: string
  readonly unit: string
  readonly keysetId: string
  readonly key: string
} {
  const { normalizedMint, unit, keysetId } = row
  if (
    typeof normalizedMint !== 'string' ||
    typeof unit !== 'string' ||
    typeof keysetId !== 'string'
  ) {
    throw new Error('daemon recovery index keyset row is invalid')
  }
  return { normalizedMint, unit, keysetId, key: `${normalizedMint}\u0000${unit}\u0000${keysetId}` }
}

function addForm(forms: Map<string, ProofFormRow>, row: ProofFormRow): void {
  const { key } = decodeKeysetRow(row)
  const existing = forms.get(key)
  if (
    existing !== undefined &&
    (existing.conditionId !== row.conditionId || existing.outcomeSetId !== row.outcomeSetId)
  ) {
    throw new Error('daemon recovery index keyset has two forms')
  }
  forms.set(key, row)
}

function indexEntry(row: ProofFormRow): RecoveryIndexEntry {
  const mintUrl = canonicalizeMintIdentityUrl(String(row.normalizedMint))
  const keysetId = String(row.keysetId)
  if (row.conditionId === null && row.outcomeSetId === null) {
    return { kind: 'regular', mintUrl, keysetId }
  }
  if (typeof row.conditionId !== 'string' || typeof row.outcomeSetId !== 'string') {
    throw new Error('daemon recovery index conditional proof row is invalid')
  }
  // bitCaster markets are root conditions. The outcome set is the outcome
  // collection of the mint keyset.
  return {
    kind: 'conditional',
    mintUrl,
    keysetId,
    conditionId: row.conditionId,
    outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
      conditionId: row.conditionId,
      outcomeCollection: row.outcomeSetId,
    }),
  }
}

function sameForm(left: RecoveryIndexEntry, right: RecoveryIndexEntry): boolean {
  if (left.kind === 'regular' || right.kind === 'regular') return left.kind === right.kind
  return (
    left.conditionId === right.conditionId && left.outcomeCollectionId === right.outcomeCollectionId
  )
}

function assertNever(value: never): never {
  throw new Error(`unhandled daemon recovery index value: ${JSON.stringify(value)}`)
}
