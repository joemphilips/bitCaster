import type { HasKeysetKeys, Proof, SerializedBlindedMessage } from '@cashu/cashu-ts'
import { requireValidCashuProofs } from './cashuProofAdmission.ts'
import { DURABLE_SEED_DERIVED_COUNTER_MAX } from './durableSeedDerivedPolicy.ts'
import {
  recoveryIndexEntryKey,
  recoveryIndexEntryMatchesKeyset,
  type RecoveryIndexEntry,
  type RecoveryIndexKeysetAuthority,
} from './recoveryIndexDocument.ts'
import {
  SEED_ADMISSION_SCAN_COUNTERS_MAX,
  SeedAdmissionScanImplausibleError,
  scanSeedCountersForAdmission,
} from './seedCounterAdmissionScan.ts'
import { SEED_COUNTER_GAP_LIMIT, nextSeedCounterAfterLastSigned } from './seedCounterGapScan.ts'
import { classifySeedRecoveryMintState } from './seedRecoveryCore.ts'
import { SEED_RECOVERY_MAX_GAP_LIMIT } from './seedRecoveryScanPolicy.ts'

/**
 * The restore of a seed from the recovery index (ADR-051 "Restore", ADR-039
 * "Restore order", ADR-033 "Scan and completion of a keyset"). The restore
 * scans each listed keyset of a wallet mint, each regular keyset of the mint
 * listing, and each hinted keyset. It never walks the market catalogue. Each
 * scan starts at counter 0 and stops after 300 unsigned counters in a row.
 */

/** The GUI gap. The CLI `wallet recover-seed --gap-limit` can pass a larger one. */
export const RECOVERY_INDEX_RESTORE_GAP_LIMIT = SEED_COUNTER_GAP_LIMIT
/**
 * The counters that one restore start can ask the mint about (ADR-039). It
 * holds a restore of the largest GUI index (467 keysets, 140,100 counters at
 * 300 each, about 1,400 NUT-09 requests) only when no keyset has a signed
 * output. A restore of a used full index stops at the budget and needs Retry.
 */
export const RECOVERY_INDEX_RESTORE_COUNTER_BUDGET = 150_000
/**
 * The counters of one keyset scan: the work bound of an admitting scan
 * (ADR-033, H1). The caller stores the result of each window before the next.
 */
export const RECOVERY_INDEX_RESTORE_WINDOW_COUNTERS = SEED_ADMISSION_SCAN_COUNTERS_MAX
export const RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND =
  'bitcaster wallet recover-seed --all-conditions'
/** The proofs of one NUT-07 request. */
const PROOF_STATE_BATCH_MAX = 100

export type RecoveryIndexRestoreSource = 'listed' | 'regular' | 'hint'

export interface RecoveryIndexRestoreTarget {
  readonly entry: RecoveryIndexEntry
  readonly source: RecoveryIndexRestoreSource
}

/** Where the scan of one keyset is. A later window continues here with the same gap. */
export interface RecoveryIndexKeysetProgress {
  readonly nextCounter: number
  readonly lastSignedCounter: number | null
  /** The total amount that the mint restored in this keyset so far. It stays a safe integer. */
  readonly restoredAmount: number
  /** The lowest counter of a `PENDING` proof in any window so far: the ADR-033 deferral marker. */
  readonly pendingFromCounter: number | null
}

export const RECOVERY_INDEX_KEYSET_PROGRESS_START: RecoveryIndexKeysetProgress = Object.freeze({
  nextCounter: 0,
  lastSignedCounter: null,
  restoredAmount: 0,
  pendingFromCounter: null,
})

/** Why a keyset scan admitted nothing of its window. */
export type RecoveryIndexKeysetRefusal =
  /** An amount that the keyset cannot sign, or a keyset total that is not a safe integer. */
  | 'amount'
  /** A restored proof without a valid DLEQ. */
  | 'dleq'
  /** A NUT-07 answer that is not one known state for each proof. */
  | 'proof-state'

/**
 * The result of one keyset scan. A window reads counters. The two refusals
 * read nothing for admission, and the caller keeps the stored progress:
 *
 * - `unverifiable`: the mint keys do not derive the keyset id of the entry
 *   with its identity. The entry stays in the index.
 * - `implausible`: the mint answer fails a check (`reason`). The window admits
 *   nothing. A failed mint request is not a refusal: the scan rejects.
 */
export type RecoveryIndexKeysetScan =
  | RecoveryIndexKeysetWindow
  | { readonly status: 'unverifiable'; readonly scannedCounters: 0 }
  | {
      readonly status: 'implausible'
      readonly reason: RecoveryIndexKeysetRefusal
      readonly scannedCounters: number
    }

export interface RecoveryIndexKeysetWindow {
  /** `complete`: the gap rule ended the scan. `incomplete`: the window ended first. */
  readonly status: 'complete' | 'incomplete'
  readonly progress: RecoveryIndexKeysetProgress
  readonly scannedCounters: number
  /** The verified `UNSPENT` proofs of this scan, in counter order. Admit only these. */
  readonly unspent: readonly Proof[]
  readonly unspentCounters: readonly number[]
  /**
   * The lowest counter of a `PENDING` proof of the keyset so far, in this or
   * an earlier window: the ADR-033 deferral marker. A complete keyset with a
   * marker is not complete under the ADR-033 completion rule.
   */
  readonly pendingFromCounter: number | null
  readonly spentCount: number
  /**
   * For a complete scan, the first counter of the next output (ADR-051 cursor
   * rule): the last signed counter plus 151, or 150 with no signed counter.
   * The client keeps a larger local cursor.
   */
  readonly nextOutputCounter: number | null
}

/**
 * Order the keysets of a GUI restore: the listed keysets of the wallet mints,
 * then the regular keysets that the index does not list, then the hinted
 * keysets that it does not list. A listed keyset of another mint is not
 * scanned; it stays in the index.
 */
export function planRecoveryIndexRestore(input: {
  /** The entries of the index, or null with no index. */
  readonly listed: readonly RecoveryIndexEntry[] | null
  readonly walletMints: readonly string[]
  /** The regular keysets of the wallet mint listings (NUT-02). */
  readonly regular: readonly RecoveryIndexEntry[]
  /** The keysets of the asset-monitoring and activity-log hints. */
  readonly hints: readonly RecoveryIndexEntry[]
}): {
  readonly targets: readonly RecoveryIndexRestoreTarget[]
  readonly foreignListed: readonly RecoveryIndexEntry[]
} {
  const walletMints = new Set(input.walletMints)
  const seen = new Set<string>()
  const targets: RecoveryIndexRestoreTarget[] = []
  const foreignListed: RecoveryIndexEntry[] = []
  const add = (entry: RecoveryIndexEntry, source: RecoveryIndexRestoreSource) => {
    const key = recoveryIndexEntryKey(entry)
    if (!walletMints.has(entry.mintUrl) || seen.has(key)) return
    seen.add(key)
    targets.push(Object.freeze({ entry, source }))
  }
  for (const entry of input.listed ?? []) {
    if (walletMints.has(entry.mintUrl)) add(entry, 'listed')
    else foreignListed.push(entry)
  }
  for (const entry of input.regular) {
    if (entry.kind !== 'regular')
      throw new Error('recovery index restore regular keyset is conditional')
    add(entry, 'regular')
  }
  for (const entry of input.hints) add(entry, 'hint')
  return { targets: Object.freeze(targets), foreignListed: Object.freeze(foreignListed) }
}

/**
 * Scan one window of one keyset with NUT-09 from its progress: at most
 * `maxScannedCounters`, and never more than one window. The mint keys must
 * derive the keyset id of the entry, with its condition identity. Every
 * restored proof must carry a valid DLEQ, and NUT-07 then splits them: only
 * `UNSPENT` proofs are returned for admission. A failed mint request rejects;
 * the progress that the caller stored stays valid.
 */
export async function scanRecoveryIndexKeyset(input: {
  readonly seed: Uint8Array
  readonly entry: RecoveryIndexEntry
  readonly keyset: RecoveryIndexKeysetAuthority
  /** One NUT-09 request to the mint of the entry. */
  readonly restore: (outputs: SerializedBlindedMessage[]) => Promise<unknown>
  /** One NUT-07 request: the state of each proof, in the order of the proofs. */
  readonly checkProofStates: (proofs: readonly Proof[]) => Promise<readonly unknown[]>
  readonly progress: RecoveryIndexKeysetProgress
  readonly maxScannedCounters: number
  readonly gapLimit?: number
}): Promise<RecoveryIndexKeysetScan> {
  const gapLimit = input.gapLimit ?? RECOVERY_INDEX_RESTORE_GAP_LIMIT
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > SEED_RECOVERY_MAX_GAP_LIMIT) {
    throw new Error('recovery index restore gap limit is invalid')
  }
  const window = input.maxScannedCounters
  if (
    !Number.isSafeInteger(window) ||
    window < 1 ||
    window > RECOVERY_INDEX_RESTORE_WINDOW_COUNTERS
  ) {
    throw new Error('recovery index restore window is invalid')
  }
  const progress = requireProgress(input.progress)
  if (!recoveryIndexEntryMatchesKeyset(input.entry, input.keyset)) {
    return Object.freeze({ status: 'unverifiable', scannedCounters: 0 })
  }
  const keyset: HasKeysetKeys = { id: input.keyset.id, keys: input.keyset.keys }
  const trailing = progress.nextCounter - (progress.lastSignedCounter ?? -1) - 1
  if (trailing >= gapLimit || progress.nextCounter > DURABLE_SEED_DERIVED_COUNTER_MAX) {
    return windowResult({
      complete: true,
      progress,
      scannedCounters: 0,
      proofs: [],
      counters: [],
      states: [],
    })
  }
  let scan
  try {
    scan = await scanSeedCountersForAdmission({
      restore: input.restore,
      seed: input.seed,
      keyset,
      startCounter: progress.nextCounter,
      maxScannedCounters: window,
      gapLimit,
      trailingUnsignedCounters: trailing,
      restoredAmountTotal: progress.restoredAmount,
    })
  } catch (error) {
    // The window admits nothing; the mint was asked about at most the window.
    if (error instanceof SeedAdmissionScanImplausibleError) {
      return Object.freeze({ status: 'implausible', reason: 'amount', scannedCounters: window })
    }
    throw error
  }
  const scannedCounters = scan.nextCounter - progress.nextCounter
  const states = await checkStates(scan.proofs, keyset, input.checkProofStates)
  if (typeof states === 'string') {
    return Object.freeze({ status: 'implausible', reason: states, scannedCounters })
  }
  const pending = scan.proofCounters.filter((_, index) => states[index] === 'retain-nonselectable')
  return windowResult({
    complete: scan.stop === 'gap-limit',
    progress: Object.freeze({
      nextCounter: scan.nextCounter,
      lastSignedCounter: scan.lastCounterWithSignature ?? progress.lastSignedCounter,
      restoredAmount: scan.restoredAmountTotal,
      pendingFromCounter: lowest(
        progress.pendingFromCounter === null ? pending : [progress.pendingFromCounter, ...pending],
      ),
    }),
    scannedCounters,
    proofs: scan.proofs,
    counters: scan.proofCounters,
    states,
  })
}

/**
 * Run one restore pass over unfinished keysets in plan order, within the
 * counter budget of this restore start. The pass scans one window at a time.
 * `commit` stores the result of each window (its admitted proofs, its progress
 * or its cursor, and its deferral marker) before the next window, and the pass
 * continues a keyset while the budget remains. An `unverifiable` or
 * `implausible` keyset does not stop the pass: it is in `refused`, and its
 * stored progress stays. The restore is complete only when the status is
 * `complete` and `refused` is empty. A failed mint request rejects the pass
 * after the committed windows; a later pass continues from them.
 */
export async function runRecoveryIndexRestorePass<T>(input: {
  readonly keysets: readonly {
    readonly target: T
    readonly progress: RecoveryIndexKeysetProgress
  }[]
  readonly counterBudget: number
  readonly scan: (
    target: T,
    request: {
      readonly progress: RecoveryIndexKeysetProgress
      readonly maxScannedCounters: number
    },
  ) => Promise<RecoveryIndexKeysetScan>
  readonly commit: (target: T, scan: RecoveryIndexKeysetScan) => Promise<void>
}): Promise<{
  readonly status: 'complete' | 'budget'
  readonly scannedCounters: number
  readonly refused: readonly T[]
}> {
  if (!Number.isSafeInteger(input.counterBudget) || input.counterBudget < 0) {
    throw new Error('recovery index restore counter budget is invalid')
  }
  let used = 0
  const refused: T[] = []
  for (const { target, progress: stored } of input.keysets) {
    let progress = stored
    for (let done = false; !done; ) {
      const remaining = input.counterBudget - used
      if (remaining === 0) return { status: 'budget', scannedCounters: used, refused }
      const maxScannedCounters = Math.min(remaining, RECOVERY_INDEX_RESTORE_WINDOW_COUNTERS)
      const result = await input.scan(target, { progress, maxScannedCounters })
      if (
        !Number.isSafeInteger(result.scannedCounters) ||
        result.scannedCounters > maxScannedCounters
      ) {
        throw new Error('recovery index restore scan exceeded its window')
      }
      used += result.scannedCounters
      await input.commit(target, result)
      switch (result.status) {
        case 'complete':
          done = true
          break
        case 'incomplete':
          if (result.scannedCounters === 0)
            throw new Error('recovery index restore scan made no progress')
          progress = result.progress
          break
        case 'unverifiable':
        case 'implausible':
          refused.push(target)
          done = true
          break
        default:
          return assertNever(result)
      }
    }
  }
  return { status: 'complete', scannedCounters: used, refused }
}

/** The CLI command for a larger gap, which every GUI restore result names in one short line. */
export function recoveryIndexCliGapCommand(gapLimit: number): string {
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > SEED_RECOVERY_MAX_GAP_LIMIT) {
    throw new Error('recovery index CLI gap limit is invalid')
  }
  return `bitcaster wallet recover-seed --gap-limit ${gapLimit}`
}

/**
 * The seed-handoff check of one local keyset (ADR-034 "Seed handoff"): the
 * longest run of unsigned counters before a later signed output. A run of at
 * least `gapLimit` hides the later outputs from a GUI restore. The warning
 * names a CLI gap that passes the run.
 */
export function seedCounterGapWarning(
  signedCounters: readonly number[],
  gapLimit: number = RECOVERY_INDEX_RESTORE_GAP_LIMIT,
): { readonly longestRun: number; readonly cliGapLimit: number } | null {
  let previous = -1
  let longestRun = 0
  for (const counter of [...new Set(signedCounters)].sort((left, right) => left - right)) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new Error('seed counter gap warning counter is invalid')
    }
    longestRun = Math.max(longestRun, counter - previous - 1)
    previous = counter
  }
  return longestRun < gapLimit ? null : { longestRun, cliGapLimit: longestRun + 1 }
}

/**
 * Verify the DLEQ of each restored proof, then ask NUT-07 for the states.
 * Return the disposition of each proof, or the check that the mint answer
 * failed. A failed NUT-07 request rejects.
 */
async function checkStates(
  proofs: readonly Proof[],
  keyset: HasKeysetKeys,
  checkProofStates: (proofs: readonly Proof[]) => Promise<readonly unknown[]>,
): Promise<
  readonly ReturnType<typeof classifySeedRecoveryMintState>[] | RecoveryIndexKeysetRefusal
> {
  if (proofs.length === 0) return []
  try {
    requireValidCashuProofs(proofs, (id) => {
      if (id !== keyset.id) throw new Error('recovery index restore proof keyset is foreign')
      return keyset
    })
  } catch {
    return 'dleq'
  }
  const dispositions: ReturnType<typeof classifySeedRecoveryMintState>[] = []
  for (let offset = 0; offset < proofs.length; offset += PROOF_STATE_BATCH_MAX) {
    const batch = proofs.slice(offset, offset + PROOF_STATE_BATCH_MAX)
    const states = await checkProofStates(batch)
    if (!Array.isArray(states) || states.length !== batch.length) return 'proof-state'
    for (const state of states) {
      const disposition = classifySeedRecoveryMintState(state)
      if (disposition === 'fail-closed') return 'proof-state'
      dispositions.push(disposition)
    }
  }
  return dispositions
}

function windowResult(input: {
  readonly complete: boolean
  readonly progress: RecoveryIndexKeysetProgress
  readonly scannedCounters: number
  readonly proofs: readonly Proof[]
  readonly counters: readonly number[]
  readonly states: readonly ReturnType<typeof classifySeedRecoveryMintState>[]
}): RecoveryIndexKeysetWindow {
  const where =
    (state: ReturnType<typeof classifySeedRecoveryMintState>) => (_: unknown, index: number) =>
      input.states[index] === state
  return Object.freeze({
    status: input.complete ? 'complete' : 'incomplete',
    progress: input.progress,
    scannedCounters: input.scannedCounters,
    unspent: Object.freeze(input.proofs.filter(where('selectable'))),
    unspentCounters: Object.freeze(input.counters.filter(where('selectable'))),
    // Every window reports the lowest PENDING counter of the keyset so far, so a
    // complete result still names a PENDING proof of an earlier window (ADR-033).
    pendingFromCounter: input.progress.pendingFromCounter,
    spentCount: input.states.filter((state) => state === 'spent').length,
    nextOutputCounter: input.complete
      ? nextSeedCounterAfterLastSigned(input.progress.lastSignedCounter)
      : null,
  })
}

function requireProgress(value: RecoveryIndexKeysetProgress): RecoveryIndexKeysetProgress {
  const last = value?.lastSignedCounter
  if (
    !Number.isSafeInteger(value?.nextCounter) ||
    value.nextCounter < 0 ||
    (last !== null && (!Number.isSafeInteger(last) || last < 0 || last >= value.nextCounter)) ||
    !Number.isSafeInteger(value.restoredAmount) ||
    value.restoredAmount < 0 ||
    (value.pendingFromCounter !== null &&
      (!Number.isSafeInteger(value.pendingFromCounter) ||
        value.pendingFromCounter < 0 ||
        value.pendingFromCounter >= value.nextCounter))
  ) {
    throw new Error('recovery index restore progress is invalid')
  }
  return value
}

function assertNever(value: never): never {
  throw new Error(`unhandled recovery index restore result: ${JSON.stringify(value)}`)
}

function lowest(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values)
}
