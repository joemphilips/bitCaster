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
 * The counters that one restore start can ask the mint about. A full restore
 * of the largest GUI index (467 keysets with no signed output, 300 counters
 * each) fits: 140,100 counters, or about 1,400 NUT-09 requests.
 */
export const RECOVERY_INDEX_RESTORE_COUNTER_BUDGET = 150_000
export const RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND =
  'bitcaster wallet recover-seed --all-conditions'
/** The proofs of one NUT-07 request. */
const PROOF_STATE_BATCH_MAX = 100

export type RecoveryIndexRestoreSource = 'listed' | 'regular' | 'hint'

export interface RecoveryIndexRestoreTarget {
  readonly entry: RecoveryIndexEntry
  readonly source: RecoveryIndexRestoreSource
}

/** Where the scan of one keyset is. A later pass continues here with the same gap. */
export interface RecoveryIndexKeysetProgress {
  readonly nextCounter: number
  readonly lastSignedCounter: number | null
}

export const RECOVERY_INDEX_KEYSET_PROGRESS_START: RecoveryIndexKeysetProgress = Object.freeze({
  nextCounter: 0,
  lastSignedCounter: null,
})

export interface RecoveryIndexKeysetScan {
  /** `complete`: the gap rule ended the scan. `incomplete`: the counter budget ended it. */
  readonly status: 'complete' | 'incomplete'
  readonly progress: RecoveryIndexKeysetProgress
  readonly scannedCounters: number
  /** The verified `UNSPENT` proofs of this scan, in counter order. Admit only these. */
  readonly unspent: readonly Proof[]
  readonly unspentCounters: readonly number[]
  /** The lowest counter of a `PENDING` proof: the ADR-033 deferral marker. */
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
 * Scan one keyset with NUT-09 from its progress, within `maxScannedCounters`.
 * The mint keys must derive the keyset id of the entry, with its condition
 * identity. Every restored proof must carry a valid DLEQ, and NUT-07 then
 * splits them: only `UNSPENT` proofs are returned for admission.
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
  if (!recoveryIndexEntryMatchesKeyset(input.entry, input.keyset)) {
    throw new Error('recovery index keyset does not match its mint keys')
  }
  const gapLimit = input.gapLimit ?? RECOVERY_INDEX_RESTORE_GAP_LIMIT
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > SEED_RECOVERY_MAX_GAP_LIMIT) {
    throw new Error('recovery index restore gap limit is invalid')
  }
  if (!Number.isSafeInteger(input.maxScannedCounters) || input.maxScannedCounters < 1) {
    throw new Error('recovery index restore counter budget is invalid')
  }
  const keyset: HasKeysetKeys = { id: input.keyset.id, keys: input.keyset.keys }
  let progress = requireProgress(input.progress)
  let scannedCounters = 0
  let complete = false
  const proofs: Proof[] = []
  const counters: number[] = []
  while (!complete && scannedCounters < input.maxScannedCounters) {
    const trailing = progress.nextCounter - (progress.lastSignedCounter ?? -1) - 1
    if (trailing >= gapLimit || progress.nextCounter > DURABLE_SEED_DERIVED_COUNTER_MAX) {
      complete = true
      break
    }
    const scan = await scanSeedCountersForAdmission({
      restore: input.restore,
      seed: input.seed,
      keyset,
      startCounter: progress.nextCounter,
      maxScannedCounters: Math.min(
        input.maxScannedCounters - scannedCounters,
        SEED_ADMISSION_SCAN_COUNTERS_MAX,
      ),
      gapLimit,
      trailingUnsignedCounters: trailing,
    })
    scannedCounters += scan.nextCounter - progress.nextCounter
    progress = Object.freeze({
      nextCounter: scan.nextCounter,
      lastSignedCounter: scan.lastCounterWithSignature ?? progress.lastSignedCounter,
    })
    proofs.push(...scan.proofs)
    counters.push(...scan.proofCounters)
    complete = scan.stop === 'gap-limit'
  }
  const states = await checkStates(proofs, keyset, input.checkProofStates)
  return Object.freeze({
    status: complete ? 'complete' : 'incomplete',
    progress,
    scannedCounters,
    unspent: Object.freeze(proofs.filter((_, index) => states[index] === 'selectable')),
    unspentCounters: Object.freeze(counters.filter((_, index) => states[index] === 'selectable')),
    pendingFromCounter: lowest(
      counters.filter((_, index) => states[index] === 'retain-nonselectable'),
    ),
    spentCount: states.filter((state) => state === 'spent').length,
    nextOutputCounter: complete ? nextSeedCounterAfterLastSigned(progress.lastSignedCounter) : null,
  })
}

/**
 * Run one restore pass over unfinished keysets in plan order, within the
 * counter budget of this restore start. `commit` stores the result of each
 * keyset (its admitted proofs, its cursor or its progress, and its deferral
 * marker) before the pass goes on. The pass stops at the budget; a later pass
 * with a new budget continues from the stored progress.
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
}): Promise<{ readonly status: 'complete' | 'budget'; readonly scannedCounters: number }> {
  if (!Number.isSafeInteger(input.counterBudget) || input.counterBudget < 0) {
    throw new Error('recovery index restore counter budget is invalid')
  }
  let used = 0
  for (const { target, progress } of input.keysets) {
    const remaining = input.counterBudget - used
    if (remaining === 0) return { status: 'budget', scannedCounters: used }
    const result = await input.scan(target, { progress, maxScannedCounters: remaining })
    if (!Number.isSafeInteger(result.scannedCounters) || result.scannedCounters > remaining) {
      throw new Error('recovery index restore scan exceeded its budget')
    }
    used += result.scannedCounters
    await input.commit(target, result)
    if (result.status === 'incomplete') return { status: 'budget', scannedCounters: used }
  }
  return { status: 'complete', scannedCounters: used }
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

async function checkStates(
  proofs: readonly Proof[],
  keyset: HasKeysetKeys,
  checkProofStates: (proofs: readonly Proof[]) => Promise<readonly unknown[]>,
): Promise<readonly ReturnType<typeof classifySeedRecoveryMintState>[]> {
  if (proofs.length === 0) return []
  requireValidCashuProofs(proofs, (id) => {
    if (id !== keyset.id) throw new Error('recovery index restore proof keyset is foreign')
    return keyset
  })
  const dispositions: ReturnType<typeof classifySeedRecoveryMintState>[] = []
  for (let offset = 0; offset < proofs.length; offset += PROOF_STATE_BATCH_MAX) {
    const batch = proofs.slice(offset, offset + PROOF_STATE_BATCH_MAX)
    const states = await checkProofStates(batch)
    if (!Array.isArray(states) || states.length !== batch.length) {
      throw new Error('recovery index restore proof states are incomplete')
    }
    for (const state of states) {
      const disposition = classifySeedRecoveryMintState(state)
      if (disposition === 'fail-closed') {
        throw new Error('recovery index restore proof state is not known')
      }
      dispositions.push(disposition)
    }
  }
  return dispositions
}

function requireProgress(value: RecoveryIndexKeysetProgress): RecoveryIndexKeysetProgress {
  const last = value?.lastSignedCounter
  if (
    !Number.isSafeInteger(value?.nextCounter) ||
    value.nextCounter < 0 ||
    (last !== null && (!Number.isSafeInteger(last) || last < 0 || last >= value.nextCounter))
  ) {
    throw new Error('recovery index restore progress is invalid')
  }
  return value
}

function lowest(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values)
}
