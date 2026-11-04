import { OutputData, type SerializedBlindedMessage } from '@cashu/cashu-ts'
import { DURABLE_SEED_DERIVED_COUNTER_MAX } from './durableSeedDerivedPolicy.ts'

/**
 * Counter-only NUT-09 scans for one seed and keyset (ADR-037 mint refusal
 * settlement). A scan asks the mint which NUT-13 outputs it already signed.
 * It admits no proof, so it claims no custody scope. The caller advances its
 * counter past the result.
 *
 * A NUT-13 blinded output does not depend on its amount, so each scan output
 * uses amount 1. The mint sees the same outputs in the real request, so a
 * probe adds no new privacy exposure.
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
/** Gap scans before a receive-range probe stops. */
export const SEED_COUNTER_PROBE_ATTEMPTS_MAX = 8
/**
 * Counters that one gap scan asks about. The bound limits the mint load when
 * a mint reports every output as signed. A later scan continues from the
 * advanced counter.
 */
export const SEED_COUNTER_SCAN_COUNTERS_MAX = 3_000

/** Return the counters in [start, start + count) whose outputs the mint signed. */
export async function probeSignedSeedCounters(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly startCounter: number
  readonly count: number
}): Promise<number[]> {
  requireCounterRange(input.startCounter, input.count)
  const signed: number[] = []
  for (let offset = 0; offset < input.count; offset += SEED_COUNTER_PROBE_BATCH_MAX) {
    const size = Math.min(SEED_COUNTER_PROBE_BATCH_MAX, input.count - offset)
    signed.push(
      ...(await probeBatch(
        input.mint,
        input.seed,
        input.keysetId,
        input.startCounter + offset,
        size,
      )),
    )
  }
  return signed
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

/**
 * Probe a counter range before the caller reserves it. On a hit, scan past
 * the mint's signed range, advance the counter, and probe the new range. Use
 * it for a buy receive range: the engine signs receive outputs in a group
 * convert, where one reused output rejects the whole group.
 */
export async function probeSeedCounterRangeBeforeReservation(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly count: number
  readonly readNextCounter: () => Promise<number>
  readonly advanceCounterTo: (nextCounter: number) => Promise<void>
}): Promise<void> {
  for (let attempt = 0; attempt < SEED_COUNTER_PROBE_ATTEMPTS_MAX; attempt += 1) {
    const startCounter = await input.readNextCounter()
    const signed = await probeSignedSeedCounters({ ...input, startCounter })
    if (signed.length === 0) return
    const last =
      (await findLastSignedSeedCounter({ ...input, startCounter })) ?? Math.max(...signed)
    await input.advanceCounterTo(last + 1)
  }
  throw new Error('receive counters stay signed after repeated scans')
}

async function probeBatch(
  mint: SeedCounterRestoreClient,
  seed: Uint8Array,
  keysetId: string,
  startCounter: number,
  size: number,
): Promise<number[]> {
  const counters = new Map<string, number>()
  const outputs = Array.from({ length: size }, (_, index) => {
    const counter = startCounter + index
    const output = OutputData.createSingleDeterministicData(1, seed, counter, keysetId)
    counters.set(output.blindedMessage.B_, counter)
    return output.blindedMessage
  })
  const response = await mint.restore({ outputs })
  if (!Array.isArray(response?.outputs) || response.outputs.length > outputs.length) {
    throw new Error('mint restore response is invalid')
  }
  const signed = new Set<number>()
  for (const output of response.outputs) {
    // A restore response may only name outputs from this request.
    const counter = typeof output?.B_ === 'string' ? counters.get(output.B_) : undefined
    if (counter === undefined) throw new Error('mint restore returned a foreign output')
    signed.add(counter)
  }
  return [...signed].sort((left, right) => left - right)
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
