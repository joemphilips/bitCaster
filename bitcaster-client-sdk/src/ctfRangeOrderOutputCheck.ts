import { OutputData } from '@cashu/cashu-ts'
import {
  createCounterCtfRangePreparation,
  planCounterCtfRangePreparation,
  reconstructCtfRangePreparation,
  type CtfRangePreparationIntent,
} from './ctfRangeOrderCounterPreparation.ts'
import type { PersistedCtfRangeOrderPreparationV2 } from './ctfRangeOrderProtocol.ts'
import {
  findSignedSeedOutputs,
  skipPastSignedSeedOutputs,
  type PlannedSeedOutput,
  type SeedCounterRestoreClient,
  type SeedCounterSkip,
} from './seedCounterGapScan.ts'

/**
 * The output check of a Buy or a Sell order before its first mint request
 * (ADR-037 reused-output amendment, decision 14).
 *
 * Another client of the same seed can already hold signed outputs at the
 * counters that this wallet is about to reserve. A pool manifest output that
 * the mint already signed rejects the whole settlement group, and the
 * participant pays the reused-output penalty. So the SDK asks the mint with
 * NUT-09 about every output that the order reservation fixes, before it
 * reserves: each authorization output, the plain output at every offer
 * counter (both counters of each authorization, then the pool change), and
 * every receive output. On a hit, it skips past the signed outputs with the
 * ADR-051 cursor rule, plans the order again at the new counters, and checks
 * again. The check admits no proof.
 *
 * The requests hold only outputs that this order reserves, each with amount
 * 1, so they show the mint no amount. The plain outputs at the authorization
 * counters are the one addition to what the order itself sends, as decision
 * 14 requires. The work is bounded: at most
 * `CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX` checks, and one bounded gap
 * scan for each keyset with a hit in a check.
 */

/** The first counter of each order range, where the caller reserves. */
export interface CtfRangeOrderCounterStarts {
  readonly offer: number
  readonly receive: number
}

/**
 * Checks before the order fails. An honest switch between clients needs two:
 * one hit, then a clean check at the new counters.
 */
export const CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX = 4

export type CtfRangeOrderOutputCheckFailure = 'mint-check-failed' | 'attempts-exhausted'

/** The check could not end with a clean order. The caller submits nothing. */
export class CtfRangeOrderOutputCheckError extends Error {
  readonly reason: CtfRangeOrderOutputCheckFailure

  constructor(reason: CtfRangeOrderOutputCheckFailure) {
    super("The wallet could not check this order's outputs with the mint. No order was submitted.")
    this.name = 'CtfRangeOrderOutputCheckError'
    this.reason = reason
  }
}

/**
 * Check the outputs of a new order at the current counters, then reserve
 * them. `reserve` must take both ranges at exactly the checked starts in one
 * transaction, and return null when a counter moved after the check; the SDK
 * then checks the new counters. A replayed reservation of the same intent can
 * return its retained record. `skipSignedCounters` advances one keyset to at
 * least `nextCounter`; the caller can also record where a later admission
 * scan starts (ADR-033 deferral marker).
 */
export async function reserveCheckedCtfRangeOrderPreparation<T>(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly preparation: PersistedCtfRangeOrderPreparationV2
  readonly intent: CtfRangePreparationIntent
  readonly readCounterStarts: () => Promise<CtfRangeOrderCounterStarts>
  readonly skipSignedCounters: (skip: SeedCounterSkip) => Promise<void>
  readonly reserve: (checked: CtfRangeOrderCounterStarts) => Promise<T | null>
}): Promise<T> {
  for (let attempt = 0; attempt < CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX; attempt += 1) {
    const starts = await input.readCounterStarts()
    const planned = plannedOrderOutputs(input, starts)
    const signed = await askMint(() => findSignedSeedOutputs(input.mint, planned))
    if (signed.length === 0) {
      const reserved = await input.reserve(starts)
      if (reserved !== null) return reserved
      continue
    }
    for (const [keysetId, counters] of signedCountersByKeyset(signed)) {
      const skip = await askMint(() =>
        skipPastSignedSeedOutputs({
          mint: input.mint,
          seed: input.seed,
          keysetId,
          fromCounter:
            keysetId === input.preparation.offerKeyset.id ? starts.offer : starts.receive,
          signedCounters: counters,
        }),
      )
      await input.skipSignedCounters(skip)
    }
  }
  throw new CtfRangeOrderOutputCheckError('attempts-exhausted')
}

/** Every output that a reservation at `starts` fixes, as the reservation derives it. */
function plannedOrderOutputs(
  input: {
    readonly seed: Uint8Array
    readonly preparation: PersistedCtfRangeOrderPreparationV2
    readonly intent: CtfRangePreparationIntent
  },
  starts: CtfRangeOrderCounterStarts,
): PlannedSeedOutput[] {
  const counts = planCounterCtfRangePreparation(input.preparation)
  const prepared = reconstructCtfRangePreparation(
    createCounterCtfRangePreparation({
      preparation: input.preparation,
      intent: input.intent,
      seed: input.seed,
      offerCounterStart: starts.offer,
      receiveCounterStart: starts.receive,
    }),
    input.seed,
  )
  const plain = [
    ...plainOutputs(input.seed, prepared.offerKeysetId, starts.offer, counts.offerCount),
    ...plainOutputs(input.seed, prepared.receiveKeysetId, starts.receive, counts.receiveCount),
  ]
  // The pool manifest outputs are the plain outputs at their counters. Refuse
  // a derivation that differs, so that no unchecked output is sent.
  const plainOutputSet = new Set(plain.map(({ B_ }) => B_))
  if (!prepared.manifest.serialized.every(({ B_ }) => plainOutputSet.has(B_))) {
    throw new Error('CTF range manifest outputs differ from their counters')
  }
  // Authorization i takes its nonce from counter offer + 2i and its blinding
  // factor from counter offer + 2i + 1. A skip must pass both.
  const authorization = prepared.authorizationOutputs.map((output, index) => ({
    keysetId: prepared.offerKeysetId,
    counter: starts.offer + 2 * index + 1,
    B_: output.blindedMessage.B_,
  }))
  return [...plain, ...authorization]
}

function plainOutputs(
  seed: Uint8Array,
  keysetId: string,
  start: number,
  count: number,
): PlannedSeedOutput[] {
  return Array.from({ length: count }, (_, index) => ({
    keysetId,
    counter: start + index,
    B_: OutputData.createSingleDeterministicData(1, seed, start + index, keysetId).blindedMessage
      .B_,
  }))
}

function signedCountersByKeyset(signed: readonly PlannedSeedOutput[]): Map<string, number[]> {
  const byKeyset = new Map<string, number[]>()
  for (const { keysetId, counter } of signed) {
    byKeyset.set(keysetId, [...(byKeyset.get(keysetId) ?? []), counter])
  }
  return byKeyset
}

/** A mint failure or an invalid mint answer ends the check with a fixed error. */
async function askMint<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch {
    throw new CtfRangeOrderOutputCheckError('mint-check-failed')
  }
}
