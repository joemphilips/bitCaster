import { Amount, OutputData, type SerializedBlindedMessage } from '@cashu/cashu-ts'
import { DURABLE_SEED_DERIVED_COUNTER_MAX } from './durableSeedDerivedPolicy.ts'

/**
 * Counter-only NUT-09 scans for one seed and keyset (ADR-037 mint refusal
 * settlement). A scan asks the mint which NUT-13 outputs it already signed.
 * It admits no proof, so it claims no custody scope. The caller advances its
 * counter past the result.
 *
 * A NUT-13 blinded output does not depend on its amount, so each request
 * output uses amount 1. The request then shows the mint no amount.
 */

/** The NUT-09 part of a mint client. */
export interface SeedCounterRestoreClient {
  restore(payload: {
    outputs: SerializedBlindedMessage[]
  }): Promise<{ readonly outputs: readonly { readonly B_: string }[] }>
}

/** Consecutive unsigned counters that end a gap scan, as in a NUT-13 restore. */
export const SEED_COUNTER_GAP_LIMIT = 300
/** The most outputs in one NUT-09 request. */
export const SEED_COUNTER_PROBE_BATCH_MAX = 100
/**
 * Counters that one gap scan asks about. The bound limits the mint load when
 * a mint reports every output as signed. A later scan continues from the
 * advanced counter.
 */
export const SEED_COUNTER_SCAN_COUNTERS_MAX = 3_000
/**
 * ADR-051 cursor rule: after a scan, the wallet never uses the counters just
 * after the last signed output. The authorization outputs of the recent
 * orders of another client sit there, and NUT-09 does not show them.
 */
export const SEED_COUNTER_SKIP_AFTER_LAST_SIGNED = 150

/** One output that the wallet plans to send, and the highest seed counter that it uses. */
export interface PlannedSeedOutput {
  readonly keysetId: string
  readonly counter: number
  readonly B_: string
}

/** A counter advance past outputs that the mint already signed for this seed. */
export interface SeedCounterSkip {
  readonly keysetId: string
  /** The first checked counter. A later admission scan starts here (ADR-033). */
  readonly fromCounter: number
  readonly lastSignedCounter: number
  /** The first counter that the wallet uses after the skip (ADR-051 cursor rule). */
  readonly nextCounter: number
}

/**
 * Return the planned outputs that the mint already signed. The outputs go in
 * NUT-09 requests of at most `SEED_COUNTER_PROBE_BATCH_MAX` outputs each.
 */
export async function findSignedSeedOutputs(
  mint: SeedCounterRestoreClient,
  planned: readonly PlannedSeedOutput[],
): Promise<PlannedSeedOutput[]> {
  const byOutput = new Map<string, PlannedSeedOutput>()
  for (const output of planned) {
    requireCounterRange(output.counter, 1)
    if (typeof output.B_ !== 'string' || byOutput.has(output.B_)) {
      throw new Error('planned seed outputs are invalid')
    }
    byOutput.set(output.B_, output)
  }
  const signed: PlannedSeedOutput[] = []
  for (let offset = 0; offset < planned.length; offset += SEED_COUNTER_PROBE_BATCH_MAX) {
    const batch = planned.slice(offset, offset + SEED_COUNTER_PROBE_BATCH_MAX)
    const requested = new Set(batch.map(({ B_ }) => B_))
    const response = await mint.restore({
      outputs: batch.map(({ keysetId, B_ }) => ({ amount: Amount.from(1), id: keysetId, B_ })),
    })
    if (!Array.isArray(response?.outputs) || response.outputs.length > batch.length) {
      throw new Error('mint restore response is invalid')
    }
    const found = new Set<string>()
    for (const output of response.outputs) {
      // A restore response may only name outputs from this request.
      const blinded = typeof output?.B_ === 'string' ? output.B_ : undefined
      if (blinded === undefined || !requested.has(blinded)) {
        throw new Error('mint restore returned a foreign output')
      }
      found.add(blinded)
    }
    for (const blinded of found) signed.push(byOutput.get(blinded)!)
  }
  return signed
}

/**
 * Scan past the outputs that the mint signed in one keyset, and apply the
 * ADR-051 cursor rule. `signedCounters` are the counters of the signed planned
 * outputs, so the skip also passes a signed output that no gap scan sees.
 */
export async function skipPastSignedSeedOutputs(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly fromCounter: number
  readonly signedCounters: readonly number[]
}): Promise<SeedCounterSkip> {
  if (input.signedCounters.length === 0) throw new Error('seed counter skip needs a signed output')
  const scanned = await findLastSignedSeedCounter({
    mint: input.mint,
    seed: input.seed,
    keysetId: input.keysetId,
    startCounter: input.fromCounter,
  })
  const lastSignedCounter = Math.max(...input.signedCounters, scanned ?? -1)
  const nextCounter = lastSignedCounter + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED
  requireCounterRange(nextCounter, 1)
  return {
    keysetId: input.keysetId,
    fromCounter: input.fromCounter,
    lastSignedCounter,
    nextCounter,
  }
}

/**
 * Find the last counter at or after `startCounter` whose output the mint
 * signed. The scan ends after the gap limit of consecutive unsigned counters,
 * or at its work bound. Return null when the mint signed none.
 */
export async function findLastSignedSeedCounter(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly startCounter: number
  readonly gapLimit?: number
  readonly maxScannedCounters?: number
}): Promise<number | null> {
  const gapLimit = input.gapLimit ?? SEED_COUNTER_GAP_LIMIT
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > SEED_COUNTER_GAP_LIMIT) {
    throw new Error('seed counter gap limit is invalid')
  }
  const maxScanned = input.maxScannedCounters ?? SEED_COUNTER_SCAN_COUNTERS_MAX
  if (
    !Number.isSafeInteger(maxScanned) ||
    maxScanned < 1 ||
    maxScanned > SEED_COUNTER_SCAN_COUNTERS_MAX
  ) {
    throw new Error('seed counter scan bound is invalid')
  }
  requireCounterRange(input.startCounter, 1)
  let last: number | null = null
  let next = input.startCounter
  for (;;) {
    // The last counter that the current gap and the work bound still cover.
    const end = Math.min(
      (last ?? input.startCounter - 1) + gapLimit,
      input.startCounter + maxScanned - 1,
      DURABLE_SEED_DERIVED_COUNTER_MAX,
    )
    if (next > end) return last
    const size = Math.min(SEED_COUNTER_PROBE_BATCH_MAX, end - next + 1)
    const signed = await probeBatch(input.mint, input.seed, input.keysetId, next, size)
    if (signed.length > 0) last = Math.max(...signed)
    next += size
  }
}

async function probeBatch(
  mint: SeedCounterRestoreClient,
  seed: Uint8Array,
  keysetId: string,
  startCounter: number,
  size: number,
): Promise<number[]> {
  const planned = Array.from({ length: size }, (_, index) => {
    const counter = startCounter + index
    const output = OutputData.createSingleDeterministicData(1, seed, counter, keysetId)
    return { keysetId, counter, B_: output.blindedMessage.B_ }
  })
  return (await findSignedSeedOutputs(mint, planned))
    .map(({ counter }) => counter)
    .sort((left, right) => left - right)
}

function requireCounterRange(startCounter: number, count: number): void {
  if (
    !Number.isSafeInteger(startCounter) ||
    startCounter < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    startCounter + count - 1 > DURABLE_SEED_DERIVED_COUNTER_MAX
  ) {
    throw new Error('seed counter range is invalid')
  }
}
