import { OutputData } from '@cashu/cashu-ts'
import {
  createCounterCtfRangePreparation,
  planCounterCtfRangePreparation,
  reconstructCtfRangePreparation,
  type CtfRangePreparationIntent,
} from './ctfRangeOrderCounterPreparation.ts'
import type { CtfRangeOrderPreparation } from './ctfRangeOrderPreparation.ts'
import type { PersistedCtfRangeOrderPreparationV2 } from './ctfRangeOrderProtocol.ts'
import { ctfRangeSourceMode } from './ctfRangeSourceOperation.ts'
import type { DurableCustodyProofOperationInput } from './durableCustodyProofOperation.ts'
import { decodeDurableSeedDerivedOutputPlan } from './durableSeedDerivedOutputs.ts'
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
 * counters that this wallet is about to use. A pool manifest output that the
 * mint already signed rejects the whole settlement group, and the participant
 * pays the reused-output penalty. A source output that the mint already signed
 * refuses the source request. So the SDK asks the mint with NUT-09 about every
 * output of the order before the mint sees the order, in two steps:
 *
 * - Before the order reserves its counters: each authorization output, the
 *   plain output at every offer counter (both counters of each authorization,
 *   then the pool change), and every receive output.
 * - Before the source request is persisted and sent: its own seed-derived
 *   outputs (keep, offered change, collateral change, complement). The source
 *   reserves them later, after input selection.
 *
 * On a hit, each step skips past the signed outputs with the ADR-051 cursor
 * rule, builds the order or the source request again at the new counters, and
 * checks again. The check admits no proof.
 *
 * Disclosure: each request output has amount 1, so the requests show the mint
 * no amount. The first check sends, in one NUT-09 request, the authorization
 * outputs of the source request together with the receive and pool change
 * outputs of the settlement request, and the plain outputs at the
 * authorization counters (decision 14 requires these). The mint can therefore
 * link the source of an order to its settlement leg and to the requester of
 * the check. The work is bounded: at most
 * `CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX` checks in each step, and one
 * bounded gap scan for each keyset with a hit in a check.
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
  const counts = planCounterCtfRangePreparation(input.preparation)
  for (let attempt = 0; attempt < CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX; attempt += 1) {
    const starts = await input.readCounterStarts()
    const planned = plannedCtfRangeOrderOutputs({
      seed: input.seed,
      prepared: reconstructCtfRangePreparation(
        createCounterCtfRangePreparation({
          preparation: input.preparation,
          intent: input.intent,
          seed: input.seed,
          offerCounterStart: starts.offer,
          receiveCounterStart: starts.receive,
        }),
        input.seed,
      ),
      starts,
      offerCount: counts.offerCount,
      receiveCount: counts.receiveCount,
    })
    const signed = await askMint(() => findSignedSeedOutputs(input.mint, planned))
    if (signed.length === 0) {
      const reserved = await input.reserve(starts)
      if (reserved !== null) return reserved
      continue
    }
    await skipSignedOutputs(input, signed, (keysetId) =>
      keysetId === input.preparation.offerKeyset.id ? starts.offer : starts.receive,
    )
  }
  throw new CtfRangeOrderOutputCheckError('attempts-exhausted')
}

/**
 * Check the seed-derived outputs of a new source request before the caller
 * persists and sends it. `prepare` reads the current counters and builds the
 * exact source request; it sends nothing. On a hit, `skipSignedCounters`
 * moves the durable counter of the keyset past the signed outputs, and the SDK
 * calls `prepare` again, so the request is rebuilt at the new counters. The
 * authorization outputs of the request are fixed by the order reservation,
 * which `reserveCheckedCtfRangeOrderPreparation` already checked.
 */
export async function prepareCheckedCtfRangeSourceOperation<
  T extends { readonly operation: DurableCustodyProofOperationInput },
>(input: {
  readonly mint: SeedCounterRestoreClient
  readonly seed: Uint8Array
  readonly prepare: () => Promise<T>
  readonly skipSignedCounters: (skip: SeedCounterSkip) => Promise<void>
}): Promise<T> {
  for (let attempt = 0; attempt < CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX; attempt += 1) {
    const prepared = await input.prepare()
    const planned = ctfRangeSourceSeedOutputs(prepared.operation)
    if (planned.length === 0) return prepared
    const signed = await askMint(() => findSignedSeedOutputs(input.mint, planned))
    if (signed.length === 0) return prepared
    await skipSignedOutputs(input, signed, (keysetId) =>
      Math.min(
        ...planned.filter((output) => output.keysetId === keysetId).map(({ counter }) => counter),
      ),
    )
  }
  throw new CtfRangeOrderOutputCheckError('attempts-exhausted')
}

/**
 * The seed-derived outputs of a source request, at their counters: the keep
 * outputs of a swap, the offered and collateral change of a mixed conversion,
 * or the complement and collateral change of a collateral conversion.
 */
export function ctfRangeSourceSeedOutputs(
  operation: DurableCustodyProofOperationInput,
): PlannedSeedOutput[] {
  return sourceOutputPlanFields(operation).flatMap((field) => {
    const value = operation.metadata?.[field]
    if (value === null) return []
    const plan = decodeDurableSeedDerivedOutputPlan(value)
    return plan.outputs.map((output, index) => ({
      keysetId: plan.keysetId,
      counter: plan.counterStart + index,
      B_: output.blindedMessage.B_,
    }))
  })
}

function sourceOutputPlanFields(operation: DurableCustodyProofOperationInput): readonly string[] {
  const mode = ctfRangeSourceMode(operation)
  switch (mode) {
    case 'wallet-send':
    case 'conditional-keyset-swap':
      return ['keepPlan']
    case 'mixed-source-ctf-convert':
      return ['offeredPlan', 'collateralPlan']
    case 'ctf-range-collateral-convert':
      return ['complementPlan', 'collateralChangePlan']
    default:
      return assertNever(mode)
  }
}

/** Skip past the signed outputs of each keyset with a hit, from its first checked counter. */
async function skipSignedOutputs(
  input: {
    readonly mint: SeedCounterRestoreClient
    readonly seed: Uint8Array
    readonly skipSignedCounters: (skip: SeedCounterSkip) => Promise<void>
  },
  signed: readonly PlannedSeedOutput[],
  fromCounter: (keysetId: string) => number,
): Promise<void> {
  for (const [keysetId, counters] of signedCountersByKeyset(signed)) {
    const skip = await askMint(() =>
      skipPastSignedSeedOutputs({
        mint: input.mint,
        seed: input.seed,
        keysetId,
        fromCounter: fromCounter(keysetId),
        signedCounters: counters,
      }),
    )
    await input.skipSignedCounters(skip)
  }
}

/**
 * Every output that a reservation at `starts` fixes, from the order preparation
 * that the reservation derives. It refuses a manifest output that is not the
 * plain output at its counter, so that no unchecked output is sent.
 */
export function plannedCtfRangeOrderOutputs(input: {
  readonly seed: Uint8Array
  readonly prepared: CtfRangeOrderPreparation
  readonly starts: CtfRangeOrderCounterStarts
  readonly offerCount: number
  readonly receiveCount: number
}): PlannedSeedOutput[] {
  const { seed, prepared, starts } = input
  const plain = [
    ...plainOutputs(seed, prepared.offerKeysetId, starts.offer, input.offerCount),
    ...plainOutputs(seed, prepared.receiveKeysetId, starts.receive, input.receiveCount),
  ]
  // The pool manifest outputs are the plain outputs at their counters.
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

function assertNever(value: never): never {
  throw new Error(`unhandled CTF range source mode: ${String(value)}`)
}

/** A mint failure or an invalid mint answer ends the check with a fixed error. */
async function askMint<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch {
    throw new CtfRangeOrderOutputCheckError('mint-check-failed')
  }
}
